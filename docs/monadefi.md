# MonaDefi: simple, rules-based vault investing (release 1)

> **Alpha · unaudited contract · only deposit what you're happy to lose.**

"Add funds. Choose your rules. Deploy into a vault. Track returns. Withdraw some or all when needed."

MonaDefi is the new default home of the PolicyPilot app (`#/` on the site root, and `/app/`). Every existing
PolicyPilot route is unchanged: `#launch` (Dispatch, Prime, Spread, Clip), `#activity` (including the
PolicyPilot showcase agents (operated by the team)), `#agents` (vault factory), `#services`, `#policy`, `/research/`
(desk tape), `/harness.html` and the other legacy pages. The service worker cache moved from `pp-v19` to `pp-v20`.

## What is supported

| | Release 1 |
|---|---|
| Asset | **MON** only. The brief asks for USDC. There is no reviewed USDC vault in this app, so MonaDefi starts with MON, the asset every existing PolicyPilot vault already uses. The UI says so. |
| Vault | **aPriori aprMON** `0x0c65A0BC65a5D819235B71F554D210D3F80E0852` (Monad mainnet). Already a "live" service in `web/src/lib/services.ts` with a mainnet fork test (`test_fork_apriori_stake`). ABI from aPriori's official integration page. |
| Deposit | `deposit(assets, receiver)` with native MON. No token approval. |
| Withdraw | Queued: `requestRedeem(shares, you, you)`, then after unlock `redeem(requestIds, receiver)`. The button says **Request withdrawal**. |
| Fees | No deposit fee. Withdrawal fee read on-chain (`withdrawalFee() = 10`). Seven mainnet `Redeem` events (blocks 114306105–114406792) charge exactly 10 bps of the gross amount, so the UI shows 0.10%. `rewardFee() = 10` is shown raw because aPriori does not document its unit. MonaDefi charges nothing. |
| Return | Real derived data: the change in `convertToAssets(1e18)` between the head block and a block ~7 days back (3 or 1 day if the RPC does not keep that much history), simple-annualised, with a "last updated" time. Otherwise "Not enough data yet". At 18 Oct 2026 16:30 BST this read 9.53% a year. Never presented as guaranteed. |

### Why not a PolicyPilot clip/prime/spread pool?

The team clip pool `0x38b4…336e` is the only shared PolicyPilot pool with depositor shares. Its share price fell
by more than 99% between blocks 114102916 and 114502916 (supply 1.25e26 → 1.09e29 shares while assets stayed at
~9.5–9.8 MON), because the showcase runner clips at small losses and refills it. Offering that as an investment vault
would be wrong. Prime and Spread pools are personal pools that need their own executor. aprMON is a real reward-bearing
vault with a published withdrawal path, so it is the one reviewed vault. The showcase caps are unchanged
(`CLIP_MAX_PER_ROUND=20`, 10-minute rounds, 5 MON reserve).

## Modules (all additive)

| Module | Where |
|---|---|
| Account access | `MonaDefi.tsx` access card; uses the existing EIP-6963 `ConnectSheet` from `App.tsx`. |
| Balance & funding | Dashboard balance card. "Add funds" shows the wallet address. No on-ramp, no paid API. |
| Rules engine | `lib/monadefi.ts`: `Rules`, `validateRules`, `describeRules`, `proposeActions`, `afterClaimBaseline`. Saved in `localStorage` (`md.rules.143.<address>`). |
| Execution | `MonaDefi.tsx`: fresh `previewDeposit`/`previewRedeem`, `eth_call` simulation, `pricedGas`, the app's existing `send` (now with an optional `onHash` callback so "Submitted" shows before the receipt). |
| Vault adapter | `VAULTS` in `lib/monadefi.ts` (facts, fees, risks, conditions) and the aprMON ABI subset. |
| Reporting | Dashboard: performance, vaults table, withdrawal requests (read from `getUserRequestData`), recent activity (receipts + recent `Deposit` logs). |

### Transaction states and protections

States: Awaiting approval, Submitted, Confirming, Completed, Partially completed, Failed, Withdrawal requested,
Waiting for liquidity, Action required.

