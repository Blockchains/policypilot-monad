/**
 * Start wizard: goals, risk levels and the real on-chain strategy behind each one. Pure (viem only) so it is unit-tested
 * and the copy shown in the wizard is exactly what this file says.
 *
 * Honesty rules: no promised returns; every risk names what can go wrong; a goal × risk pair with no safe, real strategy
 * is not offered (NOT_OFFERED says why). Every vault and pool here has no spending limits.
 */
import { formatEther, parseEther } from 'viem';

export type Goal = 'earn' | 'fast' | 'arb' | 'pay';
export type Risk = 'low' | 'balanced' | 'high';
export type Kind = 'aprmon' | 'stake3' | 'clip' | 'spread' | 'pay';
export type StrategyId = 'earn-low' | 'earn-balanced' | 'fast-balanced' | 'fast-high' | 'arb-low' | 'arb-balanced' | 'pay';

/** Gas units, measured on Monad mainnet / a mainnet fork (see docs/journey.md). Monad charges the gas limit. */
export const UNITS = {
  aprDeposit: 100_000n,
  vaultCreate: 2_300_000n,
  deskOpen: 2_900_000n,
  deskDeposit: 140_000n,
  transfer: 21_000n,
  stake: 260_000n,
  // eth_estimateGas from a v4 vault's agent key on mainnet, 19 Oct: Kintsu 220,256, aPriori 210,880, Magma 839,737.
  stakeKintsu: 240_000n,
  stakeApriori: 230_000n,
  stakeMagma: 920_000n,
  pay: 120_000n,
  clip: 420_000n,
  capture: 520_000n,
  poolWithdraw: 100_000n,
} as const;
/** Price used for estimates when the chain read is not in yet: Monad's 100 gwei minimum base fee plus a 2 gwei tip. */
export const DEFAULT_GAS_PRICE = 102_000_000_000n;
/** Head-room on every wallet gas estimate (base fee can move between review and send). */
const MARGIN = 125n; // %

export type Strategy = {
  id: StrategyId; goal: Goal; risk: Risk | null; kind: Kind;
  name: string; oneLine: string;
  does: string[]; fees: string[]; wrong: string[]; withdraw: string[]; permissions: string[];
  /** How often anything happens, said plainly. */
  frequency: string;
  /** Wallet signatures to set it up. */
  signatures: number;
  /** Gas units the wallet signs for at setup (the deposit is not included). */
  walletUnits: bigint;
  /** Gas units the browser agent key needs; funded from the deposit as a line item. 0 = no agent key. */
  agentUnits: bigint;
  min: bigint; cap: bigint | null;
  /** Spread pool on-chain profit floor in basis points (0 = the pool accepts up to a 0.50% shortfall). */
  floorBps?: number;
  /** Agent loop: send only when the quoted pool gain beats the gas of the trade (true), or on any quoted gain (false). */
  needsGasCover?: boolean;
  /** The agent accepts getting back this much less MON than it sold (basis points; the contract allows at most 50). */
  acceptShortBps?: number;
  /** Seconds between price checks while a page of the site is open. */
  everySec?: number;
};

const NO_LIMITS = 'No spending limits: this was your choice. The agent key can move everything in the vault, and you stay the owner.';
const POOL_OPEN = 'Your pool is a contract only you deposit into. Its round-trip function is public: anyone may call it, and they pay the gas.';
const KEY = 'A new agent key is created in this browser and stored only here. It is funded with the gas line item below and signs its own transactions, so you are not asked again.';
const TAB = 'The agent runs while a page of this site is open in this browser. Close it and trading stops; your money stays where it is.';

