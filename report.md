# funding-harvester: Phase 0 report

**Verdict: NO-GO.** No strategy we tested clears the go/no-go bar of **≥ 8% out-of-sample APR with zero liquidations**. A third idea, going long coins with high funding (*funding momentum*), failed its first-stage event study and was stopped before any strategy was built (section 4). The best results:

| Strategy | Best OOS APR | Max drawdown | Liquidations |
|---|---|---|---|
| Spot long / perp short carry (Binance + Bybit + OKX, filters, maker fees) | 2.51% | 0.44% | 0 |
| Cross-venue perp-perp funding spread (1–2x, volatility filter) | 3.91% | 1.84% | 2 |
| *Reference: stablecoin yield* | *~4–5%* | *~0* | *—* |

Both strategies earn less than parking the capital in stablecoin yield, and they carry exchange, execution and liquidation risk that stablecoin yield doesn't. Funding income has also shrunk over the test period. The best carry setup earned 8–9% APR in early 2024 test windows, but only about 0–1% in 2026.

---

## 1. Implementation

### Stack
- Node ≥ 22.13, ESM and TypeScript, run from source with `tsx`. TypeScript is strict, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- Storage uses `node:sqlite` in WAL mode, at `data/funding.sqlite`.
- Libraries: zod for config, fflate for archive zips, vitest for tests (49 tests).

### Data (`src/data/`, `src/exchange/`, `src/db/`)
Hourly history from 2023-01 to 2026-10 for three exchanges, **including delisted symbols**, so there's no survivorship bias.

| Venue | Source | Symbols (delisted) | Data |
|---|---|---|---|
| Binance | data.binance.vision monthly archives; REST for the current month | 479 (104) | funding, perp / spot / premium-index 1h klines |
| Bybit | REST v5 (serves delisted instruments and lists closed ones) | 603 (298) | funding, perp / spot / premium-index 1h klines |
| OKX | REST for live instruments; monthly archives for delisted ones and all funding history (1m candles aggregated to 1h) | 330 (111) | funding, perp / spot 1h klines |

Notes:
- **Symbol IDs:** IDs carry the venue prefix (`bybit:BTCUSDT`, `okx:BTCUSDT`), while Binance keeps bare IDs. Each symbol row records its underlying coin (`base`), so positions can be matched across venues.
- **Funding intervals:** symbols pay every 1h, 2h, 4h or 8h, and the interval changes over time. It's inferred per payment, and the strategy compares rates normalized to **per 8h**.
- **Resumable downloads:** the backfill tracks progress per (source, symbol, month).
- **Data limitations:**
  - OKX has no historical premium index.
  - Candles for delisted OKX perps only go back to Aug 2023.
  - Delisted OKX perps were found by probing coin names already seen on the other venues, so coins only ever listed on OKX are missing.

### Strategy code (`src/strategy/`)
All decision logic is in pure functions with no I/O, so a paper or live bot could reuse it. A decision only sees data from before decision time (a *snapshot*), so the backtest can't peek at future data.

- **`funding.ts`:** rate normalization, a linearly weighted average of the last k rates, and a reconstruction of Binance's *predicted* funding rate from premium-index bars. The reconstruction correlates about 0.9 with realized rates.
- **`entry.ts` / `exit.ts` / `allocate.ts` / `universe.ts`:** the carry strategy's rules (section 2.1).
- **`spread.ts`:** the cross-venue spread strategy's rules (section 2.2).

### Simulators (`src/backtest/`)
- **Clock:** both simulators step hourly. Bar *i* covers [t0 + i·H, t0 + (i+1)·H), and the "price at time i" is the close of bar i−1.
- **Order within each hour:**
  1. funding settles
  2. scheduled exits
  3. decisions
  4. equity is recorded
  5. the intrabar liquidation check runs on the bar's high or low
  6. margin is topped up or the position reduced at the bar close
- **Costs:**
  - Taker fees per leg and per venue, with the BNB discount on Binance spot.
  - Slippage per leg and side of `a + b·√(notional / hourly volume)`, capped at 3%.
  - Defaults: Binance spot 0.1% (×0.75 with BNB) and perp 0.05%; Bybit 0.1% / 0.055%; OKX 0.1% / 0.05%; slippage a = 2 bps, b = 0.01.
