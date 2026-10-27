import { parentPort, workerData } from "node:worker_threads";
import type { SimParams } from "../config/params.js";
import { type LoadOptions, loadDataset } from "../data/loaders.js";
import { openDb } from "../db/db.js";
import { computeMetrics } from "./metrics.js";
import type { SimJob } from "./pool.js";
import { simulate } from "./simulator.js";

const { dbPath, load, sim } = workerData as { dbPath: string; load: LoadOptions; sim: SimParams };
const db = openDb(dbPath);
const ds = loadDataset(db, load);
db.close();

parentPort!.on("message", (job: SimJob) => {
  try {
    const res = simulate(ds, { strategy: job.strategy, sim, from: job.from, to: job.to });
    parentPort!.postMessage({ id: job.id, metrics: computeMetrics(res, ds) });
  } catch (e) {
    parentPort!.postMessage({ id: job.id, error: (e as Error).stack ?? String(e) });
  }
});
