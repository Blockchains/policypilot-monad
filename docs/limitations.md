# Limitations (honest)
- No external audit. Local tests only. Not deployed to Monad testnet or mainnet.
- No withdraw/rescue function: funds sent to contract can only leave via execute(). Intentional for the reference; add admin-rescue before real use.
- Single asset per deployment; fee-on-transfer / rebasing tokens unsupported.
- Single-step admin transfer. PolicyPilot and AgentVault have no time-windowed budget. EpochAllowanceVault, SessionVault, and VetoDelayVault are separate native-MON contracts (see docs/novel-vaults.md); they are not deployed and they do not change the live factory.
- Frontend is a read-only viewer; executor uses a dev key only on local anvil.
- No users, no pilots, no production traffic.
