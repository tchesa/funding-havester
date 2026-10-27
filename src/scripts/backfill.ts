import { parseArgs } from "node:util";
import { env } from "../config/env.js";
import { backfill } from "../data/backfill.js";
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
  },
});

const db = openDb(env.DB_PATH);

if (!values["skip-discovery"]) {
  const universe = await discoverUniverse();
  for (const s of universe) upsertSymbol(db, s);
  log.info("universe discovered", { symbols: universe.length });
}

let symbols = listSymbols(db);
if (values.symbols) {
  const wanted = new Set(values.symbols.split(",").map((x) => x.trim().toUpperCase()));
  symbols = symbols.filter((s) => wanted.has(s.symbol) || wanted.has(s.base));
}

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
