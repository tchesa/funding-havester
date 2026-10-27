# funding-harvester — Implementation Plan

Delta-neutral funding rate carry bot for Binance: hold spot long + USDⓈ-M perpetual short on the same asset, collect positive funding, exit when it stops paying.

---

## 1. Goals and non-goals

**Goals**
- Earn funding payments with near-zero exposure to price direction.
- Only enter when expected funding clearly beats round-trip costs.
- Never get the short leg liquidated.
- Validate with backtest → paper trading → small live, with explicit go/no-go criteria between phases.

**Non-goals (v1)**
- Cross-exchange funding arbitrage.
- Directional "funding-skew" signals.
- Maker-only / limit-order execution optimization (later phase).
- Leverage above 2x on the short leg.

---

## 2. Strategy specification

### 2.1 Position structure
For a target notional `N` on asset `X`:
- **Spot leg:** buy `N` worth of `X` (spot wallet).
- **Perp leg:** short the same quantity of `XUSDT` perpetual (USDⓈ-M futures wallet), isolated margin, leverage `L` (default 1x, max 2x).
- **Capital used:** `N × (1 + 1/L)` plus a margin reserve.

Quantities must match after rounding to both markets' `stepSize`. Pay trading fees in BNB so the spot fee isn't deducted from the base asset (otherwise the spot leg ends up slightly smaller than the short).

### 2.2 Universe
Pairs that:
- Have both a spot market and a USDⓈ-M perpetual against USDT.
- Exceed a minimum 24h volume on both markets (start: $50M perp, $20M spot).
- Have been listed for at least 30 days (new listings have erratic funding).
- Are not on an exclusion list (stablecoins, delisting notices).

### 2.3 Entry rule
Each funding interval, for each candidate:

```
expected_funding_per_period = weighted avg of last k realized rates, blended with current predicted rate
expected_income = expected_funding_per_period × expected_holding_periods
round_trip_cost = 2 × spot_fee + 2 × perp_fee + estimated slippage
ENTER if expected_income > round_trip_cost × safety_factor
     and predicted rate > entry_threshold
     and rate has been positive for the last m periods
```

Reference math at the baseline rate: 0.01% per 8h ≈ 11% APR, while round-trip taker cost is roughly 0.2–0.3%. That's ~20–30 funding periods (7–10 days) just to break even, so **holding period matters more than picking the highest rate today.** The backtest should confirm this and set the thresholds.

### 2.4 Exit rule
Exit a position when any of:
- Rolling average funding falls below `exit_threshold` for `n` consecutive periods.
- Predicted funding is negative and larger in magnitude than a tolerance.
- Pair fails the universe filter (volume, delisting).
- A risk rule forces it (section 5).

Note: funding is paid only if the position is open at the funding timestamp. Time entries just before and exits just after a funding timestamp.

### 2.5 Sizing and allocation
- Max positions: 5 (start with 3).
- Max per position: 25% of capital.
- Allocate to the best candidates by expected net income, not by raw rate.
- Keep at least 10% of capital as USDT reserve for margin top-ups.

### 2.6 Parameters (initial values, tuned in Phase 0)

| Parameter | Start |
|---|---|
| `k` (lookback periods) | 9 (3 days at 8h) |
| `m` (positive streak required) | 6 |
| `entry_threshold` | 0.015% per 8h |
| `exit_threshold` | 0.005% per 8h |
| `n` (exit confirmation periods) | 3 |
| `safety_factor` | 1.5 |
| `expected_holding_periods` | 30 |
| Leverage on short | 1x |

---

## 3. Architecture

Node.js + TypeScript on an always-on VPS. Same pattern as earlier bots: **Binance is the source of truth for positions and balances; the local DB holds strategy state and history.**

```
funding-harvester/
├── src/
│   ├── config/            # params, universe filters, env loading
│   ├── exchange/          # Binance spot + futures clients, rate limiting, retries
│   ├── data/              # funding/price/fee collectors, historical backfill
│   ├── strategy/          # scoring, entry/exit decisions (pure functions)
│   ├── execution/         # paired order placement, leg reconciliation
│   ├── risk/              # margin monitor, imbalance checks, kill switch
│   ├── portfolio/         # positions, PnL attribution (funding vs fees vs basis)
│   ├── scheduler/         # funding-cycle loop + fast risk loop
│   ├── alerts/            # Telegram notifications
│   └── backtest/          # simulator reusing strategy/ functions
├── db/migrations/
├── scripts/               # backfill, reports, one-off ops
└── tests/
```

**Key design rule:** `strategy/` is pure (inputs → decisions), so the backtester, paper mode and live mode all call the same code. Only `exchange/` and `execution/` differ by mode (`backtest | paper | live`).

### 3.1 Loops
- **Funding cycle loop** (aligned to funding timestamps, ~10 min before each): refresh rates, score universe, decide entries/exits, execute.
- **Risk loop** (every 15–30s): margin ratio, leg imbalance, liquidation distance, API health.
- **Reconciliation loop** (every 5 min): compare DB state to Binance positions and balances; alert and halt on mismatch.