export const STRATEGIES: Strategy[] = [
  {
    id: 'earn-low', goal: 'earn', risk: 'low', kind: 'aprmon',
    name: 'Liquid staking with aPriori', oneLine: 'Stake MON with Monad validators through aPriori. You get aprMON, which is worth more MON as rewards arrive.',
    does: ['Your wallet deposits MON straight into aPriori’s aprMON contract. There is no PolicyPilot vault and no agent.', 'Rewards come from Monad staking and change over time. Nothing is promised.'],
    fees: ['No deposit fee. aPriori charges a withdrawal fee on what you claim (read on-chain at review).', 'Network gas for the deposit, about 0.01 MON.'],
    wrong: ['aprMON can lose value, for example if a validator is penalised.', 'aprMON is an upgradeable contract run by aPriori, not audited by us. aPriori can pause it.'],
    withdraw: ['Withdrawals are queued: you request, aPriori unlocks it in about 12–18 hours, then you claim the MON (2 signatures over that time).'],
    permissions: ['Only your wallet. Nobody else can move this position.'],
    frequency: 'Nothing trades. Rewards build up in the aprMON price.',
    signatures: 1, walletUnits: UNITS.aprDeposit, agentUnits: 0n, min: parseEther('0.1'), cap: null,
  },
  {
    id: 'earn-balanced', goal: 'earn', risk: 'balanced', kind: 'stake3',
    name: 'Staking spread over three providers', oneLine: 'Your vault stakes one third each with Kintsu (sMON), aPriori (aprMON) and Magma (gMON).',
    does: ['One signature creates your vault with your deposit. A second sends the agent key its gas.', 'The agent key then stakes ⅓ with each provider straight away. It does nothing else unless you ask.'],
    fees: ['No PolicyPilot fee. Each provider takes its own staking and withdrawal fees.', 'Network gas: creating the vault (about 0.25 MON) and the three stakes (paid from the agent gas line).'],
    wrong: ['Three contracts instead of one: any of them can lose value or pause.', 'sMON has no on-chain price, so it is counted 1:1 with MON.', NO_LIMITS],
    withdraw: ['Any time, from My money. Your staked tokens (sMON, aprMON, gMON) come back to your wallet as tokens, not MON.', 'Turning them into MON is a queued unstake at each provider.'],
    permissions: [NO_LIMITS, KEY],
    frequency: 'Three stakes once, right after setup. Nothing trades.',
    signatures: 2, walletUnits: UNITS.vaultCreate + UNITS.transfer, agentUnits: UNITS.stakeKintsu + UNITS.stakeApriori + UNITS.stakeMagma + UNITS.transfer, min: parseEther('0.3'), cap: null,
  },
  {
    id: 'fast-balanced', goal: 'fast', risk: 'balanced', kind: 'clip', needsGasCover: true, everySec: 4,
    name: 'Fast round trips, only when they beat gas', oneLine: 'Your pool sells MON for USDC on one pool and buys it back on another when prices differ enough to pay for the gas.',
    does: ['Opens your clip pool (one signature), deposits your MON (one signature) and funds an agent key (one signature).', 'The agent checks Uniswap v3 (0.30% and 0.05%) and PancakeSwap v3 prices every 4 seconds and on new blocks.', 'It only sends a round trip when the quote shows the pool gaining more MON than that trade’s gas. Each send is simulated first.'],
    fees: ['Each trade costs about 0.043 MON of gas (420,000 gas), paid by the agent key. The pools take their swap fees inside the quote.', 'Of any gain, 10% goes to the agent key and 10% to your wallet; 80% stays in the pool. All three are yours.'],
    wrong: ['Most of the time prices are too close and nothing is sent. It can stay idle for hours or days.', 'Your agent only accepts getting back at least the MON it sold. If the price moves before the block, the trade reverts and its gas (about 0.043 MON) is lost.', POOL_OPEN + ' The contract lets anyone run a round trip that settles up to 0.50% below what it sold, so someone else could shrink your pool.', 'Alpha contract, not audited.'],
    withdraw: ['Any time, in MON, one signature, from My money. The pool cap is 10 MON.'],
    permissions: [KEY, TAB, 'The agent key can only send round trips and its own leftover gas back to you. It cannot withdraw your pool.'],
    frequency: 'Checks every 4 seconds while a page is open. Trades only when a gain beats the gas, which is rare.',
    signatures: 3, walletUnits: UNITS.deskOpen + UNITS.deskDeposit + UNITS.transfer, agentUnits: UNITS.clip * 4n, min: parseEther('0.3'), cap: parseEther('10'),
  },
  {
    id: 'fast-high', goal: 'fast', risk: 'high', kind: 'clip', needsGasCover: true, acceptShortBps: 50, everySec: 4,
    name: 'Fast round trips that accept small slippage', oneLine: 'The same pool and checks, but the agent lets a trade settle up to 0.50% below what it sold instead of reverting, so more trades go through.',
    does: ['The same setup as Balanced: open the pool, deposit, fund the agent key (three signatures).', 'The agent sends when the quoted gain beats the gas, and accepts getting back up to 0.50% less MON than it sold if the price moves before the block.'],
    fees: ['About 0.043 MON of gas per trade (420,000 gas), paid by the agent key.', 'Of any gain, 10% goes to the agent key and 10% to your wallet; 80% stays in the pool.'],
    wrong: ['Each trade can lose up to 0.50% of the MON it trades if the price moves first.', 'Most of the time nothing is worth sending; it can stay idle for long periods.', POOL_OPEN + ' The contract lets anyone run a round trip up to 0.50% below what it sold.', 'Alpha contract, not audited.'],
    withdraw: ['Any time, in MON, one signature, from My money. The pool cap is 10 MON.'],
    permissions: [KEY, TAB, 'The agent key can only send round trips and its own leftover gas back to you.'],
    frequency: 'Checks every 4 seconds while a page is open. Trades only when a gain beats the gas.',
    signatures: 3, walletUnits: UNITS.deskOpen + UNITS.deskDeposit + UNITS.transfer, agentUnits: UNITS.clip * 4n, min: parseEther('0.3'), cap: parseEther('10'),
  },
  {
    id: 'arb-low', goal: 'arb', risk: 'low', kind: 'spread', floorBps: 10, needsGasCover: true, everySec: 4,
    name: 'Arbitrage with a profit floor', oneLine: 'Buys and sells MON across Uniswap and PancakeSwap only when the round trip makes at least 0.10%, enforced by the contract.',
    does: ['Opens a spread pool with an on-chain floor of 0.10%: any round trip that gains less reverts, so a trade can’t shrink your pool.', 'The agent checks prices every 4 seconds and sends only when the quoted gain clears the floor and beats the gas. Each send is simulated first.'],
    fees: ['About 0.05 MON of gas per trade (about 500,000 gas), paid by the agent key. A trade that reverts still costs its gas.', 'Of any gain, 10% goes to the agent key and 10% to your wallet; 80% stays in the pool.'],
    wrong: ['A 0.10% gap between these pools is rare. It may never trade.', 'A trade that passes the simulation can still revert in the block: you lose that gas (about 0.05 MON), not pool MON.', 'Alpha contract, not audited.'],
    withdraw: ['Any time, in MON, one signature, from My money. The pool cap is 10 MON.'],
    permissions: [KEY, TAB, POOL_OPEN + ' The 0.10% floor applies to everyone.'],
    frequency: 'Checks every 4 seconds while a page is open. Trades only on a 0.10%+ gap that also beats gas.',
    signatures: 3, walletUnits: UNITS.deskOpen + UNITS.deskDeposit + UNITS.transfer, agentUnits: UNITS.capture * 3n, min: parseEther('0.3'), cap: parseEther('10'),
  },
  {
    id: 'arb-balanced', goal: 'arb', risk: 'balanced', kind: 'spread', floorBps: 0, needsGasCover: true, everySec: 4,
    name: 'Arbitrage that tolerates small drift', oneLine: 'The same round trips without the contract floor, so more quotes qualify. Your agent still only sends when the gain beats gas.',
    does: ['Opens a spread pool with no profit floor. The contract still rejects a round trip more than 0.50% under what it sold.', 'The agent checks every 4 seconds and sends when the quoted gain beats the gas. Each send is simulated first.'],
    fees: ['About 0.05 MON of gas per trade, paid by the agent key.', 'Of any gain, 10% goes to the agent key and 10% to your wallet; 80% stays in the pool.'],
    wrong: ['Your agent only accepts getting back at least the MON it sold; if the price moves first, the trade reverts and its gas is lost.', POOL_OPEN + ' Without the floor, anyone may run a round trip that settles up to 0.50% below what it sold.', 'It may trade rarely or never.', 'Alpha contract, not audited.'],
    withdraw: ['Any time, in MON, one signature, from My money. The pool cap is 10 MON.'],
    permissions: [KEY, TAB],
    frequency: 'Checks every 4 seconds while a page is open. Trades only when a gain beats gas.',
    signatures: 3, walletUnits: UNITS.deskOpen + UNITS.deskDeposit + UNITS.transfer, agentUnits: UNITS.capture * 4n, min: parseEther('0.3'), cap: parseEther('10'),
  },
  {
    id: 'pay', goal: 'pay', risk: null, kind: 'pay',
    name: 'Pay people from a vault', oneLine: 'Your vault pays each address you list once, straight away. What is left stays in the vault for later.',
    does: ['One signature creates your vault with your deposit, one sends the agent key its gas.', 'The agent key then pays each address the amount you set. Each payment is simulated first.'],
    fees: ['No PolicyPilot fee. About 0.012 MON of gas per payment, from the agent gas line.'],
    wrong: ['A payment to a wrong address can’t be undone. Check every address.', NO_LIMITS],
    withdraw: ['Whatever is left: any time, in MON, from My money.'],
    permissions: [NO_LIMITS, KEY],
    frequency: 'Pays once, right after setup.',
    signatures: 2, walletUnits: UNITS.vaultCreate + UNITS.transfer, agentUnits: UNITS.pay * 3n + UNITS.transfer, min: parseEther('0.05'), cap: null,
  },
];

