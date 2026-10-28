import type { Dataset, SymbolSeries } from "../src/data/loaders.js";
import { HOUR } from "../src/data/parse.js";
import type { StrategyParams, SymbolSnapshot } from "../src/strategy/types.js";
import { defaultStrategyParams } from "../src/config/params.js";

export const T0 = Date.UTC(2024, 0, 1);

export interface SynthOpts {
  symbol?: string;
  hours: number;
  price?: (i: number) => number;
  high?: (i: number) => number;
  /** Funding rate at funding hour index i (every `interval` hours). */
  rate?: (i: number) => number;
  interval?: number;
  vol24?: number;
  premium?: (i: number) => number;
  venue?: string;
  base?: string;
}

export function synthSeries(o: SynthOpts): SymbolSeries {
  const n = o.hours;
  const price = o.price ?? (() => 100);
  const interval = o.interval ?? 8;
  const s: SymbolSeries = {
    symbol: o.symbol ?? "TESTUSDT",
    venue: o.venue ?? "binance",
    base: o.base ?? (o.symbol ?? "TESTUSDT").replace(/USDT$/, "").replace(/^.*:/, ""),
    perpClose: new Float64Array(n),
    perpHigh: new Float64Array(n),
    spotClose: new Float64Array(n),
    spotHigh: new Float64Array(n),
    premClose: new Float64Array(n),
    perpVol24: new Float64Array(n).fill(o.vol24 ?? 1e12),
    spotVol24: new Float64Array(n).fill(o.vol24 ?? 1e12),
    fundingRate: new Float64Array(n).fill(NaN),
    fundingInterval: new Uint8Array(n),
    t0: T0,
    fundingIdx: new Int32Array(0),
    firstIdx: 0,
    lastIdx: n - 1,
    listedAt: null,
    delistedAt: null,
  };
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    s.perpClose[i] = price(i);
    s.spotClose[i] = price(i);
    s.perpHigh[i] = o.high ? o.high(i) : price(i);
    s.spotHigh[i] = o.high ? o.high(i) : price(i);
    s.premClose[i] = o.premium ? o.premium(i) : 0;
    if (i % interval === 0) {
      const r = o.rate ? o.rate(i) : 0.0001;
      s.fundingRate[i] = r;
      s.fundingInterval[i] = interval;
      idx.push(i);
    }
  }
  s.fundingIdx = Int32Array.from(idx);
  return s;
}

export function synthDataset(series: SymbolSeries[], hours: number): Dataset {
  return { t0: T0, hours, symbols: series, btcClose: series[0]!.perpClose };
}

export function params(over: Partial<StrategyParams> = {}): StrategyParams {
  return { ...defaultStrategyParams(), ...over };
}

export function snap(over: Partial<SymbolSnapshot> = {}): SymbolSnapshot {
  return {
    symbol: "TESTUSDT",
    time: T0 + 100 * 86_400_000,
    recentRates: Array.from({ length: 12 }, (_, i) => ({ time: T0 + i * 8 * HOUR, rate: 0.0003, intervalHours: 8 })),
    predictedRate: 0.0003,
    intervalHours: 8,
    perpQuoteVolume24h: 1e9,
    spotQuoteVolume24h: 1e9,
    listedAt: null,
    excluded: false,
    roundTripCost: 0.003,
    cooldownUntil: null,
    volumeRank: null,
    volatility: null,
    ...over,
  };
}
