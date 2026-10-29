import { EXCLUDED_BASES } from "../config/params.js";
import { type Dataset, fundingCountUpTo, type SymbolSeries } from "../data/loaders.js";
import { HOUR } from "../data/parse.js";
import { realizedVol } from "../backtest/simulator.js";

/**
 * Phase A event study (funding-momentum requirements §4).
 * One observation per symbol at every 8h mark (00/08/16 UTC) where it paid funding in the previous 8h.
 * Everything in `features` is known at decision time t; outcomes start at the next bar's open
 * (≈ close of the bar before t) and are measured on the perp.
 */

export const HORIZONS = [1, 4, 8, 24, 72, 168] as const;
export type Horizon = (typeof HORIZONS)[number];

export interface Observation {
  symbol: string;
  base: string;
  venue: string;
  time: number;
  /** Realized funding over (t − 8h, t], per 8h. */
  funding8h: number;
  /** z-score of funding8h vs the symbol's own previous 30 days of 8h windows; NaN if too little history. */
  fundingZ: number;
  ret24h: number;
  ret7d: number;
  /** 24h volume ÷ trailing 7-day average daily volume. */
  volumeRatio: number;
  /** Annualized 7-day realized volatility; NaN if unknown. */
  vol7d: number;
  /** Per horizon (same order as HORIZONS); NaN when the horizon runs past the dataset. */
  raw: number[];
  /** Coin return minus BTC return over the same span. */
  btcAdj: number[];
  /** Worst drawdown within the horizon (≤ 0), from bar lows. */
  mae: number[];
  /** Funding a long perp pays over the horizon, as a fraction of notional (negative = received). */
  fundingPaid: number[];
}

export interface StudyOptions {
  minPerpVolume24h: number;
  minListingAgeDays: number;
  /** Hours before a symbol's last funding at which its delisting counts as announced. */
  delistNoticeHours: number;
  from: number;
  to: number;
}

export const defaultStudyOptions = (from: number, to: number): StudyOptions => ({
  minPerpVolume24h: 20_000_000,
  minListingAgeDays: 30,
  delistNoticeHours: 168,
  from,
  to,
});

function lastValid(arr: Float64Array, j: number, maxLookback: number): number {
  for (let k = j; k >= 0 && k > j - maxLookback; k--) {
    const v = arr[k]!;
    if (!Number.isNaN(v)) return v;
  }
  return NaN;
}

/** Prefix sums of raw funding: c[i] = sum of rates paid at indices < i. */
function cumFunding(s: SymbolSeries): Float64Array {
  const c = new Float64Array(s.fundingRate.length + 1);
  for (let i = 0; i < s.fundingRate.length; i++) {
    const r = s.fundingRate[i]!;
    c[i + 1] = c[i]! + (Number.isNaN(r) ? 0 : r);
  }
  return c;
}