- **Liquidation:** each perp leg is an isolated-margin position. The liquidation price comes from the margin and a 0.5% maintenance rate. To approximate the mark price, the check uses the less extreme of the perp and spot highs or lows.
- **Margin protection:** when price gets within 30% of the liquidation distance, the sim tops up from cash, or cuts both legs by 25% if cash runs out.
- **Delistings:** a delisting is "announced" 7 days before a symbol's last funding, which forces an exit.
- **Attribution:** every trade's P&L is split into **funding, fees, slippage and basis** (price P&L of both legs).
- **Pooled capital:** capital is one shared pool. In reality it would be split per exchange, which is slightly optimistic.

### Walk-forward evaluation
- **Windows:** train 6 months, test 3 months, step 3 months. That gives 12 test windows covering **2023-09-01 → 2026-09-01**.
- **Selection:** in each window, the parameter grid runs on the train period. The best combo by `APR − 0.5·maxDD` is picked, and any combo with a liquidation is rejected. That combo then runs on the next, unseen test period.
- **Results:** reported numbers chain the test windows together, so they're **out-of-sample only**.
- **Grids:** 396 combos for carry, 144–216 for spread. A sweep runs on worker threads sharing one in-memory dataset and takes about 2–4 minutes.
- **Go/no-go bar:**
  - OOS APR ≥ 8%
  - window APR std dev ≤ 10%
  - ≥ 75% of windows positive
  - 0 liquidations
- **Commands:**
  - `pnpm sweep [--strategy carry|spread] [--venues …] [--params …] [--sim …] [--grid …] [--label …]`
  - Each sweep writes `reports/<ts>-<label>.md|json`.

---

## 2. Strategies

### 2.1 Carry: spot long + perp short (`--strategy carry`)
**Mechanics:** buy the coin on spot and short the same notional on the USDT perp of the same exchange. Price moves cancel, and the short collects funding while the rate is positive.

**Entry:** the coin must pass the universe filter:
- perp 24h volume ≥ $50M
- spot 24h volume ≥ $20M
- listed at least 30 days
- not a stablecoin

It then needs all of:
- a blended expected rate (weighted realized average of the last k rates plus the predicted rate) ≥ the entry threshold
- the last m realized rates all positive
- expected income over 30 periods ≥ safety factor × round-trip cost

**Exit:**
- the rolling average of the last n rates drops below the exit threshold, or
- the predicted rate turns negative (exit immediately), or
- the coin leaves the universe or is delisted.

Normal exits wait until just after the next funding payment.

**Sizing:** at most 3 positions, at most 25% of equity each, and 10% kept as reserve.

**Tuned in the grid:** entry threshold, exit threshold, k, m, n and safety factor.

**Filters added during testing** (all default off):

| Filter | What it does |
|---|---|
| `reentryCooldownHours` | block re-entry after a forced exit |
| `maxEntryRate8h` | skip coins whose funding is *too* high, which signals a squeeze |
| `universeTopN` | only the N most liquid coins |
| `maxEntryVolatility` | skip coins whose annualized 7-day realized volatility is above the cap |

**Multi-venue:** the universe can span Binance, Bybit and OKX. The sim holds at most one position per coin and picks the venue with the best expected net income.

### 2.2 Cross-venue funding spread: perp short + perp long (`--strategy spread`)
**Mechanics:** for a coin listed on two or more venues, short the perp where funding is highest and go long the perp where funding is lowest. Prices cancel across venues, and the position earns the funding difference. It doesn't need spot, and it doesn't need positive funding overall.

**Signal:** the expected rate per venue is a blend of the realized average over `lookbackHours` and the realized average over the last 24h, weighted by `recentWeight`. The expected spread is `rate(short venue) − rate(long venue)`.

**Entry:** both venues need:
- perp volume ≥ $20M per leg
- listed at least 30 days
- fresh prices
- optionally, volatility below a cap

