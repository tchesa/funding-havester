import { parentPort, workerData } from "node:worker_threads";
import type { SimParams, SpreadParams, StrategyParams } from "../config/params.js";
import type { Dataset } from "../data/loaders.js";
import { computeMetrics } from "./metrics.js";
import type { SimJob, StrategyKind } from "./pool.js";
import { simulate } from "./simulator.js";
import { simulateSpread } from "./spread-sim.js";

// The dataset's typed arrays are backed by SharedArrayBuffers, so this is a view, not a copy.
const { ds, sim, kind } = workerData as { ds: Dataset; sim: SimParams; kind: StrategyKind };

parentPort!.on("message", (job: SimJob) => {
  try {
    const cfg = { sim, from: job.from, to: job.to };
    const res = kind === "spread"
      ? simulateSpread(ds, { ...cfg, strategy: job.strategy as SpreadParams })
      : simulate(ds, { ...cfg, strategy: job.strategy as StrategyParams });
    parentPort!.postMessage({ id: job.id, metrics: computeMetrics(res, ds) });
  } catch (e) {
    parentPort!.postMessage({ id: job.id, error: (e as Error).stack ?? String(e) });
  }
});
