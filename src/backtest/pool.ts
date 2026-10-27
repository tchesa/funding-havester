import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { SimParams, StrategyParams } from "../config/params.js";
import type { LoadOptions } from "../data/loaders.js";
import type { Metrics } from "./metrics.js";

export interface SimJob {
  id: number;
  strategy: StrategyParams;
  from: number;
  to: number;
}

interface Pending {
  resolve: (m: Metrics) => void;
  reject: (e: Error) => void;
}

/** Pool of workers, each holding its own copy of the dataset, running train-window sims. */
export class SimPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Array<{ job: SimJob; p: Pending }> = [];
  private pending = new Map<number, Pending>();
  private nextId = 0;

  constructor(dbPath: string, load: LoadOptions, sim: SimParams, size = Math.max(1, availableParallelism() - 1)) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL("./worker-entry.mjs", import.meta.url), { workerData: { dbPath, load, sim } });
      w.on("message", (msg: { id: number; metrics?: Metrics; error?: string }) => {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (p) msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.metrics!);
        this.idle.push(w);
        this.pump();
      });
      w.on("error", (e) => {
        for (const p of this.pending.values()) p.reject(e);
      });
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  run(strategy: StrategyParams, from: number, to: number): Promise<Metrics> {
    return new Promise((resolve, reject) => {
      this.queue.push({ job: { id: this.nextId++, strategy, from, to }, p: { resolve, reject } });
      this.pump();
    });
  }

  private pump(): void {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop()!;
      const { job, p } = this.queue.shift()!;
      this.pending.set(job.id, p);
      w.postMessage(job);
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}
