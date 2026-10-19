/**
 * My money: reads every Start-wizard position from the chain and builds the withdraw transactions.
 * Values are on-chain reads only (pool assetsOf, vault balances valued by convertToAssets, aprMON convertToAssets).
 * P&L uses the deposit/withdraw amounts journaled on this device for this wallet's own transactions.
 */
import { encodeFunctionData, getAddress, parseEventLogs, type Address, type Hex, type PublicClient } from 'viem';
import { byId, pnl, sharesForPct, type Strategy } from './journey';
import type { JourneyPos } from './journeyStore';
import { ADDR, erc20Abi, FACTORIES, poolAbi, readAprRequests, readVaultPositions, type AprRequest, type Rates, type TokenPos } from './positionsCore';
import { aprMonAbi } from './monadefi';
import { rid, vaultAbi as fullVaultAbi } from './vault';

const ONE = 10n ** 18n;
const NONE = { approveToken: '0x0000000000000000000000000000000000000000' as Address, approveAmount: 0n, outToken: '0x0000000000000000000000000000000000000000' as Address, minOut: 0n };
const v4 = FACTORIES.find(f => f.id === 'v4')!;

export type Holding = {
  pos: JourneyPos; s: Strategy;
  value: bigint | null;           // MON value now (on-chain)
  native: bigint;                 // MON held directly (vaults)
  tokens: TokenPos[];             // tokens held (vaults)
  shares: bigint;                 // pool shares or aprMON balance
  requests: AprRequest[];         // aprMON queued withdrawals
  agentGas: bigint | null;        // MON left on the browser agent key
  deposited: bigint | null; withdrawn: bigint;
  pnl: { abs: bigint; pct: number } | null;
  notes: string[]; error?: string;
  /** Earn · Low: shares read from the position's own Deposit events (saved by the caller). */
  derivedShares?: bigint;
};

/** aprMON shares minted to `account` by this position's deposit transactions (their Deposit events). */
async function depositedShares(pub: PublicClient, account: Address, p: JourneyPos): Promise<bigint> {
  let total = 0n;
  for (const j of p.journal.filter(x => x.dir === 'in')) {
    const rc = await pub.getTransactionReceipt({ hash: j.h });
    for (const ev of parseEventLogs({ abi: aprMonAbi, logs: rc.logs, eventName: 'Deposit' })) if (getAddress((ev.args as any).owner) === getAddress(account)) total += (ev.args as any).shares as bigint;
  }
  return total;
}

/** After an aprMON withdraw transaction: the request ids it queued, the shares they took, and the MON a claim paid out. */
export function aprEffects(logs: readonly any[], account: Address): { reqIds: string[]; reqShares: bigint; claimedIds: string[]; claimedAssets: bigint } {
  const me = getAddress(account);
  const reqs = parseEventLogs({ abi: aprMonAbi, logs: logs as any, eventName: 'RedeemRequest' }).filter(e => getAddress((e.args as any).owner) === me);
  const red = parseEventLogs({ abi: aprMonAbi, logs: logs as any, eventName: 'Redeem' }).filter(e => getAddress((e.args as any).receiver) === me);
  return {
    reqIds: reqs.map(e => String((e.args as any).requestId)), reqShares: reqs.reduce((a, e) => a + ((e.args as any).shares as bigint), 0n),
    claimedIds: red.map(e => String((e.args as any).requestId)), claimedAssets: red.reduce((a, e) => a + ((e.args as any).assets as bigint), 0n),
  };
}

const sum = (xs: (bigint | null | undefined)[]) => xs.reduce<bigint>((a, x) => a + (x ?? 0n), 0n);