export function symbolObservations(s: SymbolSeries, btc: Float64Array, o: StudyOptions): Observation[] {
  if (EXCLUDED_BASES.has(s.base) || s.firstIdx < 0) return [];
  const out: Observation[] = [];
  const hours = s.perpClose.length;
  const c = cumFunding(s);
  const notice = o.delistNoticeHours * HOUR;
  // First index on a 00/08/16 UTC mark with 30 days of history for the z-score.
  const lo = Math.max(Math.round((o.from - s.t0) / HOUR), s.firstIdx + 1, 8 * 91);
  const iFrom = lo + ((((-(s.t0 / HOUR + lo)) % 8) + 8) % 8);
  const iTo = Math.min(Math.floor((o.to - s.t0) / HOUR), hours - 1);
  const f8At = (i: number) =>
    fundingCountUpTo(s, i) - fundingCountUpTo(s, i - 8) > 0 ? c[i + 1]! - c[i - 7]! : NaN;

  for (let i = iFrom; i <= iTo; i += 8) {
    const t = s.t0 + i * HOUR;
    if (i - 1 > s.lastIdx) break;
    if (s.delistedAt !== null && t >= s.delistedAt - notice) break;
    if (s.listedAt !== null && t - s.listedAt < o.minListingAgeDays * 86_400_000) continue;
    if (!(s.perpVol24[i]! >= o.minPerpVolume24h)) continue;
    const p0 = s.perpClose[i - 1]!;
    if (Number.isNaN(p0)) continue; // stale: no bar just before decision time
    const funding8h = f8At(i);
    if (Number.isNaN(funding8h)) continue;

    // Own 30-day funding distribution (90 previous 8h windows).
    let n = 0;
    let sum = 0;
    let sq = 0;
    for (let k = 1; k <= 90; k++) {
      const f = f8At(i - 8 * k);
      if (Number.isNaN(f)) continue;
      n++;
      sum += f;
      sq += f * f;
    }
    let fundingZ = NaN;
    if (n >= 60) {
      const mean = sum / n;
      const sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
      fundingZ = sd > 1e-9 ? (funding8h - mean) / sd : 0;
    }

    const p24 = lastValid(s.perpClose, i - 25, 3);
    const p7d = lastValid(s.perpClose, i - 169, 3);
    let weekVol = 0;
    let weekN = 0;
    for (let k = 0; k < 7; k++) {
      const v = s.perpVol24[i - 24 * k];
      if (v !== undefined && v > 0) {
        weekVol += v;
        weekN++;
      }
    }
    const vol = realizedVol(s.perpClose, i, 168);
    const b0 = btc[i - 1]!;

    const raw: number[] = [];
    const btcAdj: number[] = [];
    const mae: number[] = [];
    const fundingPaid: number[] = [];
    for (const h of HORIZONS) {
      const j = i - 1 + h; // bar whose close ends the horizon
      if (j >= hours || s.t0 + (j + 1) * HOUR > o.to) {
        raw.push(NaN); btcAdj.push(NaN); mae.push(NaN); fundingPaid.push(NaN);
        continue;
      }
      // A coin whose data ends inside the horizon exits at its last price (delisting loss is kept).
      const p1 = lastValid(s.perpClose, j, h);
      const r = p1 / p0 - 1;
      let lo = Infinity;
      for (let k = i; k <= j; k++) {
        const l = s.perpLow[k]!;
        if (l < lo) lo = l;
      }
      const b1 = btc[j]!;
      raw.push(r);
      btcAdj.push(Number.isNaN(b0) || Number.isNaN(b1) ? NaN : r - (b1 / b0 - 1));
      mae.push(Number.isFinite(lo) ? Math.min(0, lo / p0 - 1) : NaN);
      // Funding settling in (t, t + h]: the long enters just after the settlement at t and holds through t + h.
      fundingPaid.push(c[Math.min(i + h, hours - 1) + 1]! - c[i + 1]!);
    }

    out.push({
      symbol: s.symbol, base: s.base, venue: s.venue, time: t,
      funding8h, fundingZ,
      ret24h: p24 / p0 > 0 ? p0 / p24 - 1 : NaN,
      ret7d: p7d / p0 > 0 ? p0 / p7d - 1 : NaN,
      volumeRatio: weekN === 7 ? s.perpVol24[i]! / (weekVol / 7) : NaN,
      vol7d: vol ?? NaN,
      raw, btcAdj, mae, fundingPaid,
    });
  }
  return out;
}

export function collectObservations(ds: Dataset, o: StudyOptions): Observation[] {
  const out: Observation[] = [];
  for (const s of ds.symbols) for (const x of symbolObservations(s, ds.btcClose, o)) out.push(x);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Statistics

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export interface Stats {
  n: number;
  mean: number;
  median: number;
  hit: number;
  p5: number;
  p95: number;
}

export function stats(xs: number[]): Stats {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  const n = v.length;
  return {
    n,
    mean: n ? v.reduce((a, b) => a + b, 0) / n : NaN,
    median: quantile(v, 0.5),
    hit: n ? v.filter((x) => x > 0).length / n : NaN,
    p5: quantile(v, 0.05),
    p95: quantile(v, 0.95),
  };
}

/** Drop the top `frac` of outcomes (fat-tail check). */
export function trimTop(xs: number[], frac: number): number[] {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return v.slice(0, Math.max(0, v.length - Math.ceil(v.length * frac)));
}

/**
 * Independent episodes: observations on the same coin (any venue) less than `gapHours` apart belong to one
 * (coin, episode) cluster. Returns the cluster id per observation (input order).
 */
export function clusterIds(obs: Observation[], gapHours = 72): number[] {
  const order = obs.map((_, k) => k).sort((a, b) => obs[a]!.base.localeCompare(obs[b]!.base) || obs[a]!.time - obs[b]!.time);
  const ids = new Array<number>(obs.length);
  let id = -1;
  let prev: Observation | null = null;
  for (const k of order) {
    const x = obs[k]!;
    if (!prev || prev.base !== x.base || x.time - prev.time > gapHours * HOUR) id++;
    ids[k] = id;
    prev = x;
  }
  return ids;
}

/** Mean outcome per cluster, then stats over clusters: each episode counts once. */
export function clusterStats(obs: Observation[], value: (o: Observation) => number, gapHours = 72): Stats {
  const ids = clusterIds(obs, gapHours);
  const agg = new Map<number, { s: number; n: number }>();
  obs.forEach((o, k) => {
    const v = value(o);
    if (!Number.isFinite(v)) return;
    const a = agg.get(ids[k]!) ?? { s: 0, n: 0 };
    a.s += v;
    a.n++;
    agg.set(ids[k]!, a);
  });
  return stats([...agg.values()].map((a) => a.s / a.n));
}
