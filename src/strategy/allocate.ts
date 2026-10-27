import type { Allocation, Candidate, OpenPositionView, StrategyParams } from "./types.js";

/** Capital tied up per unit of notional: spot leg + perp margin. */
export function capitalPerNotional(leverage: number): number {
  return 1 + 1 / leverage;
}

/**
 * Strategy doc §2.5: rank by expected net income, respect max positions, per-position cap
 * and the USDT reserve. `equity` is total account equity; `freeCash` is unallocated USDT.
 */
export function allocate(
  candidates: Candidate[],
  open: OpenPositionView[],
  equity: number,
  freeCash: number,
  p: StrategyParams,
  minNotional = 100,
): Allocation[] {
  const held = new Set(open.map((o) => o.symbol));
  const slots = p.maxPositions - open.length;
  if (slots <= 0) return [];

  const reserve = equity * p.reserveFraction;
  let available = Math.max(0, freeCash - reserve);
  const perPositionCap = equity * p.maxPositionFraction;
  const cpn = capitalPerNotional(p.leverage);

  const ranked = candidates
    .filter((c) => !held.has(c.symbol) && c.expectedNetIncome > 0)
    .sort((a, b) => b.expectedNetIncome - a.expectedNetIncome)
    .slice(0, slots);

  const out: Allocation[] = [];
  for (const c of ranked) {
    const capital = Math.min(perPositionCap, available);
    const notional = capital / cpn;
    if (notional < minNotional) break;
    out.push({ symbol: c.symbol, notional });
    available -= capital;
  }
  return out;
}
