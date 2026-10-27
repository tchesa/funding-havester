import { createHmac } from "node:crypto";
import { logger } from "../log.js";

const log = logger("rest");

export const FAPI = "https://fapi.binance.com";
export const SPOT = "https://api.binance.com";

/** Per-host weight budget per minute. We back off well below Binance's hard limits. */
const WEIGHT_SOFT_LIMIT: Record<string, number> = { [FAPI]: 1800, [SPOT]: 4800 };
const MAX_RETRIES = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msToNextMinute = () => 60_000 - (Date.now() % 60_000) + 250;

type Params = Record<string, string | number | undefined>;

function toQuery(params: Params): URLSearchParams {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
  return qs;
}

async function request<T>(base: string, path: string, qs: URLSearchParams, headers: Record<string, string> = {}): Promise<T> {
  const url = `${base}${path}${qs.size ? `?${qs}` : ""}`;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch (e) {
      if (attempt >= MAX_RETRIES) throw e;
      const wait = 1000 * 2 ** attempt;
      log.warn("network error, retrying", { path, attempt, wait, error: (e as Error).message });
      await sleep(wait);
      continue;
    }

    const used = Number(res.headers.get("x-mbx-used-weight-1m") ?? 0);
    const soft = WEIGHT_SOFT_LIMIT[base] ?? 1000;

    if (res.status === 429 || res.status === 418) {
      const retryAfter = Number(res.headers.get("retry-after") ?? 0) * 1000;
      const wait = Math.max(retryAfter, msToNextMinute());
      log.warn("rate limited", { path, status: res.status, wait });
      if (attempt >= MAX_RETRIES) throw new Error(`GET ${path} -> ${res.status} after ${attempt} retries`);
      await sleep(wait);
      continue;
    }
    if (res.status >= 500) {
      if (attempt >= MAX_RETRIES) throw new Error(`GET ${path} -> ${res.status}`);
      const wait = 1000 * 2 ** attempt;
      log.warn("server error, retrying", { path, status: res.status, wait });
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GET ${path} -> ${res.status} ${body.slice(0, 200)}`);
    }

    const body = (await res.json()) as T;
    if (used > soft) {
      const wait = msToNextMinute();
      log.info("weight near limit, pausing", { base, used, wait });
      await sleep(wait);
    }
    return body;
  }
}

export function get<T>(base: string, path: string, params: Params = {}): Promise<T> {
  return request<T>(base, path, toQuery(params));
}

export function signedGet<T>(base: string, path: string, params: Params, apiKey: string, apiSecret: string): Promise<T> {
  const qs = toQuery({ ...params, timestamp: Date.now(), recvWindow: 5000 });
  qs.set("signature", createHmac("sha256", apiSecret).update(qs.toString()).digest("hex"));
  return request<T>(base, path, qs, { "X-MBX-APIKEY": apiKey });
}

// ---- Public market data ----

export interface RawFunding {
  symbol: string;
  fundingTime: number;
  fundingRate: string;
}

export function getFundingHistory(symbol: string, startTime: number, endTime?: number): Promise<RawFunding[]> {
  return get<RawFunding[]>(FAPI, "/fapi/v1/fundingRate", { symbol, startTime, endTime, limit: 1000 });
}

/** [openTime, open, high, low, close, volume, closeTime, quoteVolume, ...] */
export type RawKline = [number, string, string, string, string, string, number, string, ...unknown[]];

export function getPerpKlines(symbol: string, startTime: number, endTime?: number): Promise<RawKline[]> {
  return get<RawKline[]>(FAPI, "/fapi/v1/klines", { symbol, interval: "1h", startTime, endTime, limit: 1500 });
}

export function getPremiumIndexKlines(symbol: string, startTime: number, endTime?: number): Promise<RawKline[]> {
  return get<RawKline[]>(FAPI, "/fapi/v1/premiumIndexKlines", { symbol, interval: "1h", startTime, endTime, limit: 1500 });
}

export function getSpotKlines(symbol: string, startTime: number, endTime?: number): Promise<RawKline[]> {
  return get<RawKline[]>(SPOT, "/api/v3/klines", { symbol, interval: "1h", startTime, endTime, limit: 1000 });
}

/** Only symbols with a non-default interval are listed; everything else settles every 8h. */
export async function getFundingIntervals(): Promise<Map<string, number>> {
  const rows = await get<Array<{ symbol: string; fundingIntervalHours: number }>>(FAPI, "/fapi/v1/fundingInfo");
  return new Map(rows.map((r) => [r.symbol, r.fundingIntervalHours]));
}

export async function getSpotTradingSymbols(): Promise<Set<string>> {
  const info = await get<{ symbols: Array<{ symbol: string; status: string }> }>(SPOT, "/api/v3/exchangeInfo");
  return new Set(info.symbols.filter((s) => s.status === "TRADING").map((s) => s.symbol));
}

// ---- Signed: account fee tier ----

export async function getPerpTakerFee(symbol: string, apiKey: string, apiSecret: string): Promise<number> {
  const raw = await signedGet<{ takerCommissionRate: string }>(FAPI, "/fapi/v1/commissionRate", { symbol }, apiKey, apiSecret);
  return Number(raw.takerCommissionRate);
}

export async function getSpotTakerFee(symbol: string, apiKey: string, apiSecret: string): Promise<number> {
  const raw = await signedGet<{ standardCommission: { taker: string } }>(
    SPOT, "/api/v3/account/commission", { symbol }, apiKey, apiSecret,
  );
  return Number(raw.standardCommission.taker);
}
