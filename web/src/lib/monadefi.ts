/**
 * MonaDefi: simple, rules-based vault investing on top of the existing PolicyPilot app.
 * Pure logic only (no React, no network): vault facts, deploy/withdraw math, the rules engine,
 * transaction states and guards. Tested by monadefi.test.ts (node --test).
 *
 * Release 1 supports ONE asset (MON) and ONE reviewed vault (aPriori aprMON, already a fork-tested
 * "live" service in services.ts). There is no reviewed USDC vault in this app yet.
 */
import { formatEther, parseAbi, parseEther, type Address } from 'viem';

export const MONADEFI_CANONICAL = 'https://monadefi.com';
export const ASSET = { symbol: 'MON', decimals: 18, note: 'The brief asks for USDC. There is no reviewed USDC vault in this app yet, so MonaDefi starts with MON, the asset the existing vaults already use.' } as const;

/** MON left in the wallet for gas whatever the rules say. Monad charges the gas limit, not the gas used. */
export const GAS_RESERVE = parseEther('0.05');
/** Default slippage guard on shares and proceeds: 0.5%. */
export const DEFAULT_SLIPPAGE_BPS = 50;
/** A preview older than this is stale and must be refreshed before anything is sent. */
export const STALE_MS = 30_000;
/** The same action (kind + vault + amount) cannot be sent twice inside this window. */
export const DUPLICATE_WINDOW_MS = 120_000;

/** aPriori aprMON: ABI subset from the official integration page (apriori-docs.gitbook.io, Smart Contract Integration). */
export const aprMonAbi = parseAbi([
  'function deposit(uint256 assets, address receiver) payable returns (uint256 shares)',
  'function requestRedeem(uint256 shares, address controller, address owner) returns (uint256 requestId)',
  'function redeem(uint256[] requestIDs, address receiver)',
  'function previewDeposit(uint256 assets) view returns (uint256)',
  'function previewRedeem(uint256 shares) view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function paused() view returns (bool)',
  'function withdrawalFee() view returns (uint256)',
  'function rewardFee() view returns (uint8)',
  'function minimumRedeem() view returns (uint256)',
  'function maxDeposit(address receiver) view returns (uint256)',
  'function getUserRequestDataCount(address user) view returns (uint256)',
  'function getUserRequestData(address user, uint256 startIndex, uint256 pageSize) view returns ((uint256 id, bool claimed, bool claimable, uint256 shares, uint256 assets, uint256 timestamp, uint64 unlockEpoch)[])',
  'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)',
  'event RedeemRequest(address indexed controller, address indexed owner, uint256 indexed requestId, address sender, uint256 shares, uint256 assets)',
  'event Redeem(address indexed controller, address indexed receiver, uint256 indexed requestId, uint256 shares, uint256 assets, uint256 fee)',
]);

export type VaultInfo = {
  id: string; name: string; provider: string; address: Address; asset: 'MON'; share: string;
  strategy: string; withdrawal: 'queued' | 'instant'; withdrawalText: string; expectedWait: string;
  risks: string[]; feeText: (o: { withdrawalFeeBps: number | null; rewardFee: number | null }) => string[];
  sources: { label: string; href: string }[]; reviewed: string;
};

