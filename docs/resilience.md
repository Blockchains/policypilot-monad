# Resilience: everything runs from GitHub (t377u)

Goal: the system keeps running with **no box and no Grok Bot**, so if the bot's usage runs out or the box is off, every feature
and function keeps going. The deployer/owner key never goes to GitHub, and nothing uses a paid API.

Owners: **GH** = GitHub Actions (repo secrets hold agent/keeper keys only), **Box** = the bot box (deployer key, Grok Bot X tools),
**Chain** = an on-chain contract that enforces the limit.

## Audit (before, 2026-10-19 12:00 BST)

Who triggered runs over the previous 24 h (GitHub API `triggering_actor`): `github-actions[bot]` = a GitHub job chaining or
kicking another; `Blockchains` workflow_dispatch = the box's `gh` login; `schedule` = GitHub cron (throttled on this repo, so
runs fire hours apart).

| # | Dependency | What needed the box / Grok Bot | Owner before | Status before |
|---|---|---|---|---|
| 1 | X sentiment (`docs/sentiment.md`) | Hourly box routine using Grok Bot's X tools; it was rate-limited at 11:00 UTC. Without it, sentiment goes stale after 3 h (v2 then ignores it). | Box + Grok Bot | **Box-only** |
| 2 | Keeper gas (`momentum-keeper-refill.mjs`) | The deployer sends MON to the keeper by hand. Keeper 3.69 MON. | Box | **Box-only** |
| 3 | Showcase float top-ups (ShowcaseRefiller v4 `0x6B4E…573c`) | Only the deployer can fund the float; daily-sweep returns vault MON to the deployer, so the float only shrinks. | Box | Box-only (long runway) |
| 4 | `owner-daily-cycle.sh` | Retired 2026-10-18; the team vaults sweep themselves on GitHub. | Box | Retired |
| 5 | aPriori queued withdrawals (deployer, ids 12521–12523) | `redeem()` must be called by the controller (deployer). 2.58 MON claimable, 0.45 MON locked. | Box | Box-only, no alert |
| 6 | `kick-workflows.sh` / `kick-activity.sh` | Called from the showcase loop (a GitHub job). If showcase-agents stops, nothing re-dispatches momentum-data, activity-index or the watchdog except throttled crons. | GH (via showcase) | Single point |
| 7 | momentum-keeper | Self-chains every ~14 min. Box dispatched 5 of its 22 runs in 24 h. | GH | Chained, no watchdog |
| 8 | momentum-data | 28-minute loop; restarted by the showcase kick. Box dispatched 4 of 12 runs. | GH | Kick only |
| 9 | agent-refill / daily-sweep | Three crons + kick + ops-watchdog. Box dispatched 5 refill and 6 sweep runs (tests). | GH | Watched |
| 10 | ops-watchdog | Two crons + showcase kick; covers only refill, sweep and the Pages heartbeat. | GH | Partial |
| 11 | showcase-agents | Hourly cron; a 5h40m loop. Nothing restarts it if crons stall. | GH | Cron only |
| 12 | activity-index / research-tape | Cron + showcase kick. | GH | Kick only |
| 13 | direct-seek / rebalancer-seek | Hourly cron (another team's job; monitor only). | GH | Cron only |
| 14 | RPC | Jobs and UI already use fallback lists, but `momentum-depth.mts` used one RPC and `tape-refresh` used no Monad backups. | GH | Partial |
| 15 | Data hosting | UI reads raw.githubusercontent with Pages as fallback; no third mirror; no single health page. | GH | Partial |
| 16 | Health page | `ops-status-143.json` covers refill, sweep and watchdog only. | GH | Partial |

## Plan (after)

See the table at the end for the final status of each item, with PR numbers.