- Minimum shares / proceeds: 0.5% guard. aPriori's functions have no on-chain minimum parameter, so the app re-reads
  the preview right before sending and refuses below the minimum, then checks the `Deposit` event in the receipt.
  Fewer shares than the minimum marks the deployment "Action required". This is a client-side guard and is labelled as such.
- Approvals: none needed (native MON in; your own aprMON for requests). Shown on the review screen.
- Duplicate-action prevention: same kind/vault/amount cannot be resent while open or within two minutes.
- Stale data: previews older than 30 s block the review and the confirm button.
- Partial execution: withdraw-all records each step and reports "Partially completed" when only some steps land.
- No phantom positions: positions come only from `balanceOf` on chain. A deposit is Completed only when its receipt
  carries a `Deposit` event for your address. Records left open by a closed tab are settled from the chain.
- Withdrawn MON is never redeployed: a claim raises the rule-B baseline by the claimed amount.
- Emergency controls: "Stop all suggestions" and "Withdraw all". MonaDefi cannot pause any vault (and never pauses team vaults).

## Rules (release 2 "suggest and approve", shipped as UI + local persistence + proposals)

A keep a reserve · B deploy a % of **new** deposits (MON that arrives after saving; never the existing balance) ·
C target allocation (proposes only) · D per-vault cap · E execution mode.