export const GOALS: { id: Goal; title: string; sub: string; emoji: string }[] = [
  { id: 'earn', title: 'Earn', sub: 'Staking rewards on your MON', emoji: '🌱' },
  { id: 'fast', title: 'Trade fast', sub: 'Frequent round trips between pools', emoji: '⚡' },
  { id: 'arb', title: 'Arbitrage', sub: 'Buy low on one exchange, sell high on another', emoji: '🔁' },
  { id: 'pay', title: 'Pay people', sub: 'Send MON to a list of addresses', emoji: '💸' },
];
export const RISKS: { id: Risk; title: string }[] = [{ id: 'low', title: 'Low' }, { id: 'balanced', title: 'Balanced' }, { id: 'high', title: 'High' }];

/** Combinations with no safe, real strategy behind them. Shown greyed with the reason. */
export const NOT_OFFERED: { goal: Goal; risk: Risk; why: string }[] = [
  { goal: 'earn', risk: 'high', why: 'There is no higher-yield strategy here that we can run honestly (no leverage, no lending). Balanced is the most this app offers.' },
  { goal: 'fast', risk: 'low', why: 'Frequent trading always pays gas and can settle below the price it saw. There is no low-risk version.' },
  { goal: 'arb', risk: 'high', why: 'The only riskier setting would be accepting slippage on each trade. Trade fast · High does exactly that, with cheaper gas, so it is offered there instead.' },
];

