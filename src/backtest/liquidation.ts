/**
 * Isolated-margin short: liquidated when unrealized loss eats margin down to maintenance:
 *   qty·(P − entry) ≥ margin − mmr·qty·P   ⇒   P_liq = (margin/qty + entry) / (1 + mmr)
 * At leverage L with margin = qty·entry/L this is entry·(1 + 1/L)/(1 + mmr).
 */
export function shortLiquidationPrice(entry: number, qty: number, margin: number, mmr: number): number {
  return (margin / qty + entry) / (1 + mmr);
}

/** Price at which we act to protect margin: `buffer` of the way from entry to liquidation remains. */
export function marginTriggerPrice(entry: number, liq: number, buffer: number): number {
  return entry + (liq - entry) * (1 - buffer);
}

/** Margin needed so that, at current price P, the short again sits at leverage L (covers unrealized loss). */
export function targetMargin(entry: number, qty: number, price: number, leverage: number): number {
  return qty * Math.max(0, price - entry) + (qty * price) / leverage;
}
