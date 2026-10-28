import { describe, expect, it } from "vitest";
import {
  allocate, evaluateEntry, evaluateExit, expectedFundingPer8h, predictFundingRate, to8h, weightedAvg8h,
} from "../src/strategy/index.js";
import { params, snap, T0 } from "./helpers.js";

const H = 3_600_000;
const pts = (rates: number[], interval = 8) => rates.map((rate, i) => ({ time: T0 + i * interval * H, rate, intervalHours: interval }));

describe("funding math", () => {
  it("normalizes rates across intervals to 8h", () => {
    expect(to8h(0.0001, 8)).toBeCloseTo(0.0001);
    expect(to8h(0.0001, 4)).toBeCloseTo(0.0002);
    expect(to8h(0.0001, 1)).toBeCloseTo(0.0008);
  });

  it("weights recent rates more", () => {
    // weights 1,2 → (0 + 2·0.0003)/3
    expect(weightedAvg8h(pts([0.0009, 0, 0.0003]), 2)).toBeCloseTo(0.0002);
  });

  it("blends history with the predicted rate", () => {
    const s = snap({ recentRates: pts([0.0002, 0.0002]), predictedRate: 0.0004 });
    expect(expectedFundingPer8h(s, params({ predictedWeight: 0.5 }))).toBeCloseTo(0.0003);
  });

  it("reconstructs Binance funding from premium index", () => {
    expect(predictFundingRate([0, 0, 0], 8)).toBeCloseTo(0.0001); // interest only
    expect(predictFundingRate([0.001], 8)).toBeCloseTo(0.0005); // 0.001 + clamp(-0.0009) = 0.0005
    expect(predictFundingRate([0.001], 4)).toBeCloseTo(0.00025);
    expect(predictFundingRate([0.5], 8, 0.02)).toBeCloseTo(0.02); // capped
    expect(predictFundingRate([], 8)).toBeNull();
  });
});

describe("entry rule", () => {
  const p = params();
  it("enters a strong, persistent, well-traded rate", () => {
    const d = evaluateEntry(snap(), p);
    expect(d).toMatchObject({ enter: true, reason: "ok" });
    expect(d.candidate!.expectedNetIncome).toBeCloseTo(0.0003 * 30 - 0.003);
  });
  it("rejects thin volume and new listings", () => {
    expect(evaluateEntry(snap({ perpQuoteVolume24h: 1e6 }), p).reason).toBe("universe");
    expect(evaluateEntry(snap({ listedAt: T0 + 90 * 86_400_000 }), p).reason).toBe("universe");
    expect(evaluateEntry(snap({ excluded: true }), p).reason).toBe("universe");
  });
  it("rejects a low predicted rate", () => {
    expect(evaluateEntry(snap({ predictedRate: 0.0001 }), p).reason).toBe("predicted_below_threshold");
  });
  it("rejects when the positive streak is broken", () => {
    const rates = pts([...Array(10).fill(0.0003), -0.0001, 0.0003]);
    expect(evaluateEntry(snap({ recentRates: rates }), p).reason).toBe("streak_broken");
  });
  it("rejects when expected income doesn't beat cost × safety", () => {
    expect(evaluateEntry(snap({ roundTripCost: 0.01 }), p).reason).toBe("income_below_cost");
  });
});

describe("exit rule", () => {
  const p = params({ k: 3, n: 2, exitThreshold: 0.00005 });
  it("holds while funding is healthy", () => {
    expect(evaluateExit(snap(), p)).toMatchObject({ exit: false, reason: "hold" });
  });
  it("exits immediately (before funding) on a negative predicted rate", () => {
    expect(evaluateExit(snap({ predictedRate: -0.0005 }), p)).toMatchObject({ exit: true, reason: "predicted_negative", beforeFunding: true });
  });
  it("exits after funding when the rolling average stays low for n periods", () => {
    const s = snap({ recentRates: pts([0.0003, 0.0003, 0, 0, 0, 0]), predictedRate: 0.00001 });
    expect(evaluateExit(s, p)).toMatchObject({ exit: true, reason: "rolling_below_exit", beforeFunding: false });
  });
  it("needs n consecutive low periods", () => {
    // rolling(3) at last two points: (0.0003+0+0)/3=0.0001 (not low), (0+0+0)=0 (low)
    const s = snap({ recentRates: pts([0.0003, 0.0003, 0.0003, 0, 0]), predictedRate: 0.00001 });
    expect(evaluateExit(s, p).exit).toBe(false);
  });
  it("exits on delisting", () => {
    expect(evaluateExit(snap({ excluded: true }), p)).toMatchObject({ exit: true, reason: "universe" });
  });
});

