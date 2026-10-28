import { expectedFundingPer8h, predicted8h, to8h } from "./funding.js";
import type { Candidate, EntryReason, StrategyParams, SymbolSnapshot } from "./types.js";
import { passesUniverse } from "./universe.js";

export interface EntryDecision {
  enter: boolean;
  reason: EntryReason;
  candidate: Candidate | null;
}

/** Strategy doc §2.3. */
export function evaluateEntry(s: SymbolSnapshot, p: StrategyParams): EntryDecision {
  if (!passesUniverse(s, p)) return { enter: false, reason: "universe", candidate: null };
  if (s.cooldownUntil !== null && s.time < s.cooldownUntil) return { enter: false, reason: "cooldown", candidate: null };
  if (p.maxEntryVolatility > 0 && (s.volatility === null || s.volatility > p.maxEntryVolatility)) {
    return { enter: false, reason: "too_volatile", candidate: null };
  }

  const expected = expectedFundingPer8h(s, p);
  const pred = predicted8h(s);
  if (expected === null || pred === null || s.recentRates.length < Math.max(p.m, 1)) {
    return { enter: false, reason: "no_data", candidate: null };
  }

  const candidate: Candidate = {
    symbol: s.symbol,
    expectedPer8h: expected,
    expectedNetIncome: expected * p.expectedHoldingPeriods - s.roundTripCost,
  };

  if (pred <= p.entryThreshold) return { enter: false, reason: "predicted_below_threshold", candidate };
  if (p.maxEntryRate8h > 0) {
    const recentMax = Math.max(...s.recentRates.slice(-Math.max(p.m, 1)).map((r) => to8h(r.rate, r.intervalHours)));
    if (pred > p.maxEntryRate8h || recentMax > p.maxEntryRate8h) return { enter: false, reason: "rate_too_high", candidate };
  }
  const streak = s.recentRates.slice(-p.m);
  if (streak.some((r) => r.rate <= 0)) return { enter: false, reason: "streak_broken", candidate };
  if (expected * p.expectedHoldingPeriods <= s.roundTripCost * p.safetyFactor) {
    return { enter: false, reason: "income_below_cost", candidate };
  }
  return { enter: true, reason: "ok", candidate };
}
