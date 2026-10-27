import { parentPort, workerData } from "node:worker_threads";
import type { SimParams } from "../config/params.js";
import type { Dataset } from "../data/loaders.js";
import { computeMetrics } from "./metrics.js";
import type { SimJob } from "./pool.js";
import { simulate } from "./simulator.js";

// The dataset's typed arrays are backed by SharedArrayBuffers, so this is a view, not a copy.
const { ds, sim } = workerData as { ds: Dataset; sim: SimParams };

parentPort!.on("message", (job: SimJob) => {
  try {
    const res = simulate(ds, { strategy: job.strategy, sim, from: job.from, to: job.to });
    parentPort!.postMessage({ id: job.id, metrics: computeMetrics(res, ds) });
  } catch (e) {
    parentPort!.postMessage({ id: job.id, error: (e as Error).stack ?? String(e) });
  }
});
