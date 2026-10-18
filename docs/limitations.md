# Limitations (honest)
- No external audit. Local tests only. Not deployed to Monad testnet or mainnet.
- No withdraw/rescue function: funds sent to contract can only leave via execute(). Intentional for the reference; add admin-rescue before real use.
- Single asset per deployment; fee-on-transfer / rebasing tokens unsupported.
- Single-step admin transfer. No time-windowed budgets.
- Frontend is a read-only viewer; executor uses a dev key only on local anvil.
- No users, no pilots, no production traffic.

## UnlimitedAgentVault (v4, mainnet)
- Alpha · unaudited contract · only deposit what you're happy to lose.
- No spending limits or allowlists by design: the agent can move all of the vault's funds. Protection is only the owner's pause, agent replacement and withdraw.
- Older v1-v3 vaults keep their immutable vault cap (1 MON v1/v2, 1000 MON v3), add-only payee allowlist, output-must-return-to-vault check and agent approve/transfer ban; these cannot be removed without a new vault.
- The team's 13 ShowcaseAgentVaults keep their bytecode limits (1000 MON vault cap, team-only payees); their caps and budgets were set to max on 18 Oct 2026.
- Pooled products (Prime, Spread, Clip) keep their loss/hop/size caps, because those protect other depositors in the same pool.
