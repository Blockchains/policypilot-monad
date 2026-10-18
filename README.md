# PolicyPilot (Monad) – bounded transaction execution reference implementation

**Desk tape (16 Oct 2026):** [The gas limit is the trade](https://blockchains.github.io/policypilot-monad/research/) — the full Monad mainnet blotter, keywords and contracts linked, including the NADXBT fill of +0.02078 MON, the UNCLE fill of +0.01414 MON, a direct AFF hop of +0.000367 MON, and a Pancake v3 AUSD round trip of +0.001729 MON, all after gas. A wider pass found no new quote above the gas limit. The closest gross was +0.021119 MON. A follow-up requoted that cross at +0.017491 MON and sent nothing. The next set of quoters peaked at +0.019962 MON and sent nothing. Training corpus: [json](https://blockchains.github.io/policypilot-monad/research/corpus.json), [jsonl](https://blockchains.github.io/policypilot-monad/research/corpus.jsonl). Hourly public read of block, base fee, and the shMON unstake fee: [live.json](https://blockchains.github.io/policypilot-monad/research/live.json).

**Pitch video (2 min):** [watch](https://blockchains.github.io/policypilot-monad/demo.html) · [download MP4](https://blockchains.github.io/policypilot-monad/pitch.mp4)

**Demo video:** [watch](https://blockchains.github.io/policypilot-monad/demo.html) · [download MP4](https://blockchains.github.io/policypilot-monad/demo.mp4)
Status: IMPLEMENTED + TESTED locally (Foundry, anvil) and DEPLOYED to Monad testnet (test token only; not mainnet).
- `src/PolicyPilot.sol` non-upgradeable contract (OpenZeppelin v5.7.0 SafeERC20). `src/MockToken.sol` test-only.
- Tests: all pass under `forge test` (PolicyPilot, AgentVault unit/fuzz/invariant, dapp-call mocks). PolicyPilot invariants: `totalSpent <= budget`, `totalSpent == sum of transfers == recipient balance`, `remainingBudget == budget - totalSpent` (exact). Mainnet fork tests (`AgentVaultForkTest`: WMON wrap/unwrap, Uniswap v3 MON→USDC→MON, Kintsu stake, blocked calls) run with `forge test --fork-url https://rpc.monad.xyz --match-contract AgentVaultForkTest`.
- `executor/` viem deterministic executor + `e2e-anvil.mjs` local demo (writes evidence JSON).
- `frontend/index.html` static read-only demo dashboard: live state and budget gauge, event timeline, decoded on-chain rejections, read-only `eth_call` policy simulator, architecture, judge quick-start. Reads via RPC, or the Envio indexer via `?indexer=`.
- `indexer/` Envio HyperIndex indexer for all PolicyPilot events (local).
Run: `forge test -vv`; `anvil &`; `cd executor && node e2e-anvil.mjs`.
Deploy yourself: see [`docs/DEPLOY.md`](docs/DEPLOY.md).

## MonaDefi: simple, rules-based vault investing (new default home)

**Your balance. Your rules. Put it to work.** The site now opens on MonaDefi (`#/`, also `/app/`): connect a wallet, add MON, deploy into the one reviewed vault (aPriori aprMON, mainnet), track value and an estimated variable return derived from on-chain exchange-rate reads, and withdraw 25/50/75/100%, an amount, or everything through aPriori's queued withdrawals (Request withdrawal, then Claim). Rules (reserve, % of new deposits, target allocation, per-vault cap) only suggest actions; automatic execution stays off until a contract can enforce it. Release 1 uses MON because there is no reviewed USDC vault here. Every PolicyPilot tab and page below is unchanged. Details, protections, tests and the documented monadefi.com DNS change: [`docs/monadefi.md`](docs/monadefi.md).

Passkey accounts (Mera) are behind a feature flag that is **off by default**, because Mera derives a private key in the browser. Turn it on with `NEXT_PUBLIC_MONADEFI_PASSKEY=1` at build time, or per device with `?passkey=1` (`?passkey=0` turns it off). See [`docs/monadefi.md`](docs/monadefi.md#passkey-accounts-mera-behind-a-feature-flag-off-by-default).

## v3: one mobile-native app ("Love agents. Love control. PolicyPilot.")

https://blockchains.github.io/policypilot-monad/ is now a single Next.js PWA (installable, safe-area aware, bottom tab bar on phones and tablets). Tabs:
- **Launch**: a product bar jumps to Dispatch, Prime, Spread, Clip, or custom rules, and two shortcuts open your vaults or the live feed. Under that, a three-tap console. Pick a live preset (stake, best-price swap, or pay yourself), pick one of your vaults or create that preset in one transaction, then dispatch one real action. The vault cap, the budget, and the balance are checked before anything is sent. The owner can raise a vault’s per-action cap and budget up to that vault’s on-chain cap, and can deposit MON from a balancer or deployer wallet. The request id is generated for you. Payments, deposits, and withdrawals use a fixed gas limit, because Monad charges the limit rather than the gas used. New blocks arrive over a WebSocket when the public endpoint connects, and the page keeps polling if it does not. Under that, Prime is two choices on one pool: Capital Protected or Max Alpha. Protected is paid 30% of each profit and loses MON only after alpha is wiped out. Alpha takes the first loss and the other 70%. A hop can move at most 5% of the pool, an unprofitable hop reverts, and a 1.5% drop from the high watermark halts new hops. The 10% fee applies only to gains above that watermark. Opening one is a single transaction, capped at 10 MON. There is no promised rate. Under that, Spread quotes Uniswap v3 at 0.30% and 0.05%, PancakeSwap v3 at 0.05%, and Kuru from this tab when a new block arrives. Kuru is a price only. A round trip settles across those v3 pools when the pool's MON increases, in a separate pool you open yourself, capped at 10 MON. Rough gas is shown beside the quote and does not block a gain. It reverts unless the pool’s MON increases. The desk keeps a pool only when its runtime bytecode is the current spread contract. It fills the size, up to the 10 MON cap, that returns the most MON, and a larger size is used when that size returns more. One signature sends it. 10% of that profit pays the wallet that submitted it, 10% goes to the wallet that opened the pool, and the rest stays. The caller pays gas, including when the transaction reverts. There is no promised rate. Clip calls the Uniswap v3 and PancakeSwap v3 pools directly, searches sizes up to 10 MON, and the team runner sends at most 20 clips per round while the quote shows a gain. Rounds stay 10 minutes apart. Gas is paid on every send and can be larger than the gain. The signing wallet keeps 5 MON. There is no promised rate. Custom agent keys, sliders, and per-service switches are still there, under “Custom agent and custom rules”.
- **Activity**: a live feed of real transactions (the mainnet showcase vault plus your own), with allowed/blocked filters, plain-English revert reasons, a spend chart, and quick "run your agent" / "😈 break it" actions.
- **Agents**: your vaults, read from the factory: budget ring, a kill-switch toggle, deposit/withdraw, pull everything back, and withdraw tokens.
- **Services**: the top Monad services, each either live or honestly marked "coming soon".
- **Policy**: the original PolicyPilot dashboard (testnet).

Wallets: EIP-6963 multi-wallet discovery (MetaMask, Rabby, Phantom, Backpack, OKX, Coinbase… whatever is injected), a legacy `window.ethereum` fallback, and official deep links that open the app in a mobile wallet's browser (MetaMask, Phantom, Coinbase, OKX, Backpack, Trust). **WalletConnect is not included**: it needs a Reown project ID, which means a third-party signup.

Live services on mainnet. Each address comes from the protocol's own docs and passes a mainnet fork test (`forge test --fork-url https://rpc.monad.xyz --match-contract AgentVaultFork`):

| Service | Contract | Official source | Fork test |
|---|---|---|---|
| Pay approved payees | vault `execute` | – | unit/fuzz/invariant |
| Uniswap v3 swap | SwapRouter02 `0xfE31F71C1b106EAc32F1A19239c9a9A72ddfb900` | developers.uniswap.org (v3 Monad deployments) | `test_fork_uniswap_mon_to_usdc_and_back` |
| PancakeSwap v3 swap | SmartRouter `0x21114915Ac6d5A2e156931e20B20b038dEd0Be7C` (QuoterV2 `0xB048…5997`) | developer.pancakeswap.finance/contracts/v3/addresses | `test_fork_pancake_mon_to_usdc_and_back` |
| Kintsu liquid staking (sMON) | `0xA3227C5969757783154C60bF0bC1944180ed81B9` | docs.kintsu.xyz | `test_fork_kintsu_stake` |
| aPriori liquid staking (aprMON) | `0x0c65A0BC65a5D819235B71F554D210D3F80E0852` | apriori-docs.gitbook.io (smart contract integration) | `test_fork_apriori_stake` |
| Magma liquid staking (gMON) | `0x8498312A6B3CbD158bf0c93AbdCF29E6e4F55081` | docs.hydrogenlabs.xyz/magma | `test_fork_magma_stake` |
| Wrapped MON | `0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A` | docs.monad.xyz | `test_fork_wmon_wrap_unwrap` |

Coming soon, and not enabled: lending (Morpho is on Monad, but no vault is "listed" in Morpho's official API yet), USDC payouts (needs a new vault version, because ERC-20 `transfer` is blocked by design), perps (Kuru's official router address isn't verified), bridges (the output can't be forced back to the vault), NFTs (not verified).

These are new rules for new vaults. The deployed factory is unchanged, so no redeploy was needed, and existing vaults keep their own rules.

## Agent spending harness: live on Monad mainnet (alpha)

> **Alpha · unaudited contract · only deposit what you're happy to lose.** New vaults opened in the app use factory v3 `0x52727226aF0efe2bfe3E5c97e46B704613344a92` (on-chain vault cap 1000 MON, global cap 100000 MON). The app stops a new vault at 1000 MON, matching the v3 chain cap. Vaults opened on v2 `0x0342…6a` (1 MON vault cap, 1000 MON global) and v1 `0x8738…eEB7` (1 MON vault cap, 10 MON global) stay at those caps and remain viewable.

Site: https://blockchains.github.io/policypilot-monad/ ("Is this how easy it is to put a harness on agentic spending?"). Pick an agent, set the limits with sliders and approve dapp cards. One transaction creates a vault with every rule baked in. The agent key is generated and kept in your browser only.

- `AgentVaultFactory` on mainnet: v3 `0x52727226aF0efe2bfe3E5c97e46B704613344a92` (1000 MON on-chain vault cap, 100000 MON global). The app stops a new vault at 1000 MON, matching the v3 chain cap. v2 `0x0342d29055d77ba155c50233f550539E3029BA6a` and v1 `0x8738B74778502ff3623A8319837A819d8dBdEeB7` stay readable. The factory has no owner and no admin path to user funds.
- Showcase vault: `0x379e0C3Ecba46d62dAdCf26dBecd0F26A2cdCA97` (Sourcify exact match). Every allowed and blocked action is in `frontend/showcase-143.json`, and the site's history timeline re-reads it live from chain.
- Policy: target+selector allowlist, recipient word must equal the vault, a per-action MON cap, a total budget, per-token caps, exact approvals reset to 0, minOut checks and pause. Approve/transfer/permit selectors are forbidden.
- Dapps are verified official addresses only (`frontend/dapps.json`): WMON, Uniswap v3 SwapRouter02 and Kintsu sMON. Lending (Morpho) and perps (Kuru) are listed as not yet verified and are not enabled.
- Testnet factory: `0x2E40E06C0B864caF87cCB00f31e6EE2d0689cDd7`. The older mUSD consumer app is at `agents-testnet.html`.

## Dashboard (Next.js) and agent packages

- `web/`: a Next.js App Router + TypeScript + Tailwind + lucide-react + viem dashboard, statically exported to the site root. It shows the live block, chain id, a copyable address, a Sourcify badge and the Envio/RPC mode; metric cards for budget progress, remaining (with a warning under 20%), cap, firewall Active/Paused and execution count; a policy sandbox (client precheck plus a real `eth_call` of `execute()` from the on-chain executor, giving PASS or the exact custom error); and a Payouts/Audit Log table with explorer links, polling every 8s. It reads from Envio when `NEXT_PUBLIC_ENVIO_URL` is set and falls back to RPC logs otherwise. The vault harness lives at `/harness.html`.
- `packages/agent-kit`: `PolicyClient` with `checkPolicy(recipient, amount)` and `executeSafePayment(recipient, amount, {idempotencyKey})`, written against the real deployed ABI (`execute`, `paused`, `remainingBudget`, errors `Paused`, `RecipientNotAllowed`, `PerRequestLimitExceeded`, `BudgetExceeded`, `RequestAlreadyExecuted`, ...). It is tested against anvil (`npm test`).
- `packages/plugin-eliza`: an ElizaOS (`@elizaos/core` 1.x) plugin with the `EXECUTE_POLICY_PAYMENT` action and the `POLICYPILOT_STATE` provider. Settings: `POLICYPILOT_ADDRESS`, `POLICYPILOT_RPC`, `POLICYPILOT_CHAIN_ID` and the secret `POLICYPILOT_EXECUTOR_KEY`.

## Live on Monad testnet (chain 10143)
- **PolicyPilot:** [`0x583fDB6441a9bCE517CF5bb15b9dB7340BB57D4E`](https://testnet.monadexplorer.com/address/0x583fDB6441a9bCE517CF5bb15b9dB7340BB57D4E) (Sourcify verified, exact runtime match)
- **MockToken (mUSD, test-only):** [`0xE2966C817267FC7E63362895Cf55C6cb2548b9E3`](https://testnet.monadexplorer.com/address/0xE2966C817267FC7E63362895Cf55C6cb2548b9E3) (Sourcify verified)
- Policy: executor = admin = `0x549D8c5D94f8ec4Ea488a0283f8EbF16b509b411`, 2 allowlisted recipients, per-request limit 100 mUSD, budget 250 mUSD, funded 1000 mUSD.
- Live viewer: https://blockchains.github.io/policypilot-monad/ · Record: [`deployments/monad-testnet.json`](deployments/monad-testnet.json) · Reproduce: [`docs/DEPLOY.md`](docs/DEPLOY.md)

| demo step | result | tx |
|---|---|---|
| valid_execute_1 | success | [0x8e799909dd71…](https://testnet.monadexplorer.com/tx/0x8e799909dd7155cac966ff15e14eb72d7cbaedc8bc8b58952f5392ed8b260305) |
| valid_execute_2 | success | [0x593705cc5d3b…](https://testnet.monadexplorer.com/tx/0x593705cc5d3bbcd6932cc37574e73bd97937ccbeca76bb151c00788ec6e451c3) |
| replay_req_1 | reverted | [0x618511db3427…](https://testnet.monadexplorer.com/tx/0x618511db34273878d7b83bb8bd1af5b2062e7c94fe3a806db30a2efae7da52f9) |
| reject_recipient | reverted | [0x475a58183dc2…](https://testnet.monadexplorer.com/tx/0x475a58183dc244e3eb5caddd2dbcd4085a54e7da54f738b82eeb24dff85aeb6a) |
| reject_per_request_limit | reverted | [0x540ff26d3148…](https://testnet.monadexplorer.com/tx/0x540ff26d3148eb511c8967b17fe05df194502d9bfd142d6f55076e6def3601a4) |
| reject_budget | reverted | [0xc61f401a6e45…](https://testnet.monadexplorer.com/tx/0xc61f401a6e45d60766c9772d85b00894fc5dbc824fca5e850f5c50ed63fdad59) |
| pause | success | [0x195ac238401b…](https://testnet.monadexplorer.com/tx/0x195ac238401bf6fd8681fe6591bc976e037bd5850aa5331759b82750939fcfa7) |
| reject_paused | reverted | [0x1bbaf1dfb8ba…](https://testnet.monadexplorer.com/tx/0x1bbaf1dfb8badf94241c3e150293315d09831ae138fb14904b05b99c55023977) |
| unpause | success | [0x919240de6de0…](https://testnet.monadexplorer.com/tx/0x919240de6de013e59d3038b7a6f9493e5e065bdf9d0c78debb16e4f666dffc26) |

Rejections are real on-chain **reverted** transactions (sent with a fixed gas limit after an `eth_call` preflight captured the revert reason).

## Envio HyperIndex indexer (optional data source)
`indexer/` is an Envio HyperIndex project that indexes every PolicyPilot event on Monad testnet (PerRequestLimitSet, BudgetSet, RecipientSet, Executed, PausedSet) into `PolicyState`, `Execution`, `Recipient` and an append-only `PolicyEvent` audit log, served over GraphQL.
The viewer reads state, execution history and the audit log from it when opened with `?indexer=<graphql url>` (or `indexerUrl` in `frontend/deployment.json`), and falls back to direct RPC otherwise or if the indexer is unreachable.
- Verified against the live contract: all 8 events indexed; indexer values match direct `cast call` reads (budget 250, limit 100, totalSpent 200 mUSD, paused false). Evidence: [`docs/envio-indexer-check.txt`](docs/envio-indexer-check.txt). Video (45 s): [envio-demo.mp4](https://blockchains.github.io/policypilot-monad/envio-demo.mp4).
- **Local only**: not hosted (no Envio Cloud), so the public site runs in RPC mode. Uses the public Monad RPC as source, so no HyperSync token or Envio account is needed. Run: [`indexer/README.md`](indexer/README.md).

## Kuru (live) and team showcase agents

- **Kuru** order-book DEX is live as a service: Router `0xd651346d7c789536ebf06dc72aE3C8502cd695CC`, MON-USDC market `0x065C9d28E428A0db40191a54d33d5b7c71a9C394` (source: https://docs.kuru.io/contracts/Contract-addresses). Both are ERC-1967 proxies with code on chain 143 (upgradeable by Kuru). Allowlisted selector: `anyToAnySwap` (0xffa5210a); output is credited to the caller (the vault), and the vault also enforces `minOut`. Fork test: `test_fork_kuru_mon_to_usdc` (docs/evidence/kuru-fork-test.txt). Real mainnet tx: see docs/evidence/kuru-mainnet-tx.json.
- **PolicyPilot showcase agents (operated by the team)**: `runner/showcase-agents.mjs` (uses `@policypilot/agent-kit` `VaultAgent`) runs DCA bot / Staker / Payroll / Rogue agent vaults on mainnet from the team's box with a hard MON-consumed auto-stop and full recovery at the end. They are shown separately on the Activity tab and are never counted as users.
- **Showcase spend policy**: total MON consumed is capped at 1000 MON (`STOP_AT`), and the runner stops before the deployer wallet drops below a 5 MON reserve (`OWNER_RESERVE`). Per-vault policy limits and allowlists are unchanged. The v3 factory's global deposit cap is 100000 MON. The app stops a new vault at 1000 MON, matching the v3 chain cap, and vaults already opened on v1 or v2 stay at 1 MON. The runner never tops up a team vault if that would leave less than 1 MON of global-cap room for real users. The Launch screen shows the room left and blocks deposits that wouldn't fit.

### Running the showcase agents without the box (GitHub Actions)

`.github/workflows/showcase-agents.yml` runs near-continuously with no external trigger: a job starts every hour (plus `workflow_dispatch`), and each job loops **one full round over all team vaults every ~10 minutes for ~5h40m** (`runner/showcase-loop.sh`). The `showcase-agents` concurrency group queues the next job without cancelling the running one, so exactly one loop is active at a time. After every round the ledger (`runner/ledger/showcase-143.jsonl`) and the snapshot (`web/public/showcase-agents-143.json`) are committed with `[skip ci]` (`runner/showcase-commit.sh`): the job rebases onto the remote, the ledger is union-merged (append-only, `.gitattributes`), and on a snapshot conflict the freshly generated file wins. The site reads the snapshot from raw.githubusercontent.com and falls back to the copy deployed with Pages.

- **Every vault, every round:** `node runner/showcase-agents.mjs run` iterates all personas in `runner/showcase-config-143.json`, each in its own try/catch, so one failure never blocks the others. A persona is skipped only when it is genuinely stuck (no agent-key secret, no vault yet, key is not the vault's executor, vault paused, agent gas < 0.08 MON, vault balance / budget exhausted) and the reason is written to the ledger once per reason (`status: "skipped"`) and shown on the site. Policy decisions are left to the vault on-chain.
- **Vault resolution:** before each round the runner checks on-chain that each key is the `executor()` of its configured vault; if not, it looks the vault up by executor across the v2 and legacy factories (the committed config can lag behind a migration).
- **Personas:** DCA bot, Staker, Payroll, Rogue agent, DCA bot (v1 vault), plus **Kuru market maker** (sells MON→USDC and buys MON back with USDC on Kuru's order book, approval capped by the vault), **Wrap/unwrap rebalancer** (keeps a 50/50 MON/WMON split), **Tipper** (pays its full per-action cap to allowlisted team addresses) and **Policy tester** (wraps exactly the cap, then cap + 1 wei, replays a requestId, swaps with the wrong recipient, pays a stranger: the blocked attempts are broadcast so the reverts are public). Each spending persona sends the largest amount the vault will still accept: the minimum of the per-action cap, the vault's MON balance, and the budget left. A dust remainder is broadcast; a zero remainder is skipped. The rogue agent and the tester's blocked probes are not resized. The four new personas are `pending` until the owner creates their vaults and adds `AGENT_KEY_MM`, `AGENT_KEY_REBALANCER`, `AGENT_KEY_TIPPER`, `AGENT_KEY_TESTER`.
- **Keys:** only the agents' executor keys, stored as encrypted secrets `AGENT_KEY_<ID>`. Set them with `runner/set-actions-secrets.sh`, which needs `gh auth login`. The deployer/owner key is never used in CI, so CI cannot withdraw, change policy or unpause a vault. Recovery (box mode) uses `withdraw(owner, balance)`, never `emergencyWithdrawAll` (which would pause the vault).
- **Vault refill:** `.github/workflows/agent-refill.yml` (every 30 min + backup crons) lets each agent top up its own team vault to 20 MON (rogue vaults 0.5) from its own spare gas, at most 10 MON per agent per run, never below an 8 MON agent gas floor. Destinations are only the vaults in `runner/agent-refill-config-143.json`, verified on-chain (owner, executor). A paused team vault or combined agent spare gas below 30 MON opens one alert issue; unpausing stays manual.
- **Kill switch:** the repo variable `SHOWCASE_ENABLED` must be `true`. Remove it or set it to anything else to stop; a running loop re-checks it between rounds.
- **Guards:** the loop stops if a single transaction costs more than 0.15 MON (`MAX_FEE_MON`). Every action is still checked by the vault on-chain.
- **Funding:** there are no owner top-ups in CI. At one round every 10 minutes a swap-heavy persona burns roughly 0.05 MON of gas per round (~0.3 MON/hour), so a 1 MON gas wallet lasts a few hours of looping; the persona is then skipped (with the reason in the ledger) until the owner tops it up. Vault balances and budgets drain the same way. Change the cadence with the `interval_seconds` dispatch input if needed. The runner also paces itself (`ROUND_SPACING_S`, default `INTERVAL_S_DEFAULT` from `runner/showcase-loop.env`), so a cadence change merged to main applies to an already-running loop on its next round.
- **Handoff from the box runner:** run `touch ~/.policypilot/showcase-143v2.handoff`. The box runner then exits without recovering funds. After that, set `SHOWCASE_ENABLED=true`.
- **Dry run / local test:** `AGENTS_ONLY=1 DRY_RUN=1 node runner/showcase-agents.mjs run` builds and simulates every action without sending or writing anything. The whole path (all nine personas, real Uniswap/PancakeSwap/Kuru/Kintsu/aPriori/Magma/WMON calls, blocked reverts, skip reasons, commit/rebase) was exercised on an `anvil --fork-url https://rpc.monad.xyz` fork.

### Vault picker in the app (Agents tab)

Lists the connected wallet's own vaults from the current factory and the older ones, and the team vaults from the snapshot. For your own vaults the buttons (wrap, unwrap, Kuru swap, Uniswap / PancakeSwap swap, pay an address) send **real transactions through the vault's policy** when this browser can sign for the agent (your wallet is the executor, or the agent key is stored in this browser); otherwise they simulate, and the owner can make the connected wallet the agent in one signature (`setExecutor`). Paying an address that isn't an approved payee asks the owner to allowlist it first (one extra signature). Team vaults are read-only / simulate: the agent keys never enter a browser. The **one-click starter vault** creates a vault with your wallet as the agent and deposits 0.5 MON in a single factory transaction (`createVault` is payable, fixed 8,000,000 gas so creation cannot run out; Monad charges that limit). Its per-action cap and budget sit at the 1000 MON vault cap. If the alpha deposit cap is full it is created empty and you deposit later.

### Super vaults (Agents tab, mainnet)

Three curated templates, each created and funded in one factory transaction with your wallet as the agent, then driven by a **playbook** (real transactions through the vault policy; a failed step stops the run and says why, it does not keep retrying):

- **Yield** — splits a deposit across Kintsu (sMON), aPriori (aprMON) and Magma (gMON). Receipt tokens stay in the vault.
- **Best execution** — quotes Uniswap v3, PancakeSwap v3 and Kuru for the same MON→USDC size and routes to the best output, with the vault’s own minOut (−3%) guard. The same quote panel is on the manual “Best-price swap” button whenever a vault has two or more of those venues.
- **Payments** — only payees you approve, with the per-action cap and budget at the 1000 MON vault cap. The playbook pays 0.1 MON to each approved payee.

### Vault report and cash-out

Every vault (yours, and the team vaults as a read-only view) opens a portfolio: a donut and allocation bar of what is inside, each asset’s amount and estimated MON value, and two sparklines (MON/USDC, and the vault’s estimated value). Prices are quoted on-chain from Uniswap v3, PancakeSwap v3 and Kuru for 0.1 MON and scaled to 1 MON — there is no paid price API. The lines are sampled every 20 seconds while the page is open and stored in this browser only. aprMON and gMON are valued with `convertToAssets`; sMON has no exchange-rate function on its contract, so it is shown 1:1 and labeled as such. A “how this vault works” strip lists the policy and the playbook or the allowlisted services.

**Cash out / close** (owner only, real transactions, stops at the first failure):

1. If the vault holds USDC, this browser can sign as the agent, a Uniswap or PancakeSwap rule is on, and the balance is within the vault’s USDC approval cap — swap USDC → WMON on the better quote (minOut = quote − 3%). Otherwise USDC is returned as USDC.
2. If the vault holds WMON and the wrap rule is on — unwrap it to MON inside the vault. Otherwise WMON is returned as WMON.
3. `withdrawToken` every remaining receipt (sMON, aprMON, gMON, and anything that could not be swapped) to the creator. The vault can stake into those protocols; it cannot unstake. Redeem the receipts in Kintsu, aPriori or Magma.
4. `withdraw` the vault’s MON to the creator. This does not pause the vault.
5. Optional: pause the agent afterwards (the “close” switch, on by default). A paused vault is resumed first if a swap or unwrap is needed, then paused again only when that switch is on.

Team vaults show the same report with the cash-out button disabled. The flow never calls `emergencyWithdrawAll`.