### 3.2 Binance endpoints (verify against current docs)
- Funding history: `GET /fapi/v1/fundingRate`
- Current mark price, index price, predicted funding, next funding time: `GET /fapi/v1/premiumIndex`
- Per-symbol funding interval overrides: `GET /fapi/v1/fundingInfo` (not all symbols are 8h)
- Funding actually received: `GET /fapi/v1/income` (`incomeType=FUNDING_FEE`)
- Exchange filters (stepSize, minNotional): `GET /api/v3/exchangeInfo`, `GET /fapi/v1/exchangeInfo`
- Wallet transfers spot ↔ futures: universal transfer endpoint
- User data streams for order fills and account updates

### 3.3 Data model (initial)

| Table | Purpose |
|---|---|
| `funding_rates` | symbol, funding_time, rate, mark_price |
| `positions` | id, symbol, state (opening/open/closing/closed), spot_qty, perp_qty, entry prices, opened_at, closed_at |
| `orders` | position_id, leg (spot/perp), side, qty, price, fee, fee_asset, status, exchange_order_id |
| `funding_payments` | position_id, funding_time, amount |
| `risk_events` | type, symbol, details, action_taken, created_at |
| `equity_snapshots` | timestamp, total equity, per-wallet breakdown |

PnL is always attributed into **funding income, trading fees, and basis/slippage** so it's obvious where money comes from and goes.

---

## 4. Execution

- **Paired entry:** place the perp short and spot buy concurrently (market orders in v1). After both fill, compare quantities and fix any residual with a small market order on the lagging leg.
- **Failure handling:** if one leg fails and the other filled, retry the missing leg up to N times, then unwind the filled leg. Never leave a naked leg longer than a configured timeout (e.g., 30s).
- **State machine per position:** `opening → open → closing → closed`, persisted before every exchange call so a crash mid-execution is recoverable on restart.
- **Idempotency:** use client order IDs derived from position ID + leg + action.

---

## 5. Risk management

| Risk | Control |
|---|---|
| Short leg liquidation on a pump | Leverage ≤ 2x; alert at margin ratio threshold; auto top-up from USDT reserve; if reserve is low, reduce both legs proportionally |
| Leg imbalance | Reconcile quantities each risk loop; rebalance if mismatch > 1% |
| Funding turns negative | Exit rule plus hard exit if predicted rate < −X |
| Exchange/API outage | Halt new entries on repeated errors; alert; keep existing hedges (they're neutral) |
| Delisting / extreme volatility | Universe filter + immediate exit on delisting announcements |
| Bugs | Kill switch (Telegram command + env flag) that stops entries and optionally unwinds everything; max daily loss circuit breaker |
| Counterparty risk | Cap total capital on the exchange; withdraw profits periodically |

When price rises a lot, the short accumulates unrealized loss in the futures wallet while the gain sits in the spot wallet. Rebalancing (sell part of spot, buy back the matching perp, transfer USDT to futures) keeps margin healthy without breaking neutrality.

---

## 6. Phases

### Phase 0 — Data and backtest (go/no-go gate)
- Backfill 2+ years of funding history, mark prices and fees for the universe.
- Build the simulator on top of `strategy/`: realistic fees (actual fee tier), slippage model from volume, funding paid only when held at timestamp, liquidation checks on the short leg using intraperiod highs.
- Grid-search entry/exit thresholds; validate with walk-forward (tune on one window, test on the next).
- Report: APR, max drawdown, % of time deployed, income split, behavior per market regime (bull vs bear).

**Go criteria:** net APR comfortably above holding stablecoins, stable across walk-forward windows, no liquidation events at chosen leverage.

### Phase 1 — Paper trading (2–4 weeks)
- Live data, simulated fills (paper mode in `exchange/`), real fee model.
- Compare paper results with what the backtest predicted for the same period.
- Exercise risk paths deliberately: forced imbalance, simulated API failures, kill switch.

**Go criteria:** paper PnL within tolerance of backtest expectations; no unhandled errors; reconciliation clean.

### Phase 2 — Small live
- Real capital, small size (an amount you're comfortable losing entirely), max 2 positions.
- Verify funding income via `/fapi/v1/income` matches internal accounting.
- Daily Telegram report: positions, funding earned, fees, equity.

**Go criteria:** 4+ weeks live with accounting matching exchange records and results consistent with paper.

### Phase 3 — Scale and improve
- Increase capital and max positions gradually.
- Maker (limit) orders for entries/exits to reduce fees.
- Use BNB fee discounts / higher fee tiers.
- Optional: cross-exchange variant, funding-skew signals as a separate strategy.

---

## 7. Monitoring and alerts (Telegram)

- Entry/exit executed (symbol, size, expected funding).
- Funding received each period (summary).
- Risk events: margin ratio warning, imbalance, failed leg, reconciliation mismatch.
- Daily report and weekly PnL attribution.
- Commands: `/status`, `/pause`, `/resume`, `/killswitch`.

---

## 8. Testing

- Unit tests for strategy scoring and entry/exit decisions (pure functions).
- Unit tests for quantity rounding and leg matching with real exchange filters.
- Execution tests with a mocked exchange: partial fills, one leg failing, crash between legs and recovery on restart.
- Binance testnet for an end-to-end run before Phase 1.

---

## 9. Open questions

- Fee tier and whether BNB fee payment is available on the account.
- Margin mode: isolated per position (simpler, contained risk) vs a mode that counts spot holdings as collateral (more capital-efficient, more complex).
- Starting capital for Phase 2.
- Tax treatment of funding income and spot trades as a Brazilian tax resident (check with an accountant).
- VPS provider and region (latency to Binance matters little here, uptime matters more).
