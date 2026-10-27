import { z } from "zod";

/** Strategy params (strategy doc §2.6). Rates are fractions per 8h (0.0001 = 0.01%). */
export const strategyParamsSchema = z.object({
  k: z.number().int().positive().default(9),
  m: z.number().int().nonnegative().default(6),
  n: z.number().int().positive().default(3),
  entryThreshold: z.number().default(0.00015),
  exitThreshold: z.number().default(0.00005),
  /** Exit when predicted rate < -negativeTolerance. */
  negativeTolerance: z.number().nonnegative().default(0.0001),
  /** Blend weight on the predicted rate vs. the realized average (0..1). */
  predictedWeight: z.number().min(0).max(1).default(0.3),
  safetyFactor: z.number().positive().default(1.5),
  expectedHoldingPeriods: z.number().positive().default(30),
  leverage: z.number().min(1).max(2).default(1),
  maxPositions: z.number().int().positive().default(3),
  maxPositionFraction: z.number().positive().max(1).default(0.25),
  reserveFraction: z.number().min(0).max(1).default(0.1),
  minPerpVolume24h: z.number().nonnegative().default(50_000_000),
  minSpotVolume24h: z.number().nonnegative().default(20_000_000),
  minListingAgeDays: z.number().nonnegative().default(30),
});
export type StrategyParams = z.infer<typeof strategyParamsSchema>;

/** Cost and risk model used by the simulator (not by strategy decisions). */
export const simParamsSchema = z.object({
  initialCapital: z.number().positive().default(10_000),
  spotTakerFee: z.number().nonnegative().default(0.001),
  perpTakerFee: z.number().nonnegative().default(0.0005),
  /** Multiplier on spot fee when paying in BNB (0.75 = 25% off). */
  bnbDiscount: z.number().positive().max(1).default(0.75),
  useBnb: z.boolean().default(true),
  /** Slippage per leg per side, as a fraction: a + b * sqrt(notional / hourlyQuoteVolume). */
  slippageA: z.number().nonnegative().default(0.0002),
  slippageB: z.number().nonnegative().default(0.01),
  /** Hard cap on slippage per leg per side (thin/illiquid markets). */
  slippageMax: z.number().positive().default(0.03),
  maintenanceMarginRate: z.number().nonnegative().default(0.005),
  /** Top up / rebalance when price is within this fraction of the liquidation price. */
  marginBufferTrigger: z.number().positive().default(0.3),
});
export type SimParams = z.infer<typeof simParamsSchema>;

/** Phase 0 go/no-go thresholds. */
export const goCriteriaSchema = z.object({
  minNetApr: z.number().default(0.08),
  /** Max standard deviation of out-of-sample APR across walk-forward windows. */
  maxAprStdDev: z.number().default(0.1),
  /** Minimum share of OOS windows with positive net APR. */
  minPositiveWindowShare: z.number().default(0.75),
  maxLiquidations: z.number().int().default(0),
});
export type GoCriteria = z.infer<typeof goCriteriaSchema>;

export const defaultStrategyParams = (): StrategyParams => strategyParamsSchema.parse({});
export const defaultSimParams = (): SimParams => simParamsSchema.parse({});
export const defaultGoCriteria = (): GoCriteria => goCriteriaSchema.parse({});

/** Bases excluded from the universe: stablecoins, wrapped/pegged assets. */
export const EXCLUDED_BASES = new Set([
  "USDC", "BUSD", "TUSD", "USDP", "FDUSD", "DAI", "USDE", "USD1", "PYUSD", "EUR", "EURI", "AEUR", "UST", "USTC",
  "WBTC", "WBETH", "BFUSD", "XUSD", "RLUSD",
]);
