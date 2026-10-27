import type { SimParams, StrategyParams } from "../config/params.js";
import { type Dataset, fundingCountUpTo, fundingPoints, type SymbolSeries, timeAt } from "../data/loaders.js";
import { HOUR } from "../data/parse.js";
import {
  allocate, capitalPerNotional, type Candidate, evaluateEntry, evaluateExit, predictFundingRate, type SymbolSnapshot,
} from "../strategy/index.js";
import { roundTripCost, slippage, spotFee } from "./costs.js";
import { marginTriggerPrice, shortLiquidationPrice, targetMargin } from "./liquidation.js";

export interface SimConfig {
  strategy: StrategyParams;
  sim: SimParams;
  from: number;
  to: number;
  /** Sanity mode: hold these symbols for the whole run, ignoring signals. */
  alwaysOn?: string[];
  /** Hours before the last funding at which a delisting is "announced" (default 7 days). */
  delistNoticeHours?: number;
}

export interface TradeRecord {
  symbol: string;
  openTime: number;
  closeTime: number;
  notional: number;
  funding: number;
  fees: number;
  slippage: number;
  basis: number;
  net: number;
  payments: number;
  exitReason: string;
  liquidated: boolean;
}

export interface RiskEvent {
  time: number;
  symbol: string;
  type: "topup" | "reduce" | "liquidation";
  amount: number;
}

export interface SimResult {
  initialCapital: number;
  times: number[];
  equity: number[];
  capitalUsed: number[];
  openCount: number[];
  trades: TradeRecord[];
  events: RiskEvent[];
  totals: { funding: number; fees: number; slippage: number; basis: number };
  tradedNotional: number;
}

interface Pos {
  s: SymbolSeries;
  notional: number;
  spotQty: number;
  perpQty: number;
  spotEntry: number;
  perpEntry: number;
  margin: number;
  openTime: number;
  initialNotional: number;
  funding: number;
  fees: number;
  slippage: number;
  basis: number;
  payments: number;
  pendingExit: string | null;
  alwaysOn: boolean;
}

/** Last valid value at or before bar j (looking back at most `maxLookback` bars), NaN if none. */
function lastValid(arr: Float64Array, j: number, maxLookback = Infinity): number {
  for (let k = j; k >= 0 && k > j - maxLookback; k--) {
    const v = arr[k]!;
    if (!Number.isNaN(v)) return v;
  }
  return NaN;
}

