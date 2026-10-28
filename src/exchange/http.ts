import { logger } from "../log.js";

const log = logger("http");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_RETRIES = 6;

/** Spaces requests out to at most `perSecond` per instance (shared by all callers). */
export class Limiter {
  private next = 0;
  constructor(private readonly perSecond: number) {}
  async take(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + 1000 / this.perSecond;
    if (at > now) await sleep(at - now);
  }
}

/** Fetch with retry on network errors, 429 and 5xx. Returns null on 404. */
export async function fetchWithRetry(url: string, limiter?: Limiter): Promise<Response | null> {
  for (let attempt = 0; ; attempt++) {
    await limiter?.take();
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      if (attempt >= MAX_RETRIES) throw e;
      const wait = 1000 * 2 ** attempt;
      log.warn("network error, retrying", { url: url.slice(0, 120), attempt, wait, error: (e as Error).message });
      await sleep(wait);
      continue;
    }
    if (res.status === 404) return null;
    if (res.status === 429 || res.status === 403 || res.status >= 500) {
      if (attempt >= MAX_RETRIES) throw new Error(`GET ${url} -> ${res.status}`);
      const wait = Math.max(Number(res.headers.get("retry-after") ?? 0) * 1000, 1000 * 2 ** attempt);
      log.warn("retrying", { url: url.slice(0, 120), status: res.status, wait });
      await res.body?.cancel();
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return res;
  }
}

export async function getJson<T>(url: string, limiter?: Limiter): Promise<T> {
  const res = await fetchWithRetry(url, limiter);
  if (!res) throw new Error(`GET ${url} -> 404`);
  return (await res.json()) as T;
}

export function qs(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  return q.toString();
}
