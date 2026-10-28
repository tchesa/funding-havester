import { describe, expect, it } from "vitest";
import { defaultSimParams, defaultSpreadParams, type SimParams, type SpreadParams } from "../src/config/params.js";
import { HOUR } from "../src/data/parse.js";
import { simulateSpread } from "../src/backtest/spread-sim.js";
import { longLiquidationPrice } from "../src/backtest/liquidation.js";
import { bestPair, type SpreadLeg } from "../src/strategy/spread.js";
import { synthDataset, synthSeries, T0 } from "./helpers.js";

const free: SimParams = {
  ...defaultSimParams(), spotTakerFee: 0, perpTakerFee: 0, slippageA: 0, slippageB: 0,
  venueFees: { bybit: { spot: 0, perp: 0 }, okx: { spot: 0, perp: 0 } },
};
const at = (i: number) => T0 + i * HOUR;
const sp = (o: Partial<SpreadParams> = {}): SpreadParams => ({ ...defaultSpreadParams(), minPerpVolume24h: 0, minListingAgeDays: 0, ...o });
const leg = (venue: string, avg8h: number, roundTripCost = 0): SpreadLeg => ({ symbol: `${venue}:X`, venue, avg8h, recent8h: avg8h, roundTripCost });

describe("spread pair selection", () => {
  it("shorts the highest-funding venue and longs the lowest", () => {
    const c = bestPair("X", [leg("binance", 0.0001), leg("bybit", 0.0004), leg("okx", -0.0001)], sp({ entryThreshold: 0.0001 }))!;
    expect(c.short.venue).toBe("bybit");
    expect(c.long.venue).toBe("okx");
    expect(c.spread8h).toBeCloseTo(0.0005, 10);
  });

  it("rejects spreads below the entry threshold or that don't cover costs", () => {
    expect(bestPair("X", [leg("binance", 0.0001), leg("bybit", 0.00015)], sp({ entryThreshold: 0.0001 }))).toBeNull();
    // 0.0002/8h over 240h = 0.6% income vs 2 × 0.4% cost × safety 1.5
    expect(bestPair("X", [leg("binance", 0, 0.004), leg("bybit", 0.0002, 0.004)], sp({ entryThreshold: 0.0001 }))).toBeNull();
  });
});

describe("spread simulator", () => {
  it("earns exactly the funding difference with no costs on flat prices", () => {
    const hours = 24 * 30;
    const a = synthSeries({ hours, symbol: "XUSDT", base: "X", rate: () => 0.0003 });
    const b = synthSeries({ hours, symbol: "bybit:XUSDT", venue: "bybit", base: "X", rate: () => 0.0001 });
    const ds = synthDataset([a, b], hours);
    const r = simulateSpread(ds, { strategy: sp({ lookbackHours: 72 }), sim: free, from: at(1), to: at(716) });
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0]!;
    expect(t.symbol).toBe("X:binance/bybit");
    // Opened at hour 72 (after its funding), paid at 80..712 on both legs.
    expect(t.payments).toBe(160);
    expect(t.funding).toBeCloseTo(80 * 0.0002 * t.notional, 6);
    expect(t.basis).toBeCloseTo(0, 8);
    expect(r.equity.at(-1)).toBeCloseTo(free.initialCapital + t.funding, 6);
  });

  it("liquidates the long leg on a crash when no cash is left for top-ups", () => {
    const hours = 24 * 10;
    const a = synthSeries({ hours, symbol: "XUSDT", base: "X", rate: () => 0.0005 });
    const b = synthSeries({ hours, symbol: "bybit:XUSDT", venue: "bybit", base: "X", rate: () => 0, low: (i) => (i === 100 ? 40 : 100) });
    const ds = synthDataset([a, b], hours);
    const strategy = sp({ lookbackHours: 24, leverage: 2, reserveFraction: 0, maxPositionFraction: 1 });
    const r = simulateSpread(ds, { strategy, sim: free, from: at(1), to: at(200) });
    const t = r.trades[0]!;
    expect(t.liquidated).toBe(true);
    expect(t.closeTime).toBe(at(101));
    // Long margin (notional / 2) is lost; the short closes flat.
    expect(t.basis).toBeCloseTo(-t.notional / 2, 4);
  });

  it("computes the long liquidation price", () => {
    // 2x long from 100: margin 50 per unit → (100 − 50) / (1 − 0.005)
    expect(longLiquidationPrice(100, 1, 50, 0.005)).toBeCloseTo(50 / 0.995, 8);
  });
});