export const strategyFor = (goal: Goal, risk: Risk | null): Strategy | undefined =>
  goal === 'pay' ? STRATEGIES.find(s => s.id === 'pay') : STRATEGIES.find(s => s.goal === goal && s.risk === risk);
export const byId = (id: string): Strategy | undefined => STRATEGIES.find(s => s.id === id);
export const risksFor = (goal: Goal) => RISKS.map(r => ({ ...r, strategy: strategyFor(goal, r.id), notOffered: NOT_OFFERED.find(n => n.goal === goal && n.risk === r.id) }));

export const gasWei = (units: bigint, price: bigint = DEFAULT_GAS_PRICE) => (units * price * MARGIN) / 100n;
/** Rounded up to 0.001 MON so the line item is a clean number. */
const roundUp = (wei: bigint) => { const step = 10n ** 15n; return ((wei + step - 1n) / step) * step; };

/**
 * walletGas / agentGas: what is spent. headroom: what must also sit in the wallet while it is not spent, because a wallet
 * only accepts a transaction when the balance covers value + gas limit × fee cap (Monad's cap is 2 × base fee + tip).
 */
export type Costs = { walletGas: bigint; agentGas: bigint; payGas: bigint; headroom: bigint };
type WStep = { units: bigint; value: 'amount' | 'agent' | 'none' };
export const walletSteps = (s: Strategy): WStep[] =>
  s.kind === 'aprmon' ? [{ units: UNITS.aprDeposit, value: 'amount' }]
    : s.kind === 'clip' || s.kind === 'spread' ? [{ units: UNITS.deskOpen, value: 'none' }, { units: UNITS.deskDeposit, value: 'amount' }, { units: UNITS.transfer, value: 'agent' }]
      : [{ units: UNITS.vaultCreate, value: 'amount' }, { units: UNITS.transfer, value: 'agent' }];