/** The one reviewed vault. Facts below come from aPriori's docs and from mainnet reads (see docs/monadefi.md). */
export const VAULTS: VaultInfo[] = [{
  id: 'apriori-aprmon', name: 'MON liquid staking', provider: 'aPriori', address: '0x0c65A0BC65a5D819235B71F554D210D3F80E0852', asset: 'MON', share: 'aprMON',
  strategy: 'Your MON is staked with Monad validators through aPriori. You receive aprMON, a reward-bearing token: the number of tokens stays the same and each one is worth more MON as staking rewards arrive.',
  withdrawal: 'queued',
  withdrawalText: 'Withdrawals are queued. You request a withdrawal, aPriori unlocks it after a few staking epochs, then you claim the MON.',
  expectedWait: 'aPriori says requests usually unlock in about 12–18 hours (each staking epoch is roughly 5.5–6 hours).',
  risks: [
    'Investment returns are variable. Your position can lose value.',
    'Smart-contract risk: aprMON is an upgradeable proxy controlled by aPriori. MonaDefi has not audited it.',
    'Validator risk: staking rewards depend on validator performance and the exchange rate is updated by aPriori’s oracle operator.',
    'aPriori can pause the contract. Deposits and withdrawal requests would stop until it is unpaused.',
    'Withdrawals are not instant. Your MON is locked until the request unlocks.',
  ],
  feeText: ({ withdrawalFeeBps, rewardFee }) => [
    'No deposit fee.',
    withdrawalFeeBps == null ? 'Withdrawal fee: reading…' : `Withdrawal fee: ${(withdrawalFeeBps / 100).toFixed(2)}% of the MON you claim (on-chain withdrawalFee = ${withdrawalFeeBps}; mainnet Redeem events charge exactly this).`,
    rewardFee == null ? 'Reward fee: reading…' : `Reward fee: on-chain rewardFee = ${rewardFee}. aPriori does not document the unit. It is taken from staking rewards, so the return shown below is already after it.`,
    'Network gas on every transaction. Monad charges the gas limit.',
    'MonaDefi charges no fee.',
  ],
  sources: [
    { label: 'aPriori integration docs', href: 'https://apriori-docs.gitbook.io/apriori-docs/aprmon/smart-contract-integration' },
    { label: 'aprMON on MonadVision', href: 'https://monadvision.com/address/0x0c65A0BC65a5D819235B71F554D210D3F80E0852' },
  ],
  reviewed: 'Listed in services.ts as a verified official address with a mainnet fork test (test_fork_apriori_stake). The withdrawal path is checked against the official ABI and live mainnet reads.',
}];
export const PRIMARY_VAULT = VAULTS[0];

// ---------- formatting ----------
export const fmt = (v: bigint | null | undefined, d = 4) => (v == null ? '—' : `${Number(formatEther(v)).toLocaleString('en-GB', { maximumFractionDigits: d })} MON`);
export const signedFmt = (v: bigint, d = 4) => `${v > 0n ? '+' : v < 0n ? '−' : ''}${fmt(v < 0n ? -v : v, d)}`;

export function parseMon(s: string): bigint | null {
  const t = (s ?? '').trim();
  if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') return null;
  try { return parseEther(t as `${number}`); } catch { return null; }
}

// ---------- deploy ----------
/** What can be deployed now: wallet MON minus the larger of the gas reserve and the rule-A reserve. */
export function availableToDeploy(wallet: bigint, reserve: bigint = 0n): bigint {
  const keep = reserve > GAS_RESERVE ? reserve : GAS_RESERVE;
  return wallet > keep ? wallet - keep : 0n;
}
/** 25/50/75/Max of what is available. Max is exactly the available amount. */
export function presetAmount(available: bigint, pct: 25 | 50 | 75 | 100): bigint {
  if (available <= 0n) return 0n;
  return pct === 100 ? available : (available * BigInt(pct)) / 100n;
}
/** Minimum accepted after slippage, rounded down. */
export function minAfterSlippage(expected: bigint, bps: number = DEFAULT_SLIPPAGE_BPS): bigint {
  if (expected <= 0n) return 0n;
  const b = BigInt(Math.max(0, Math.min(10_000, Math.round(bps))));
  return (expected * (10_000n - b)) / 10_000n;
}

export type Preview = { at: number; block: bigint; amount: bigint; shares: bigint };
export const isStale = (p: { at: number } | null | undefined, now = Date.now()) => !p || now - p.at > STALE_MS;

