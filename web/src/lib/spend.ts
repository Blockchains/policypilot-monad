import { getAddress, isAddress, parseEther, type Address } from 'viem';

/** Left on the signing wallet so the deposit and the action can still pay gas. */
export const SIGNER_RESERVE = 5n * 10n ** 16n;

export type FundSource = 'vault' | 'balancer' | 'deployer';

export type LimitRaise = { cap: bigint | null; budget: bigint | null };

const UNL = 2n ** 255n; // anything this large is a v4 'unlimited' value (type(uint256).max)
const unlimited = (o: { cap: bigint; vaultCap: bigint }) => o.cap >= UNL && o.vaultCap >= UNL;
const show = (v: bigint) => `${(Number(v) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 4 })} MON`;

/**
 * Owner-only raises. The new cap is the vault's immutable vault cap.
 * The new budget, when the remaining budget is short, is total spent plus one vault cap.
 * Pause, allowlists, and call rules are not touched.
 */
export function limitsFor(s: { cap: bigint; budget: bigint; spent: bigint; vaultCap: bigint }, wei: bigint): LimitRaise {
  const ceiling = s.vaultCap;
  if (ceiling === 0n || wei <= 0n || wei > ceiling) return { cap: null, budget: null };
  const rem = s.budget > s.spent ? s.budget - s.spent : 0n;
  const nextBudget = s.spent + ceiling;
  return {
    cap: wei > s.cap ? ceiling : null,
    budget: wei > rem && nextBudget > s.budget ? nextBudget : null,
  };
}

export function fundedMax(o: {
  cap: bigint; budget: bigint; spent: bigint; bal: bigint; vaultCap: bigint;
  isOwner: boolean; source: FundSource; funderBal: bigint; funderReady: boolean;
}): bigint {
  const ceiling = o.vaultCap > 0n ? o.vaultCap : o.cap;
  if (!o.isOwner) {
    const rem = o.budget > o.spent ? o.budget - o.spent : 0n;
    let n = o.cap < o.bal ? o.cap : o.bal;
    if (rem < n) n = rem;
    return n > 0n ? n : 0n;
  }
  const room = ceiling > o.bal ? ceiling - o.bal : 0n;
  const spare = o.funderBal > SIGNER_RESERVE ? o.funderBal - SIGNER_RESERVE : 0n;
  const pull = o.source !== 'vault' && o.funderReady ? (spare < room ? spare : room) : 0n;
  const total = o.bal + pull;
  return total < ceiling ? total : ceiling;
}

export type SpendPlan = {
  ok: boolean; code: string; label: string; detail: string;
  wei: bigint; maxWei: bigint; lift: boolean; pull: bigint;
};

const none = (code: string, label: string, detail: string, wei = 0n, maxWei = 0n): SpendPlan =>
  ({ ok: false, code, label, detail, wei, maxWei, lift: false, pull: 0n });

