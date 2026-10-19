# MonaDefi Momentum

**Follow strength. Set your limits. Return to MON.**

A trading strategy, not yield. It buys an eligible wrapped asset with MON only while that asset is getting stronger
*against MON*, holds while the position is valid, and sells back to MON when one of the user's exit rules is reached.
Nothing is guaranteed and "no trade" is a normal outcome. Alpha · unaudited contract · only deposit what you're happy to lose.

Status (19 Oct 2026): **Releases 1–2 are live, and Releases 3 (automated exits) and 4 (bounded automatic entries) are live as
an opt-in alpha** ("Automatic within limits", see *Keeper* below). R4 was switched on at the owner's request **ahead of the
research gate**: the backtest has under 60 days of history and is anecdotal. All four assets (WETH, WBTC, cbBTC, SOL) are
enabled; every entry must still pass a fresh-quote round-trip cost check, so an enabled asset can be refused (SOL is today).

## Code map

| Piece | File |
|---|---|
| Pure core: registry, candles, rule engine v1, exits, sizing, accounting, state machine, request ids, calldata, backtest | `web/src/lib/momentumCore.ts` |
| Unit tests (rules, sizing, accounting with partials and fees, state machine, no-lookahead backtest, copy) | `web/src/lib/momentum.test.ts` |
| Browser reads: public job files, vault discovery, ledger tail, quotes | `web/src/lib/momentumData.ts` |
| Screens: strategy card, watchlist, dashboard, entry review, position detail, withdraw, pauses, setup wizard | `web/src/components/Momentum.tsx` |
| Data job (GitHub Actions) and its commit script | `web/scripts/momentum-job.mts`, `web/scripts/momentum-commit.sh`, `.github/workflows/momentum-data.yml` |
| Versioned asset registry | `web/public/momentum/143/assets.v1.json` |
| Public data (candles, samples, signals, decisions, paper, ledger, alerts, backtest) | `web/public/momentum/143/` |

## Asset registry v1 (verified against docs.monad.xyz tokens-and-bridges)

| Asset | Address | Issuer / bridge | Upgradeability | Best route | Round trip (buy then sell) | Status |
|---|---|---|---|---|---|---|
| WETH | `0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242` | Wormhole NTT 2/2 (MonadBridge) | ERC-1967 proxy, NTT manager mints | PancakeSwap v3 0.05% `0xB027…E402` | 0.10% at 0.3–30 MON, 0.22% at 100 | **Enabled** · min 0.1 MON |
| WBTC | `0x0555E30da8f98308EdB960aa94C0Db47230d2B9c` | LayerZero OFT | not a proxy; owner sets OFT peers | PancakeSwap v3 0.05% `0x0944…0a09` | 23% at 0.3, 7.5% at 1, 0.45–0.54% at 10, 0.19–0.29% at 30 | **Enabled** · min 10 MON · preferred BTC |
| cbBTC | `0xd18B7EC58Cdf4876f6AFebd3Ed1730e4Ce10414b` | Coinbase, Chainlink CCIP | ERC-1967 transparent proxy, pausable | PancakeSwap v3 0.05% `0x614B…A284` | 23% at 0.3, 7.3% at 1, 0.61–0.72% at 10 | **Enabled** · min 10 MON |
| SOL (wSOL) | `0xea17E5a9efEBf1477dB45082d67010E2245217f1` | Wormhole Portal | beacon proxy | PancakeSwap v3 0.25% (thin) | 1.2% at 0.01, 6.6% at 0.1, 17% at 0.3, 40% at 1, 87% at 10 | **Enabled, cost-blocked** · min 0.1 MON |

BTC: cbBTC and WBTC have 8 decimals; one unit is about 0.04 MON, and the pool's fee rounds up to a whole unit, so small swaps
lose several percent. Hence the **10 MON minimum entry** (refused below it, manual and keeper). They count as **one BTC
exposure**; WBTC is used when both qualify. Real test at the minimum (`docs/evidence/momentum-wbtc-mainnet.json`): 10 MON →
259 WBTC base units; selling in two halves returned 9.8799 MON (1.20% swap loss vs 0.45–0.54% quoted for one full round
trip), because each partial sell also rounds to whole units. Partial exits on BTC at the minimum size cost extra.

