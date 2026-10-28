import { unzipSync, strFromU8 } from "fflate";
import { fetchWithRetry, getJson, Limiter, qs } from "./http.js";

/** OKX v5 public data. history-candles: 20 req / 2 s; market-data-history: conservative. */
const BASE = "https://www.okx.com";
const candleLimiter = new Limiter(8);
const archiveLimiter = new Limiter(4);
const miscLimiter = new Limiter(8);
const cdnLimiter = new Limiter(30);

interface Envelope<T> {
  code: string;
  msg: string;
  data: T;
}

async function call<T>(path: string, params: Record<string, string | number | undefined>, limiter: Limiter): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    const r = await getJson<Envelope<T>>(`${BASE}${path}?${qs(params)}`, limiter);
    if (r.code === "0") return r.data;
    if (r.code === "51001") return null; // instrument doesn't exist
    if (r.code === "50011" && attempt < 6) {
      await new Promise((res) => setTimeout(res, 2000 * (attempt + 1))); // rate limited
      continue;
    }
    throw new Error(`okx ${path} ${JSON.stringify(params)} -> ${r.code} ${r.msg}`);
  }
}

export interface OkxInstrument {
  instId: string;
  instFamily: string;
  baseCcy: string;
  quoteCcy: string;
  settleCcy: string;
  ctType: string;
  state: string;
}

export async function instruments(instType: "SWAP" | "SPOT"): Promise<OkxInstrument[]> {
  return (await call<OkxInstrument[]>("/api/v5/public/instruments", { instType }, miscLimiter)) ?? [];
}

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  qv: number;
}

/** Confirmed 1h bars strictly before `after` (newest first from OKX; returned ascending), max 300. */
export async function historyCandles(instId: string, after: number): Promise<Bar[] | null> {
  const r = await call<string[][]>("/api/v5/market/history-candles", { instId, bar: "1H", limit: 300, after }, candleLimiter);
  if (!r) return null;
  return r
    .filter((x) => x[8] === "1")
    .map((x) => ({ t: Number(x[0]), o: Number(x[1]), h: Number(x[2]), l: Number(x[3]), c: Number(x[4]), qv: Number(x[7]) }))
    .sort((a, b) => a.t - b.t);
}

/** Recent funding (REST keeps ~3 months), rows strictly before `after`, max 100, ascending. */
export async function fundingHistory(instId: string, after?: number): Promise<Array<{ t: number; rate: number }>> {
  const r = await call<Array<{ fundingTime: string; realizedRate?: string; fundingRate: string }>>(
    "/api/v5/public/funding-rate-history", { instId, limit: 100, after }, miscLimiter,
  );
  return (r ?? [])
    .map((x) => ({ t: Number(x.fundingTime), rate: Number(x.realizedRate || x.fundingRate) }))
    .sort((a, b) => a.t - b.t);
}

export interface ArchiveFile {
  key: string; // instFamily (SWAP) or instId (SPOT)
  month: number; // dateTs
  url: string;
}

/**
 * List monthly archive files. module 2 = 1m candlesticks, 3 = funding rates.
 * The API caps a query at 10 months, so callers should chunk the range.
 */
export async function archiveFiles(
  module: 2 | 3, instType: "SWAP" | "SPOT", keys: string[], begin: number, end: number,
): Promise<ArchiveFile[]> {
  const listKey = instType === "SWAP" ? "instFamilyList" : "instIdList";
  const r = await call<Array<{ details: Array<{ instFamily: string; instId: string; groupDetails: Array<{ dateTs: string; url: string }> }> }>>(
    "/api/v5/public/market-data-history",
    { module, instType, [listKey]: keys.join(","), dateAggrType: "monthly", begin, end },
    archiveLimiter,
  );
  const out: ArchiveFile[] = [];
  for (const d of r ?? []) {
    for (const det of d.details) {
      const key = instType === "SWAP" ? det.instFamily : det.instId;
      for (const g of det.groupDetails) out.push({ key, month: Number(g.dateTs), url: g.url });
    }
  }
  return out;
}

/** Download a zip and return its first CSV as text (null on 404). */
export async function downloadCsv(url: string): Promise<string | null> {
  const res = await fetchWithRetry(url, cdnLimiter);
  if (!res) return null;
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  const name = Object.keys(files).find((n) => n.endsWith(".csv"));
  return name ? strFromU8(files[name]!) : null;
}
