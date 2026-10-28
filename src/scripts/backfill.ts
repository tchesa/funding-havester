import { parseArgs } from "node:util";
import { env } from "../config/env.js";
import { backfill } from "../data/backfill.js";
import { backfillBybit, backfillOkx, discoverBybit, discoverOkx } from "../data/backfill-venues.js";
import { monthStart } from "../data/parse.js";
import { discoverUniverse } from "../data/symbols.js";
import { listSymbols, openDb, upsertFees, upsertSymbol } from "../db/db.js";
import { getPerpTakerFee, getSpotTakerFee } from "../exchange/rest.js";
import { logger, setLogLevel } from "../log.js";

const log = logger("backfill");
setLogLevel(env.LOG_LEVEL);

const { values } = parseArgs({
  options: {
    from: { type: "string", default: "2023-01" },
    symbols: { type: "string" }, // comma list of bases or symbols, e.g. BTC,ETH,1000PEPEUSDT
    "no-gap-fill": { type: "boolean", default: false },
    "skip-discovery": { type: "boolean", default: false },
    venue: { type: "string", default: "binance" }, // binance | bybit | okx
  },
});

const db = openDb(env.DB_PATH);
const wanted = values.symbols ? new Set(values.symbols.split(",").map((x) => x.trim().toUpperCase())) : null;
const pick = <T extends { symbol: string; base: string }>(xs: T[]) =>
  wanted ? xs.filter((s) => wanted.has(s.symbol) || wanted.has(s.base) || wanted.has(s.symbol.split(":").pop()!)) : xs;
const from = monthStart(values.from!);

if (values.venue === "bybit") {
  const rows = await discoverBybit();
  for (const s of rows) upsertSymbol(db, s);
  log.info("bybit universe", { symbols: rows.length });
  await backfillBybit(db, pick(rows), { from, concurrency: 8 });
  db.close();
  process.exit(0);
}
if (values.venue === "okx") {
  // Delisted OKX swaps can only be found by name, so probe bases seen on the other venues.
  const bases = listSymbols(db).map((s) => s.base);
  const d = await discoverOkx(bases, from);
  for (const s of d.rows) upsertSymbol(db, s);
  await backfillOkx(db, { ...d, rows: pick(d.rows) }, { from, concurrency: 8 });
  db.close();
  process.exit(0);
}
if (values.venue !== "binance") throw new Error(`unknown venue ${values.venue}`);

if (!values["skip-discovery"]) {
  const universe = await discoverUniverse();
  for (const s of universe) upsertSymbol(db, s);
  log.info("universe discovered", { symbols: universe.length });
}

let symbols = listSymbols(db).filter((s) => (s.venue ?? "binance") === "binance");
if (wanted) symbols = symbols.filter((s) => wanted.has(s.symbol) || wanted.has(s.base));

if (env.BINANCE_API_KEY && env.BINANCE_API_SECRET) {
  try {
    const [spot, perp] = await Promise.all([
      getSpotTakerFee("BTCUSDT", env.BINANCE_API_KEY, env.BINANCE_API_SECRET),
      getPerpTakerFee("BTCUSDT", env.BINANCE_API_KEY, env.BINANCE_API_SECRET),
    ]);
    upsertFees(db, "account", spot, perp);
    log.info("account fees", { spot, perp });
  } catch (e) {
    log.warn("could not read account fees", e);
  }
}

await backfill(db, symbols, {
  from: values.from!,
  cacheDir: env.DATA_DIR,
  concurrency: env.DOWNLOAD_CONCURRENCY,
  gapFill: !values["no-gap-fill"],
});
db.close();