SOL: the only pool holds about 3 MON and both SOL/USDC pools on Monad are empty (zero liquidity, checked 19 Oct 2026), so
the round trip rises with size and no reference price exists. Enabled with a 0.1 MON minimum, but the cost check (max 1%)
and the reference check refuse every entry today; the app says *Enabled, but blocked by the cost check right now (round
trip X% at 0.1 MON)*.

Owner max cost: a per-vault setting (default 1%, range 0.1–1%) applied to the fresh quote at the exact entry size; it can
only tighten rules v1's 1% liquidity rule.
Kuru Flow was tested as a free quote source (a JWT is minted from any address without signup, 1 request/second): it quoted
slightly less WETH than PancakeSwap and its auto-slippage minimum was ~9% below the quote, so it is a cross-check only, not an
execution route. Uniswap v3 WETH/WMON pools exist but are thin. Excluded: liquid staking/restaking tokens, stablecoins,
anything not on the Monad tokens page.

Reference price: asset/USDC pool mid ÷ WMON/USDC pool mid (PancakeSwap `0x63e4…53F2`), both read from `slot0`.

## Data pipeline (no paid APIs)

* `momentum-data` workflow: cron at :03 and :33, each run loops ~28 minutes and **samples every 5 minutes** (GitHub may
  delay cron starts). Public RPCs only, paced at ≤ 4 requests/s.
* Each sample: `slot0` of every asset/WMON pool, the USDC reference pools and WMON/USDC; real `quoteExactInputSingle` buy
  quotes at each asset's minimum entry size, 1, 10 and 30 MON and the matching sell-back quotes.
* Candles: every PancakeSwap v3 `Swap` log on the five pools (post-swap `sqrtPriceX96`, block timestamp) folded into hourly
  OHLC of MON per asset, plus USDC per MON. `rpc2.monad.xyz` allows a 10,000-block `eth_getLogs` range; the job scans
  forward every sample and **backfills older logs** within a per-run budget (default 40 ranges) toward 120 days.
  Files: `candles/<SERIES>/<YYYY-MM>.json` as `[hourStart, open, high, low, close, swaps]`.
* Only completed hours feed signals; gaps between swaps are carried flat; trailing gaps are never invented.

## Rule engine v1 (research hypothesis)

Completed hourly candles of asset/MON. Every check is shown with its value, its threshold and why it exists.

1. Enough fresh data: ≥ 240 candles, last ≤ 2 h old.
2. Stronger than MON: 7-day return vs MON > 0%.
3. Trend: EMA 24 h > EMA 72 h.
4. Breakout: close within 0.5% of the prior 48 h high, or above.
5. Not overextended: close ≤ EMA 24 h × (1 + 2 × daily volatility).
6. Volatility acceptable: 72 h volatility ≤ 8% a day.
7. Liquidity at the size: buy + sell round trip ≤ 1%.
8. Wrapper price healthy: pool mid within ±1.5% of the USDC cross-rate.
9. Entry + estimated exit cost (swaps + gas) ≤ 2% of the position.

No "AI confidence". Variants for research only: `v1-slow` (EMA 48/144, 14-day momentum, 96 h breakout) and `v1-fast`
(EMA 12/36, 3-day momentum, 24 h breakout).

Exits (set before entry, triggers use the **executable sell quote**): profit target (full, or partial 50% at +8% then a 4%
trailing exit), **loss-exit trigger** −5%, trend invalidation (EMA 24 < EMA 72 and close < EMA 72), max holding time 7 days,
wrapper/liquidity incident (no sell quote, price gap > 3%, round trip > 2%), user exit, and a daily portfolio loss threshold
that stops new entries.

Sizing: notional = (allocation × risk per trade) ÷ loss-exit distance, then capped by max per position, remaining max
total exposure, liquidity, available MON (no leverage) and flagged below the minimum economical size. One position per
underlying: no adding, no averaging down, no martingale.

## Release 2: assisted execution

