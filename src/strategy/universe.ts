import type { StrategyParams, SymbolSnapshot } from "./types.js";

const DAY = 86_400_000;

export function passesUniverse(s: SymbolSnapshot, p: StrategyParams): boolean {
  if (s.excluded) return false;
  if (s.perpQuoteVolume24h < p.minPerpVolume24h) return false;
  if (s.spotQuoteVolume24h < p.minSpotVolume24h) return false;
  if (s.listedAt !== null && s.time - s.listedAt < p.minListingAgeDays * DAY) return false;
  if (p.universeTopN > 0 && (s.volumeRank === null || s.volumeRank > p.universeTopN)) return false;
  return true;
}
