# Novel vaults

AgentVault gives one standing executor a lifetime budget and settles native MON immediately. That is the right shape for a small allowlisted payout the owner is willing to pre-authorize in full. It is a bad shape for a long-running agent:

- A lifetime budget stays spendable until it is gone. Unused room stockpiles. A key stolen on a quiet week can take the whole remainder in one shot.
- A rolling window does not fix the stockpile. Spend the full window at the boundary, then spend the new window a moment later, and the key takes about twice the intended rate.
- The executor key does not expire. Rotating it requires the owner to show up.
- Settlement is instant, so a second key that can see a bad payment cannot stop it.

These three vaults are separate contracts behind `NovelVaultFactory`. They do not change `AgentVault` or the factory that is already on Monad. They are alpha, unaudited, and not deployed. None of them can call arbitrary dapps; AgentVault already owns that path.

## EpochAllowanceVault

Card networks and treasury software use a non-rolling period limit: this epoch's unused allowance dies with the epoch. `EpochAllowanceVault` does that for native MON.

- `epochLength` is immutable and at least one hour. Allowance is `epochAllowance` per epoch, tracked by `currentEpochSpent()`.
- Unspent allowance does not carry. After the epoch rolls, the agent has a fresh `epochAllowance`, not `epochAllowance + leftover`.
- A reserve floor is owner principal. `execute` reverts if the balance would fall through it. `withdraw` is owner-only and may take the floor.
- Naked transfers revert (`DirectTransferDisabled`), so MON cannot skip `deposit()` and the factory's global cap.

Raw storage `epochSpent` is updated on the next agent call. Readers that need the live figure should use `currentEpochSpent()` or `remainingEpochAllowance()`.

## SessionVault

[ERC-7715](https://eips.ethereum.org/EIPS/eip-7715) and account-abstraction session keys scope a delegate to a clock, a value, and a target set, and the delegate cannot widen that scope. `SessionVault` is that idea for several agents sharing one MON balance.

- The owner opens a session: key, `notBefore`, `notAfter`, allowance, and up to eight payees.
- The window cannot exceed 30 days. A key that should live forever belongs on AgentVault, not here.
- The key cannot open, extend, revoke, or add payees. Request ids are unique across every session on the vault, so one session cannot replay another's id.
- Sessions do not share allowances or payee lists. The same reserve floor applies to every key.

## VetoDelayVault

The Zodiac Delay modifier and optimistic governance (propose, wait, let a distinct party veto, then anyone may execute) separate "the agent wants this" from "the funds moved." `VetoDelayVault` uses that split.

- The executor `propose`s. Nothing is transferred and nothing is reserved against the budget.
- `delay` is immutable and at least 15 minutes. `readyAt` is fixed on the proposal, so a later config change cannot pull a pending payment forward.
- After `readyAt`, anyone may `release`. Liveness does not depend on the owner being online.
- The owner or the guardian may `cancel` until release, including after the delay. The guardian cannot withdraw, change payees, change the executor, or shorten the delay. The guardian cannot be the executor.
- A cancelled request id stays used, so the agent cannot reset the clock by proposing it again.
- `release` checks pause, payee, per-payment cap, remaining lifetime budget, balance, and reserve floor again. The owner can pull funds or remove a payee during the wait.

## What this does not do

No upgrade path, no factory admin, no arbitrary call router, no ERC-20 streaming, and no claim that these are live on mainnet. Forced MON (not a normal transfer) can still increase a vault's balance; the agent can spend only the surplus above the reserve, inside that vault's allowance. A compromised owner can still withdraw, which is the owner's own money.
