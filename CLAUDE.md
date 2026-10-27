# funding-harvester

Delta-neutral funding carry on Binance (spot long + USDⓈ-M perp short). Strategy spec: `funding-harvester-plan.md`.
Current state: **Phase 0** (historical data + backtest + walk-forward go/no-go). No live/paper trading code yet.

## Commands
- `pnpm backfill --from 2023-01 [--symbols BTC,ETH] [--no-gap-fill]`: download history into SQLite (resumable)
- `pnpm backtest --from 2024-01-01 --to 2026-10-01 [--symbols ..] [--always-on BTCUSDT] [--params '{"leverage":2}'] [--sim '{..}']`
- `pnpm sweep [--quick] [--grid '{..}'] [--train 6 --test 3 --step 3] [--workers N]`: walk-forward grid search, writes `reports/<ts>.md|json`
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

## Simulator semantics (keep these when changing it)
- Bar i covers [t0+i·H, t0+(i+1)·H); "price at time index i" is the close of bar i−1.
- Order at each hour: funding settles → scheduled exits → decisions for symbols whose funding is next hour → record equity → intrabar liquidation check (perp high) and margin top-up/reduce at bar close.
- Predicted funding is reconstructed from the premium-index bars already closed (7 of 8 for 8h); verified corr ≈0.9 with realized.
- Exits wait until just after funding unless the predicted rate is negative.
- Delisting is "announced" 7 days before a symbol's last funding (`delistNoticeHours`).
- Data comes from data.binance.vision archives, which include delisted symbols (no survivorship bias).
