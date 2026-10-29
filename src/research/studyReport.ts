import { clusterIds, clusterStats, HORIZONS, type Observation, quantile, type Stats, stats, trimTop } from "./eventStudy.js";

/** Phase A analysis + markdown (funding-momentum requirements §4.3–4.4). */

const pct = (x: number, d = 2) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : "–");
const bp8 = (x: number) => `${(x * 100).toFixed(2)}%`;
const H = (h: number) => (h >= 24 ? `${h / 24}d` : `${h}h`);

/** Funding is "net" for a long perp: BTC-adjusted return minus funding paid. */
const net = (o: Observation, hi: number) => o.btcAdj[hi]! - o.fundingPaid[hi]!;

export interface Bucket {
  name: string;
  test: (o: Observation) => boolean;
}

const FIXED_EDGES = [0, 0.0001, 0.0003, 0.0005, 0.001, 0.002];
export const FIXED_BUCKETS: Bucket[] = [
  { name: "< 0", test: (o) => o.funding8h < 0 },
  ...FIXED_EDGES.slice(0, -1).map((lo, k) => {
    const hi = FIXED_EDGES[k + 1]!;
    return { name: `${bp8(lo)}–${bp8(hi)}`, test: (o: Observation) => o.funding8h >= lo && o.funding8h < hi };
  }),
  { name: `≥ ${bp8(0.002)}`, test: (o) => o.funding8h >= 0.002 },
];

function quantileBuckets(obs: Observation[], value: (o: Observation) => number, k: number, label: string): Bucket[] {
  const v = obs.map(value).filter(Number.isFinite).sort((a, b) => a - b);
  const edges = Array.from({ length: k - 1 }, (_, j) => quantile(v, (j + 1) / k));
  return Array.from({ length: k }, (_, j) => {
    const lo = j === 0 ? -Infinity : edges[j - 1]!;
    const hi = j === k - 1 ? Infinity : edges[j]!;
    const name = `${label}${j + 1} (${Number.isFinite(lo) ? pct(lo) : "−∞"} … ${Number.isFinite(hi) ? pct(hi) : "∞"})`;
    return { name, test: (o: Observation) => value(o) >= lo && value(o) < hi };
  });
}

/** "High funding" definitions the gate checks (each reported). */
export function highDefinitions(obs: Observation[]): Bucket[] {
  const v = obs.map((o) => o.funding8h).sort((a, b) => a - b);
  const d9 = quantile(v, 0.9);
  return [
    { name: "funding ≥ 0.05%/8h", test: (o) => o.funding8h >= 0.0005 },
    { name: "funding ≥ 0.10%/8h", test: (o) => o.funding8h >= 0.001 },
    { name: `top funding decile (≥ ${bp8(d9)}/8h)`, test: (o) => o.funding8h >= d9 },
    { name: "funding z ≥ 2", test: (o) => o.fundingZ >= 2 },
  ];
}
const NORMAL: Bucket = { name: "normal funding (0.005–0.03%/8h)", test: (o) => o.funding8h >= 0.00005 && o.funding8h < 0.0003 };

const yearOf = (o: Observation) => new Date(o.time).getUTCFullYear();

export interface GateResult {
  pass: boolean;
  lines: string[];
  /** Per high definition × horizon (≥ 8h). */
  checks: Array<{ def: string; horizon: string; g1: boolean; g2: boolean; g3: boolean; detail: string }>;
}

export function evaluateGate(obs: Observation[], quintiles: Bucket[]): GateResult {
  const checks: GateResult["checks"] = [];
  const years = [...new Set(obs.map(yearOf))].sort();
  for (const def of highDefinitions(obs)) {
    const hiObs = obs.filter(def.test);
    HORIZONS.forEach((h, hi) => {
      if (h < 8) return;
      const s = stats(hiObs.map((o) => net(o, hi)));
      const cs = clusterStats(hiObs, (o) => net(o, hi));
      const g1 = s.median > 0 && cs.median > 0;
      let wins = 0;
      const diffs: string[] = [];
      for (const q of quintiles) {
        const a = stats(hiObs.filter(q.test).map((o) => net(o, hi))).median;
        const b = stats(obs.filter((o) => q.test(o) && NORMAL.test(o)).map((o) => net(o, hi))).median;
        if (a > b) wins++;
        diffs.push(pct(a - b));
      }
      const g2 = wins >= 4;
      const posYears = years.filter((y) => stats(hiObs.filter((o) => yearOf(o) === y).map((o) => net(o, hi))).median > 0);
      const trimmed = stats(trimTop(hiObs.map((o) => net(o, hi)), 0.01));
      const g3 = posYears.length >= 2 && trimmed.mean > 0 && trimmed.median > 0;
      checks.push({
        def: def.name, horizon: H(h), g1, g2, g3,
        detail: `median ${pct(s.median)} (episodes ${pct(cs.median)}); beats normal in ${wins}/5 prior-return quintiles [${diffs.join(", ")}]; positive years ${posYears.join("/") || "none"}; trimmed mean ${pct(trimmed.mean)}`,
      });
    });
  }
  const pass = checks.some((c) => c.g1 && c.g2 && c.g3);
  return { pass, checks, lines: [] };
}