The spread must be ≥ the entry threshold, and the expected spread income over 240h must be ≥ safety factor × both legs' round-trip cost.

**Exit:** the spread falls below the exit threshold, a leg leaves the universe, or a leg's data ends.

**Timing and sizing:**
- Decisions run every 8h (00/08/16 UTC).
- At most 5 positions, at most 20% of equity per position, and 20% kept as cash reserve for top-ups.

**Risk model:** each leg is an isolated position on its own exchange, posting notional ÷ leverage as margin.
- A rally liquidates the short leg; a crash liquidates the long leg.
- The winning leg's profit sits on the other exchange and **can't** be used to protect the losing leg. Only the cash pool can.

**Tuned in the grid:** lookback (24/72/168h), recent weight, entry threshold, exit threshold, safety factor and leverage.

---

## 3. Results

All numbers are **chained out-of-sample** results over 12 test windows (2023-09 → 2026-09). Each window starts from $10k.

Column key:
- **Std:** standard deviation of the APR across windows.
- **Pos:** share of windows with positive APR.
- **Liq:** liquidations.
- **Funding** and **Basis:** dollar totals summed over the windows.

### 3.1 Carry, Binance only

**Baseline and the first round of filters:**

| Variant | APR | Max DD | Std | Pos | Liq | Trades | Funding | Basis |
|---|---|---|---|---|---|---|---|---|
| baseline | 1.08% | 7.36% | 8.79% | 75% | 3 | 115 | $1,218 | −$281 |
| cooldown 7d | 1.06% | 7.42% | 8.75% | 75% | 3 | 105 | $1,197 | −$305 |
| cooldown 30d | 1.02% | 7.38% | 8.70% | 75% | 3 | 102 | $1,169 | −$307 |
| rate cap 0.05%/8h | −0.45% | 7.29% | 7.92% | 83% | 1 | 71 | $822 | −$572 |
| rate cap 0.10%/8h | 3.31% | 0.95% | 4.87% | 75% | 2 | 101 | $1,151 | +$359 |
| top 20 by liquidity | −3.04% | 15.91% | 12.16% | 67% | 3 | 97 | $1,140 | −$1,521 |
| top 50 by liquidity | 1.13% | 7.34% | 8.86% | 67% | 3 | 112 | $1,215 | −$283 |
| cooldown + cap + top-20 | −1.62% | 9.96% | 9.80% | 58% | 2 | 65 | $742 | −$871 |

**Lower fees.** Maker/VIP means maker orders on the perp and VIP fee tiers: spot 0.06%, perp 0.016%, with lower slippage. Zero cost removes all fees and slippage.

| Variant | APR | Max DD | Pos | Liq | Trades |
|---|---|---|---|---|---|
| perp maker | −4.57% | 19.37% | 58% | 4 | 222 |
| maker/VIP | −4.70% | 20.32% | 50% | 5 | 360 |
| maker/VIP + cap 0.10% | −2.40% | 14.14% | 75% | 2 | 328 |
| zero cost | −0.31% | 13.30% | 75% | 4 | 725 |
| zero cost + cap 0.10% | 0.88% | 9.83% | 83% | 2 | 741 |

**Volatility filter.** The cap is on annualized 7-day realized volatility.

| Variant | APR | Max DD | Std | Pos | Liq | Trades |
|---|---|---|---|---|---|---|
| vol ≤ 80% | 1.73% | 0.15% | 2.91% | 50% | 0 | 27 |
| vol ≤ 120% | 1.95% | 0.29% | 3.27% | 58% | 0 | 47 |
| vol ≤ 160% | 2.29% | 0.49% | 4.13% | 58% | 0 | 62 |
| vol ≤ 120% + cap 0.10% | 1.91% | 0.29% | 3.10% | 58% | 0 | 46 |
| vol ≤ 80% + cap 0.10% + maker/VIP | 2.17% | 0.11% | 2.56% | 100% | 0 | 75 |
| **vol ≤ 120% + cap 0.10% + maker/VIP** | **2.50%** | 0.35% | 2.97% | 92% | 0 | 117 |