export type Gate = { ok: boolean; code: string; text: string };
export function deployGate(o: {
  mainnet: boolean; account: boolean; amount: bigint | null; available: bigint; paused: boolean | null;
  preview: Preview | null; now?: number; capRoom: bigint | null; busy: boolean;
}): Gate {
  if (!o.mainnet) return { ok: false, code: 'net', text: 'MonaDefi runs on Monad mainnet. Switch network to continue.' };
  if (!o.account) return { ok: false, code: 'connect', text: 'Connect a wallet first.' };
  if (o.busy) return { ok: false, code: 'busy', text: 'A transaction is already in progress.' };
  if (o.amount == null || o.amount <= 0n) return { ok: false, code: 'amount', text: 'Enter an amount above 0 MON.' };
  if (o.amount > o.available) return { ok: false, code: 'available', text: `That is more than you can deploy now (${fmt(o.available)} after the reserve you keep for gas and your rules).` };
  if (o.capRoom != null && o.amount > o.capRoom) return { ok: false, code: 'cap', text: `Your rule caps this vault. You can add at most ${fmt(o.capRoom)} more.` };
  if (o.paused == null) return { ok: false, code: 'loading', text: 'Reading the vault…' };
  if (o.paused) return { ok: false, code: 'paused', text: 'The vault is paused by aPriori. Deposits are closed for now.' };
  if (!o.preview || o.preview.amount !== o.amount) return { ok: false, code: 'preview', text: 'Getting a fresh preview…' };
  if (isStale(o.preview, o.now)) return { ok: false, code: 'stale', text: 'The preview is out of date. Refresh it before you deploy.' };
  if (o.preview.shares <= 0n) return { ok: false, code: 'zero', text: 'This amount would mint no shares.' };
  return { ok: true, code: 'ok', text: 'Ready to review.' };
}

// ---------- withdraw ----------
export type WithdrawPick = { kind: 'pct'; pct: number } | { kind: 'amount'; mon: bigint } | { kind: 'shares'; shares: bigint };

/** Shares for a pick. 50% means 50% of the current position; 100% is every share (no dust left behind). */
export function sharesFor(pick: WithdrawPick, position: { shares: bigint; value: bigint }): bigint {
  const { shares, value } = position;
  if (shares <= 0n) return 0n;
  if (pick.kind === 'pct') {
    const p = Math.max(0, Math.min(100, pick.pct));
    if (p >= 100) return shares;
    return (shares * BigInt(Math.round(p * 100))) / 10_000n;
  }
  if (pick.kind === 'shares') return pick.shares > shares ? shares : pick.shares < 0n ? 0n : pick.shares;
  if (value <= 0n || pick.mon <= 0n) return 0n;
  if (pick.mon >= value) return shares;
  const s = (pick.mon * shares + value - 1n) / value; // round up so the amount is covered
  return s > shares ? shares : s;
}
export function feeOn(gross: bigint, feeBps: number | null): bigint {
  if (!feeBps || gross <= 0n) return 0n;
  return (gross * BigInt(feeBps)) / 10_000n;
}
export function withdrawPreview(shares: bigint, grossPerShares: (s: bigint) => bigint, feeBps: number | null, slippageBps = DEFAULT_SLIPPAGE_BPS) {
  const gross = shares > 0n ? grossPerShares(shares) : 0n;
  const fee = feeOn(gross, feeBps);
  const net = gross - fee;
  return { shares, gross, fee, net, minNet: minAfterSlippage(net, slippageBps) };
}
export function withdrawGate(o: { account: boolean; mainnet: boolean; shares: bigint; position: bigint; minimum: bigint | null; paused: boolean | null; busy: boolean; receiverOk: boolean; previewAt: number | null; now?: number }): Gate {
  if (!o.mainnet) return { ok: false, code: 'net', text: 'MonaDefi runs on Monad mainnet.' };
  if (!o.account) return { ok: false, code: 'connect', text: 'Connect a wallet first.' };
  if (o.busy) return { ok: false, code: 'busy', text: 'A transaction is already in progress.' };
  if (o.position <= 0n) return { ok: false, code: 'empty', text: 'You have no position in this vault.' };
  if (o.shares <= 0n) return { ok: false, code: 'amount', text: 'Choose how much to withdraw.' };
  if (o.shares > o.position) return { ok: false, code: 'over', text: 'That is more than your position.' };
  if (o.minimum != null && o.shares < o.minimum) return { ok: false, code: 'min', text: 'That is below the vault’s minimum withdrawal.' };
  if (!o.receiverOk) return { ok: false, code: 'receiver', text: 'Enter a valid address to receive the MON.' };
  if (o.paused) return { ok: false, code: 'paused', text: 'The vault is paused by aPriori, so a withdrawal cannot be requested right now.' };
  if (o.previewAt == null || isStale({ at: o.previewAt }, o.now)) return { ok: false, code: 'stale', text: 'Refreshing the preview…' };
  return { ok: true, code: 'ok', text: 'Ready to review.' };
}

