# Threat model
| Threat | Mitigation | Residual |
|---|---|---|
| Compromised executor key | Bounded by allowlist, per-request limit, cumulative budget; admin can pause / rotate executor | Executor can drain up to remaining budget to allowlisted recipients |
| Replay / double payment | requestId mapping set before transfer; deterministic id derivation in executor | Different keys for same invoice = two payments (off-chain dedupe needed) |
| Reentrancy via token | CEI ordering; state set before external call | Non-standard tokens (fee-on-transfer) cause accounting drift – unsupported |
| Compromised admin | Out of scope; recommend multisig (Safe) as admin | Single-step admin transfer – typo risk |
| Upgrade risk | Non-upgradeable | Bugs require redeploy |

## UnlimitedAgentVault (v4)
| Threat | Mitigation | Residual |
|---|---|---|
| Compromised agent key | None on spending: there are no caps or allowlists. Owner can pause, replace the agent (`setExecutor`) or `emergencyWithdrawAll` | **The agent can move all of the vault's funds, to any address or contract, in one transaction** |
| Replay | `executed[requestId]` set before the external call | Different ids are different payments |
| Reentrancy | `nonReentrant` on every agent and owner withdraw path | Unaudited |
| Older v1-v3 vaults | Owner can lift caps/budget/token caps and enable services ("Remove limits") | Immutable vault cap, payee allowlist (add-only), output-to-vault check and approve/transfer ban stay |