export async function readHolding(pub: PublicClient, account: Address, p: JourneyPos, rates: Rates): Promise<Holding> {
  const s = byId(p.strategy)!;
  const deposited = p.journal.some(j => j.dir === 'in') ? sum(p.journal.filter(j => j.dir === 'in').map(j => (j.amt ? BigInt(j.amt) : null))) : null;
  // Withdrawn or paid out: withdrawals plus the agent's payments (an intended outflow, not a loss).
  const withdrawn = sum(p.journal.filter(j => j.dir === 'out' || (j.dir === 'act' && j.amt)).map(j => (j.amt ? BigInt(j.amt) : 0n)));
  const base = { pos: p, s, native: 0n, tokens: [] as TokenPos[], shares: 0n, requests: [] as AprRequest[], agentGas: null as bigint | null, deposited, withdrawn, notes: [] as string[] };
  try {
    const agentGas = p.agent ? pub.getBalance({ address: p.agent }).catch(() => null) : Promise.resolve(null);
    if (s.kind === 'clip' || s.kind === 'spread') {
      const [shares, assets, g] = await Promise.all([
        pub.readContract({ address: p.address, abi: poolAbi, functionName: 'balanceOf', args: [account] }),
        pub.readContract({ address: p.address, abi: poolAbi, functionName: 'assetsOf', args: [account] }),
        agentGas,
      ]);
      return { ...base, shares, value: assets, agentGas: g, pnl: pnl({ value: assets, deposited, withdrawn }) };
    }
    if (s.kind === 'aprmon') {
      const [bal, reqs, derived] = await Promise.all([
        pub.readContract({ address: ADDR.aprMON, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
        readAprRequests(pub, account).catch(() => [] as AprRequest[]),
        p.shares == null ? depositedShares(pub, account, p) : Promise.resolve(null),
      ]);
      // Only this position's aprMON: shares from its own Deposit events, less what it queued; never more than the wallet holds.
      const own = p.shares != null ? BigInt(p.shares) : derived ?? 0n;
      const shares = own < bal ? own : bal;
      const mine = reqs.filter(r => (p.reqIds ?? []).includes(r.id.toString()));
      const value = rates.aprMON ? (shares * rates.aprMON) / ONE + sum(mine.map(r => r.assets)) : null;
      return { ...base, shares, requests: mine, value, derivedShares: derived ?? undefined, pnl: pnl({ value, deposited, withdrawn }), notes: ['Only the aprMON this position minted (from its Deposit events), not other aprMON in the wallet.'] };
    }
    const [vp, g] = await Promise.all([readVaultPositions(pub, { vault: p.address, factory: v4, relations: ['owner'] }, { rates, discovered: { ok: true, tokens: [] } }), agentGas]);
    const unknown = vp.tokens.some(t => t.monValue == null);
    const value = unknown ? null : vp.navMon;
    return { ...base, native: vp.native, tokens: vp.tokens, value, agentGas: g, pnl: pnl({ value, deposited, withdrawn }), notes: vp.tokens.filter(t => t.priced !== 'live' || t.kind === 'lst').map(t => t.note) };
  } catch (e: any) {
    return { ...base, value: null, pnl: null, error: String(e?.shortMessage ?? e?.message ?? e).split('\n')[0].slice(0, 160) };
  }
}

export type Tx = { to: Address; data: Hex; value?: bigint };
export type WithdrawStep = { label: string; who: 'wallet' | 'agent'; req: Tx; fallback?: Tx; gets: string };

/** The transactions for withdrawing `pct`% of one holding. */
export function withdrawSteps(h: Holding, account: Address, pct: number): { steps: WithdrawStep[]; note: string } {
  const s = h.s; const owner = getAddress(account);
  if (s.kind === 'clip' || s.kind === 'spread') {
    const sh = sharesForPct(h.shares, pct);
    return { steps: sh > 0n ? [{ label: `Withdraw ${pct}% of your pool`, who: 'wallet', req: { to: h.pos.address, data: encodeFunctionData({ abi: poolAbi, functionName: 'withdraw', args: [sh] }) }, gets: 'MON, straight to your wallet' }] : [], note: 'Comes back as MON in one signature, straight away.' };
  }
  if (s.kind === 'aprmon') {
    const steps: WithdrawStep[] = [];
    const ready = h.requests.filter(r => r.claimable).map(r => r.id);
    if (ready.length) steps.push({ label: `Claim ${ready.length} finished withdrawal${ready.length > 1 ? 's' : ''}`, who: 'wallet', req: { to: ADDR.aprMON, data: encodeFunctionData({ abi: aprMonAbi, functionName: 'redeem', args: [ready, owner] }) }, gets: 'MON, straight to your wallet' });
    const sh = sharesForPct(h.shares, pct);
    if (sh > 0n) steps.push({ label: `Request ${pct}% back from aPriori`, who: 'wallet', req: { to: ADDR.aprMON, data: encodeFunctionData({ abi: aprMonAbi, functionName: 'requestRedeem', args: [sh, owner, owner] }) }, gets: 'a queued withdrawal (about 12–18 hours), then Claim here' });
    return { steps, note: 'aPriori queues withdrawals: you request now and claim the MON here after about 12–18 hours.' };
  }
  // Journey vault (stake3 / pay): the browser agent key moves MON and tokens to you with no wallet popup.
  const steps: WithdrawStep[] = [];
  const mon = (h.native * BigInt(Math.round(pct * 100))) / 10_000n;
  const monAmt = pct >= 100 ? h.native : mon;
  if (monAmt > 0n) steps.push({ label: `Send ${pct}% of the vault's MON to you`, who: 'agent', req: { to: h.pos.address, data: encodeFunctionData({ abi: fullVaultAbi, functionName: 'execute', args: [rid('out'), owner, monAmt] }) }, gets: 'MON' });
  for (const t of h.tokens) {
    const amt = pct >= 100 ? t.amount : (t.amount * BigInt(Math.round(pct * 100))) / 10_000n;
    if (amt <= 0n) continue;
    steps.push({
      label: `Send ${pct}% of the vault's ${t.sym} to you`, who: 'agent',
      req: { to: h.pos.address, data: encodeFunctionData({ abi: fullVaultAbi, functionName: 'executeCall', args: [rid('out'), t.address, 0n, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [owner, amt] }), NONE] }) },
      fallback: { to: h.pos.address, data: encodeFunctionData({ abi: fullVaultAbi, functionName: 'withdrawToken', args: [t.address, owner, amt] }) },
      gets: `${t.sym} (a token, not MON)`,
    });
  }
  const tok = h.tokens.length > 0;
  return { steps, note: tok ? `Staked MON comes back as the staking tokens (${h.tokens.map(t => t.sym).join(', ')}), not MON. Unstaking them is queued by each protocol.` : 'Comes back as MON. The agent key signs in this browser, so there is no wallet popup.' };
}

/** The agent key's leftover gas that can go back to the owner: balance minus the 21,000-gas transfer at the max fee cap. */
export function gasBack(bal: bigint, maxFeePerGas: bigint): bigint { const fee = 21_000n * maxFeePerGas; return bal > fee ? bal - fee : 0n; }