* Custody: a fresh **UnlimitedAgentVault v4** from factory `0x41d6667aA35c3634D19068A39481d4c955f6557D`, owned by the user,
  with the **executor set to the user's own wallet** (no agent key exists). The user signs every entry and exit.
* Entry pipeline: rule check → exposure/slot/cooldown/pause limits → fresh quote for the exact size → exit-route quote
  (selling exactly what the buy returns) → price impact, reference deviation, round-trip and economics checks → `minOut`
  0.5% under the quote (enforced by the vault's own balance check) → 30 s quote expiry (re-quoted before signing) →
  simulate (`eth_estimateGas`; a revert sends nothing) → submit once → read the vault's actual token balance.
* Exit: `executeCall` with an exact approval (reset to 0 afterwards) → PancakeSwap `multicall(deadline, [exactInputSingle →
  router, unwrapWETH9(minOut, vault)])` → the vault checks MON received ≥ minOut.
* **Durable position record on-chain**: each request id is `"MOM1" | action | asset | position | step | amount`. The vault
  emits `DappCalled(requestId, …, value, outToken, received)`; the same id cannot run twice (submit once). Positions are
  rebuilt from those events (public `ledger.json` indexed by the job + a live `eth_getLogs` tail in the browser), reconciled
  against the vault's live token balances.
* Accounting: net MON = MON received − MON committed − gas paid separately. Pool fees are inside the quotes and are not
  subtracted again (unit-tested both ways). Partial sells remove cost basis in proportion to quantity sold. USD = net MON ×
  WMON/USDC mid. "vs holding MON" = net MON ÷ MON committed.
* Withdraw: "Withdraw available MON" (available only, a specific position, or proportional, with exposure-after preview)
  and "Close positions and withdraw" (pauses new entries, fresh quotes, sells each position, unwraps any WMON, withdraws,
  pauses the vault, reports leftovers and never says complete while tokens remain).
* Pauses: *Pause new entries* (browser setting; exits and withdrawals continue; not the vault's `paused` flag, which would
  also stop exits signed by the executor), *Pause automation* (revokes the keeper with one signature when automatic mode is on), *Close & stop*.
* Exit alerts: the job evaluates every open Momentum position from public data and publishes `status.json → alerts`; the
  dashboard also evaluates live. In-app only; nobody is emailed.

## Mainnet evidence (real MON, deployer wallet, through the live site UI)

Full receipts (block, gas, fee, every app message) are in [`docs/evidence/momentum-mainnet.json`](evidence/momentum-mainnet.json).
All 12 transactions have status 1. Entry size 0.5 MON in WETH via PancakeSwap v3 0.05%; the wallet stayed above 92 MON (5 MON reserve kept).

| Run | Vault | Steps | Position net MON (received − committed) | Gas (paid separately) | Wallet total |
|---|---|---|---|---|---|
| A | `0x924a8D3B3A8ab15018D14D7d59F1C9C2DA097FB6` | create vault 1.2 MON `0x4e1a7ced…0cc5` → entry `0x64fcdbfa…0c95` → Sell 50% `0xed3e5b9a…23ce` → Close `0x858680ba…5701` → Withdraw available `0x6643648b…8a3a` | −0.0005 MON (0.4995 back from 0.5) | 0.3497 MON (0.2352 of it vault creation) | −0.3502 MON |
| B | `0xEBF7140E9c233D2B72bbC245ef863435D05A76c0` | create vault 1.2 MON `0x136f09a0…231d` → entry `0xabb79772…28ac` → Sell 50% `0x521cd27e…3e4bd7` → Withdraw available MON with a position open `0x228d680e…bd88` → Close positions and withdraw: sell `0xe212a310…a788`, withdraw `0x93ca05c8…a5ac`, pause `0x4e4f913e…076` | −0.0005 MON | 0.3602 MON (0.2352 vault creation) | −0.3607 MON |

Monad charges the full gas limit, which dominates at these test sizes: a 0.5 MON round trip costs about 0.073 MON of gas,
so the app's "vs holding MON" figure for such a small position is about −15%. Larger positions dilute that cost.

## Keeper: R3 automated exits + R4 bounded automatic entries (live, opt-in alpha)

* **Who acts:** the GitHub Actions workflow `momentum-keeper.yml` (a pass about every 15 min: each run dispatches its
  successor 14 min after it started, because GitHub throttles this repo's crons; the cron and the showcase loop's kick are backups), with its own agent key `0xDC07…7ad7` (secret `MOMENTUM_KEEPER_KEY`).
  The deployer key is never used by the keeper. Kill switch: repo variable `MOMENTUM_KEEPER_ENABLED`; operator pauses
  `MOMENTUM_KEEPER_ENTRIES_PAUSED` / `MOMENTUM_KEEPER_EXITS_PAUSED`.
* **Opt-in:** one owner signature, `setExecutor(keeper)` with the owner's limits appended to the calldata (read back from
  the chain by the keeper). Revoke: one signature (`setExecutor(owner)`). Editing limits is one signature.
