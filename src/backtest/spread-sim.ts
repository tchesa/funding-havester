import type { SimParams, SpreadParams } from "../config/params.js";
import { type Dataset, type SymbolSeries, timeAt } from "../data/loaders.js";
import { HOUR } from "../data/parse.js";
import { bestPair, shouldExitSpread, spreadCapitalPerNotional, type SpreadCandidate, type SpreadLeg } from "../strategy/spread.js";
import { perpFee, slippage } from "./costs.js";
import { longLiquidationPrice, longTargetMargin, marginTriggerPrice, shortLiquidationPrice, targetMargin } from "./liquidation.js";
import { realizedVol, type SimResult } from "./simulator.js";

export interface SpreadSimConfig {
  strategy: SpreadParams;
  sim: SimParams;
  from: number;
  to: number;
  delistNoticeHours?: number;
}

interface Leg {
  s: SymbolSeries;
  /** +1 long, −1 short. */
  side: 1 | -1;
  qty: number;
  entry: number;
  margin: number;
}

interface Pos {
  id: string;
  base: string;
  short: Leg;
  long: Leg;
  initialNotional: number;
  openTime: number;
  funding: number;
  fees: number;
  slippage: number;
  basis: number;
  payments: number;
}

function lastValid(arr: Float64Array, j: number, maxLookback = Infinity): number {
  for (let k = j; k >= 0 && k > j - maxLookback; k--) {
    const v = arr[k]!;
    if (!Number.isNaN(v)) return v;
  }
  return NaN;
}

/** Prefix sums of raw funding: cum[i] = sum of rates paid at time indices < i. Cached per series. */
const cumCache = new WeakMap<SymbolSeries, Float64Array>();
function cumFunding(s: SymbolSeries): Float64Array {
  let c = cumCache.get(s);
  if (!c) {
    c = new Float64Array(s.fundingRate.length + 1);
    for (let i = 0; i < s.fundingRate.length; i++) {
      const r = s.fundingRate[i]!;
      c[i + 1] = c[i]! + (Number.isNaN(r) ? 0 : r);
    }
    cumCache.set(s, c);
  }
  return c;
}

/** Realized funding over hours (i − w, i], as a per-8h rate; null if the series didn't pay funding for the whole window. */
function windowAvg8h(s: SymbolSeries, i: number, w: number): number | null {
  const first = s.fundingIdx[0];
  if (first === undefined || first > i + 1 - w) return null;
  const c = cumFunding(s);
  return ((c[i + 1]! - c[i + 1 - w]!) * 8) / w;
}

/**
 * Hourly simulator for the cross-venue perp-perp spread. Same clock and price conventions as `simulate`:
 * price "at time i" is the close of bar i − 1; funding settles first, then decisions, then intrabar risk.
 * Decisions run every 8h (00/08/16 UTC), right after the most common funding times.
 * Each leg is an isolated position on its own venue; top-ups come from the shared cash pool
 * (assumes transfers between exchanges are fast enough at an hourly cadence).
 */