/** The fee cap a wallet reserves per gas unit for a given price (base + 2 gwei tip): 2 × base + tip. */
export const capOf = (price: bigint) => { const tip = 2_000_000_000n; const base = price > tip ? price - tip : price; return base * 2n + tip; };

/** Agent key gas: enough that its last transaction still passes the wallet-side check (balance ≥ limit × fee cap). */
export function agentGasFor(s: Strategy, price: bigint = DEFAULT_GAS_PRICE, payees = 0): bigint {
  const each: bigint[] = s.kind === 'pay' ? [...Array(Math.max(payees, 1)).fill(UNITS.pay), UNITS.transfer]
    : s.kind === 'stake3' ? [UNITS.stakeKintsu, UNITS.stakeApriori, UNITS.stakeMagma, UNITS.transfer]
      : s.kind === 'clip' ? [UNITS.clip, UNITS.clip, UNITS.clip, UNITS.clip, UNITS.transfer]
        : s.kind === 'spread' ? [UNITS.capture, UNITS.capture, UNITS.capture, UNITS.capture, UNITS.transfer] : [];
  if (!each.length) return 0n;
  const cap = capOf(price); let spent = 0n; let peak = 0n;
  for (const u of each) { const need = spent + (u * cap * 110n) / 100n; if (need > peak) peak = need; spent += (u * price * 110n) / 100n; }
  return roundUp(peak);
}
/** The least an agent key must hold to send one more transaction of `units` gas. */
export const keyNeeds = (units: bigint, price: bigint = DEFAULT_GAS_PRICE) => (units * capOf(price) * 110n) / 100n;

export function costsOf(s: Strategy, price: bigint = DEFAULT_GAS_PRICE, payees = 0): Costs {
  const walletGas = roundUp(gasWei(s.walletUnits, price));
  const agentGas = agentGasFor(s, price, payees);
  // Peak balance needed at any step, minus the amount and the spend: the head-room line.
  const cap = capOf(price); let spent = 0n; let peak = 0n;
  const ONE_AMOUNT = 10n ** 30n; // stands for "the amount", larger than any gas figure, then removed
  for (const w of walletSteps(s)) {
    const v = w.value === 'amount' ? ONE_AMOUNT : w.value === 'agent' ? agentGas : 0n;
    const need = spent + v + (w.units * cap * 110n) / 100n; // +10%: the estimate-based limit can exceed the units for creations
    if (need > peak) peak = need;
    spent += v + gasWei(w.units, price);
  }
  const total = ONE_AMOUNT + walletGas + agentGas;
  const extra = peak > total ? peak - total : 0n;
  return { walletGas, agentGas, payGas: 0n, headroom: roundUp(extra) };
}

/** The most MON the user can put in: wallet minus the gas the wallet signs for, the agent gas line and the head-room, capped. */
export function maxAmount(s: Strategy, walletBal: bigint, price: bigint = DEFAULT_GAS_PRICE, payees = 0): bigint {
  const c = costsOf(s, price, payees);
  const keep = c.walletGas + c.agentGas + c.headroom;
  const room = walletBal > keep ? walletBal - keep : 0n;
  return s.cap != null && room > s.cap ? s.cap : room;
}

export type Review = {
  ok: boolean; blocker?: string; amount: bigint; deposit: bigint; costs: Costs; total: bigint;
  lines: { label: string; value: string; note?: string }[];
};
const m = (x: bigint, d = 4) => `${Number(formatEther(x)).toLocaleString('en-GB', { maximumFractionDigits: d })} MON`;

/**
 * What exactly happens with `amountText` MON. `deposit` goes into the strategy; the agent gas is extra, from the wallet,
 * and is shown as its own line. Every blocker is caught here, before the review screen, so nothing is sent that would fail.
 */
