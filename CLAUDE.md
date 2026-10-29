# funding-harvester

Delta-neutral funding carry on Binance (spot long + USDⓈ-M perp short). Strategy spec: `funding-harvester-plan.md`.
Current state: **Phase 0 verdict NO-GO** (historical data + backtest + walk-forward). No live/paper trading code.
Best out-of-sample results (bar: ≥8% APR, 0 liquidations): spot/perp carry 2.5% APR (vol filter + rate cap + maker fees, all 3 venues); cross-venue perp-perp spread 3.9% APR with 2 liquidations. Both lose to stablecoin yield.

## Commands
- `pnpm backfill --from 2023-01 [--venue binance|bybit|okx] [--symbols BTC,ETH] [--no-gap-fill]`: download history into SQLite (resumable). Run `okx` after the others: delisted OKX swaps are found by probing bases seen on other venues.
- `pnpm backtest --from 2024-01-01 --to 2026-10-01 [--symbols ..] [--always-on BTCUSDT] [--params '{"leverage":2}'] [--sim '{..}']`
- `pnpm sweep [--strategy carry|spread] [--venues binance,bybit,okx] [--label name] [--quick] [--grid '{..}'] [--train 6 --test 3 --step 3] [--workers N]`: walk-forward grid search, writes `reports/<ts>.md|json`
- `pnpm study [--from .. --to .. --venues ..]`: funding-momentum Phase A event study (`src/research/`), writes `reports/<ts>-study.md|json` with an automatic gate
- `pnpm typecheck && pnpm test`

## Layout
- `src/strategy/`: **pure** decision functions (entry/exit/allocate/funding math). Backtest, paper and live must all call these; never add I/O here.
- `src/backtest/`: hourly simulator, cost/liquidation model, metrics, walk-forward, report, worker pool.
- `src/data/`: archive/REST backfill, CSV parsing, in-memory dataset loader (hour grid, NaN = missing).
- `src/exchange/`: Binance REST (throttle + retry, HMAC signing) and data.binance.vision downloader.
- `src/db/db.ts`: `node:sqlite` schema + helpers. DB at `data/funding.sqlite`, zip cache at `data/vision/` (both gitignored).

## Conventions
- Node ≥22.13, ESM, run from source with tsx (no build). Strict TS incl. `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; imports use `.js` suffixes.
- Rates are fractions (0.0001 = 0.01%). Strategy compares rates normalized to **per 8h** (`to8h`), since symbols use 1h/4h/8h intervals.
- Klines for scaled perps (1000PEPEUSDT) are stored under the perp symbol; `symbols.spot_symbol` holds the spot pair. The sim works in notional, so the multiplier never matters.

## Venues
- Symbol ids are venue-qualified (`bybit:BTCUSDT`, `okx:BTCUSDT`); Binance keeps bare ids (`BTCUSDT`). `symbols.venue` holds the venue. Helpers in `src/data/venues.ts`.
- Bybit: REST only (it serves delisted perps/spot and lists closed instruments). OKX: live instruments via REST; delisted ones and all funding history via the monthly archives (1m candles aggregated to 1h). OKX has no premium-index history, so its predicted rate falls back to the last realized rate.
- Fees per venue: Binance uses `spotTakerFee`/`perpTakerFee` (+ BNB discount); others use `sim.venueFees`.
- The sim holds at most one position per coin (`base`) across venues and uses one shared capital pool (in reality capital is split per exchange).

## Strategies
- `carry` (default): spot long + perp short on one venue. `src/strategy/*` + `src/backtest/simulator.ts`.
- `spread`: short the perp on the venue paying the most funding, long it on the venue paying the least (`src/strategy/spread.ts` + `src/backtest/spread-sim.ts`, params `spreadParamsSchema`). Each leg is an isolated position on its own venue, so a big move can liquidate one leg even though the pair is hedged; top-ups come from the shared cash pool.

## Simulator semantics (keep these when changing it)
- Bar i covers [t0+i·H, t0+(i+1)·H); "price at time index i" is the close of bar i−1.
- Order at each hour: funding settles → scheduled exits → decisions for symbols whose funding is next hour → record equity → intrabar liquidation check (perp high) and margin top-up/reduce at bar close.
- Predicted funding is reconstructed from the premium-index bars already closed (7 of 8 for 8h); verified corr ≈0.9 with realized.
- Exits wait until just after funding unless the predicted rate is negative.
- Delisting is "announced" 7 days before a symbol's last funding (`delistNoticeHours`).
- Data comes from data.binance.vision archives, which include delisted symbols (no survivorship bias).