export interface StudyMeta {
  generatedAt: number;
  commit: string;
  from: number;
  to: number;
  venues: string[];
  options: Record<string, unknown>;
}

export function buildReport(obs: Observation[], meta: StudyMeta): { md: string; json: unknown } {
  const md: string[] = [];
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const ids = clusterIds(obs);
  const nClusters = new Set(ids).size;
  const quintiles = quantileBuckets(obs, (o) => o.ret24h, 5, "R");
  const gate = evaluateGate(obs, quintiles);

  md.push(`# funding-momentum Phase A: event study`, "");
  md.push(`Generated ${new Date(meta.generatedAt).toISOString()} · commit ${meta.commit} · ${iso(meta.from)} → ${iso(meta.to)} · venues ${meta.venues.join(", ")}`, "");
  md.push(`- Observations: ${obs.length.toLocaleString()} (one per symbol per 8h mark), ${new Set(obs.map((o) => o.symbol)).size} symbols, ${new Set(obs.map((o) => o.base)).size} coins, ${nClusters.toLocaleString()} (coin, episode) clusters (gap > 72h starts a new one).`);
  md.push(`- Entry at the next bar's open after the funding settlement; outcomes on the perp. **net** = BTC-adjusted return − funding a long perp pays over the horizon.`);
  md.push(`- Universe: ${JSON.stringify(meta.options)}`, "");

  md.push(`## Gate: ${gate.pass ? "PASS ✅ (proceed to Phase B)" : "FAIL ❌ (stop)"}`, "");
  md.push(`Passes if, for some "high funding" definition and horizon ≥ 8h: **G1** median net > 0 (per observation and per episode), **G2** beats normal funding (0.005–0.03%/8h) in ≥ 4 of 5 prior-24h-return quintiles, **G3** median net > 0 in ≥ 2 calendar years and mean/median net still > 0 with the top 1% of outcomes removed.`, "");
  md.push(`| High definition | Horizon | G1 | G2 | G3 | Detail |`, `|---|---|---|---|---|---|`);
  const ok = (b: boolean) => (b ? "✅" : "❌");
  for (const c of gate.checks) md.push(`| ${c.def} | ${c.horizon} | ${ok(c.g1)} | ${ok(c.g2)} | ${ok(c.g3)} | ${c.detail} |`);
  md.push("");

  const statRow = (name: string, sub: Observation[], hi: number, withClusters = true) => {
    const s = stats(sub.map((o) => net(o, hi)));
    const r = stats(sub.map((o) => o.btcAdj[hi]!));
    const f = stats(sub.map((o) => o.fundingPaid[hi]!));
    const m = stats(sub.map((o) => o.mae[hi]!));
    const cs = withClusters ? clusterStats(sub, (o) => net(o, hi)).median : NaN;
    const nc = withClusters ? new Set(clusterIds(sub)).size : NaN;
    return `| ${name} | ${s.n.toLocaleString()} | ${Number.isFinite(nc) ? nc.toLocaleString() : "–"} | ${pct(r.median)} | ${pct(f.mean)} | **${pct(s.median)}** | ${pct(cs)} | ${pct(s.mean)} | ${pct(s.hit, 0)} | ${pct(s.p5)} | ${pct(s.p95)} | ${pct(m.median)} |`;
  };
  const statHead = [
    `| Bucket | Obs | Episodes | Median BTC-adj | Mean funding paid | Median net | Episode median net | Mean net | Hit (net > 0) | p5 net | p95 net | Median MAE |`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|`,
  ];

  const medianGrid = (title: string, buckets: Bucket[], value: (o: Observation, hi: number) => number, agg: "median" | "mean" = "median") => {
    md.push(`### ${title}`, "");
    md.push(`| Bucket | Obs | ${HORIZONS.map(H).join(" | ")} |`, `|---|---|${HORIZONS.map(() => "---").join("|")}|`);
    for (const b of buckets) {
      const sub = obs.filter(b.test);
      md.push(`| ${b.name} | ${sub.length.toLocaleString()} | ${HORIZONS.map((_, hi) => pct(stats(sub.map((o) => value(o, hi)))[agg])).join(" | ")} |`);
    }
    md.push("");
  };

  md.push(`## R-A1: by funding level`, "");
  medianGrid("Median net return (BTC-adjusted, after long funding), fixed buckets per 8h", FIXED_BUCKETS, net);
  medianGrid("Median BTC-adjusted return before funding, fixed buckets", FIXED_BUCKETS, (o, hi) => o.btcAdj[hi]!);
  medianGrid("Median raw return, fixed buckets", FIXED_BUCKETS, (o, hi) => o.raw[hi]!);
  const deciles = quantileBuckets(obs, (o) => o.funding8h, 10, "D");
  medianGrid("Median net return by funding decile", deciles, net);
  for (const hi of [2, 3, 4, 5]) {
    md.push(`### Detail at ${H(HORIZONS[hi]!)}`, "", ...statHead);
    for (const b of FIXED_BUCKETS) md.push(statRow(b.name, obs.filter(b.test), hi));
    md.push("");
  }

  md.push(`## R-A2: by prior 24h return (price-momentum control)`, "");
  medianGrid("Median BTC-adjusted return by prior-24h-return quintile", quintiles, (o, hi) => o.btcAdj[hi]!);
  medianGrid("Median net return (long perp) by prior-24h-return quintile", quintiles, net);

  md.push(`## R-A3: double sort (funding × prior 24h return)`, "");
  const groups: Bucket[] = [
    { name: "< 0", test: (o) => o.funding8h < 0 },
    { name: "0–0.005%", test: (o) => o.funding8h >= 0 && o.funding8h < 0.00005 },
    NORMAL,
    { name: "0.03–0.1%", test: (o) => o.funding8h >= 0.0003 && o.funding8h < 0.001 },
    { name: "≥ 0.1%", test: (o) => o.funding8h >= 0.001 },
  ];
  for (const hi of [2, 3, 4, 5]) {
    md.push(`### Median net at ${H(HORIZONS[hi]!)} (cell: median · obs)`, "");
    md.push(`| Prior 24h return | ${groups.map((g) => g.name).join(" | ")} |`, `|---|${groups.map(() => "---").join("|")}|`);
    for (const q of quintiles) {
      md.push(`| ${q.name} | ${groups.map((g) => {
        const sub = obs.filter((o) => q.test(o) && g.test(o));
        return `${pct(stats(sub.map((o) => net(o, hi))).median)} · ${sub.length}`;
      }).join(" | ")} |`);
    }
    md.push("");
  }

  md.push(`## R-A5: robustness of high funding (≥ 0.05%/8h)`, "");
  const high = obs.filter((o) => o.funding8h >= 0.0005);
  for (const hi of [3, 4, 5]) {
    md.push(`### At ${H(HORIZONS[hi]!)}`, "", ...statHead);
    for (const y of [...new Set(high.map(yearOf))].sort()) md.push(statRow(`year ${y}`, high.filter((o) => yearOf(o) === y), hi));
    for (const v of [...new Set(high.map((o) => o.venue))].sort()) md.push(statRow(`venue ${v}`, high.filter((o) => o.venue === v), hi));
    const volB: Array<[string, number, number]> = [["vol < 60%", 0, 0.6], ["vol 60–120%", 0.6, 1.2], ["vol 120–200%", 1.2, 2], ["vol ≥ 200%", 2, Infinity]];
    for (const [name, lo, up] of volB) md.push(statRow(name, high.filter((o) => o.vol7d >= lo && o.vol7d < up), hi));
    const tr = trimTop(high.map((o) => net(o, hi)), 0.01);
    const all = stats(high.map((o) => net(o, hi)));
    const t = stats(tr);
    md.push(`| all | ${all.n.toLocaleString()} | – | – | – | **${pct(all.median)}** | – | ${pct(all.mean)} | ${pct(all.hit, 0)} | ${pct(all.p5)} | ${pct(all.p95)} | – |`);
    md.push(`| top 1% removed | ${t.n.toLocaleString()} | – | – | – | **${pct(t.median)}** | – | ${pct(t.mean)} | ${pct(t.hit, 0)} | ${pct(t.p5)} | ${pct(t.p95)} | – |`);
    md.push("");
  }

  md.push(`## Signal variants (informational)`, "");
  const variants: Bucket[] = [
    ...highDefinitions(obs),
    { name: "funding ≥ 0.05% & prior 24h ≥ +5%", test: (o) => o.funding8h >= 0.0005 && o.ret24h >= 0.05 },
    { name: "funding ≥ 0.05% & volume ratio ≥ 2", test: (o) => o.funding8h >= 0.0005 && o.volumeRatio >= 2 },
    { name: "funding ≥ 0.05% & vol7d ≤ 120%", test: (o) => o.funding8h >= 0.0005 && o.vol7d <= 1.2 },
    { name: "prior 24h ≥ +5% (any funding)", test: (o) => o.ret24h >= 0.05 },
    { name: "prior 24h ≥ +5% & funding < 0.03%", test: (o) => o.ret24h >= 0.05 && o.funding8h < 0.0003 },
  ];
  medianGrid("Median net return", variants, net);
  medianGrid("Mean net return", variants, net, "mean");

  const json = {
    meta,
    observations: obs.length,
    clusters: nClusters,
    gate,
    fixed: FIXED_BUCKETS.map((b) => {
      const sub = obs.filter(b.test);
      return { bucket: b.name, horizons: HORIZONS.map((h, hi) => ({ h, net: stats(sub.map((o) => net(o, hi))), btcAdj: stats(sub.map((o) => o.btcAdj[hi]!)) as Stats })) };
    }),
  };
  return { md: md.join("\n"), json };
}
