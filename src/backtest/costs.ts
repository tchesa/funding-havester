import type { SimParams } from "../config/params.js";

export function spotFee(p: SimParams): number {
  return p.useBnb ? p.spotTakerFee * p.bnbDiscount : p.spotTakerFee;
}

/** Slippage fraction for one leg, one side: a + b·sqrt(notional / hourly quote volume). */
export function slippage(p: SimParams, notional: number, vol24: number): number {
  const hourly = vol24 / 24;
  if (!(hourly > 0)) return p.slippageMax; // no volume: assume the worst
  return Math.min(p.slippageMax, p.slippageA + p.slippageB * Math.sqrt(notional / hourly));
}

/** Round-trip cost (both legs, in and out) as a fraction of notional. */
export function roundTripCost(p: SimParams, notional: number, spotVol24: number, perpVol24: number): number {
  return 2 * spotFee(p) + 2 * p.perpTakerFee + 2 * slippage(p, notional, spotVol24) + 2 * slippage(p, notional, perpVol24);
}
