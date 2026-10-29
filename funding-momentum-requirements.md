# funding-momentum — Requirements

Test whether **high funding rates predict further upside** (continuation) rather than a squeeze, and whether a directional long strategy built on that signal survives costs, funding payments and out-of-sample testing.

Built inside the existing **funding-harvester** repo, reusing its data, cost model, simulator conventions and walk-forward harness.

---

## 1. Background and hypothesis

The funding-harvester Phase 0 report found that carry lost money on **basis**: coins with very high funding kept rallying, so the short perp leg lost more than the funding earned. That suggests:

> **H1:** When a coin's funding rate is unusually high (optionally together with rising price and volume), its price tends to keep rising over the following hours to days.

The test must also distinguish this from plain price momentum:

> **H2:** Funding adds predictive value **beyond** recent price and volume momentum.

If H1 holds but H2 doesn't, funding is just a noisy proxy for momentum, and a funding-based strategy has no reason to exist.

**Main risks to the hypothesis**
- The carry losses may come from a handful of huge pumps (fat-tailed), not a repeatable effect.
- Being long when funding is high means **paying** that funding, which can be very expensive (0.1% per 8h ≈ 110% APR).
- Squeeze-prone coins also crash hard; long-side tail risk is real.

---

## 2. Scope

**In scope**
- Phase A: event study (no trading simulation).
- Phase B: directional long strategy simulation with walk-forward evaluation.
- Two execution variants: **long perp** (pays funding, liquidation risk) and **long spot** (no funding, no liquidation, needs a spot market).
- Venues: Binance, Bybit, OKX (data already backfilled).

**Out of scope**
- Short-side strategies (fading high funding) except as a control in the event study.
- Live or paper trading.
- New data sources.

---

## 3. Data requirements

Reuse `data/funding.sqlite` and the existing backfill. No new downloads expected.

| Requirement | Detail |
|---|---|
| R-D1 | Hourly perp and spot klines, funding history and (Binance, Bybit) premium-index bars, 2023-01 → 2026-10 |
| R-D2 | **Delisted symbols included** (survivorship bias is a bigger issue for longs than for carry) |
| R-D3 | Funding normalized to per 8h, with the interval inferred per payment (existing logic) |
| R-D4 | BTC hourly returns available as the market benchmark for each venue |
| R-D5 | Data gaps flagged; a symbol with stale or missing bars is not tradeable at that hour |

---

## 4. Phase A — Event study

Goal: a cheap answer to H1 and H2 before building any strategy.

### 4.1 Events
At each funding settlement (normalized per 8h) for each symbol in the universe (section 5.1), record an observation with:
- funding rate (realized, per 8h) and, where available, the predicted rate
- funding z-score vs the symbol's own trailing 30-day distribution
- price return over the prior 24h and 7d
- volume ratio: 24h volume ÷ trailing 7-day average daily volume
- 7-day realized volatility (annualized)
- venue, coin, timestamp

### 4.2 Outcomes
Forward returns from the **next bar's open** at horizons 1h, 4h, 8h, 24h, 72h, 7d:
- raw return
- BTC-adjusted return (coin return minus BTC return over the same span)
- maximum adverse excursion (worst drawdown within the horizon)
- funding a long perp would have paid over the horizon

### 4.3 Analysis
- **R-A1** Bucket observations by funding level (deciles and fixed thresholds: 0.01%, 0.03%, 0.05%, 0.1%, 0.2%+ per 8h) and report mean, median, hit rate and tail percentiles of forward returns per bucket.
- **R-A2** Same, bucketed by prior 24h price return alone (the price-momentum control).
- **R-A3** Double sort: funding bucket × prior-return bucket. **H2 is supported only if high funding shows higher forward returns within the same prior-return bucket.**
- **R-A4** Report results net of the funding a long perp would pay, not only raw returns.
- **R-A5** Robustness: results by year, by venue, by volatility bucket, and with the top 1% of outcomes removed (to detect fat-tail dependence).
- **R-A6** Count independent events: overlapping observations on the same coin in the same pump must not be treated as independent. Report the number of distinct (coin, episode) clusters.

### 4.4 Phase A gate
Proceed to Phase B only if:
- the highest funding buckets show positive **median** BTC-adjusted forward returns at some horizon ≥ 8h, net of long funding,
- the effect survives the double sort (H2),
- the effect holds in at least 2 of the 3+ years and does not depend on the top 1% of outcomes.

Otherwise: write up the findings and stop.

---

## 5. Phase B — Strategy simulation

### 5.1 Universe
- Listed ≥ 30 days on the venue.
- Perp 24h volume ≥ $20M (tunable); spot 24h volume ≥ $10M for the spot variant.
- Not a stablecoin.
- Fresh data for the decision hour.

### 5.2 Entry signal (all tunable)
Enter long when, at decision time:
- funding (per 8h, realized and/or predicted blend) ≥ `entryFunding`, **or** funding z-score ≥ `entryZ` (grid selects which form),
- prior `lookbackHours` return ≥ `minPriorReturn` (can be set to off),
- volume ratio ≥ `minVolumeRatio` (can be set to off),
- 7-day volatility ≤ `maxEntryVolatility` (can be set to off),
- the coin has no open position and is not in a re-entry cooldown.

Decisions run hourly; fills at the next bar per existing clock conventions.

