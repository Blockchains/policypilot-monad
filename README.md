# PolicyPilot (Monad) – bounded transaction execution reference implementation

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

## v3: one mobile-native app ("Love agents. Love control. PolicyPilot.")

https://blockchains.github.io/policypilot-monad/ is now a single Next.js PWA (installable, safe-area aware, bottom tab bar on phones and tablets). Tabs:
- **Launch**: the novice flow. Connect wallet → connect agent (create an in-browser agent key, or paste an external agent address such as an ElizaOS agent) → switch rules on/off (total budget, per-action cap, allowed services, payees, start paused) → **Let it go into the wild** (one `createVault` tx with every rule baked in, plus optional agent gas).
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

## Novel vaults (local only, not deployed)

`NovelVaultFactory` creates three more native-MON vaults. They do not replace AgentVault and they are not on the factory that is live on mainnet. Design notes: [`docs/novel-vaults.md`](docs/novel-vaults.md).

| Vault | Agent authority | What a stolen agent key still cannot do |
|---|---|---|
| `EpochAllowanceVault` | A fresh allowance each epoch (at least 1 hour) | Stockpile unused allowance, or spend the reserve floor |
| `SessionVault` | Several keys, each with its own clock, allowance, and payees | Outlive a 30-day window, or widen its own session |
| `VetoDelayVault` | Propose a payment anyone can release after a delay (at least 15 minutes) | Move funds before the delay, or stop the owner/guardian veto |

Run: `forge test --match-contract "Epoch|Session|Veto"`.

## Agent spending harness: live on Monad mainnet (alpha)

> **Alpha · unaudited contract · only deposit what you're happy to lose.** The vault cap is 1 MON and the global cap is 1000 MON (factory v2 `0x0342d29055d77ba155c50233f550539E3029BA6a`, Sourcify exact match). The first factory `0x8738…eEB7` (10 MON global cap) is kept as legacy and its vaults stay viewable.

Site: https://blockchains.github.io/policypilot-monad/ ("Is this how easy it is to put a harness on agentic spending?"). Pick an agent, set the limits with sliders and approve dapp cards. One transaction creates a vault with every rule baked in. The agent key is generated and kept in your browser only.

- `AgentVaultFactory` on mainnet: `0x8738B74778502ff3623A8319837A819d8dBdEeB7` (Sourcify exact match). The factory has no owner and no admin path to user funds.
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
- **Showcase spend policy**: total MON consumed is capped at 1000 MON (`STOP_AT`), and the runner stops before the deployer wallet drops below a 5 MON reserve (`OWNER_RESERVE`). Per-vault policy limits and allowlists are unchanged. The contract's alpha global deposit cap (10 MON across all vaults) still applies. The runner never tops up a team vault if that would leave less than 1 MON of that room for real users. The Launch screen shows the room left and blocks deposits that wouldn't fit.

### Running the showcase agents without the box (GitHub Actions)

`.github/workflows/showcase-agents.yml` runs every 10 minutes. Each run is one agent action, and the persona rotates by run number. It commits the snapshot (`web/public/showcase-agents-143.json`) and the ledger (`runner/ledger/showcase-143.jsonl`) with `[skip ci]`. The site reads the snapshot from raw.githubusercontent.com and falls back to the copy deployed with Pages.

- **Keys:** only the agents' executor keys, stored as encrypted secrets `AGENT_KEY_DCA`, `AGENT_KEY_STAKER`, `AGENT_KEY_PAYROLL`, `AGENT_KEY_ROGUE` and `AGENT_KEY_DCA1`. Set them with `runner/set-actions-secrets.sh`, which needs `gh auth login`. The deployer/owner key is never used in CI, so CI cannot withdraw, change policy or top up a vault.
- **Kill switch:** the repo variable `SHOWCASE_ENABLED` must be `true`. Remove it or set it to anything else to stop.
- **Per-run guards:** a run is skipped if the agent's gas is below 0.08 MON. The job fails if a single transaction costs more than 0.15 MON. Every action is still checked by the vault on-chain.
- **Funding:** the vaults were pre-funded near the 1 MON per-vault cap and the agent gas wallets hold about 4.4 MON in total. There are no owner top-ups in CI, so activity stops once the gas or vault MON runs out. That is roughly 1–2 days at the default rate.
- **Handoff from the box runner:** run `touch ~/.policypilot/showcase-143v2.handoff`. The box runner then exits without recovering funds. After that, set `SHOWCASE_ENABLED=true`.
