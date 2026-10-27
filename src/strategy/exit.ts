import { predicted8h, rollingAvg8h } from "./funding.js";
import type { ExitReason, StrategyParams, SymbolSnapshot } from "./types.js";

export interface ExitDecision {
  exit: boolean;
  reason: ExitReason;
  /** Exit before the upcoming funding (it would cost us) rather than right after it. */
  beforeFunding: boolean;
}

/**
 * Strategy doc §2.4. Stateless: "below exit threshold for n consecutive periods" is checked by
 * recomputing the k-period rolling average at each of the last n funding points.
 * Delisting/excluded symbols are handled here; volume filters only gate entries so a brief
 * volume dip doesn't churn positions.
 */
export function evaluateExit(s: SymbolSnapshot, p: StrategyParams): ExitDecision {
  const pred = predicted8h(s);
  const predNegative = pred !== null && pred < -p.negativeTolerance;

  if (s.excluded) return { exit: true, reason: "universe", beforeFunding: pred !== null && pred < 0 };
  if (predNegative) return { exit: true, reason: "predicted_negative", beforeFunding: true };

  const pts = s.recentRates;
  if (pts.length >= p.k + p.n - 1) {
    let below = 0;
    for (let i = pts.length - p.n; i < pts.length; i++) {
      const avg = rollingAvg8h(pts, i, p.k);
      if (avg !== null && avg < p.exitThreshold) below++;
    }
    if (below === p.n) return { exit: true, reason: "rolling_below_exit", beforeFunding: pred !== null && pred < 0 };
  }
  return { exit: false, reason: "hold", beforeFunding: false };
}