### 5.3 Exit rules (all tunable, first one hit wins)
- **Hard stop:** price falls `stopLossPct` below entry.
- **Trailing stop:** price falls `trailPct` (or `trailAtr` × ATR) below the highest close since entry.
- **Funding exit:** funding drops below `exitFunding` (signal has faded).
- **Time stop:** position age reaches `maxHoldHours`.
- **Delisting:** forced exit at the announcement (7 days before last funding), or at the last available price if the data ends first.

Stops are checked intrabar against the bar's low, with a configurable **gap fill** (stop filled at the worse of the stop price and the bar's low plus slippage) to avoid assuming perfect stop fills on violent moves.

### 5.4 Sizing
- `maxPositions` concurrent (start 5).
- Size per position either fixed fraction of equity (`positionPct`, start 10%) or risk-based (`riskPct` of equity ÷ stop distance), grid-selectable.
- At most one position per coin across venues.
- Perp variant leverage `leverage` 1x by default, max 2x.

### 5.5 Execution variants
| Variant | Instrument | Funding | Liquidation | Notes |
|---|---|---|---|---|
| `perp` | Long USDT perp | **Pays** funding at each settlement while held | Isolated margin, existing liquidation model with 0.5% maintenance | Same mark-price approximation as carry |
| `spot` | Long spot | None | None | Only coins with a spot market; signal still from perp funding |

### 5.6 Costs
Reuse the existing cost model: taker fees per venue and leg, BNB discount on Binance spot, slippage `a + b·√(notional / hourly volume)` capped at 3%, plus the maker/VIP and zero-cost presets for sensitivity runs.

### 5.7 Attribution
Every trade's P&L split into **price, funding paid, fees, slippage**. Report how much of gross price P&L funding payments consume.

---

## 6. Controls and baselines

Each must run through the same walk-forward harness and cost model:

| ID | Baseline | Purpose |
|---|---|---|
| B1 | Price momentum only: same entry/exit, funding condition removed | Tests H2 directly |
| B2 | Random entry: same number of trades, same universe, same exits, random timing (≥ 20 seeds) | Rules out "any trade in these coins works" |
| B3 | Buy and hold BTC | Market benchmark |
| B4 | Equal-weight buy and hold of the universe, rebalanced weekly | Rules out "altcoins just went up" |

**The strategy only counts if it beats B1 and B2 out-of-sample**, not just if it's profitable.

---

## 7. Evaluation

### 7.1 Walk-forward
Same harness as funding-harvester: train 6 months, test 3 months, step 3 months, 12 test windows (2023-09 → 2026-09). Best combo per window chosen on train by `APR − 0.5·maxDD`; reported numbers chain test windows only.

### 7.2 Metrics (per variant and baseline)
- OOS APR, max drawdown, Sharpe and Sortino (hourly returns, annualized)
- per-window APR std dev and % of windows positive
- trades, win rate, average and median trade return, average hold time
- **concentration:** share of total P&L from the top 5 trades and top 5 coins
- **APR with the top 5 trades removed**
- liquidations (perp variant), worst single trade, worst single day
- exposure (average fraction of equity deployed)

### 7.3 Go/no-go bar (proposed; confirm before running)
- OOS APR ≥ 20% with max drawdown ≤ 25%
- Sharpe ≥ 1.0
- ≥ 67% of windows positive
- still positive with the top 5 trades removed
- beats B1 by ≥ 5 points APR at similar or lower drawdown
- beats the B2 median and at least 90% of B2 seeds
- 0 liquidations at the chosen leverage (perp variant)

The higher bar compared to carry (8%) reflects that this is a directional strategy with much more risk than a hedged one.

---

## 8. Integrity requirements

- **R-I1 No lookahead:** decisions see only the snapshot before decision time (existing pattern). Funding is usable only after its settlement timestamp; predicted rates only from premium-index bars already closed.
- **R-I2 No survivorship:** delisted coins remain in the universe until their delisting; a long held into a delisting takes the realized loss.
- **R-I3 Tests:** unit tests for signal computation, stop logic (including gap fills), funding paid by longs, and a lookahead test that fails if any decision reads a future bar.
- **R-I4 Reproducibility:** each sweep writes `reports/<ts>-<label>.md|json` with the config, grid, git commit and results.
- **R-I5 Sanity reproduction:** existing carry sweeps must still reproduce their published numbers after the refactor.

---

## 9. Implementation notes

Fits the existing layout:

```
src/
├── research/
│   └── eventStudy.ts        # Phase A: observations, buckets, double sort, report
├── strategy/
│   └── momentum/            # pure functions: signal, entry, exit, sizing
├── backtest/
│   └── directionalSim.ts    # long-only sim (perp + spot variants), reuses clock/costs/liquidation
└── baselines/               # B1–B4
```

Commands:
- `pnpm study` → Phase A report
- `pnpm sweep --strategy momentum --variant perp|spot [--params …] [--grid …] [--label …]`
- `pnpm baselines --strategy momentum [--seeds 20]`

Grid size target: ≤ 500 combos per variant, so a sweep stays in the same few-minutes range as carry.

---

## 10. Deliverables

1. Phase A event-study report with the gate decision.
2. If the gate passes: Phase B sweep reports for both variants and all baselines.
3. A final `report.md` in the same format as the funding-harvester report: verdict, implementation, results tables, conclusions, caveats.

---

## 11. Open questions

- Confirm the go/no-go bar in 7.3 before running Phase B.
- Signal form: absolute funding threshold vs per-coin z-score (both supported; the grid decides, but limiting to one reduces overfitting risk).
- Whether the OKX predicted-rate fallback (last realized rate) is acceptable, or OKX should be limited to realized-rate signals.
- Maximum acceptable leverage for the perp variant (default 1x).
