import type { Dataset } from "../data/loaders.js";
import { HOUR } from "../data/parse.js";
import type { SimResult } from "./simulator.js";

const HOURS_PER_YEAR = 8760;

export interface RegimeStats {
  hours: number;
  apr: number;
}

export interface Metrics {
  hours: number;
  finalEquity: number;
  netReturn: number;
  netApr: number;
  maxDrawdown: number;
  /** Share of hours with at least one open position. */
  deployedShare: number;
  /** Mean capital used / equity. */
  avgUtilization: number;
  /** Traded notional / average equity, annualized. */
  turnover: number;
  trades: number;
  avgHoldingHours: number;
  winRate: number;
  liquidations: number;
  topups: number;
  reductions: number;
  income: { funding: number; fees: number; slippage: number; basis: number; net: number };
  regimes: { bull: RegimeStats; bear: RegimeStats };
  bySymbol: Array<{ symbol: string; trades: number; net: number; funding: number }>;
}

export function computeMetrics(r: SimResult, ds: Dataset): Metrics {
  const n = r.equity.length;
  const first = r.initialCapital;
  const last = n ? r.equity[n - 1]! : first;
  const hours = n;
  const years = hours / HOURS_PER_YEAR;
  const netReturn = last / first - 1;
  const netApr = years > 0 && last > 0 ? Math.pow(last / first, 1 / years) - 1 : 0;

  let peak = first;
  let maxDd = 0;
  let deployed = 0;
  let util = 0;
  for (let i = 0; i < n; i++) {
    const e = r.equity[i]!;
    peak = Math.max(peak, e);
    maxDd = Math.max(maxDd, (peak - e) / peak);
    if (r.openCount[i]! > 0) deployed++;
    util += r.capitalUsed[i]! / e;
  }

  // Regime: BTC up over the trailing 30 days.
  const reg = { bull: { hours: 0, logSum: 0 }, bear: { hours: 0, logSum: 0 } };
  for (let i = 1; i < n; i++) {
    const idx = Math.round((r.times[i]! - ds.t0) / HOUR);
    const now = ds.btcClose[idx - 1];
    const then = ds.btcClose[idx - 1 - 720];
    if (now === undefined || then === undefined || Number.isNaN(now) || Number.isNaN(then)) continue;
    const bucket = now >= then ? reg.bull : reg.bear;
    bucket.hours++;
    bucket.logSum += Math.log(r.equity[i]! / r.equity[i - 1]!);
  }
  const regApr = (b: { hours: number; logSum: number }): RegimeStats => ({
    hours: b.hours,
    apr: b.hours ? Math.exp((b.logSum / b.hours) * HOURS_PER_YEAR) - 1 : 0,
  });

  const t = r.totals;
  const sym = new Map<string, { trades: number; net: number; funding: number }>();
  for (const tr of r.trades) {
    const s = sym.get(tr.symbol) ?? { trades: 0, net: 0, funding: 0 };
    s.trades++;
    s.net += tr.net;
    s.funding += tr.funding;
    sym.set(tr.symbol, s);
  }
  const avgEquity = n ? r.equity.reduce((a, b) => a + b, 0) / n : first;

  return {
    hours,
    finalEquity: last,
    netReturn,
    netApr,
    maxDrawdown: maxDd,
    deployedShare: n ? deployed / n : 0,
    avgUtilization: n ? util / n : 0,
    turnover: years > 0 ? r.tradedNotional / avgEquity / years : 0,
    trades: r.trades.length,
    avgHoldingHours: r.trades.length
      ? r.trades.reduce((a, tr) => a + (tr.closeTime - tr.openTime) / HOUR, 0) / r.trades.length
      : 0,
    winRate: r.trades.length ? r.trades.filter((tr) => tr.net > 0).length / r.trades.length : 0,
    liquidations: r.events.filter((e) => e.type === "liquidation").length,
    topups: r.events.filter((e) => e.type === "topup").length,
    reductions: r.events.filter((e) => e.type === "reduce").length,
    income: { ...t, net: t.funding + t.basis - t.fees - t.slippage },
    regimes: { bull: regApr(reg.bull), bear: regApr(reg.bear) },
    bySymbol: [...sym.entries()].map(([symbol, v]) => ({ symbol, ...v })).sort((a, b) => b.net - a.net),
  };
}