What the Binance-only runs show:
- **Liquidations come from pumping coins.** High funding is mostly a squeeze signal. Without the volatility filter, the strategy shorts coins that are about to rally, and losses on the perp leg (basis) outweigh the funding.
- **Cutting costs alone made results worse.** Cheaper trading lets the strategy enter more of these risky coins. Even with zero costs it lost money (−0.31%).
- **Ranking by liquidity backfired.** "Top-20 by volume" selects coins at the moment they pump (for example BANANAS31 and ALPINE).
- **The volatility filter removes every liquidation and cuts drawdown to under 0.5%.** But the remaining calm coins pay little, so APR tops out around 2–2.5%.
- **Capital sits idle.** Average utilization is only about 35–48%, so the limit is the number of good opportunities, not capital.
- **Funding has shrunk over time.** Per-window APR in the best setup went 3.5%, 8.1%, 8.9% (2023-09 → 2024-06), then down to 0.1–0.6% in 2026.

### 3.2 Carry, multi-venue (Binance + Bybit + OKX)

| Variant | Venues | APR | Max DD | Std | Pos | Liq | Trades |
|---|---|---|---|---|---|---|---|
| no filters | all 3 | 0.52% | 7.19% | 8.89% | 67% | 7 | 160 |
| vol ≤ 120% + cap 0.10% | Binance | 1.91% | 0.29% | 3.10% | 58% | 0 | 46 |
| vol ≤ 120% + cap 0.10% | all 3 | 2.01% | 0.55% | 3.41% | 58% | 0 | 56 |
| vol ≤ 120% + cap 0.10% | Bybit only | 2.03% | 0.21% | 3.08% | 67% | 0 | 30 |
| vol ≤ 120% + cap 0.10% | OKX only | 1.00% | 0.76% | 2.25% | 25% | 0 | 62 |
| vol ≤ 120% + cap 0.10% + maker/VIP | Binance | 2.50% | 0.35% | 2.97% | 92% | 0 | 117 |
| **vol ≤ 120% + cap 0.10% + maker/VIP** | **all 3** | **2.51%** | 0.44% | 3.62% | 83% | 0 | 172 |

What adding Bybit and OKX shows:
- **More venues add almost nothing.** The extra trades are mostly OKX majors (DOGE, ETH, BTC, XRP, LTC) that pay little. Utilization stays around 45%.
- **Without filters, more venues make things worse.** They bring more volatile coins, and liquidations go from 3 to 7.
- **OKX alone is weakest.** It has no premium-index history, so its predicted rate falls back to the last realized rate.
- **The refactor didn't change Binance results.** Re-running the Binance-only sweeps after the multi-venue changes reproduced 1.08% and 2.50% exactly.

### 3.3 Cross-venue perp-perp spread (all 3 venues)

**Upper bound before simulating.** Since 2024, the daily funding gap between the best and worst venue per coin, taken with hindsight and with no costs, was:
- about 5.6% APR for BTC and ETH
- about 6–7% for SOL, XRP, DOGE, LINK and LTC
- 9.6% for BNB
- 8–30%+ for many altcoins

| Variant | APR | Max DD | Std | Pos | Liq | Trades | Funding | Fees + slip | Basis |
|---|---|---|---|---|---|---|---|---|---|
| leverage 2–3x | −20.39% | 49.64% | 18.60% | 17% | 34 | 989 | $5,682 | $6,230 | −$5,875 |
| leverage 1–2x, vol ≤ 120% | **3.91%** | 1.84% | 10.95% | 75% | 2 | 212 | $1,716 | $1,177 | +$653 |
| leverage 1–2x, vol ≤ 120%, maker/VIP | 3.76% | 9.49% | 17.87% | 83% | 3 | 334 | $2,073 | $665 | −$186 |
| leverage 1–2x, perp volume ≥ $200M | −1.42% | 4.66% | 5.72% | 58% | 2 | 300 | $1,672 | $935 | −$1,154 |
| leverage 1–2x, perp volume ≥ $200M, maker/VIP | −2.34% | 11.21% | 8.76% | 58% | 10 | 475 | $2,029 | $565 | −$2,140 |
| leverage 1x, vol ≤ 120% | 1.09% | 1.84% | 2.06% | 67% | 0 | 207 | $1,272 | $777 | −$168 |
| leverage 1x, vol ≤ 120%, maker/VIP | −0.18% | 5.03% | 5.75% | 75% | 2 | 335 | $1,207 | $405 | −$842 |

