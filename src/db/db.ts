import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Market = "spot" | "perp" | "premium";

export interface FundingRow {
  symbol: string;
  fundingTime: number;
  intervalHours: number;
  rate: number;
}

export interface KlineRow {
  market: Market;
  symbol: string;
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  quoteVolume: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS symbols (
  symbol TEXT PRIMARY KEY,           -- perp symbol, e.g. BTCUSDT (spot uses the same name)
  base TEXT NOT NULL,
  spot_symbol TEXT NOT NULL,         -- spot pair, e.g. PEPEUSDT for 1000PEPEUSDT (klines are stored under the perp symbol)
  first_funding_ts INTEGER,
  last_funding_ts INTEGER
);
CREATE TABLE IF NOT EXISTS funding_rates (
  symbol TEXT NOT NULL,
  funding_time INTEGER NOT NULL,
  interval_hours INTEGER NOT NULL,
  rate REAL NOT NULL,
  PRIMARY KEY (symbol, funding_time)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS klines (
  market TEXT NOT NULL,              -- spot | perp | premium
  symbol TEXT NOT NULL,
  open_time INTEGER NOT NULL,        -- ms, 1h bars
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  quote_volume REAL NOT NULL,
  PRIMARY KEY (market, symbol, open_time)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS backfill_progress (
  source TEXT NOT NULL,              -- fundingRate | perp | premium | spot
  symbol TEXT NOT NULL,
  month TEXT NOT NULL,               -- YYYY-MM
  status TEXT NOT NULL,              -- done | missing
  rows INTEGER NOT NULL,
  PRIMARY KEY (source, symbol, month)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS fees (
  tier TEXT PRIMARY KEY,
  spot_taker REAL NOT NULL,
  perp_taker REAL NOT NULL,
  updated_ts INTEGER NOT NULL
);
`;

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 60000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);
  // Multi-venue: rows written before venues existed are Binance.
  const cols = db.prepare("PRAGMA table_info(symbols)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "venue")) db.exec("ALTER TABLE symbols ADD COLUMN venue TEXT NOT NULL DEFAULT 'binance'");
  return db;
}

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function insertFunding(db: DatabaseSync, rows: FundingRow[]): void {
  const st = db.prepare(
    "INSERT OR REPLACE INTO funding_rates (symbol, funding_time, interval_hours, rate) VALUES (?, ?, ?, ?)",
  );
  tx(db, () => {
    for (const r of rows) st.run(r.symbol, r.fundingTime, r.intervalHours, r.rate);
  });
}

export function insertKlines(db: DatabaseSync, rows: KlineRow[]): void {
  const st = db.prepare(
    "INSERT OR REPLACE INTO klines (market, symbol, open_time, open, high, low, close, quote_volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  tx(db, () => {
    for (const r of rows) st.run(r.market, r.symbol, r.openTime, r.open, r.high, r.low, r.close, r.quoteVolume);
  });
}

export interface SymbolRow {
  /** Venue-qualified id (see data/venues.ts); klines/funding are stored under it. */
  symbol: string;
  base: string;
  /** The spot pair's name on its venue (e.g. PEPEUSDT, PEPE-USDT). */
  spotSymbol: string;
  venue?: string;
}

export function upsertSymbol(db: DatabaseSync, s: SymbolRow): void {
  db.prepare(
    `INSERT INTO symbols (symbol, base, spot_symbol, venue) VALUES (?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET base = excluded.base, spot_symbol = excluded.spot_symbol, venue = excluded.venue`,
  ).run(s.symbol, s.base, s.spotSymbol, s.venue ?? "binance");
}

export function listSymbols(db: DatabaseSync): SymbolRow[] {
  return db.prepare("SELECT symbol, base, spot_symbol AS spotSymbol, venue FROM symbols ORDER BY symbol").all() as unknown as SymbolRow[];
}

export function refreshSymbolRanges(db: DatabaseSync): void {
  db.exec(`
    UPDATE symbols SET
      first_funding_ts = (SELECT MIN(funding_time) FROM funding_rates f WHERE f.symbol = symbols.symbol),
      last_funding_ts  = (SELECT MAX(funding_time) FROM funding_rates f WHERE f.symbol = symbols.symbol)
  `);
}

export function isDone(db: DatabaseSync, source: string, symbol: string, month: string): boolean {
  return !!db.prepare("SELECT 1 FROM backfill_progress WHERE source = ? AND symbol = ? AND month = ?").get(source, symbol, month);
}

export function markDone(db: DatabaseSync, source: string, symbol: string, month: string, status: "done" | "missing", rows: number): void {
  db.prepare("INSERT OR REPLACE INTO backfill_progress (source, symbol, month, status, rows) VALUES (?, ?, ?, ?, ?)").run(
    source, symbol, month, status, rows,
  );
}

export function upsertFees(db: DatabaseSync, tier: string, spotTaker: number, perpTaker: number): void {
  db.prepare("INSERT OR REPLACE INTO fees (tier, spot_taker, perp_taker, updated_ts) VALUES (?, ?, ?, ?)").run(
    tier, spotTaker, perpTaker, Date.now(),
  );
}