// ---------- rules (release 2 "suggest and approve") ----------
export type Rules = {
  reserveOn: boolean; reserve: string;            // A keep a reserve (MON) in the wallet
  autoDeployOn: boolean; autoDeployPct: number;   // B deploy a % of eligible NEW deposits (never the existing balance)
  targetOn: boolean; targetPct: number;           // C target allocation (% of total value in the vault). Proposes only.
  capOn: boolean; cap: string;                    // D per-vault exposure cap (MON)
  mode: 'suggest' | 'auto';                       // E execution mode
  baseline: string | null;                        // wallet MON when B was saved; growth above it counts as new deposits
  savedAt: number | null;
};
export const DEFAULT_RULES: Rules = { reserveOn: true, reserve: '1', autoDeployOn: false, autoDeployPct: 50, targetOn: false, targetPct: 50, capOn: false, cap: '100', mode: 'suggest', baseline: null, savedAt: null };

/** Automatic execution needs an on-chain permission that limits assets, destinations, amounts, expiry and revocation. None exists for this vault yet. */
export const AUTO_MODE_AVAILABLE = false;
export const AUTO_MODE_WHY = 'Automatic mode stays off. It needs an on-chain permission that limits the asset, the destination, the amount, an expiry date and lets you revoke it. PolicyPilot vaults no longer have spending limits or allowlists (an agent can move all of a vault’s funds), so they cannot provide that permission, and their aPriori call sends aprMON to the vault instead of to your MonaDefi position. Until a contract enforces all five, MonaDefi only suggests actions for you to approve.';

export function validateRules(r: Rules): string[] {
  const errs: string[] = [];
  if (r.reserveOn && parseMon(r.reserve) == null) errs.push('Reserve must be a MON amount.');
  if (r.autoDeployOn && !(r.autoDeployPct > 0 && r.autoDeployPct <= 100)) errs.push('Deploy percentage must be between 1 and 100.');
  if (r.targetOn && !(r.targetPct >= 0 && r.targetPct <= 100)) errs.push('Target allocation must be between 0 and 100%.');
  if (r.capOn && (parseMon(r.cap) == null || parseMon(r.cap)! <= 0n)) errs.push('Vault cap must be a MON amount above 0.');
  if (r.mode === 'auto' && !AUTO_MODE_AVAILABLE) errs.push('Automatic mode is not available yet.');
  return errs;
}
export const reserveOf = (r: Rules) => (r.reserveOn ? parseMon(r.reserve) ?? 0n : 0n);
export const capOf = (r: Rules) => (r.capOn ? parseMon(r.cap) : null);

/** Plain sentences, one per rule, in the order the brief lists them. */
export function describeRules(r: Rules, vault = PRIMARY_VAULT): string[] {
  const out: string[] = [];
  out.push(r.reserveOn ? `Always keep at least ${r.reserve || '0'} MON in my wallet, plus a small amount for gas.` : 'Keep only a small amount of MON in my wallet for gas.');
  out.push(r.autoDeployOn ? `When new MON arrives in my wallet, suggest deploying ${r.autoDeployPct}% of it into ${vault.provider} ${vault.share}. This applies to new deposits only, never to the balance I already have or to money I withdraw.` : 'Do not suggest deploying new deposits.');
  out.push(r.targetOn ? `Suggest a deploy or a withdrawal when ${vault.provider} ${vault.share} drifts away from ${r.targetPct}% of my total value. Nothing moves until I approve it.` : 'No target allocation.');
  out.push(r.capOn ? `Never hold more than ${r.cap || '0'} MON in ${vault.provider} ${vault.share}.` : `No cap on ${vault.provider} ${vault.share}.`);
  out.push(r.mode === 'auto' ? 'Execute automatically within my approved limits.' : 'Suggest actions for me to approve. Nothing is sent without my signature.');
  return out;
}

