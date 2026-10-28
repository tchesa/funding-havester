import type { StrategyParams } from "../config/params.js";

export type { StrategyParams };

/** A realized funding payment. `rate` is the raw rate for its interval. */
export interface FundingPoint {
  time: number;
  rate: number;
  intervalHours: number;
}

/**
 * Everything the strategy may know about a symbol at decision time `time`.
 * Callers must only put data observable before `time` in here (no lookahead).
 */
export interface SymbolSnapshot {
  symbol: string;
  time: number;
  /** Realized funding, oldest → newest, all strictly before `time`. */
  recentRates: FundingPoint[];
  /** Predicted rate for the upcoming funding (raw, for `intervalHours`), or null if unknown. */
  predictedRate: number | null;
  intervalHours: number;
  perpQuoteVolume24h: number;
  spotQuoteVolume24h: number;
  /** First time this perp traded; null if older than the available history. */
  listedAt: number | null;
  /** Delisting notice, manual exclusion, missing data, etc. */
  excluded: boolean;
  /** Estimated round-trip cost as a fraction of notional (fees + slippage, both legs, in and out). */
  roundTripCost: number;
  /** Entries are blocked before this time (cooldown after a forced exit); null = none. */
  cooldownUntil: number | null;
  /** 1-based rank by min(perp, spot) 24h volume among tradable symbols; null if unknown. */
  volumeRank: number | null;
  /** Annualized realized volatility of hourly perp returns; null if not computed. */
  volatility: number | null;
}

export type EntryReason = "ok" | "universe" | "predicted_below_threshold" | "streak_broken" | "income_below_cost" | "no_data" | "cooldown" | "rate_too_high" | "too_volatile";
export type ExitReason = "hold" | "rolling_below_exit" | "predicted_negative" | "universe";

/** Exits that should trigger a re-entry cooldown (anything other than funding fading normally). */
export const FORCED_EXITS: ReadonlySet<string> = new Set(["liquidation", "margin_reduce", "predicted_negative", "universe", "data_end"]);

export interface Candidate {
  symbol: string;
  expectedPer8h: number;
  /** Expected funding over the holding horizon minus round-trip cost (fraction of notional). */
  expectedNetIncome: number;
}

export interface OpenPositionView {
  symbol: string;
  /** Capital tied up: spot notional + perp margin. */
  capitalUsed: number;
}

export interface Allocation {
  symbol: string;
  /** Target notional of each leg. */
  notional: number;
}
