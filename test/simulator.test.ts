import { describe, expect, it } from "vitest";
import { defaultSimParams, type SimParams } from "../src/config/params.js";
import { HOUR } from "../src/data/parse.js";
import { realizedVol, simulate } from "../src/backtest/simulator.js";
import { shortLiquidationPrice } from "../src/backtest/liquidation.js";
import { params, synthDataset, synthSeries, T0 } from "./helpers.js";

const free: SimParams = { ...defaultSimParams(), spotTakerFee: 0, perpTakerFee: 0, slippageA: 0, slippageB: 0 };
const at = (i: number) => T0 + i * HOUR;

describe("simulator accounting", () => {
  it("earns exactly N × rate × notional with no costs on flat prices", () => {
    const hours = 24 * 30;
    const ds = synthDataset([synthSeries({ hours })], hours);
    // Open at hour 4 (between fundings); fundings at 8, 16, ..., 712 (89 payments) before closing at hour 716.
    const r = simulate(ds, { strategy: params(), sim: free, from: at(4), to: at(716), alwaysOn: ["TESTUSDT"] });
    const t = r.trades[0]!;
    expect(t.payments).toBe(89);
    expect(t.funding).toBeCloseTo(89 * 0.0001 * t.notional, 6);
    expect(t.basis).toBeCloseTo(0, 8);
    expect(r.equity.at(-1)).toBeCloseTo(free.initialCapital + t.funding, 6);
  });

  it("does not pay the funding at the entry hour itself", () => {
    const hours = 48;
    const ds = synthDataset([synthSeries({ hours })], hours);
    const r = simulate(ds, { strategy: params(), sim: free, from: at(8), to: at(20), alwaysOn: ["TESTUSDT"] });
    expect(r.trades[0]!.payments).toBe(1); // only hour 16
  });

  it("charges fees and slippage once per leg per side", () => {
    const hours = 48;
    const sim: SimParams = { ...free, spotTakerFee: 0.001, useBnb: false, perpTakerFee: 0.0005, slippageA: 0.0002 };
    const ds = synthDataset([synthSeries({ hours, rate: () => 0 })], hours);
    const r = simulate(ds, { strategy: params(), sim, from: at(2), to: at(20), alwaysOn: ["TESTUSDT"] });
    const t = r.trades[0]!;
    expect(t.fees).toBeCloseTo(2 * t.notional * (0.001 + 0.0005), 6);
    expect(t.slippage).toBeCloseTo(4 * t.notional * 0.0002, 6);
  });

  it("liquidates a +60% wick at 2x but not at 1x", () => {
    const hours = 72;
    const mk = () => synthDataset([synthSeries({ hours, high: (i) => (i === 30 ? 160 : 100) })], hours);
    const at2 = simulate(mk(), { strategy: params({ leverage: 2 }), sim: free, from: at(2), to: at(60), alwaysOn: ["TESTUSDT"] });
    const at1 = simulate(mk(), { strategy: params({ leverage: 1 }), sim: free, from: at(2), to: at(60), alwaysOn: ["TESTUSDT"] });
    expect(at2.trades[0]!.liquidated).toBe(true);
    expect(at1.trades[0]!.liquidated).toBe(false);
    expect(shortLiquidationPrice(100, 1, 50, 0.005)).toBeCloseTo(150 / 1.005);
  });

  it("tops up margin from cash on a sustained rally instead of being liquidated", () => {
    const hours = 24 * 10;
    // Price ramps from 100 to 190 over 9 days; the 1x short would liquidate near 199 without top-ups.
    const price = (i: number) => 100 + Math.min(i, 216) * (90 / 216);
    const ds = synthDataset([synthSeries({ hours, price, high: (i) => price(i) * 1.01 })], hours);
    const r = simulate(ds, { strategy: params({ leverage: 1 }), sim: free, from: at(2), to: at(230), alwaysOn: ["TESTUSDT"] });
    expect(r.events.some((e) => e.type === "topup")).toBe(true);
    expect(r.trades.every((t) => !t.liquidated)).toBe(true);
    // Delta neutral: equity ≈ initial + funding
    expect(r.equity.at(-1)! / free.initialCapital).toBeGreaterThan(0.999);
  });
});

describe("simulator strategy loop", () => {
  it("enters on persistent positive funding and exits when it turns negative", () => {
    const hours = 24 * 40;
    // 0.03%/8h for 25 days, then -0.05% with negative premium.
    const flip = 24 * 25;
    const s = synthSeries({
      hours,
      rate: (i) => (i < flip ? 0.0003 : -0.0005),
      premium: (i) => (i < flip ? 0.0008 : -0.002), // 0.0008 premium → 0.03% predicted after the interest clamp
    });
    const ds = synthDataset([s], hours);
    const r = simulate(ds, { strategy: params({ maxPositions: 1 }), sim: defaultSimParams(), from: at(24 * 3), to: at(hours - 2) });
    expect(r.trades.length).toBe(1);
    const t = r.trades[0]!;
    expect(t.exitReason).toBe("predicted_negative");
    expect(t.closeTime).toBeGreaterThanOrEqual(at(flip));
    expect(t.closeTime).toBeLessThan(at(flip + 24));
    expect(t.funding).toBeGreaterThan(0);
  });
});

