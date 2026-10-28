import { getJson, Limiter, qs } from "./http.js";

/** Bybit v5 public market data. Public limit is 600 req / 5 s per IP; stay well under it. */
const BASE = "https://api.bybit.com";
const limiter = new Limiter(40);

interface Envelope<T> {
  retCode: number;
  retMsg: string;
  result: T;
}

async function call<T>(path: string, params: Record<string, string | number | undefined>): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    const r = await getJson<Envelope<T>>(`${BASE}${path}?${qs(params)}`, limiter);
    if (r.retCode === 0) return r.result;
    if (r.retCode === 10001) return null; // unknown / unsupported symbol
    // 10006 = rate limited, 10016 = transient service error ("Get kline failed").
    if ((r.retCode === 10006 || r.retCode === 10016) && attempt < 5) {
      await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
      continue;
    }
    throw new Error(`bybit ${path} ${JSON.stringify(params)} -> ${r.retCode} ${r.retMsg}`);
  }
}

export interface BybitLinear {
  symbol: string;
  contractType: string;
  status: string;
  baseCoin: string;
  quoteCoin: string;
  settleCoin: string;
  launchTime: string;
  deliveryTime: string;
}

export async function listLinear(status: "Trading" | "Closed"): Promise<BybitLinear[]> {
  const out: BybitLinear[] = [];
  let cursor: string | undefined;
  for (;;) {
    const r = await call<{ list: BybitLinear[]; nextPageCursor?: string }>("/v5/market/instruments-info", {
      category: "linear", status, limit: 1000, cursor,
    });
    if (!r) break;
    out.push(...r.list);
    if (!r.nextPageCursor || !r.list.length) break;
    cursor = r.nextPageCursor;
  }
  return out;
}

export async function listSpot(): Promise<Array<{ symbol: string; baseCoin: string; quoteCoin: string }>> {
  const r = await call<{ list: Array<{ symbol: string; baseCoin: string; quoteCoin: string }> }>("/v5/market/instruments-info", {
    category: "spot", limit: 1000,
  });
  return r?.list ?? [];
}

/** Funding rows in [start, end], newest first, max 200. */
export async function fundingHistory(symbol: string, end: number, start?: number): Promise<Array<{ t: number; rate: number }>> {
  const r = await call<{ list: Array<{ fundingRate: string; fundingRateTimestamp: string }> }>("/v5/market/funding/history", {
    category: "linear", symbol, endTime: end, startTime: start, limit: 200,
  });
  return (r?.list ?? []).map((x) => ({ t: Number(x.fundingRateTimestamp), rate: Number(x.fundingRate) }));
}

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  qv: number;
}

/** 1h bars in [start, end], ascending, max 1000. Premium bars have no volume (qv = 0). */
export async function klines(kind: "spot" | "linear" | "premium", symbol: string, start: number, end: number): Promise<Bar[] | null> {
  const path = kind === "premium" ? "/v5/market/premium-index-price-kline" : "/v5/market/kline";
  const r = await call<{ list: string[][] }>(path, {
    category: kind === "spot" ? "spot" : "linear", symbol, interval: 60, start, end, limit: 1000,
  });
  if (!r) return null;
  return r.list
    .map((x) => ({ t: Number(x[0]), o: Number(x[1]), h: Number(x[2]), l: Number(x[3]), c: Number(x[4]), qv: x[6] !== undefined ? Number(x[6]) : 0 }))
    .sort((a, b) => a.t - b.t);
}
