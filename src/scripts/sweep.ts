import { parseArgs } from "node:util";
import { env } from "../config/env.js";
import {
  defaultGoCriteria, defaultSimParams, defaultStrategyParams, goCriteriaSchema, simParamsSchema, type StrategyParams, strategyParamsSchema,
} from "../config/params.js";
import { type LoadOptions, loadDataset } from "../data/loaders.js";
import { openDb } from "../db/db.js";
import { normalizeId } from "../data/venues.js";
import { summarize } from "../backtest/format.js";
import { computeMetrics } from "../backtest/metrics.js";
import { SimPool } from "../backtest/pool.js";
import { goNoGo, writeReport } from "../backtest/report.js";
import { simulate } from "../backtest/simulator.js";
import { expandGrid, type Grid, iso, makeWindows, runWalkForward } from "../backtest/walkforward.js";
import { logger, setLogLevel } from "../log.js";

const log = logger("sweep");
setLogLevel(env.LOG_LEVEL);

const { values } = parseArgs({
  options: {
    from: { type: "string", default: "2023-03-01" },
    to: { type: "string", default: new Date().toISOString().slice(0, 10) },
    symbols: { type: "string" },
    venues: { type: "string", default: "binance" }, // comma list: binance,bybit,okx
    train: { type: "string", default: "6" },
    test: { type: "string", default: "3" },
    step: { type: "string", default: "3" },
    quick: { type: "boolean", default: false },
    grid: { type: "string" }, // JSON Grid override
    params: { type: "string" }, // JSON base strategy overrides
    sim: { type: "string" },
    criteria: { type: "string" },
    workers: { type: "string" },
    label: { type: "string" },
  },
});

const DEFAULT_GRID: Grid = {
  entryThreshold: [0.0001, 0.00015, 0.0002, 0.0003],
  exitThreshold: [0, 0.00005, 0.0001],
  k: [3, 9, 21],
  m: [3, 6],
  n: [1, 3],
  safetyFactor: [1, 1.5, 2],
};
const QUICK_GRID: Grid = { entryThreshold: [0.0001, 0.0002], exitThreshold: [0, 0.00005], k: [9], m: [3, 6], n: [3], safetyFactor: [1.5] };

const base = strategyParamsSchema.parse({ ...defaultStrategyParams(), ...JSON.parse(values.params ?? "{}") });
const sim = simParamsSchema.parse({ ...defaultSimParams(), ...JSON.parse(values.sim ?? "{}") });
const criteria = goCriteriaSchema.parse({ ...defaultGoCriteria(), ...JSON.parse(values.criteria ?? "{}") });
const grid: Grid = values.grid ? JSON.parse(values.grid) : values.quick ? QUICK_GRID : DEFAULT_GRID;
const combos = expandGrid(base, grid);

const from = Date.parse(values.from!);
const to = Date.parse(values.to!);
const windows = makeWindows(from, to, Number(values.train), Number(values.test), Number(values.step));
if (!windows.length) throw new Error("no walk-forward windows fit in the date range");

const load: LoadOptions = {
  from: from - 30 * 86_400_000,
  to,
  ...(values.symbols ? { symbols: values.symbols.split(",").map(normalizeId) } : {}),
  venues: values.venues!.split(",").map((v) => v.trim()),
  minPerpVolume24h: Math.min(base.minPerpVolume24h, ...(grid.minPerpVolume24h ?? [])),
  minSpotVolume24h: Math.min(base.minSpotVolume24h, ...(grid.minSpotVolume24h ?? [])),
};

const db = openDb(env.DB_PATH);
const ds = loadDataset(db, load);
db.close();
log.info("sweep", { symbols: ds.symbols.length, combos: combos.length, windows: windows.length, first: iso(windows[0]!.testFrom) });

const pool = new SimPool(ds, sim, values.workers ? Number(values.workers) : undefined);
log.info("workers", { size: pool.size });
const t0 = Date.now();
const { results, oos } = await runWalkForward(
  ds, sim, combos, windows,
  (params, f, t) => pool.run(params, f, t),
  (msg) => log.info(msg),
);
await pool.close();
log.info("walk-forward done", { s: Math.round((Date.now() - t0) / 1000) });

// Modal params across windows → full-period run for breakdowns.
const counts = new Map<string, { n: number; p: StrategyParams }>();
for (const r of results) {
  const key = JSON.stringify(r.params);
  counts.set(key, { n: (counts.get(key)?.n ?? 0) + 1, p: r.params });
}
const modal = [...counts.values()].sort((a, b) => b.n - a.n)[0]!.p;
const fullMetrics = computeMetrics(simulate(ds, { strategy: modal, sim, from: windows[0]!.trainFrom, to }), ds);

const paths = writeReport("reports", {
  generatedAt: Date.now(),
  dataFrom: windows[0]!.trainFrom,
  dataTo: to,
  symbols: ds.symbols.length,
  combos: combos.length,
  sim,
  criteria,
  results,
  oos,
  fullPeriod: { params: modal, metrics: fullMetrics },
  ...(values.label ? { label: values.label } : {}),
});

const verdict = goNoGo(oos, criteria);
console.log(`\nOOS net APR ${(oos.netApr * 100).toFixed(2)}% | max DD ${(oos.maxDrawdown * 100).toFixed(2)}% | windows ${oos.windowAprs.map((a) => (a * 100).toFixed(1) + "%").join(", ")}`);
console.log(`Full period (modal params):\n${summarize(fullMetrics)}`);
console.log(`\nVerdict: ${verdict.go ? "GO" : "NO-GO"}`);
for (const c of verdict.checks) console.log(`  ${c.pass ? "✓" : "✗"} ${c.name}: ${c.value} (${c.threshold})`);
console.log(`\nReport: ${paths.md}`);
const inc = oos.income;
console.log(
  `SUMMARY\t${values.label ?? "-"}\tapr=${(oos.netApr * 100).toFixed(2)}%\tdd=${(oos.maxDrawdown * 100).toFixed(2)}%` +
  `\tstd=${(oos.aprStdDev * 100).toFixed(2)}%\tpos=${(oos.positiveWindowShare * 100).toFixed(0)}%\tliq=${oos.liquidations}` +
  `\ttrades=${oos.trades}\tfunding=${inc.funding.toFixed(0)}\tfees=${inc.fees.toFixed(0)}\tslip=${inc.slippage.toFixed(0)}\tbasis=${inc.basis.toFixed(0)}` +
  `\tfullApr=${(fullMetrics.netApr * 100).toFixed(2)}%\tfullLiq=${fullMetrics.liquidations}\t${verdict.go ? "GO" : "NO-GO"}`,
);
