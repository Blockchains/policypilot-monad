# Architecture
Off-chain request (invoice key, recipient, amount) -> executor derives requestId = keccak256(chainId, contract, key, recipient, amount)
-> reads `executed(id)` (skip if consumed) -> `simulateContract` (policy pre-check) -> `execute(id, recipient, amount)`.
On-chain checks in order: executor role, paused, replay, zero amount, allowlist, per-request limit, cumulative budget; then effects (mark executed, totalSpent) and event; then SafeERC20 transfer (CEI).
Admin: setRecipient, setExecutor, transferAdmin (single-step), setPerRequestLimit, setBudget, setPaused. Contract holds the asset; no withdraw function (see limitations).

The lines above describe the original testnet `PolicyPilot.sol` reference.

## UnlimitedAgentVault (v4, Monad mainnet, 18 Oct 2026)
`UnlimitedAgentVaultFactory.createVault(executor)` (payable) deploys one `UnlimitedAgentVault` per user: owner = caller, executor = the agent, `msg.value` deposited. There are no spending limits and no allowlists: no vault cap, per-payment cap, budget, token cap, payee allowlist or call allowlist. The agent can move all of the vault's funds.
Agent checks: caller is executor, not paused, requestId not used, amount <= balance (and `minOut` if the agent passes one). `execute(id, to, amount)` pays any address; `executeCall(id, target, value, data, approveToken, approveAmount, minOutToken, minOut)` calls any contract with any calldata. Owner: deposit, withdraw, withdrawToken, emergencyWithdrawAll, setExecutor, setPaused. Compatibility views report `type(uint256).max` caps and allow-all rules so v1-v3 readers keep working.
