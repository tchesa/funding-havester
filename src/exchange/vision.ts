import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import { logger } from "../log.js";

const log = logger("vision");

const LIST_BASE = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision";
const FILE_BASE = "https://data.binance.vision";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** List "sub-directories" under an S3 prefix (handles pagination). */
export async function listPrefixes(prefix: string): Promise<string[]> {
  const out: string[] = [];
  let marker = "";
  for (;;) {
    const url = `${LIST_BASE}?delimiter=/&prefix=${encodeURIComponent(prefix)}${marker ? `&marker=${encodeURIComponent(marker)}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`list ${prefix} -> ${res.status}`);
    const xml = await res.text();
    const found = [...xml.matchAll(/<CommonPrefixes><Prefix>([^<]+)<\/Prefix><\/CommonPrefixes>/g)].map((m) => m[1]!);
    out.push(...found);
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const next = /<NextMarker>([^<]+)<\/NextMarker>/.exec(xml)?.[1] ?? found.at(-1);
    if (!truncated || !next) return out;
    marker = next;
  }
}

/** Months (YYYY-MM) that have a monthly .zip under a directory prefix — one cheap listing instead of probing each URL. */
export async function listMonths(dirPrefix: string): Promise<Set<string>> {
  const out = new Set<string>();
  let marker = "";
  for (;;) {
    const url = `${LIST_BASE}?prefix=${encodeURIComponent(dirPrefix)}${marker ? `&marker=${encodeURIComponent(marker)}` : ""}`;
    let xml = "";
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status}`);
        xml = await res.text();
        break;
      } catch (e) {
        if (attempt >= 4) throw new Error(`list ${dirPrefix} failed: ${(e as Error).message}`);
        await sleep(1000 * 2 ** attempt);
      }
    }
    const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!);
    for (const k of keys) {
      const m = /-(\d{4}-\d{2})\.zip$/.exec(k);
      if (m) out.add(m[1]!);
    }
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml) || !keys.length) return out;
    marker = keys.at(-1)!;
  }
}

export const visionDirs = {
  funding: (sym: string) => `data/futures/um/monthly/fundingRate/${sym}/`,
  perp: (sym: string) => `data/futures/um/monthly/klines/${sym}/1h/`,
  premium: (sym: string) => `data/futures/um/monthly/premiumIndexKlines/${sym}/1h/`,
  spot: (sym: string) => `data/spot/monthly/klines/${sym}/1h/`,
};

/**
 * Download a monthly archive and return the CSV text, or null if it doesn't exist (404).
 * Archives are cached on disk; a missing archive is cached as an empty marker file.
 */
export async function fetchCsv(cacheDir: string, path: string): Promise<string | null> {
  const local = join(cacheDir, path);
  const missing = `${local}.missing`;
  if (existsSync(missing)) return null;

  let zip: Uint8Array;
  if (existsSync(local)) {
    zip = readFileSync(local);
  } else {
    const fetched = await download(`${FILE_BASE}/${path}`);
    mkdirSync(dirname(local), { recursive: true });
    if (fetched === null) {
      writeFileSync(missing, "");
      return null;
    }
    writeFileSync(local, fetched);
    zip = fetched;
  }

  const files = unzipSync(zip);
  const first = Object.values(files)[0];
  if (!first) throw new Error(`empty archive ${path}`);
  return new TextDecoder().decode(first);
}

async function download(url: string): Promise<Uint8Array | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (attempt >= 4) throw new Error(`download ${url} failed: ${(e as Error).message}`);
      const wait = 1000 * 2 ** attempt;
      log.warn("download failed, retrying", { url, attempt, wait });
      await sleep(wait);
    }
  }
}

export const visionPaths = {
  funding: (sym: string, month: string) => `data/futures/um/monthly/fundingRate/${sym}/${sym}-fundingRate-${month}.zip`,
  perp: (sym: string, month: string) => `data/futures/um/monthly/klines/${sym}/1h/${sym}-1h-${month}.zip`,
  premium: (sym: string, month: string) => `data/futures/um/monthly/premiumIndexKlines/${sym}/1h/${sym}-1h-${month}.zip`,
  spot: (sym: string, month: string) => `data/spot/monthly/klines/${sym}/1h/${sym}-1h-${month}.zip`,
};
