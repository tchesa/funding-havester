import type { FundingPoint, StrategyParams, SymbolSnapshot } from "./types.js";

/** Normalize a raw rate for an N-hour interval to an 8h-equivalent rate. */
export function to8h(rate: number, intervalHours: number): number {
  return (rate * 8) / intervalHours;
}

/** Linearly weighted average (newest weighs most) of the last k rates, normalized to 8h. */
export function weightedAvg8h(points: FundingPoint[], k: number): number | null {
  const tail = points.slice(-k);
  if (!tail.length) return null;
  let num = 0;
  let den = 0;
  tail.forEach((p, i) => {
    const w = i + 1;
    num += w * to8h(p.rate, p.intervalHours);
    den += w;
  });
  return num / den;
}

/** Simple average of the k rates ending at index `end` (inclusive), normalized to 8h. */
export function rollingAvg8h(points: FundingPoint[], end: number, k: number): number | null {
  const start = end - k + 1;
  if (start < 0) return null;
  let sum = 0;
  for (let i = start; i <= end; i++) sum += to8h(points[i]!.rate, points[i]!.intervalHours);
  return sum / k;
}

/** Predicted rate normalized to 8h, falling back to the latest realized rate. */
export function predicted8h(s: SymbolSnapshot): number | null {
  if (s.predictedRate !== null) return to8h(s.predictedRate, s.intervalHours);
  const last = s.recentRates.at(-1);
  return last ? to8h(last.rate, last.intervalHours) : null;
}

/** Blend of weighted realized history and the predicted rate, per 8h. */
export function expectedFundingPer8h(s: SymbolSnapshot, p: StrategyParams): number | null {
  const hist = weightedAvg8h(s.recentRates, p.k);
  const pred = predicted8h(s);
  if (hist === null) return pred;
  if (pred === null) return hist;
  return (1 - p.predictedWeight) * hist + p.predictedWeight * pred;
}

export const DEFAULT_INTEREST_8H = 0.0001;
export const INTEREST_CLAMP_8H = 0.0005;

/**
 * Reconstruct Binance's funding rate for one interval from premium index samples:
 *   F = clamp( P + clamp(I − P, ±0.05%), ±cap )   (8h terms), scaled by intervalHours/8.
 * `premiums` are samples from the current interval (oldest → newest); Binance weights later samples more.
 */
export function predictFundingRate(premiums: number[], intervalHours: number, cap = 0.03): number | null {
  if (!premiums.length) return null;
  let num = 0;
  let den = 0;
  premiums.forEach((p, i) => {
    num += (i + 1) * p;
    den += i + 1;
  });
  const P = num / den;
  const f8 = P + clamp(DEFAULT_INTEREST_8H - P, -INTEREST_CLAMP_8H, INTEREST_CLAMP_8H);
  return clamp((f8 * intervalHours) / 8, -cap, cap);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