What the spread runs show:
- **The widest gaps appear during squeezes.** For example TRB, ONE, UNFI, MMT and F. Those are exactly the moments a 2–3x leg gets liquidated, often on a 30–45% intrabar move.
- **One leg can't protect the other.** The losing leg can't use the winning leg's profit on the other exchange. Even SOL's +44% day in July 2023 liquidated a 2x short once the cash reserve ran out.
  - We checked the data: Binance and OKX SOL prices agree to within about 0.1%.
- **Turnover is high.** Gaps flip quickly, so the average hold is about 4–5 days and fees plus slippage eat most of the funding.
- **"Majors only" by volume isn't majors-only.** Squeezing altcoins also cross $200M of daily volume.
- **Lower leverage removes liquidations and also the return.** At 1x, liquidations mostly disappear, but each leg is fully collateralized: twice the capital per unit of notional. APR drops to about 1%.

---

## 4. Funding momentum: Phase A event study (`pnpm study`)

Spec: `funding-momentum-requirements.md`.

**Hypotheses:**
- **H1:** coins with unusually high funding keep rising, which would explain the carry's basis losses.
- **H2:** funding predicts returns beyond plain price momentum.

**Process:** a cheap event study first (Phase A). The long-strategy simulation (Phase B) only gets built if a gate passes.

### Method (`src/research/`)
- **Observations:** one per symbol at every 00/08/16 UTC mark where it paid funding in the previous 8h.
  - Universe: perp volume ≥ $20M, listed at least 30 days, not a stablecoin, fresh data, stopped at the delisting announcement.
  - Venues: Binance, Bybit and OKX, 2023-03 → 2026-10.
  - **Totals: 817,060 observations, 1,301 symbols, 688 coins, 12,131 independent (coin, episode) clusters.** A new cluster starts after a gap of more than 72h; venues of the same coin share clusters.
- **Features**, all known at decision time:
  - realized funding over the past 8h, normalized per 8h
  - z-score against the coin's own previous 30 days
  - prior 24h and 7d return
  - 24h volume ÷ 7-day average
  - 7-day volatility
- **Outcomes** from the next bar's open at 1h, 4h, 8h, 1d, 3d and 7d:
  - raw return
  - BTC-adjusted return
  - worst drawdown within the horizon
  - funding a long perp pays over the horizon
  - **net** = BTC-adjusted return − funding paid
  - A coin delisted inside the horizon exits at its last price, so the loss counts.
- **Tests:** a test confirms no feature changes when future bars or funding change.
- **Automatic gate:** for some definition of "high funding" (≥ 0.05%/8h, ≥ 0.10%/8h, top decile, or z ≥ 2) and some horizon ≥ 8h, all three must hold:
  - **G1:** median net > 0, both per observation and per episode.
  - **G2:** beats normal funding (0.005–0.03%/8h) in ≥ 4 of 5 prior-return quintiles.
  - **G3:** positive in ≥ 2 years and still positive with the top 1% of outcomes removed.

### Results: gate FAIL (H1 rejected; the effect goes the other way)

**Median net return for a long perp, by funding level per 8h:**

| Funding | Obs | 8h | 1d | 3d | 7d |
|---|---|---|---|---|---|
| < 0 | 211,262 | −0.12% | −0.39% | −0.91% | −1.88% |
| 0–0.01% | 373,847 | −0.14% | −0.42% | −1.11% | −2.54% |
| 0.01–0.03% | 166,305 | −0.20% | −0.54% | −1.26% | −2.81% |
| 0.03–0.05% | 33,481 | −0.30% | −0.82% | −1.69% | −3.92% |
| 0.05–0.10% | 27,534 | −0.45% | −1.22% | −2.80% | −7.31% |
| 0.10–0.20% | 4,181 | −0.97% | −2.65% | −3.96% | −6.24% |
| ≥ 0.20% | 450 | −0.87% | −2.73% | −6.74% | −11.37% |

