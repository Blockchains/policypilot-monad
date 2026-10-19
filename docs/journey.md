# Guided journey (Start · My money · Activity · More)

Alpha · unaudited contract · only deposit what you're happy to lose

## Paths (taps after connecting)
| Path | Taps | Wallet signatures |
|---|---|---|
| Earn · Low (aPriori aprMON) | goal, risk, amount/Max, Review, Confirm = 5 | 1 |
| Earn · Balanced (agent stakes Kintsu/aPriori/Magma) | 5 | 2 (create vault, fund agent gas) |
| Trade fast · Balanced / High, Arbitrage · Low / Balanced (pools) | 5 | 3 (open pool, deposit, fund agent gas) |
| Pay people (agent vault) | goal, payees, amount, Review, Confirm = 5 | 2 |
| Withdraw (My money) | 25/50/100 %, Withdraw = 2 | 1 for pools/aprMON, 0 for agent vaults |
| Withdraw everything | Withdraw everything, Confirm | 1 per vault/pool |

## Goal × risk → strategy
| Goal | Low | Balanced | High |
|---|---|---|---|
| Earn | aprMON liquid staking (withdraw queues ~12–18 h) | Agent vault splits MON across Kintsu, aPriori, Magma (comes back as tokens) | not offered |
| Trade fast | not offered | Clip pool, agent trades only when the round trip gains after its floor | Clip pool, accepts up to 0.50 % short per trip |
| Arbitrage | Spread pool, high profit floor | Spread pool, lower floor | not offered (same thing as Trade fast · High) |
| Pay people | Agent vault pays the listed addresses | | |

Vaults have no spending limits (the user chose this); the review copy says so. Agent gas is funded from the deposit and shown as its own line. Nothing is guaranteed: quotes on mainnet are usually below gas, so loops mostly watch and send nothing.

## Not offered
- Earn · High: no MON-only yield strategy with honest higher upside that we can unwind on-chain.
- Trade fast · Low: high-frequency trading is never low risk.
- Arbitrage · High: would be the same contract as Trade fast · High; offered once, under that name.

## Robustness
Simulate-first on every write, gas buffer + 900k create cap handling, chain switch prompt, insufficient-MON blocker before review, resumable runs (hashes recorded immediately, on-chain idempotence checks, orphan pool adoption after a closed tab), RPC kept under 40 requests / 20 s per screen through rpcLimit.
