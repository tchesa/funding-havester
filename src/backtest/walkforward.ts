import type { SimParams, StrategyParams } from "../config/params.js";
import type { Dataset } from "../data/loaders.js";
import { HOUR } from "../data/parse.js";
import { computeMetrics, type Metrics } from "./metrics.js";
import { simulate } from "./simulator.js";

export interface Window {
  trainFrom: number;
  trainTo: number;
  testFrom: number;
  testTo: number;
}

const addMonths = (t: number, m: number) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + m, d.getUTCDate());
};

export function makeWindows(from: number, to: number, trainMonths: number, testMonths: number, stepMonths: number): Window[] {
  const out: Window[] = [];
  for (let start = from; ; start = addMonths(start, stepMonths)) {
    const trainTo = addMonths(start, trainMonths);
    const testTo = addMonths(trainTo, testMonths);
    if (testTo > to) break;
    out.push({ trainFrom: start, trainTo, testFrom: trainTo, testTo });
  }
  return out;
}

export type Grid = { [K in keyof StrategyParams]?: Array<StrategyParams[K]> };

export function expandGrid(base: StrategyParams, grid: Grid): StrategyParams[] {
  let combos: StrategyParams[] = [{ ...base }];
  for (const [key, vals] of Object.entries(grid) as Array<[keyof StrategyParams, unknown[]]>) {
    const next: StrategyParams[] = [];
    for (const c of combos) for (const v of vals) next.push({ ...c, [key]: v });
    combos = next;
  }
  // exit threshold above entry threshold makes no sense
  return combos.filter((c) => c.exitThreshold < c.entryThreshold);
}

/** Selection objective on the train window. */
export function score(m: Metrics, ddPenalty = 0.5): number {
  if (m.liquidations > 0) return -Infinity;
  return m.netApr - ddPenalty * m.maxDrawdown;
}

export interface WindowResult {
  window: Window;
  params: StrategyParams;
  train: Metrics;
  test: Metrics;
  /** Test-window equity, normalized to start at 1. */
  testCurve: number[];
}

export interface CombinedOos {
  hours: number;
  netApr: number;
  maxDrawdown: number;
  windowAprs: number[];
  aprMean: number;
  aprStdDev: number;
  positiveWindowShare: number;
  liquidations: number;
  income: Metrics["income"];
  trades: number;
}

/** Runs one train-window sim; swap in a worker pool for parallelism. */
export type TrainRunner = (params: StrategyParams, from: number, to: number) => Promise<Metrics>;

export async function runWalkForward(
  ds: Dataset,
  sim: SimParams,
  combos: StrategyParams[],
  windows: Window[],
  runTrain?: TrainRunner,
  onProgress?: (msg: string) => void,
): Promise<{ results: WindowResult[]; oos: CombinedOos }> {
  const run: TrainRunner =
    runTrain ?? (async (params, from, to) => computeMetrics(simulate(ds, { strategy: params, sim, from, to }), ds));
  const results: WindowResult[] = [];
  for (const [wi, w] of windows.entries()) {
    let best: { params: StrategyParams; m: Metrics; s: number } | null = null;
    const ms = await Promise.all(combos.map((params) => run(params, w.trainFrom, w.trainTo)));
    ms.forEach((m, ci) => {
      const s = score(m);
      if (!best || s > best.s) best = { params: combos[ci]!, m, s };
    });
    const testRes = simulate(ds, { strategy: best!.params, sim, from: w.testFrom, to: w.testTo });
    const test = computeMetrics(testRes, ds);
    results.push({
      window: w,
      params: best!.params,
      train: best!.m,
      test,
      testCurve: testRes.equity.map((e) => e / testRes.initialCapital),
    });
    onProgress?.(
      `window ${wi + 1}/${windows.length} ${iso(w.testFrom)}..${iso(w.testTo)}: train APR ${(best!.m.netApr * 100).toFixed(1)}% → test APR ${(test.netApr * 100).toFixed(1)}%`,
    );
  }
  return { results, oos: combine(results) };
}

export function combine(results: WindowResult[]): CombinedOos {
  let level = 1;
  let peak = 1;
  let maxDd = 0;
  let hours = 0;
  for (const r of results) {
    for (const v of r.testCurve) {
      const e = level * v;
      peak = Math.max(peak, e);
      maxDd = Math.max(maxDd, (peak - e) / peak);
    }
    level *= r.testCurve.at(-1) ?? 1;
    hours += r.testCurve.length;
  }
  const aprs = results.map((r) => r.test.netApr);
  const mean = aprs.reduce((a, b) => a + b, 0) / Math.max(1, aprs.length);
  const sd = Math.sqrt(aprs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, aprs.length));
  const income = { funding: 0, fees: 0, slippage: 0, basis: 0, net: 0 };
  for (const r of results) for (const k of Object.keys(income) as Array<keyof typeof income>) income[k] += r.test.income[k];
  return {
    hours,
    netApr: hours ? Math.pow(level, 8760 / hours) - 1 : 0,
    maxDrawdown: maxDd,
    windowAprs: aprs,
    aprMean: mean,
    aprStdDev: sd,
    positiveWindowShare: aprs.length ? aprs.filter((a) => a > 0).length / aprs.length : 0,
    liquidations: results.reduce((a, r) => a + r.test.liquidations, 0),
    income,
    trades: results.reduce((a, r) => a + r.test.trades, 0),
  };
}

export const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
export const hoursBetween = (a: number, b: number) => (b - a) / HOUR;
