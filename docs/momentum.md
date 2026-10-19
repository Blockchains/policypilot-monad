# MonaDefi Momentum

**Follow strength. Set your limits. Return to MON.**

A trading strategy, not yield. It buys an eligible wrapped asset with MON only while that asset is getting stronger
*against MON*, holds while the position is valid, and sells back to MON when one of the user's exit rules is reached.
Nothing is guaranteed and "no trade" is a normal outcome. Alpha · unaudited contract · only deposit what you're happy to lose.

Status (19 Oct 2026): **Release 1 (watchlist) and Release 2 (assisted execution, "Review each entry") are live.
Release 3 and Release 4 are designed below and not enabled.** "Automatic within limits" is shown as *coming after research
and review* and cannot be selected.

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
| WETH | `0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242` | Wormhole NTT 2/2 (MonadBridge) | ERC-1967 proxy, NTT manager mints | PancakeSwap v3 0.05% `0xB027…E402` | 0.10% at 0.3–30 MON, 0.22% at 100 | **Enabled** |
| WBTC | `0x0555E30da8f98308EdB960aa94C0Db47230d2B9c` | LayerZero OFT | not a proxy; owner sets OFT peers | PancakeSwap v3 0.05% `0x0944…0a09` | 23% at 0.3, 3.9% at 1, 0.45% at 10, 0.19% at 30 | Watchlist |
| cbBTC | `0xd18B7EC58Cdf4876f6AFebd3Ed1730e4Ce10414b` | Coinbase, Chainlink CCIP | ERC-1967 transparent proxy, pausable | PancakeSwap v3 0.05% `0x614B…A284` | 23% at 0.3, 7.5% at 1, 0.61% at 10 | Watchlist |
| SOL (wSOL) | `0xea17E5a9efEBf1477dB45082d67010E2245217f1` | Wormhole Portal | beacon proxy | PancakeSwap v3 0.25% (thin) | 17% at 0.3, 40% at 1 | Watchlist (by design) |

Why BTC is not enabled: cbBTC and WBTC have 8 decimals; one unit is about 0.04 MON, and the pool's fee rounds up to a whole
unit, so small swaps lose several percent. Both directions quote, but only from about 10 MON does the round trip fall under
0.5%. They count as **one BTC exposure** (WBTC is the better wrapper). Enabling needs a reviewed pilot at that size.
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
  also stop exits signed by the executor), *Pause automation* (shown, not enabled: nothing is automated), *Close & stop*.
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

## Release 3 design: authorized automated exits (NOT enabled)

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

## Release 4 design: bounded automatic entries (NOT enabled)

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