What the study shows:
- **Higher funding means worse forward returns, at every horizon from 4h to 7d.** This holds even *before* the funding a long pays: BTC-adjusted median at 1d is −0.40% for 0–0.01% funding versus −2.44% for 0.10–0.20%.
- **All 16 gate checks fail on all three criteria.** High funding never has a positive median at any horizon ≥ 8h.
- **No calendar year, venue or volatility bucket is positive.** Removing the top 1% of outcomes makes results worse.
- **H2 is also rejected.** Within every prior-24h-return quintile, high funding does *worse* than normal funding. At 1d, ≥ 0.1% funding trails normal funding by 1.4–2.6 points in every quintile.
- **Price momentum is negative too.** Coins up more than 4.5% over the prior 24h underperform BTC by a median of −1.1% the next day. The only positive number is +0.23% mean over 1h for funding ≥ 0.1%, which is smaller than a round trip's costs.
- **The tails are fat.** Means are much less negative than medians: at 3d, ≥ 0.05% funding has a median net of −2.95% but a mean of −0.66%, with p5 −18.9% and p95 +24.1%.
  - The typical high-funding coin fades, but a minority keep squeezing hard. That minority is what produced the carry strategy's liquidations and basis losses (the first risk listed in the spec).
- **Not pursued:** fading high funding (going short) shows a positive *median*. But it's a short-squeeze bet with the same fat right tail that already sank the carry, and it's out of scope for this spec.

Per the spec, the study stops here and Phase B wasn't built. Report: `reports/<ts>-study.md` (gitignored).

---

## 5. Conclusions

1. **Funding carry on these venues hasn't been worth running since 2024.** Positive funding on calm coins is small, and it has shrunk, because large players such as Ethena run the same trade at scale. High funding is mostly a squeeze signal, and harvesting it is a short-volatility bet that ends in liquidations.
2. **The only filter that matters is volatility.** It removes liquidations entirely. But what's left yields 2–2.5%, under stablecoin yield.
3. **Neither more venues nor lower fees fixes it.** The limit is how many good opportunities exist, not costs or capital. Utilization stays under 50%.
4. **Cross-venue spreads are a riskier version of the same bet.** Two separate exchanges mean two separate liquidation risks with no shared margin.
5. **High funding doesn't predict further upside.** Across 817k observations, high-funding coins underperform BTC at the median and the right tail is fat. Neither side of that trade is safe: longs bleed, and shorts (or carry) get squeezed.

### Caveats (most of these make the backtest *optimistic*)
- **One shared capital pool across exchanges.** Real capital would be split per exchange, and transfers would be delayed.
- **Hourly bars.** Decisions and fills happen once per hour at bar closes. The mark-price approximation (the less extreme of perp and spot) is a model, not the exchange's actual index.
- **Weaker predicted rates outside Binance.** OKX and Bybit predicted rates use the last realized rate (OKX) or the venue's own premium index (Bybit). The Binance reconstruction is validated; the others are not.
- **Stablecoin yield isn't modeled.** Idle capital earns nothing in the sim. Counting about 4% yield on idle capital would add roughly 2 points, which is still under the bar.
- **Spot isn't used as perp collateral.** Portfolio margin, where spot collateralizes the short, would raise capital efficiency by roughly 1.3× (best carry about 3.3%). Still under the bar.

### If this is revisited
The pipeline (downloads for three exchanges, simulators, walk-forward sweep, report) is reusable. Re-run `pnpm backfill` for each venue, then `pnpm sweep` with the best settings, if funding conditions change, for example a sustained bull market with broad positive funding. The best configs to start from:
- **Carry:** `--venues binance,bybit,okx --params '{"maxEntryVolatility":1.2,"maxEntryRate8h":0.001}'` plus maker/VIP fees in `--sim`.
- **Spread:** `--strategy spread --params '{"maxEntryVolatility":1.2}' --grid '{…,"leverage":[1,1.5,2]}'`.
