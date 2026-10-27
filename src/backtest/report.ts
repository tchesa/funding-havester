import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GoCriteria, SimParams, StrategyParams } from "../config/params.js";
import { pct, usd } from "./format.js";
import type { Metrics } from "./metrics.js";
import { type CombinedOos, iso, type WindowResult } from "./walkforward.js";

export interface GoCheck {
  name: string;
  value: string;
  threshold: string;
  pass: boolean;
}

export function goNoGo(oos: CombinedOos, c: GoCriteria): { go: boolean; checks: GoCheck[] } {
  const checks: GoCheck[] = [
    { name: "OOS net APR", value: pct(oos.netApr), threshold: `≥ ${pct(c.minNetApr)}`, pass: oos.netApr >= c.minNetApr },
    { name: "Window APR std dev", value: pct(oos.aprStdDev), threshold: `≤ ${pct(c.maxAprStdDev)}`, pass: oos.aprStdDev <= c.maxAprStdDev },
    {
      name: "Positive windows", value: pct(oos.positiveWindowShare, 0), threshold: `≥ ${pct(c.minPositiveWindowShare, 0)}`,
      pass: oos.positiveWindowShare >= c.minPositiveWindowShare,
    },
    { name: "Liquidations", value: String(oos.liquidations), threshold: `≤ ${c.maxLiquidations}`, pass: oos.liquidations <= c.maxLiquidations },
  ];
  return { go: checks.every((x) => x.pass), checks };
}

const TUNED: Array<keyof StrategyParams> = ["entryThreshold", "exitThreshold", "k", "m", "n", "safetyFactor", "leverage", "maxPositions"];

export interface ReportInput {
  generatedAt: number;
  dataFrom: number;
  dataTo: number;
  symbols: number;
  combos: number;
  sim: SimParams;
  criteria: GoCriteria;
  results: WindowResult[];
  oos: CombinedOos;
  /** Full-period run with the most frequently selected params, for symbol/regime breakdowns. */
  fullPeriod: { params: StrategyParams; metrics: Metrics };
}

export function writeReport(dir: string, input: ReportInput): { md: string; json: string } {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(input.generatedAt).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const { go, checks } = goNoGo(input.oos, input.criteria);
  const o = input.oos;
  const fp = input.fullPeriod.metrics;

  const md: string[] = [];
  md.push(`# Phase 0 backtest report`, "");
  md.push(`Generated ${new Date(input.generatedAt).toISOString()} · data ${iso(input.dataFrom)} → ${iso(input.dataTo)} · ${input.symbols} symbols · ${input.combos} param combos · ${input.results.length} walk-forward windows`, "");
  md.push(`## Verdict: ${go ? "GO ✅" : "NO-GO ❌"}`, "");
  md.push(`| Check | Value | Threshold | Pass |`, `|---|---|---|---|`);
  for (const c of checks) md.push(`| ${c.name} | ${c.value} | ${c.threshold} | ${c.pass ? "✅" : "❌"} |`);
  md.push("");

  md.push(`## Out-of-sample (chained test windows)`, "");
  md.push(`- Net APR **${pct(o.netApr)}**, max drawdown ${pct(o.maxDrawdown)}, ${o.trades} trades`);
  md.push(`- Window APR mean ${pct(o.aprMean)}, std dev ${pct(o.aprStdDev)}, positive ${pct(o.positiveWindowShare, 0)}`);
  md.push(`- Income (sum over windows, $${input.sim.initialCapital.toLocaleString()} start each): funding ${usd(o.income.funding)}, fees -${usd(o.income.fees)}, slippage -${usd(o.income.slippage)}, basis ${usd(o.income.basis)}, **net ${usd(o.income.net)}**`, "");

  md.push(`## Walk-forward windows`, "");
  md.push(`| Test window | Train APR | Test APR | Test DD | Trades | Deployed | ${TUNED.join(" | ")} |`);
  md.push(`|---|---|---|---|---|---|${TUNED.map(() => "---").join("|")}|`);
  for (const r of input.results) {
    md.push(
      `| ${iso(r.window.testFrom)}..${iso(r.window.testTo)} | ${pct(r.train.netApr, 1)} | ${pct(r.test.netApr, 1)} | ${pct(r.test.maxDrawdown, 1)} | ${r.test.trades} | ${pct(r.test.deployedShare, 0)} | ${TUNED.map((k) => String(r.params[k])).join(" | ")} |`,
    );
  }
  md.push("");

  md.push(`## Full period with modal params (in-sample, for breakdowns only)`, "");
  md.push(`Params: ${TUNED.map((k) => `${k}=${input.fullPeriod.params[k]}`).join(", ")}`, "");
  md.push(`- Net APR ${pct(fp.netApr)}, max DD ${pct(fp.maxDrawdown)}, deployed ${pct(fp.deployedShare, 0)}, avg utilization ${pct(fp.avgUtilization, 0)}, turnover ${fp.turnover.toFixed(1)}x/yr`);
  md.push(`- Trades ${fp.trades}, avg hold ${(fp.avgHoldingHours / 24).toFixed(1)} days, win rate ${pct(fp.winRate, 0)}, liquidations ${fp.liquidations}, margin top-ups ${fp.topups}, reductions ${fp.reductions}`);
  md.push(`- Income: funding ${usd(fp.income.funding)}, fees -${usd(fp.income.fees)}, slippage -${usd(fp.income.slippage)}, basis ${usd(fp.income.basis)}, net ${usd(fp.income.net)}`);
  md.push(`- Regimes (BTC 30d trend): bull ${pct(fp.regimes.bull.apr)} APR over ${fp.regimes.bull.hours}h, bear ${pct(fp.regimes.bear.apr)} APR over ${fp.regimes.bear.hours}h`, "");
  md.push(`| Symbol | Trades | Funding | Net |`, `|---|---|---|---|`);
  for (const s of fp.bySymbol.slice(0, 15)) md.push(`| ${s.symbol} | ${s.trades} | ${usd(s.funding)} | ${usd(s.net)} |`);
  md.push("");

  md.push(`## Cost model`, "");
  md.push("```json", JSON.stringify(input.sim, null, 2), "```", "");

  const mdPath = join(dir, `${stamp}.md`);
  const jsonPath = join(dir, `${stamp}.json`);
  writeFileSync(mdPath, md.join("\n"));
  writeFileSync(
    jsonPath,
    JSON.stringify({ ...input, results: input.results.map(({ testCurve: _c, ...r }) => r), verdict: { go, checks } }, null, 2),
  );
  return { md: mdPath, json: jsonPath };
}