**Automatic mode is disabled.** It needs an on-chain permission that limits asset, destination, amount, expiry and
revocation. PolicyPilot vaults no longer have spending limits or allowlists (since 18 Oct 2026 an agent can move all
of a vault's funds), so they cannot provide that permission, and their aPriori call sends aprMON to the vault rather
than to the user's position. Until a contract enforces all five, MonaDefi only
suggests actions. `AUTO_MODE_AVAILABLE = false` in `lib/monadefi.ts`.

## Passkey accounts (Mera), behind a feature flag, OFF by default

Mera (Category Labs, `@category-labs/mera` 0.2.0, MIT/Apache-2.0) is real, free and open source, and Monad's docs have a
guide (docs.monad.xyz/guides/mera). It is in preview and has only had an internal security review.

**What Mera does: it creates a private key in the browser.** A WebAuthn passkey with the PRF extension returns a
32-byte secret. MonaDefi turns that into a BIP-39 mnemonic and derives `m/44'/60'/0'/0/0`, which is the derivation
Mera's guide recommends. That gives an ordinary Monad EOA private key, computed in the page's JavaScript. The key goes
straight into a Mera signing session. The PRF output, seed and key bytes are zeroed right after the session is
created, and nothing secret is stored, logged or sent. localStorage only holds the credential id, its transports and the
derived address (`md.passkey.cred.<host>`). Lock, Disconnect or reloading the page ends the session.

**Why a flag exists:** this project's standing rule is "no keys in the frontend". A passkey account breaks that rule
on purpose, for users who choose it. So it ships disabled. The site owner turns it on for a build, or a user turns it
on for their own device. When it is off, the UI shows the original disabled "Create account with a passkey · Passkey
accounts coming soon" button, and the Mera code is never downloaded (it is a lazily loaded chunk).

| How | Effect |
| --- | --- |
| Build time: `NEXT_PUBLIC_MONADEFI_PASSKEY=1 npm run build` (CI/Pages: set it as an env var on the build step) | On for every visitor of that build |
| Runtime, per device: open the site with `?passkey=1`, e.g. `https://blockchains.github.io/policypilot-monad/?passkey=1` | On in this browser (saved in localStorage `md.passkey.optin=1`) |
| Runtime off: `?passkey=0` | Off in this browser, even if the build enables it |

The default Pages build does **not** set the env var, so the live site is off unless a visitor opts in with `?passkey=1`.

When the flag is on, the access card explains how the account works and asks for an explicit acknowledgement checkbox.
It then offers **Create account with a passkey** and **Sign in with an existing passkey**.

- **Not permission to move funds.** A new account is empty. The passkey "wallet" is an EIP-1193 provider
  (`lib/passkey.ts`) that plugs into the existing connect/send path. Every `eth_sendTransaction`, `personal_sign` and
  `eth_signTypedData_v4` opens an approval dialog that shows the destination, MON amount and gas limit. Reject returns
  the standard 4001 error and nothing is signed. It never auto-reconnects: `eth_accounts` is empty until the passkey is
  used again. Other `eth_sign*` methods are refused. Showcase rules, caps and the aprMON flow are unchanged; passkey
  accounts use exactly the same gates.
- **Access:** use the same passkey on the same domain to get the same address. Passkeys are bound to the hostname. A
  passkey created on `blockchains.github.io` gives a different (empty) account from one on `monadefi.com`, so after a
  domain move, users must withdraw first and recreate.
- **Recovery:** the account is only as recoverable as the passkey. Synced providers (iCloud Keychain, Google Password
  Manager, 1Password) restore it on new devices. If you delete the passkey or it was device-only, funds are lost.
  Recovery-phrase export is **not implemented** (deferred), so the UI tells users to keep small amounts only.
- **Compatibility:** PRF is required. On desktop Chrome the passkey must be saved to Google Password Manager. If PRF
  is unavailable, the user gets a plain error and no account is created.
- **Dependencies:** `@category-labs/mera@0.2.0`, plus `@scure/bip39@1.3.0` and `@scure/bip32@1.4.0` (the versions viem 2.21
  already ships). Mera's optional `viem >= 2.28` peer is satisfied by an npm `overrides` entry. It is only needed for
  Mera's `mera/viem` adapter, which we don't import; `lib/passkey.ts` has its own small viem-2.21 account adapter.
- **Tests:** `src/lib/passkey.test.ts` checks that derivation matches viem's standard mnemonic account for a fixed,
  public test vector, that it is deterministic, that the flag is off by default, and that Mera-session signatures
  (message and EIP-1559 transaction) recover to the account address. The smoke test checks the flag-off button and
  the flag-on panel, then creates a passkey with a Chrome virtual authenticator (PRF) to check the account connects
  and that rejecting the approval dialog sends nothing.

## Access and recovery

MonaDefi is non-custodial. The wallet is the account; aprMON and withdrawal requests live on Monad and appear on any
device where the same wallet connects. The wallet's recovery phrase recovers everything. Only rules and this device's
activity notes live in the browser. If the site is unavailable, the position can be managed directly on the aprMON
contract (`requestRedeem`, then `redeem`) or in aPriori's own app.

## Domain identity and the DNS change (documented, not applied)

Canonical and Open Graph URLs now point at `https://monadefi.com/`.

Current state (checked 18 Oct 2026): `monadefi.com` has `A 216.150.1.1` (name.com nameservers) and serves a separate
Grok Build app from Vercel; `mona.grok.me` is a Cloudflare-proxied Grok subdomain serving the same Grok Build app;
`www.monadefi.com` does not resolve. The Pages site is `https://blockchains.github.io/policypilot-monad/`.

To serve this repo at monadefi.com instead of Grok Build (do **not** do this without the owner):

1. At name.com, replace the apex `A 216.150.1.1` with GitHub Pages' records:
   `A 185.199.108.153`, `A 185.199.109.153`, `A 185.199.110.153`, `A 185.199.111.153`, and optionally
   `AAAA 2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153`.
   Add `CNAME www → blockchains.github.io`.
2. Verify the domain under the Blockchains account's GitHub Pages settings, then set the repo's Pages custom domain to
   `monadefi.com` and enable "Enforce HTTPS" once the certificate is issued.
3. The site would then live at the domain root, so build with `NEXT_BASE_PATH=""` in `.github/workflows/pages.yml`
   and change the `/policypilot-monad/` paths in `web/public/manifest.webmanifest`, `robots.txt`, `sitemap.xml` and
   `llms.txt`. The old Pages URL would redirect to monadefi.com.
4. `mona.grok.me` is controlled by Grok, not by this repo's DNS. It keeps serving the Grok Build app until it is
   repointed there.

## Tests

- `cd web && npm test` runs `src/lib/monadefi.test.ts` (23 tests: deploy presets, slippage, gates, 25/50/75/100%/amount/shares
  withdraw math, fees, rules sentences, proposals, no redeploy of withdrawals, duplicate prevention, no phantom position,
  partial completion, gain kept apart from deposits, return needs a day of data) and the existing `spend.test.ts`.
  Needs Node 22 (`--experimental-strip-types`); CI runs it.
- `cd web && npm run build && SMOKE_WATCH=0x… npm run smoke` is a headless Chrome smoke test against real Monad mainnet
  reads, with a mock wallet that rejects every signature (it never sends a transaction).