/** What Dispatch can send. The chain still enforces the vault cap, pause, allowlist, and call rules. */
export function planSpend(o: {
  mainnet: boolean; account: boolean; mode: 'create' | 'run'; amount: string;
  cap: bigint; budget: bigint; spent: bigint; bal: bigint; vaultCap: bigint;
  paused: boolean; canSign: boolean; isOwner: boolean;
  source: FundSource; funder: Address | null; funderConnected: boolean; funderBal: bigint;
}): SpendPlan {
  let wei: bigint;
  try { wei = parseEther(o.amount || '0'); }
  catch { return none('amount', 'ENTER AN AMOUNT', 'Use a MON amount such as 0.02.'); }
  const maxWei = o.mode === 'create' ? o.cap : fundedMax({
    ...o,
    funderReady: o.source !== 'vault' && !!o.funder && o.funderConnected && o.isOwner,
  });
  if (wei <= 0n) return none('amount', 'ENTER AN AMOUNT', 'The action needs more than 0 MON.', wei, maxWei);
  if (!o.mainnet) return none('net', 'MAINNET ONLY', 'These presets call live Monad protocols. Switch the network to mainnet.', wei, maxWei);
  if (!o.account) return none('connect', 'CONNECT WALLET', 'One wallet connection, then this button sends the transaction.', wei, maxWei);
  if (o.mode === 'create') {
    return { ok: true, code: 'create', label: 'READY TO CREATE', detail: 'One signature creates the vault, deposits the MON you chose (any amount), and makes your wallet the agent. The vault has no spending limits or allowlists.', wei, maxWei, lift: false, pull: 0n };
  }
  if (o.paused) return none('paused', 'VAULT PAUSED', 'Resume it from Agents, then come back. Nothing is sent while it is paused.', wei, maxWei);
  const ceiling = o.vaultCap;
  if (ceiling > 0n && wei > ceiling) return none('vaultcap', 'EXCEEDS VAULT CAP', `This vault cannot hold more than ${show(ceiling)}.`, wei, maxWei);
  const raise = o.isOwner ? limitsFor(o, wei) : { cap: null, budget: null };
  const rem = o.budget > o.spent ? o.budget - o.spent : 0n;
  const needsLift = wei > o.cap || wei > rem;
  if (needsLift && !o.isOwner) {
    if (wei > o.cap) return none('cap', 'EXCEEDS CAP', `The per-action cap is ${show(o.cap)}. Only the owner can raise it, up to the vault cap.`, wei, maxWei);
    return none('budget', 'EXCEEDS BUDGET', `${show(rem)} of the budget is left. Only the owner can raise it.`, wei, maxWei);
  }
  const shortfall = wei > o.bal ? wei - o.bal : 0n;
  let pull = 0n;
  if (shortfall > 0n) {
    const name = o.source === 'balancer' ? 'balancer' : 'deployer';
    if (o.source === 'vault') return none('bal', 'NOT ENOUGH MON', `This vault holds ${show(o.bal)}. Choose Balancer or Deployer, add MON to that wallet, and connect it.`, wei, maxWei);
    if (!o.funder) return none('funder', 'ADD A WALLET', `Save the ${name} wallet you will add MON to.`, wei, maxWei);
    if (!o.funderConnected) return none('connect-funder', 'CONNECT THAT WALLET', `Connect ${name} ${o.funder.slice(0, 6)}…${o.funder.slice(-4)} after you add MON to it.`, wei, maxWei);
    if (!o.isOwner) return none('owner', 'OWNER WALLET', 'Only the vault owner can deposit. Add MON to the owner wallet and connect it.', wei, maxWei);
    const spare = o.funderBal > SIGNER_RESERVE ? o.funderBal - SIGNER_RESERVE : 0n;
    if (spare < shortfall) return none('fund-bal', 'ADD MON', `That wallet can move ${show(spare)} after keeping ${show(SIGNER_RESERVE)} for gas. Add MON, then dispatch.`, wei, maxWei);
    pull = shortfall;
  }
  const lift = raise.cap != null || raise.budget != null;
  if (!o.canSign) {
    if (lift || pull > 0n) return none('signer', 'AGENT WALLET', 'This browser cannot sign the action. Make your wallet the agent, then dispatch. Nothing was sent.', wei, maxWei);
    return { ok: true, code: 'sim', label: 'POLICY PASS', detail: 'This browser cannot sign for the agent, so Dispatch runs a free on-chain check and sends nothing.', wei, maxWei, lift: false, pull: 0n };
  }
  const parts: string[] = [];
  if (pull > 0n) parts.push(`deposits ${show(pull)} from your ${o.source} wallet`);
  if (lift) parts.push('raises the cap and budget up to this vault’s on-chain cap');
  const detail = unlimited(o)
    ? (parts.length ? `Dispatch ${parts.join(' and ')}, then sends one transaction. This vault has no spending limits or allowlists.` : 'No spending limits on this vault, only its balance. Dispatch sends one real transaction.')
    : parts.length
      ? `Dispatch ${parts.join(' and ')}, then sends one transaction. This older vault keeps its payee allowlist and call rules; use Remove limits to lift what its contract allows.`
      : 'Inside this older vault’s cap, budget, and balance. Dispatch sends one real transaction.';
  return { ok: true, code: 'go', label: 'PASSED — READY', detail, wei, maxWei, lift, pull };
}

const FUNDER_KEY = 'pp.funders.v1';

export function loadFunders(): { balancer: string; deployer: string } {
  try {
    const raw = JSON.parse(localStorage.getItem(FUNDER_KEY) || '{}') as { balancer?: unknown; deployer?: unknown };
    return {
      balancer: typeof raw.balancer === 'string' ? raw.balancer : '',
      deployer: typeof raw.deployer === 'string' ? raw.deployer : '',
    };
  } catch { return { balancer: '', deployer: '' }; }
}

export function saveFunders(f: { balancer: string; deployer: string }) {
  localStorage.setItem(FUNDER_KEY, JSON.stringify({ balancer: f.balancer, deployer: f.deployer }));
}

export function parseFunder(raw: string): Address | null {
  const t = raw.trim();
  if (!isAddress(t)) return null;
  return getAddress(t);
}