export function simulate(ds: Dataset, cfg: SimConfig): SimResult {
  const { strategy: sp, sim } = cfg;
  const notice = (cfg.delistNoticeHours ?? 168) * HOUR;
  const iFrom = Math.max(1, Math.round((cfg.from - ds.t0) / HOUR));
  const iTo = Math.min(ds.hours - 1, Math.round((cfg.to - ds.t0) / HOUR));
  const cpn = capitalPerNotional(sp.leverage);
  const fSpot = spotFee(sim);
  const lookback = sp.k + sp.n + sp.m + 2;

  let cash = sim.initialCapital;
  const positions = new Map<string, Pos>();
  const res: SimResult = {
    initialCapital: sim.initialCapital,
    times: [], equity: [], capitalUsed: [], openCount: [], trades: [], events: [],
    totals: { funding: 0, fees: 0, slippage: 0, basis: 0 },
    tradedNotional: 0,
  };

  // Prices "at time i" = close of bar i − 1. Accounting uses the last known price; trading
  // decisions require a fresh one (see `snapshot`).
  const spotAt = (s: SymbolSeries, i: number) => lastValid(s.spotClose, i - 1);
  const perpAt = (s: SymbolSeries, i: number) => lastValid(s.perpClose, i - 1);

  const equityAt = (i: number) => {
    let eq = cash;
    let used = 0;
    for (const p of positions.values()) {
      const sv = p.spotQty * spotAt(p.s, i);
      eq += sv + p.margin + p.perpQty * (p.perpEntry - perpAt(p.s, i));
      used += sv + p.margin;
    }
    return { eq, used };
  };

  const open = (s: SymbolSeries, i: number, notional: number) => {
    const spotPx = spotAt(s, i);
    const perpPx = perpAt(s, i);
    const fee = notional * fSpot + notional * sim.perpTakerFee;
    const slip = notional * (slippage(sim, notional, s.spotVol24[i]!) + slippage(sim, notional, s.perpVol24[i]!));
    const margin = notional / sp.leverage;
    cash -= notional + margin + fee + slip;
    res.tradedNotional += 2 * notional;
    positions.set(s.symbol, {
      s, notional, initialNotional: notional,
      spotQty: notional / spotPx, perpQty: notional / perpPx, spotEntry: spotPx, perpEntry: perpPx, margin,
      openTime: timeAt(ds, i), funding: 0, fees: fee, slippage: slip, basis: 0, payments: 0,
      pendingExit: null, alwaysOn: false,
    });
  };

  const record = (p: Pos, i: number, reason: string, liquidated: boolean) => {
    const net = p.funding + p.basis - p.fees - p.slippage;
    res.trades.push({
      symbol: p.s.symbol, openTime: p.openTime, closeTime: timeAt(ds, i), notional: p.initialNotional,
      funding: p.funding, fees: p.fees, slippage: p.slippage, basis: p.basis, net, payments: p.payments,
      exitReason: reason, liquidated,
    });
    res.totals.funding += p.funding;
    res.totals.fees += p.fees;
    res.totals.slippage += p.slippage;
    res.totals.basis += p.basis;
    positions.delete(p.s.symbol);
  };

  /** Close fraction f of both legs at prices at time i. */
  const close = (p: Pos, i: number, f: number, reason: string) => {
    const spotPx = spotAt(p.s, i);
    const perpPx = perpAt(p.s, i);
    const q = p.spotQty * f;
    const pq = p.perpQty * f;
    const spotVal = q * spotPx;
    const perpVal = pq * perpPx;
    const fee = spotVal * fSpot + perpVal * sim.perpTakerFee;
    const slip = spotVal * slippage(sim, spotVal, p.s.spotVol24[i]!) + perpVal * slippage(sim, perpVal, p.s.perpVol24[i]!);
    const perpPnl = pq * (p.perpEntry - perpPx);
    const spotPnl = q * (spotPx - p.spotEntry);
    const released = p.margin * f;
    cash += spotVal + released + perpPnl - fee - slip;
    res.tradedNotional += spotVal + perpVal;
    p.fees += fee;
    p.slippage += slip;
    p.basis += perpPnl + spotPnl;
    p.spotQty -= q;
    p.perpQty -= pq;
    p.margin -= released;
    p.notional *= 1 - f;
    if (f >= 0.999999) record(p, i, reason, false);
  };

  /** Perp leg liquidated during bar i; spot is sold at that bar's close. */
  const liquidate = (p: Pos, i: number) => {
    const spotPx = lastValid(p.s.spotClose, i);
    const perpLoss = p.margin; // whole isolated margin is gone
    const spotVal = p.spotQty * spotPx;
    const fee = spotVal * fSpot;
    const slip = spotVal * slippage(sim, spotVal, p.s.spotVol24[i]!);
    cash += spotVal - fee - slip;
    p.fees += fee;
    p.slippage += slip;
    p.basis += p.spotQty * (spotPx - p.spotEntry) - perpLoss;
    res.events.push({ time: timeAt(ds, i), symbol: p.s.symbol, type: "liquidation", amount: perpLoss });
    record(p, i + 1, "liquidation", true);
  };

  /** Restore the short's margin after a rally: top up from cash, else shrink both legs. */
  const maintain = (p: Pos, i: number) => {
    for (let guard = 0; guard < 10 && positions.has(p.s.symbol); guard++) {
      const need = targetMargin(p.perpEntry, p.perpQty, perpAt(p.s, i), sp.leverage) - p.margin;
      if (need <= 0) return;
      const topup = Math.min(need, Math.max(0, cash));
      if (topup > 0) {
        cash -= topup;
        p.margin += topup;
        res.events.push({ time: timeAt(ds, i), symbol: p.s.symbol, type: "topup", amount: topup });
      }
      if (topup >= need) return;
      const f = guard === 9 ? 1 : 0.25;
      res.events.push({ time: timeAt(ds, i), symbol: p.s.symbol, type: "reduce", amount: p.notional * f });
      close(p, i, f, "margin_reduce");
    }
  };

  const snapshot = (s: SymbolSeries, i: number, targetNotional: number): SymbolSnapshot => {
    const cnt = fundingCountUpTo(s, i);
    const interval = s.fundingInterval[i + 1] || 8;
    const prem: number[] = [];
    for (let j = i + 1 - interval; j <= i - 1; j++) {
      const v = s.premClose[j];
      if (v !== undefined && !Number.isNaN(v)) prem.push(v);
    }
    const t = timeAt(ds, i);
    const noPrice = Number.isNaN(lastValid(s.spotClose, i - 1, 48)) || Number.isNaN(lastValid(s.perpClose, i - 1, 48));
    return {
      symbol: s.symbol,
      time: t,
      recentRates: fundingPoints(s, cnt - lookback, cnt),
      predictedRate: predictFundingRate(prem, interval),
      intervalHours: interval,
      perpQuoteVolume24h: s.perpVol24[i]!,
      spotQuoteVolume24h: s.spotVol24[i]!,
      listedAt: s.listedAt,
      excluded: noPrice || (s.delistedAt !== null && t >= s.delistedAt - notice),
      roundTripCost: roundTripCost(sim, targetNotional, s.spotVol24[i]!, s.perpVol24[i]!),
    };
  };

  const alwaysOn = cfg.alwaysOn ? ds.symbols.filter((s) => cfg.alwaysOn!.includes(s.symbol)) : null;

  for (let i = iFrom; i <= iTo; i++) {
    const t = timeAt(ds, i);

    // 1) Funding settles at t for positions open now.
    for (const p of positions.values()) {
      const r = p.s.fundingRate[i]!;
      if (Number.isNaN(r)) continue;
      const pay = r * p.perpQty * perpAt(p.s, i); // short receives when the rate is positive
      p.margin += pay;
      p.funding += pay;
      p.payments++;
    }

    // 2) Exits scheduled for just after this funding; forced exits when data ends.
    for (const p of [...positions.values()]) {
      if (p.pendingExit) close(p, i, 1, p.pendingExit);
      else if (i - 1 > p.s.lastIdx) close(p, i, 1, "data_end");
    }

    if (alwaysOn && i === iFrom) {
      const { eq } = equityAt(i);
      const each = (eq * (1 - sp.reserveFraction)) / alwaysOn.length / cpn;
      for (const s of alwaysOn) {
        open(s, i, each);
        positions.get(s.symbol)!.alwaysOn = true;
      }
    }

    // 3) Decisions one hour before each symbol's next funding.
    if (!alwaysOn && i + 1 < ds.hours) {
      const { eq } = equityAt(i);
      const targetNotional = (eq * sp.maxPositionFraction) / cpn;
      const cands: Candidate[] = [];
      const bySymbol = new Map<string, SymbolSeries>();
      for (const s of ds.symbols) {
        if (Number.isNaN(s.fundingRate[i + 1]!) || s.firstIdx < 0 || i <= s.firstIdx) continue;
        const pos = positions.get(s.symbol);
        const snap = snapshot(s, i, targetNotional);
        if (pos) {
          const ex = evaluateExit(snap, sp);
          if (!ex.exit) continue;
          if (ex.beforeFunding) close(pos, i, 1, ex.reason);
          else pos.pendingExit = ex.reason;
        } else {
          const en = evaluateEntry(snap, sp);
          if (en.enter && en.candidate) {
            cands.push(en.candidate);
            bySymbol.set(s.symbol, s);
          }
        }
      }
      if (cands.length) {
        const { eq: eqNow } = equityAt(i);
        const openViews = [...positions.values()].map((p) => ({ symbol: p.s.symbol, capitalUsed: 0 }));
        for (const a of allocate(cands, openViews, eqNow, cash, sp)) open(bySymbol.get(a.symbol)!, i, a.notional);
      }
    }

    // 4) Record state at t.
    const { eq, used } = equityAt(i);
    res.times.push(t);
    res.equity.push(eq);
    res.capitalUsed.push(used);
    res.openCount.push(positions.size);

    // 5) Risk during bar i: liquidation on the intrabar high, margin maintenance at the bar close.
    if (i + 1 <= iTo) {
      for (const p of [...positions.values()]) {
        // Binance liquidates on the mark price, which tracks the index (spot) rather than perp last-trade wicks.
        const perpHigh = p.s.perpHigh[i]!;
        const spotHigh = p.s.spotHigh[i]!;
        const high = Number.isNaN(spotHigh) ? perpHigh : Math.min(perpHigh, spotHigh);
        if (Number.isNaN(high)) continue;
        const liq = shortLiquidationPrice(p.perpEntry, p.perpQty, p.margin, sim.maintenanceMarginRate);
        if (high >= liq) {
          liquidate(p, i);
          continue;
        }
        const px = p.s.perpClose[i]!;
        if (!Number.isNaN(px) && px >= marginTriggerPrice(p.perpEntry, liq, sim.marginBufferTrigger)) maintain(p, i + 1);
      }
    }
  }

  // Close whatever is left at the end so attribution is complete.
  for (const p of [...positions.values()]) close(p, iTo, 1, "end_of_test");
  const last = res.equity.length - 1;
  if (last >= 0) res.equity[last] = cash;
  return res;
}