export type Proposal = { id: string; kind: 'deploy' | 'withdraw'; amount: bigint; reason: string };

/**
 * Suggestions only. Withdrawn MON is never redeployed: claimed proceeds raise the baseline, so they are
 * not "new deposits". Rule D always clamps; rule A always leaves the reserve.
 */
export function proposeActions(o: { rules: Rules; wallet: bigint; invested: bigint; pending: boolean }): Proposal[] {
  const { rules: r, wallet, invested } = o;
  if (o.pending) return [];
  const out: Proposal[] = [];
  const avail = availableToDeploy(wallet, reserveOf(r));
  const cap = capOf(r);
  const capRoom = cap == null ? null : cap > invested ? cap - invested : 0n;
  const clamp = (x: bigint) => { let v = x > avail ? avail : x; if (capRoom != null && v > capRoom) v = capRoom; return v > 0n ? v : 0n; };
  const dust = parseEther('0.001');
  if (r.autoDeployOn && r.baseline != null) {
    const base = BigInt(r.baseline);
    const fresh = wallet > base ? wallet - base : 0n;
    const amt = clamp((fresh * BigInt(Math.round(r.autoDeployPct))) / 100n);
    if (amt > dust) out.push({ id: `b:${amt}`, kind: 'deploy', amount: amt, reason: `${r.autoDeployPct}% of ${fmt(fresh)} that arrived since you saved your rules.` });
  }
  if (r.targetOn) {
    const total = wallet + invested;
    const want = (total * BigInt(Math.round(r.targetPct * 100))) / 10_000n;
    const already = out.reduce((s, p) => s + p.amount, 0n);
    if (want > invested + already) {
      const amt = clamp(want - invested - already);
      if (amt > dust) out.push({ id: `c+:${amt}`, kind: 'deploy', amount: amt, reason: `Brings the vault towards your ${r.targetPct}% target.` });
    } else if (invested > want && invested - want > dust) {
      out.push({ id: `c-:${invested - want}`, kind: 'withdraw', amount: invested - want, reason: `The vault is above your ${r.targetPct}% target. A withdrawal request would bring it back.` });
    }
  }
  if (cap != null && invested > cap && invested - cap > dust && !out.some(p => p.kind === 'withdraw')) {
    out.push({ id: `d:${invested - cap}`, kind: 'withdraw', amount: invested - cap, reason: `Your position is above your ${fmt(cap)} cap.` });
  }
  return out;
}
/** After a claim, raise the baseline so withdrawn MON is never treated as a new deposit. */
export const afterClaimBaseline = (r: Rules, claimed: bigint): Rules => (r.baseline == null ? r : { ...r, baseline: (BigInt(r.baseline) + claimed).toString() });

