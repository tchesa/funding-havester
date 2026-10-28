import type { SpreadParams } from "../config/params.js";

/**
 * Cross-venue perp-perp funding spread (pure decision logic).
 * Short the coin's perp where funding is highest, long it where funding is lowest; price moves cancel,
 * the position earns the funding difference.
 */

/** One venue's perp for a coin at decision time. Rates are realized averages per 8h, observed before decision time. */
export interface SpreadLeg {
  symbol: string;
  venue: string;
  /** Realized funding average over the lookback window, per 8h. */
  avg8h: number;
  /** Realized funding average over the last 24h, per 8h. */
  recent8h: number;
  /** Fees + slippage to open and close this leg, as a fraction of notional. */
  roundTripCost: number;
}

export interface SpreadCandidate {
  base: string;
  short: SpreadLeg;
  long: SpreadLeg;
  /** Expected short-minus-long funding, per 8h. */
  spread8h: number;
  /** Expected spread income over the holding horizon minus both legs' round-trip cost (fraction of notional). */
  expectedNetIncome: number;
}

export function expectedRate8h(leg: SpreadLeg, p: SpreadParams): number {
  return (1 - p.recentWeight) * leg.avg8h + p.recentWeight * leg.recent8h;
}

export function expectedSpread8h(short: SpreadLeg, long: SpreadLeg, p: SpreadParams): number {
  return expectedRate8h(short, p) - expectedRate8h(long, p);
}

/** Best short/long venue pair for one coin, or null if it doesn't clear the entry and cost thresholds. */
export function bestPair(base: string, legs: SpreadLeg[], p: SpreadParams): SpreadCandidate | null {
  if (legs.length < 2) return null;
  let hi = legs[0]!;
  let lo = legs[0]!;
  for (const l of legs) {
    if (expectedRate8h(l, p) > expectedRate8h(hi, p)) hi = l;
    if (expectedRate8h(l, p) < expectedRate8h(lo, p)) lo = l;
  }
  if (hi.venue === lo.venue) return null;
  const spread8h = expectedSpread8h(hi, lo, p);
  if (spread8h < p.entryThreshold) return null;
  const income = (spread8h * p.expectedHoldingHours) / 8;
  const cost = hi.roundTripCost + lo.roundTripCost;
  if (income < p.safetyFactor * cost) return null;
  return { base, short: hi, long: lo, spread8h, expectedNetIncome: income - cost };
}

/** Exit when the spread of the held pair has faded below the exit threshold. */
export function shouldExitSpread(short: SpreadLeg, long: SpreadLeg, p: SpreadParams): boolean {
  return expectedSpread8h(short, long, p) < p.exitThreshold;
}

/** Capital (both legs' margin) per unit of notional per leg. */
export function spreadCapitalPerNotional(leverage: number): number {
  return 2 / leverage;
}