* **Power:** the v4 vault has no on-chain spending limits, so the keeper key could technically move the vault's funds. The
  published keeper only buys enabled assets within the signed limits, sells back to MON into the vault, and sweeps only to
  `vault.owner()`. This is the main alpha risk and the UI says so before the opt-in.
* **Entries:** rules v1 pass, data fresh, enabled asset, per-asset minimum, size = min(per position, room under the vault
  share, free MON), max open positions, one position per underlying (WBTC before cbBTC), cooldown, fresh executable quote,
  impact, reference price, owner max cost, economical size (or the owner's explicit tick), simulation before sending.
* **Exits:** loss-exit trigger, profit target (partial or full), trailing exit, trend fade, time stop, each on an executable
  sell quote for the exact quantity; first try at ≤0.5% slippage, retry up to the owner's ceiling; a failed exit is logged
  in the app and raises one GitHub issue. MON returns to the vault.
* **Withdrawals:** optional auto-sweep of free MON above a kept amount to the owner's wallet. Manual withdraw always works.
* **Gas:** keeper funded from the deployer (deployer keeps a 5 MON reserve, box script `momentum-keeper-refill.mjs`);
  entries stop below 1 MON of keeper gas so exits stay funded; low gas opens an issue.

Mainnet test (deployer-owned vault `0x2010…0507`, live UI, receipts in
[`docs/evidence/momentum-keeper-mainnet.json`](evidence/momentum-keeper-mainnet.json)): create + opt-in (2 signatures) →
keeper auto-entry 0.5 MON WETH (`0x752cc3cc…62ea`, test dispatch that skips only the rule check) → keeper time-stop exit,
0.4965 MON back to the vault as MON (`0xd5768dbc…6e07`) → owner turns auto-sweep on (`0x8c5e9de2…c364`) → keeper sweeps
0.996507 MON to the owner (`0x2cb5453c…97f9`) → owner revokes (`0x5a088ee4…d1ae`). Keeper gas 0.0975 MON for 3 sends.

Still open from the original design (not done in this alpha): an exit-only vault role (v5) with on-chain limits, an audit,
redundant non-GitHub execution, and research on enough history.

## Momentum v2 (opt-in, alpha)

- **Depth** (`momentumDepth.ts`, `scripts/momentum-depth.mts`, hourly in the data job):
  - Quotes every PancakeSwap v3 and Uniswap v3 route per asset (direct, or two hops via USDC/WETH on one venue) at 1/10/50/100/250/500/1000 MON.
  - The round trip is the buy plus the sell back on the same route, excluding gas.
  - An exact DP finds the best split across routes.
  - The "sensible size" range at the owner's max cost handles the 8-decimal U-shape (tiny BTC trades lose to rounding).
- **Signal engine v2** (`momentumV2.ts`):
  - One composite score with per-factor contributions in `status.json` and `decisions.json`: strength vs MON 1 h/4 h/24 h/7 d, regime, swap activity, X sentiment (confirming only, ignored when older than 3 h) and an extension penalty.
  - An entry needs composite ≥ 0.35 (0.5 in chop), positive strength on its own, and every v1 hard gate.
  - v1 stays the default; the v1 vs v2 backtest is in `backtest.json` (`v1v2`).
- **X sentiment:** see [sentiment.md](sentiment.md). It is collected on the bot box hourly (216 X calls a day).
- **Keeper v2** (owner settings `eng`, `twap`, `split`, `atr`, `dloss`; older opt-ins keep v1 behaviour):
  - **Caps:** alpha ceiling 250 MON per position. The real cap is the measured depth at the owner's max cost; the fixed 10 MON applies when depth data is stale.
  - **TWAP:** up to 6 slices, one per keeper run. Each slice gets a fresh quote, the signal is re-checked, and every entry gate runs again.
    - A slice uses rid step ≥ 1, which adds to the open position in the ledger.
    - Remaining slices are cancelled when the signal is lost, an exit fires or the circuit breaker trips.
    - Free MON is not swept while slices are pending.
  - **Split router** (`momentumSplit.ts`): one vault call into the PancakeSwap router whose `multicall` runs one `exactInput` per leg, with one aggregate minimum, so the split is all-or-nothing. It is used from 20 MON and only when it beats the best single route by ≥ 5 bps. Cross-venue splits are not used.
  - **ATR loss-exit trigger and trailing exit:** 1.5× and 1.2× the daily ATR, clamped. They only ever tighten the owner's settings.
  - **Correlation:** a new position is halved when its MON-priced returns correlate ≥ 0.7 with a position already held. WBTC and cbBTC are always one BTC exposure.
  - **Daily loss circuit breaker:** when 24 h realised plus unrealised losses pass the owner's % of vault value, new entries pause. Exits keep running.
  - **BTC rounding fix:** a partial sale whose rounding would cost more than 0.04% becomes a full exit.
  - **Heartbeat:** written to `keeper-143/status.json` and shown in the UI.
- **Fork rehearsal:** `scripts/momentum-keeper-fork-v2.mjs` runs a TWAP of 3 slices (slice 1 a forced split), then exit, sweep and revoke.
- **Mainnet evidence (2026-10-19):** [`evidence/momentum-keeper-v2-mainnet.json`](evidence/momentum-keeper-v2-mainnet.json). 15 MON WETH in 3 TWAP slices (slice 1 a two-leg split in one multicall) and a time-limit exit by the scheduled keeper: 15 MON → 15.0184 MON before gas, 0.43 MON all-in cost (mostly vault creation gas). Reserve kept.

## Release 3 design notes: authorized automated exits

What it does: a keeper may **only sell** a position back to MON into the user's vault when a pre-set exit triggers.

Needs:
1. **Vault v5 "exit-only executor"** (new contract + audit): a second role that can call only
   `exitSwap(asset, qty, minOut)` against an allow-listed router/pool, output must be MON to the vault, `minOut` ≥ an
   on-chain floor derived from a TWAP; it can never withdraw, approve arbitrary spenders, or enter. Entry allowance and exit
   permission are separate, so an exhausted entry budget can never block an exit. Owner can revoke instantly.
2. Keeper: price/liquidity ingestion → signal → risk → execution coordinator → vault → reconciliation ledger → alerts;
   per-position lock, bounded retries with tx replacement, redundant RPCs and freshness checks, gas-reserve monitoring.
3. Failed-exit alerts (in-app; opt-in channels later) and a recovery runbook (`EXIT_FAILED → MANUAL_ACTION_REQUIRED`).
4. A permission-limited, separately funded keeper key — never the showcase loop.

## Release 4 design notes: bounded automatic entries

Only after: research results on enough history (walk-forward, out-of-sample, live paper trading on executable quotes),
an independent review, and a capped pilot. Needs an on-chain entry budget (turnover vs capital vs execution budget),
per-underlying exposure caps, cooldowns, the daily loss stop enforced on-chain, executor-compromise analysis, and the
same exact-input calldata decoding for entries as R3 has for exits.

## Research

`backtest.json` (rebuilt hourly by the job) reports, per asset, net MON, USD, max drawdown, trades, average gain/loss,
turnover, cost per round trip, time in market, failed exits (not modelled historically) and concentration, for the full
window and a 60/20/20 train/validation/out-of-sample split, against hold MON, inactive, hold the asset and slow trend; plus a
walk-forward that picks one of the three predefined variants on each previous fold. With only weeks or months of on-chain
history the report says so; nothing is extrapolated or invented.