// ---------- transactions ----------
export const TX_STATES = ['Awaiting approval', 'Submitted', 'Confirming', 'Completed', 'Partially completed', 'Failed', 'Withdrawal requested', 'Waiting for liquidity', 'Action required'] as const;
export type TxState = typeof TX_STATES[number];
export type TxKind = 'deploy' | 'request' | 'claim' | 'withdraw-all';
export type TxRecord = {
  id: string; kind: TxKind; state: TxState; vault: string; amount: string; shares?: string; minShares?: string;
  hash?: string; hashes?: string[]; note?: string; at: number; updated: number; receiver?: string; requestIds?: string[];
};
export const isOpen = (s: TxState) => s === 'Awaiting approval' || s === 'Submitted' || s === 'Confirming';
/** Duplicate-action prevention: same kind, vault and amount still open or sent in the last two minutes. */
export function isDuplicate(list: TxRecord[], next: { kind: TxKind; vault: string; amount: string }, now = Date.now()): boolean {
  return list.some(t => t.kind === next.kind && t.vault === next.vault && t.amount === next.amount && (isOpen(t.state) || (t.state !== 'Failed' && now - t.at < DUPLICATE_WINDOW_MS)));
}
/** A deposit is only Completed when its receipt carries the Deposit event. Anything else never becomes a position. */
export function settleDeposit(rec: TxRecord, receipt: { status: 'success' | 'reverted' } | null, mintedShares: bigint | null): TxRecord {
  const now = Date.now();
  if (!receipt) return { ...rec, state: 'Confirming', updated: now };
  if (receipt.status !== 'success') return { ...rec, state: 'Failed', note: 'The transaction reverted. No position was created.', updated: now };
  if (mintedShares == null || mintedShares <= 0n) return { ...rec, state: 'Action required', note: 'The transaction succeeded but no Deposit event for your address was found. Check it on the explorer.', updated: now };
  const min = rec.minShares ? BigInt(rec.minShares) : 0n;
  if (mintedShares < min) return { ...rec, state: 'Action required', shares: mintedShares.toString(), note: 'Fewer shares were minted than your minimum. The position is real; review it before deploying again.', updated: now };
  return { ...rec, state: 'Completed', shares: mintedShares.toString(), updated: now };
}
/** Withdraw-all is several steps. Some may finish and some may not. */
export function combineSteps(states: TxState[]): TxState {
  if (!states.length) return 'Failed';
  const done = (s: TxState) => s === 'Completed' || s === 'Withdrawal requested';
  if (states.every(done)) return states.some(s => s === 'Withdrawal requested') ? 'Withdrawal requested' : 'Completed';
  if (states.some(done)) return 'Partially completed';
  if (states.some(isOpen)) return 'Confirming';
  return 'Failed';
}

// ---------- performance ----------
export type RequestRow = { id: bigint; claimed: boolean; claimable: boolean; shares: bigint; assets: bigint; timestamp: bigint; unlockEpoch: bigint };
export function requestState(r: RequestRow): TxState { return r.claimed ? 'Completed' : r.claimable ? 'Action required' : 'Waiting for liquidity'; }

/**
 * Net deposits and investment gain, kept apart. Deposits and withdrawals come from on-chain events this
 * device saw (receipts and recent logs). `untracked` is aprMON in the wallet that MonaDefi did not see
 * arrive, so its cost is unknown and it is excluded from the gain.
 */
export function performance(o: { depositedMon: bigint; depositedShares: bigint; requestedShares: bigint; requestedMon: bigint; heldShares: bigint; value: (s: bigint) => bigint }) {
  const trackedLeft = o.depositedShares > o.requestedShares ? o.depositedShares - o.requestedShares : 0n;
  const tracked = trackedLeft < o.heldShares ? trackedLeft : o.heldShares;
  const untracked = o.heldShares > tracked ? o.heldShares - tracked : 0n;
  const netDeposits = o.depositedMon > o.requestedMon ? o.depositedMon - o.requestedMon : 0n;
  const costLeft = o.depositedShares > 0n ? (o.depositedMon * tracked) / o.depositedShares : 0n;
  const trackedValue = tracked > 0n ? o.value(tracked) : 0n;
  const gain = o.depositedShares > 0n ? trackedValue - costLeft : null;
  return { netDeposits, tracked, untracked, trackedValue, costLeft, gain };
}
/** Trailing return from two exchange-rate reads, annualised. Null when the window is too short to say anything. */
export function annualised(rateNow: bigint, rateThen: bigint, seconds: number): number | null {
  if (rateThen <= 0n || seconds < 86_400) return null;
  const growth = Number((rateNow * 1_000_000_000n) / rateThen) / 1e9;
  const years = seconds / (365 * 86_400);
  return (growth - 1) / years; // simple, not compounded, so the figure is not inflated

}