export function review(s: Strategy, amountText: string, walletBal: bigint | null, price: bigint = DEFAULT_GAS_PRICE, o: { payees?: { to: string; amount: bigint }[] } = {}): Review {
  const payees = o.payees ?? [];
  const costs = costsOf(s, price, payees.length);
  let amount = 0n;
  const bad = (blocker: string): Review => ({ ok: false, blocker, amount, deposit: amount, costs, total: amount + costs.walletGas + costs.agentGas, lines: [] });
  try { amount = parseEther((amountText || '').trim().replace(',', '.') || '0'); } catch { return bad('Enter an amount in MON, for example 0.5.'); }
  if (amount <= 0n) return bad('Enter an amount in MON, for example 0.5.');
  if (amount < s.min) return bad(`The smallest amount for this is ${m(s.min)}.`);
  if (s.cap != null && amount > s.cap) return bad(`This pool holds at most ${m(s.cap)}. Max fills the right amount.`);
  if (s.kind === 'pay') {
    if (!payees.length) return bad('Add at least one address to pay.');
    if (payees.some(p => !/^0x[0-9a-fA-F]{40}$/.test(p.to))) return bad('One of the addresses is not a valid 0x… address.');
    const sum = payees.reduce((a, p) => a + p.amount, 0n);
    if (payees.some(p => p.amount <= 0n)) return bad('Every payment needs an amount above 0.');
    if (sum > amount) return bad(`The payments add up to ${m(sum)}, more than the ${m(amount)} you are putting in.`);
  }
  const total = amount + costs.walletGas + costs.agentGas;
  const needed = total + costs.headroom;
  if (walletBal != null && needed > walletBal) {
    const short = needed - walletBal;
    return bad(`You need ${m(needed)} in your wallet (amount + gas${costs.headroom ? ' + fee head-room' : ''}) and have ${m(walletBal)}. Add ${m(short)} or lower the amount; Max fills it.`);
  }
  const lines: Review['lines'] = [{ label: s.kind === 'aprmon' ? 'Staked with aPriori' : s.kind === 'pay' ? 'Into your payments vault' : s.kind === 'stake3' ? 'Into your vault, then staked' : 'Into your pool', value: m(amount) }];
  if (costs.agentGas > 0n) lines.push({ label: 'Agent gas (to your new agent key)', value: m(costs.agentGas), note: 'Unused gas comes back with Withdraw everything.' });
  lines.push({ label: `Network gas for your ${s.signatures} signature${s.signatures > 1 ? 's' : ''} (estimate)`, value: `≈ ${m(costs.walletGas)}`, note: 'Monad charges the gas limit. Each step is simulated first, so nothing is sent that would fail.' });
  lines.push({ label: 'Total from your wallet', value: `≈ ${m(total)}` });
  if (costs.headroom > 0n) lines.push({ label: 'Must also be free in your wallet (not spent)', value: m(costs.headroom), note: 'Wallets only accept a transaction if the balance covers its gas limit at the maximum fee. This MON stays yours.' });
  return { ok: true, amount, deposit: amount, costs, total, lines };
}

/** Split `amount` into three stakes that add up exactly. */
export function thirds(amount: bigint): [bigint, bigint, bigint] { const a = amount / 3n; return [a, a, amount - 2n * a]; }

/** Shares to withdraw for a percentage (100% = all, no rounding dust left behind). */
export function sharesForPct(shares: bigint, pct: number): bigint {
  if (pct >= 100) return shares;
  if (pct <= 0) return 0n;
  return (shares * BigInt(Math.round(pct * 100))) / 10_000n;
}

/** P&L since deposit from on-chain amounts (deposits and withdrawals read from the user's own transactions). */
export function pnl(o: { value: bigint | null; deposited: bigint | null; withdrawn: bigint }): { abs: bigint; pct: number } | null {
  if (o.value == null || o.deposited == null || o.deposited <= 0n) return null;
  const abs = o.value + o.withdrawn - o.deposited;
  return { abs, pct: Number((abs * 1_000_000n) / o.deposited) / 10_000 };
}

/** Agent loop decision for one quote. `gain` is the pool's MON gain, `gas` the trade's gas cost in MON. */
export function shouldTrade(s: Pick<Strategy, 'needsGasCover' | 'floorBps'>, q: { amount: bigint; gain: bigint; gas: bigint }): boolean {
  if (q.amount <= 0n || q.gain <= 0n) return false;
  if (s.floorBps && q.gain * 10_000n < q.amount * BigInt(s.floorBps)) return false;
  return s.needsGasCover ? q.gain > q.gas : true;
}

export const fmtMon = m;
