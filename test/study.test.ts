import { describe, expect, it } from "vitest";
import { HOUR } from "../src/data/parse.js";
import { clusterIds, HORIZONS, symbolObservations, stats, trimTop } from "../src/research/eventStudy.js";
import { synthSeries, T0 } from "./helpers.js";

const hours = 24 * 60;
const opts = { minPerpVolume24h: 0, minListingAgeDays: 0, delistNoticeHours: 168, from: T0, to: T0 + hours * HOUR };
const flatBtc = new Float64Array(hours).fill(100);
const h24 = HORIZONS.indexOf(24);
const h8 = HORIZONS.indexOf(8);

describe("event study observations", () => {
  const s = synthSeries({ hours, price: (i) => 100 * 1.001 ** i, rate: () => 0.0002 });
  const obs = symbolObservations(s, flatBtc, opts);

  it("starts on an 8h mark after 30 days of funding history", () => {
    expect(obs[0]!.time).toBe(T0 + 728 * HOUR);
    expect(obs.every((o) => ((o.time - T0) / HOUR) % 8 === 0)).toBe(true);
    expect(obs[0]!.funding8h).toBeCloseTo(0.0002, 12);
    expect(obs[0]!.fundingZ).toBe(0); // constant history
  });

  it("enters at the close before t, exits at the close ending the horizon, and charges funding in (t, t + h]", () => {
    const o = obs[0]!;
    expect(o.raw[h24]).toBeCloseTo(1.001 ** 24 - 1, 10); // close[751] / close[727]
    expect(o.btcAdj[h24]).toBeCloseTo(o.raw[h24]!, 12); // flat BTC
    expect(o.fundingPaid[h24]).toBeCloseTo(3 * 0.0002, 12); // 736, 744, 752
    expect(o.fundingPaid[h8]).toBeCloseTo(0.0002, 12); // 736 only
    expect(o.ret24h).toBeCloseTo(1.001 ** 24 - 1, 10);
    expect(o.mae[h24]).toBeCloseTo(0, 12); // never below entry
  });

  it("marks horizons past the end of the data as NaN", () => {
    const last = obs.at(-1)!;
    expect(Number.isNaN(last.raw.at(-1)!)).toBe(true);
  });

  it("features never read data at or after decision time (lookahead)", () => {
    const k = 904; // decision index (8h mark)
    const a = synthSeries({ hours, price: (i) => 100 + Math.sin(i / 7) * 5, rate: (i) => 0.0001 + (i % 24) * 1e-5 });
    const b = synthSeries({
      hours,
      price: (i) => (i < k ? 100 + Math.sin(i / 7) * 5 : 500),
      rate: (i) => (i <= k ? 0.0001 + (i % 24) * 1e-5 : 0.05),
    });
    for (const x of [b.perpVol24, b.spotVol24]) for (let i = k + 1; i < hours; i++) x[i] = 1; // vol24[i] covers bars before i
    const fa = symbolObservations(a, flatBtc, opts).find((o) => o.time === T0 + k * HOUR)!;
    const fb = symbolObservations(b, flatBtc, opts).find((o) => o.time === T0 + k * HOUR)!;
    for (const key of ["funding8h", "fundingZ", "ret24h", "ret7d", "volumeRatio", "vol7d"] as const) expect(fb[key]).toBe(fa[key]);
    expect(fb.raw[h24]).not.toBe(fa.raw[h24]); // outcomes do see the future
  });
});

describe("event study statistics", () => {
  it("computes median, hit rate and trims the top tail", () => {
    const s = stats([1, -1, 2, 3, NaN]);
    expect(s.n).toBe(4);
    expect(s.median).toBe(1.5);
    expect(s.hit).toBe(0.75);
    expect(trimTop([1, 2, 3, 100], 0.01)).toEqual([1, 2, 3]);
  });

  it("clusters observations of the same coin closer than the gap, across venues", () => {
    const mk = (base: string, h: number) => ({ base, time: T0 + h * HOUR }) as never;
    const ids = clusterIds([mk("A", 0), mk("A", 48), mk("A", 200), mk("B", 0), mk("A", 50)], 72);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[1]).toBe(ids[4]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(ids[3]).not.toBe(ids[0]);
  });
});