describe("simulator robustness", () => {
  it("exits cleanly at the last known price when the spot market stops trading", () => {
    const hours = 24 * 40;
    const s = synthSeries({ hours, rate: () => 0.0003, premium: () => 0.0008 });
    for (let i = 24 * 20; i < hours; i++) s.spotClose[i] = NaN; // spot delisted on day 20
    const r = simulate(synthDataset([s], hours), { strategy: params(), sim: defaultSimParams(), from: at(24 * 3), to: at(hours - 2) });
    expect(r.trades.length).toBe(1);
    expect(r.trades[0]!.exitReason).toBe("universe");
    expect(r.equity.every((e) => Number.isFinite(e))).toBe(true);
  });
});

describe("cost model", () => {
  it("caps slippage on vanishing volume", async () => {
    const { slippage } = await import("../src/backtest/costs.js");
    const sim = defaultSimParams();
    expect(slippage(sim, 1000, 1e-7)).toBe(sim.slippageMax);
    expect(slippage(sim, 1000, 0)).toBe(sim.slippageMax);
    expect(slippage(sim, 1000, 24e6)).toBeCloseTo(sim.slippageA + sim.slippageB * Math.sqrt(1000 / 1e6));
  });
});

describe("simulator entry filters", () => {
  it("waits out the re-entry cooldown after a liquidation", () => {
    const hours = 24 * 60;
    const wick = 24 * 10 + 3;
    const s = synthSeries({ hours, rate: () => 0.0003, premium: () => 0.0008, high: (i) => (i === wick ? 300 : 100) });
    const run = (reentryCooldownHours: number) =>
      simulate(synthDataset([s], hours), {
        strategy: params({ leverage: 2, reentryCooldownHours }), sim: defaultSimParams(), from: at(24 * 3), to: at(hours - 2),
      });
    const noCd = run(0);
    expect(noCd.trades[0]!.exitReason).toBe("liquidation");
    expect(noCd.trades[1]!.openTime).toBeLessThan(at(wick + 24));
    const cd = run(24 * 14);
    expect(cd.trades[0]!.exitReason).toBe("liquidation");
    expect(cd.trades[1]!.openTime).toBeGreaterThanOrEqual(at(wick + 1 + 24 * 14));
  });

  it("ranks symbols by min(perp, spot) volume for the top-N universe", () => {
    const hours = 24 * 20;
    const big = synthSeries({ symbol: "BIGUSDT", hours, rate: () => 0.0003, premium: () => 0.0008, vol24: 1e12 });
    const small = synthSeries({ symbol: "SMALLUSDT", hours, rate: () => 0.0003, premium: () => 0.0008, vol24: 1e11 });
    const r = simulate(synthDataset([small, big], hours), {
      strategy: params({ universeTopN: 1, maxPositions: 2 }), sim: defaultSimParams(), from: at(24 * 3), to: at(hours - 2),
    });
    expect(new Set(r.trades.map((t) => t.symbol))).toEqual(new Set(["BIGUSDT"]));
  });
});

describe("realized volatility", () => {
  it("is zero for a flat series and matches a known alternating series", () => {
    expect(realizedVol(new Float64Array(200).fill(100), 200, 168)).toBe(0);
    const alt = Float64Array.from({ length: 200 }, (_, i) => (i % 2 ? 101 : 100));
    const r = Math.log(1.01);
    expect(realizedVol(alt, 200, 168)).toBeCloseTo(r * Math.sqrt(8760), 6);
    expect(realizedVol(new Float64Array(200).fill(NaN), 200, 168)).toBeNull();
  });
});

describe("multi-venue", () => {
  it("charges each venue's own fees", () => {
    const hours = 24 * 10;
    const s = synthSeries({ symbol: "bybit:TESTUSDT", venue: "bybit", hours });
    const sim: SimParams = { ...defaultSimParams(), slippageA: 0, slippageB: 0, venueFees: { bybit: { spot: 0.002, perp: 0.001 } } };
    const r = simulate(synthDataset([s], hours), { strategy: params(), sim, from: at(24), to: at(hours - 2), alwaysOn: ["bybit:TESTUSDT"] });
    const t = r.trades[0]!;
    expect(t.fees).toBeCloseTo(2 * t.notional * (0.002 + 0.001), 6);
  });

  it("holds at most one position per coin across venues", () => {
    const hours = 24 * 20;
    const mk = (symbol: string, venue: string) =>
      synthSeries({ symbol, venue, base: "TEST", hours, rate: () => 0.0003, premium: () => 0.0008 });
    const ds = synthDataset([mk("TESTUSDT", "binance"), mk("bybit:TESTUSDT", "bybit")], hours);
    const r = simulate(ds, { strategy: params({ maxPositions: 3 }), sim: defaultSimParams(), from: at(24 * 3), to: at(hours - 2) });
    expect(r.trades.length).toBe(1);
    expect(Math.max(...r.openCount)).toBe(1);
    // Binance is cheaper (BNB discount), so it wins the tie on expected net income.
    expect(r.trades[0]!.symbol).toBe("TESTUSDT");
  });
});
