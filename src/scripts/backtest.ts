import { parseArgs } from "node:util";
import { env } from "../config/env.js";
import { defaultSimParams, defaultStrategyParams, simParamsSchema, strategyParamsSchema } from "../config/params.js";
import { loadDataset } from "../data/loaders.js";
import { openDb } from "../db/db.js";
import { summarize } from "../backtest/format.js";
import { computeMetrics } from "../backtest/metrics.js";
import { simulate } from "../backtest/simulator.js";
import { logger, setLogLevel } from "../log.js";

const log = logger("backtest");
setLogLevel(env.LOG_LEVEL);

const { values } = parseArgs({
  options: {
    from: { type: "string", default: "2023-03-01" },
    to: { type: "string", default: new Date().toISOString().slice(0, 10) },
    symbols: { type: "string" },
    "always-on": { type: "string" },
    params: { type: "string" }, // JSON overrides for strategy params
    sim: { type: "string" }, // JSON overrides for sim params
    top: { type: "string", default: "10" },
  },
});

const strategy = strategyParamsSchema.parse({ ...defaultStrategyParams(), ...JSON.parse(values.params ?? "{}") });
const sim = simParamsSchema.parse({ ...defaultSimParams(), ...JSON.parse(values.sim ?? "{}") });
const from = Date.parse(values.from!);
const to = Date.parse(values.to!);
const alwaysOn = values["always-on"]?.split(",").map((s) => s.trim().toUpperCase());
const symbols = values.symbols?.split(",").map((s) => s.trim().toUpperCase()) ?? alwaysOn;

const db = openDb(env.DB_PATH);
const t0 = Date.now();
// Load extra history before `from` so lookbacks and 24h volumes are warm.
const ds = loadDataset(db, {
  from: from - 30 * 86_400_000,
  to,
  ...(symbols ? { symbols } : {}),
  minPerpVolume24h: strategy.minPerpVolume24h,
  minSpotVolume24h: strategy.minSpotVolume24h,
});
log.info("dataset loaded", { symbols: ds.symbols.length, hours: ds.hours, ms: Date.now() - t0 });

const t1 = Date.now();
const res = simulate(ds, { strategy, sim, from, to, ...(alwaysOn ? { alwaysOn } : {}) });
const m = computeMetrics(res, ds);
log.info("simulated", { ms: Date.now() - t1 });

console.log(summarize(m));
const top = Number(values.top);
if (m.bySymbol.length) {
  console.log(`\nTop ${top} symbols by net PnL:`);
  for (const s of m.bySymbol.slice(0, top)) console.log(`  ${s.symbol.padEnd(16)} trades ${String(s.trades).padStart(3)}  funding $${s.funding.toFixed(0).padStart(7)}  net $${s.net.toFixed(0).padStart(7)}`);
}
db.close();
