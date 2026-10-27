import type { Metrics } from "./metrics.js";

export const pct = (x: number, d = 2) => `${(x * 100).toFixed(d)}%`;
export const usd = (x: number) => `${x < 0 ? "-" : ""}$${Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export function summarize(m: Metrics): string {
  const lines = [
    `Net APR ${pct(m.netApr)} | return ${pct(m.netReturn)} | max DD ${pct(m.maxDrawdown)} | final ${usd(m.finalEquity)}`,
    `Deployed ${pct(m.deployedShare, 0)} of hours | avg utilization ${pct(m.avgUtilization, 0)} | turnover ${m.turnover.toFixed(1)}x/yr`,
    `Trades ${m.trades} | avg hold ${(m.avgHoldingHours / 24).toFixed(1)}d | win rate ${pct(m.winRate, 0)} | liquidations ${m.liquidations} | top-ups ${m.topups} | reductions ${m.reductions}`,
    `Income: funding ${usd(m.income.funding)} | fees -${usd(m.income.fees)} | slippage -${usd(m.income.slippage)} | basis ${usd(m.income.basis)} | net ${usd(m.income.net)}`,
    `Regimes: bull ${pct(m.regimes.bull.apr)} APR (${m.regimes.bull.hours}h) | bear ${pct(m.regimes.bear.apr)} APR (${m.regimes.bear.hours}h)`,
  ];
  return lines.join("\n");
}
