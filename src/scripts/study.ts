import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { env } from "../config/env.js";
import { loadDataset } from "../data/loaders.js";
import { openDb } from "../db/db.js";
import { collectObservations, defaultStudyOptions } from "../research/eventStudy.js";
import { buildReport } from "../research/studyReport.js";
import { logger, setLogLevel } from "../log.js";

const log = logger("study");
setLogLevel(env.LOG_LEVEL);

const { values } = parseArgs({
  options: {
    from: { type: "string", default: "2023-03-01" },
    to: { type: "string", default: "2026-10-01" },
    venues: { type: "string", default: "binance,bybit,okx" },
    "min-volume": { type: "string", default: "20000000" },
    label: { type: "string", default: "study" },
  },
});

const from = Date.parse(values.from!);
const to = Date.parse(values.to!);
const venues = values.venues!.split(",").map((v) => v.trim());
if (!venues.includes("binance")) throw new Error("binance is needed for the BTC benchmark");
const opts = { ...defaultStudyOptions(from, to), minPerpVolume24h: Number(values["min-volume"]) };

const db = openDb(env.DB_PATH);
const t0 = Date.now();
// 40 days of warm-up for the 30-day funding z-score and 7-day returns/volatility.
const ds = loadDataset(db, { from: from - 40 * 86_400_000, to, venues, minPerpVolume24h: opts.minPerpVolume24h, requireSpot: false });
db.close();
log.info("dataset loaded", { symbols: ds.symbols.length, s: Math.round((Date.now() - t0) / 1000) });

const obs = collectObservations(ds, opts);
log.info("observations", { n: obs.length });

let commit = "unknown";
try {
  commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  if (execSync("git status --porcelain src", { encoding: "utf8" }).trim()) commit += "+dirty";
} catch { /* not a git checkout */ }

const { md, json } = buildReport(obs, { generatedAt: Date.now(), commit, from, to, venues, options: opts });
mkdirSync("reports", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + `-${values.label}`;
writeFileSync(join("reports", `${stamp}.md`), md);
writeFileSync(join("reports", `${stamp}.json`), JSON.stringify(json, null, 2));
const gate = (json as { gate: { pass: boolean } }).gate.pass;
console.log(`Gate: ${gate ? "PASS" : "FAIL"}\nReport: reports/${stamp}.md`);