describe("allocation", () => {
  const c = (symbol: string, expectedNetIncome: number) => ({ symbol, expectedPer8h: 0, expectedNetIncome });
  it("ranks by expected net income and respects max positions", () => {
    const out = allocate([c("A", 0.01), c("B", 0.03), c("C", 0.02)], [], 10_000, 10_000, params({ maxPositions: 2 }));
    expect(out.map((a) => a.symbol)).toEqual(["B", "C"]);
  });
  it("caps each position and keeps the reserve", () => {
    const p = params({ maxPositions: 5, maxPositionFraction: 0.25, reserveFraction: 0.1, leverage: 1 });
    const out = allocate([c("A", 3), c("B", 2), c("C", 1), c("D", 1), c("E", 1)], [], 10_000, 10_000, p);
    // 25% cap = 2500 capital → 1250 notional at 1x; 9000 deployable → 3 full + 1500 left → 750 notional
    expect(out.map((a) => Math.round(a.notional))).toEqual([1250, 1250, 1250, 750]);
  });
  it("skips held symbols and negative candidates", () => {
    const out = allocate([c("A", 1), c("B", -1)], [{ symbol: "A", capitalUsed: 1 }], 10_000, 5_000, params());
    expect(out).toEqual([]);
  });
});

describe("entry filters (cooldown, rate cap, top-N universe)", () => {
  it("blocks entries during a cooldown and allows them after", () => {
    const s = snap();
    expect(evaluateEntry({ ...s, cooldownUntil: s.time + 1 }, params()).reason).toBe("cooldown");
    expect(evaluateEntry({ ...s, cooldownUntil: s.time }, params()).enter).toBe(true);
  });

  it("skips symbols whose predicted or recent funding is extreme", () => {
    const p = params({ maxEntryRate8h: 0.001 });
    expect(evaluateEntry(snap({ predictedRate: 0.002 }), p).reason).toBe("rate_too_high");
    const spiky = snap();
    spiky.recentRates = spiky.recentRates.map((r, i, a) => (i === a.length - 1 ? { ...r, rate: 0.0015 } : r));
    expect(evaluateEntry(spiky, p).reason).toBe("rate_too_high");
    // a 1h-interval rate of 0.0002 is 0.0016 per 8h
    expect(evaluateEntry(snap({ predictedRate: 0.0002, intervalHours: 1 }), p).reason).toBe("rate_too_high");
    expect(evaluateEntry(snap(), p).enter).toBe(true);
  });

  it("restricts the universe to the top-N by volume rank", () => {
    const p = params({ universeTopN: 10 });
    expect(evaluateEntry(snap({ volumeRank: 10 }), p).enter).toBe(true);
    expect(evaluateEntry(snap({ volumeRank: 11 }), p).reason).toBe("universe");
    expect(evaluateEntry(snap({ volumeRank: null }), p).reason).toBe("universe");
    expect(evaluateEntry(snap({ volumeRank: 50 }), params()).enter).toBe(true);
  });
});

describe("volatility filter", () => {
  it("blocks entries above the volatility cap and when volatility is unknown", () => {
    const p = params({ maxEntryVolatility: 1 });
    expect(evaluateEntry(snap({ volatility: 0.8 }), p).enter).toBe(true);
    expect(evaluateEntry(snap({ volatility: 1.2 }), p).reason).toBe("too_volatile");
    expect(evaluateEntry(snap({ volatility: null }), p).reason).toBe("too_volatile");
    expect(evaluateEntry(snap({ volatility: 5 }), params()).enter).toBe(true);
  });
});