export function simulateSpread(ds: Dataset, cfg: SpreadSimConfig): SimResult {
  const { strategy: sp, sim } = cfg;
  const notice = (cfg.delistNoticeHours ?? 168) * HOUR;
  const iFrom = Math.max(1, Math.round((cfg.from - ds.t0) / HOUR));
  const iTo = Math.min(ds.hours - 1, Math.round((cfg.to - ds.t0) / HOUR));
  const cpn = spreadCapitalPerNotional(sp.leverage);
  const mmr = sim.maintenanceMarginRate;

  // Coins listed on at least two venues.
  const byBase = new Map<string, SymbolSeries[]>();
  for (const s of ds.symbols) byBase.set(s.base, [...(byBase.get(s.base) ?? []), s]);
  for (const [b, xs] of byBase) if (new Set(xs.map((x) => x.venue)).size < 2) byBase.delete(b);

  let cash = sim.initialCapital;
  const positions = new Map<string, Pos>();
  const res: SimResult = {
    initialCapital: sim.initialCapital,
    times: [], equity: [], capitalUsed: [], openCount: [], trades: [], events: [],
    totals: { funding: 0, fees: 0, slippage: 0, basis: 0 },
    tradedNotional: 0,
  };

  const px = (s: SymbolSeries, i: number) => lastValid(s.perpClose, i - 1);
  const legValue = (l: Leg, i: number) => l.margin + l.side * l.qty * (px(l.s, i) - l.entry);

  const equityAt = (i: number) => {
    let eq = cash;
    let used = 0;
    for (const p of positions.values()) {
      eq += legValue(p.short, i) + legValue(p.long, i);
      used += p.short.margin + p.long.margin;
    }
    return { eq, used };
  };

  const legCost = (s: SymbolSeries, i: number, notional: number) =>
    notional * (perpFee(sim, s.venue) + slippage(sim, notional, s.perpVol24[i]!));

  const open = (c: SpreadCandidate, legs: Map<string, SymbolSeries>, i: number, notional: number) => {
    const mk = (sym: string, side: 1 | -1): Leg => {
      const s = legs.get(sym)!;
      const entry = px(s, i);
      return { s, side, qty: notional / entry, entry, margin: notional / sp.leverage };
    };
    const short = mk(c.short.symbol, -1);
    const long = mk(c.long.symbol, 1);
    let fees = 0;
    let slip = 0;
    for (const l of [short, long]) {
      fees += notional * perpFee(sim, l.s.venue);
      slip += notional * slippage(sim, notional, l.s.perpVol24[i]!);
    }
    cash -= short.margin + long.margin + fees + slip;
    res.tradedNotional += 2 * notional;
    const id = `${c.base}:${short.s.venue}/${long.s.venue}`;
    positions.set(c.base, {
      id, base: c.base, short, long, initialNotional: notional, openTime: timeAt(ds, i),
      funding: 0, fees, slippage: slip, basis: 0, payments: 0,
    });
  };

  const record = (p: Pos, i: number, reason: string, liquidated: boolean) => {
    const net = p.funding + p.basis - p.fees - p.slippage;
    res.trades.push({
      symbol: p.id, openTime: p.openTime, closeTime: timeAt(ds, i), notional: p.initialNotional,
      funding: p.funding, fees: p.fees, slippage: p.slippage, basis: p.basis, net, payments: p.payments,
      exitReason: reason, liquidated,
    });
    res.totals.funding += p.funding;
    res.totals.fees += p.fees;
    res.totals.slippage += p.slippage;
    res.totals.basis += p.basis;
    positions.delete(p.base);
  };

  /** Close fraction f of one leg at price `price`. */
  const closeLeg = (p: Pos, l: Leg, i: number, f: number, price: number) => {
    const q = l.qty * f;
    const value = q * price;
    const fee = value * perpFee(sim, l.s.venue);
    const slip = value * slippage(sim, value, l.s.perpVol24[i]!);
    const pnl = l.side * q * (price - l.entry);
    const released = l.margin * f;
    cash += released + pnl - fee - slip;
    res.tradedNotional += value;
    p.fees += fee;
    p.slippage += slip;
    p.basis += pnl;
    l.qty -= q;
    l.margin -= released;
  };

  const close = (p: Pos, i: number, f: number, reason: string) => {
    closeLeg(p, p.short, i, f, px(p.short.s, i));
    closeLeg(p, p.long, i, f, px(p.long.s, i));
    if (f >= 0.999999) record(p, i, reason, false);
  };

  /** Leg `dead` was liquidated during bar i (its margin is gone); the other leg is closed at the bar close. */
  const liquidate = (p: Pos, dead: Leg, i: number) => {
    p.basis -= dead.margin;
    dead.margin = 0;
    dead.qty = 0;
    const other = dead === p.short ? p.long : p.short;
    closeLeg(p, other, i, 1, lastValid(other.s.perpClose, i));
    res.events.push({ time: timeAt(ds, i), symbol: p.id, type: "liquidation", amount: 0 });
    record(p, i + 1, "liquidation", true);
  };

  /** Restore a leg's margin after an adverse move: top up from cash, else shrink both legs. */
  const maintain = (p: Pos, l: Leg, i: number) => {
    for (let guard = 0; guard < 10 && positions.has(p.base); guard++) {
      const price = px(l.s, i);
      const tgt = l.side < 0 ? targetMargin(l.entry, l.qty, price, sp.leverage) : longTargetMargin(l.entry, l.qty, price, sp.leverage);
      const need = tgt - l.margin;
      if (need <= 0) return;
      const topup = Math.min(need, Math.max(0, cash));
      if (topup > 0) {
        cash -= topup;
        l.margin += topup;
        res.events.push({ time: timeAt(ds, i), symbol: p.id, type: "topup", amount: topup });
      }
      if (topup >= need) return;
      const f = guard === 9 ? 1 : 0.25;
      res.events.push({ time: timeAt(ds, i), symbol: p.id, type: "reduce", amount: l.qty * price * f });
      close(p, i, f, "margin_reduce");
    }
  };

  /** Snapshot of one venue's perp for decisions at time i (null if not tradable). */
  const leg = (s: SymbolSeries, i: number, notional: number, forEntry: boolean): SpreadLeg | null => {
    const t = timeAt(ds, i);
    if (s.firstIdx < 0 || i <= s.firstIdx || i - 1 > s.lastIdx) return null;
    if (Number.isNaN(lastValid(s.perpClose, i - 1, 48))) return null;
    if (s.delistedAt !== null && t >= s.delistedAt - notice) return null;
    const avg = windowAvg8h(s, i, sp.lookbackHours);
    const recent = windowAvg8h(s, i, 24);
    if (avg === null || recent === null) return null;
    if (forEntry) {
      if (s.perpVol24[i]! < sp.minPerpVolume24h) return null;
      if (s.listedAt !== null && t - s.listedAt < sp.minListingAgeDays * 86_400_000) return null;
      if (sp.maxEntryVolatility > 0) {
        const v = realizedVol(s.perpClose, i, sp.volatilityLookbackHours);
        if (v === null || v > sp.maxEntryVolatility) return null;
      }
    }
    const rt = notional > 0 ? (2 * legCost(s, i, notional)) / notional : 2 * perpFee(sim, s.venue);
    return { symbol: s.symbol, venue: s.venue, avg8h: avg, recent8h: recent, roundTripCost: rt };
  };

  for (let i = iFrom; i <= iTo; i++) {
    const t = timeAt(ds, i);

    // 1) Funding settles at t on each leg's own schedule. Short receives rate × notional, long pays it.
    for (const p of positions.values()) {
      for (const l of [p.short, p.long]) {
        const r = l.s.fundingRate[i]!;
        if (Number.isNaN(r)) continue;
        const pay = -l.side * r * l.qty * px(l.s, i);
        l.margin += pay;
        p.funding += pay;
        p.payments++;
      }
    }

    // 2) Forced exits when either leg's data ends.
    for (const p of [...positions.values()]) {
      if (i - 1 > p.short.s.lastIdx || i - 1 > p.long.s.lastIdx) close(p, i, 1, "data_end");
    }

    // 3) Decisions every 8h.
    if ((t / HOUR) % 8 === 0) {
      const { eq } = equityAt(i);
      const targetNotional = (eq * sp.maxPositionFraction) / cpn;
      for (const p of [...positions.values()]) {
        const s = leg(p.short.s, i, 0, false);
        const l = leg(p.long.s, i, 0, false);
        if (!s || !l) close(p, i, 1, "universe");
        else if (shouldExitSpread(s, l, sp)) close(p, i, 1, "spread_faded");
      }
      if (positions.size < sp.maxPositions) {
        const cands: Array<{ c: SpreadCandidate; legs: Map<string, SymbolSeries> }> = [];
        for (const [base, xs] of byBase) {
          if (positions.has(base)) continue;
          const legs: SpreadLeg[] = [];
          const map = new Map<string, SymbolSeries>();
          for (const s of xs) {
            const l = leg(s, i, targetNotional, true);
            if (l) {
              legs.push(l);
              map.set(s.symbol, s);
            }
          }
          const c = bestPair(base, legs, sp);
          if (c) cands.push({ c, legs: map });
        }
        cands.sort((a, b) => b.c.expectedNetIncome - a.c.expectedNetIncome);
        for (const { c, legs } of cands) {
          if (positions.size >= sp.maxPositions) break;
          const { eq: eqNow } = equityAt(i);
          const capital = Math.min(eqNow * sp.maxPositionFraction, cash - eqNow * sp.reserveFraction);
          const notional = capital / cpn;
          if (notional < 0.02 * targetNotional || notional <= 0) break;
          open(c, legs, i, notional);
        }
      }
    }

    // 4) Record state at t.
    const { eq, used } = equityAt(i);
    res.times.push(t);
    res.equity.push(eq);
    res.capitalUsed.push(used);
    res.openCount.push(positions.size);

    // 5) Intrabar liquidation per leg (mark-price proxy: the less extreme of perp and spot), then margin upkeep.
    if (i + 1 <= iTo) {
      for (const p of [...positions.values()]) {
        const ss = p.short.s;
        const ls = p.long.s;
        const hi = Number.isNaN(ss.spotHigh[i]!) ? ss.perpHigh[i]! : Math.min(ss.perpHigh[i]!, ss.spotHigh[i]!);
        const lo = Number.isNaN(ls.spotLow[i]!) ? ls.perpLow[i]! : Math.max(ls.perpLow[i]!, ls.spotLow[i]!);
        const sLiq = shortLiquidationPrice(p.short.entry, p.short.qty, p.short.margin, mmr);
        const lLiq = longLiquidationPrice(p.long.entry, p.long.qty, p.long.margin, mmr);
        if (!Number.isNaN(hi) && hi >= sLiq) {
          liquidate(p, p.short, i);
          continue;
        }
        if (!Number.isNaN(lo) && lo <= lLiq) {
          liquidate(p, p.long, i);
          continue;
        }
        const sPx = ss.perpClose[i]!;
        if (!Number.isNaN(sPx) && sPx >= marginTriggerPrice(p.short.entry, sLiq, sim.marginBufferTrigger)) maintain(p, p.short, i + 1);
        const lPx = ls.perpClose[i]!;
        if (positions.has(p.base) && !Number.isNaN(lPx) && lPx <= marginTriggerPrice(p.long.entry, lLiq, sim.marginBufferTrigger)) {
          maintain(p, p.long, i + 1);
        }
      }
    }
  }

  for (const p of [...positions.values()]) close(p, iTo, 1, "end_of_test");
  const last = res.equity.length - 1;
  if (last >= 0) res.equity[last] = cash;
  return res;
}
