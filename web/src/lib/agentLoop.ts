/**
 * Browser agent for Start-wizard pools (Trade fast / Arbitrage). While a page of the site is open it checks one pool per
 * tick: pool + key balances (folded into one Multicall3 read), then a two-request round-trip quote. It sends only when
 * journey.shouldTrade says so, always simulated first (sendWithKey → preflight), never accepting less MON back than it
 * sold. One tab holds a lease per pool so two tabs never double-send. Status is published for My money.
 */
import { encodeFunctionData, type Address, type Hex, type PublicClient } from 'viem';
import { byId, keyNeeds, shouldTrade, UNITS, DEFAULT_GAS_PRICE } from './journey';
import { addJournal, agentKey, positions, subscribe, updatePos, type JourneyPos } from './journeyStore';
import { bestRoundTrip, tripArgs, tripSizes } from './roundTrip';
import { clipAbi } from './clip';
import { spreadAbi } from './spread';
import { ethBal, type Net } from './vault';

export type LoopStatus = {
  id: string; at: number; state: 'starting' | 'watching' | 'sending' | 'traded' | 'no-gas' | 'empty' | 'paused' | 'error' | 'other-tab';
  note: string; trades: number; lastTx?: Hex; gapBps?: number; everySec: number; checks: number;
};
const status = new Map<string, LoopStatus>();
const subs = new Set<() => void>();
export const loopStatus = (id: string) => status.get(id);
export const onLoopStatus = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const publish = (s: LoopStatus) => { status.set(s.id, s); subs.forEach(f => f()); };

const TAB = Math.random().toString(36).slice(2);
/** "Run one round trip now" from My money: the next tick checks this pool first and sends if the pool itself gains
 * (and clears the on-chain floor), even when the gain is below the gas. The user is told it costs the gas. */
const now = new Set<string>();
export const tradeNow = (id: string) => { now.add(id); subs.forEach(f => f()); };
const LEASE_MS = 12_000;
function lease(id: string): boolean {
  try {
    const k = `pp.journey.lease.${id}`; const v = JSON.parse(localStorage.getItem(k) || 'null') as { t: string; at: number } | null;
    if (v && v.t !== TAB && Date.now() - v.at < LEASE_MS) return false;
    localStorage.setItem(k, JSON.stringify({ t: TAB, at: Date.now() })); return true;
  } catch { return true; }
}

export type LoopDeps = {
  net: Net; pub: PublicClient; account: Address;
  /** Simulate-first key send that resolves after a successful receipt. */
  sendKey: (key: Hex, req: { to: Address; data: Hex }) => Promise<Hex>;
  gasPrice: () => bigint | null;
  log?: (e: { label: string; tx: Hex; from: Address }) => void;
};

/** Start the loop for this account. Returns a stop function. Safe to call again (the old loop must be stopped first). */
export function startAgentLoops(d: LoopDeps): () => void {
  let stopped = false; let tick = 0; let busy = false;
  const loops = () => positions(d.net.id, d.account).filter(p => p.loop && p.agent && ['fast-balanced', 'fast-high', 'arb-low', 'arb-balanced'].includes(p.strategy));
  const run = async () => {
    if (stopped || busy) return;
    const all = loops();
    for (const p of positions(d.net.id, d.account)) if (!p.loop && status.get(p.id)?.state !== 'paused' && p.agent) publish({ ...(status.get(p.id) ?? { trades: 0, checks: 0 }), id: p.id, at: Date.now(), state: 'paused', note: 'Agent stopped. Your money stays in the pool.', everySec: 0 } as LoopStatus);
    if (!all.length) return;
    const forced = all.find(x => now.has(x.id));
    const p = forced ?? all[tick++ % all.length];
    const every = Math.max(4, 4 * all.length);
    busy = true;
    try { await once(p, every, !!forced); } finally { busy = false; if (forced) now.delete(forced.id); }
  };
  const once = async (p: JourneyPos, every: number, force = false) => {
    const s = byId(p.strategy)!; const prev = status.get(p.id) ?? { id: p.id, at: 0, state: 'starting', note: 'Starting…', trades: 0, checks: 0, everySec: every } as LoopStatus;
    const pub2 = (x: Partial<LoopStatus>) => publish({ ...prev, ...x, id: p.id, at: Date.now(), everySec: every, checks: prev.checks + 1 });
    if (!lease(p.id)) return pub2({ state: 'other-tab', note: 'Another tab of this site is running this agent.' });
    const key = agentKey(p.agent);
    if (!key) return pub2({ state: 'error', note: 'The agent key is not in this browser. Withdraw from My money; your MON is safe in the pool.' });
    try {
      const [poolBal, keyBal] = await Promise.all([ethBal(d.pub, p.address), ethBal(d.pub, p.agent!)]);
      const units = s.kind === 'clip' ? UNITS.clip : UNITS.capture;
      const price = d.gasPrice() ?? DEFAULT_GAS_PRICE;
      const gas = units * price;
      if (poolBal === 0n) return pub2({ state: 'empty', note: 'The pool is empty.' });
      if (keyBal < keyNeeds(units, price)) return pub2({ state: 'no-gas', note: 'The agent key is out of gas, so it stopped trading. Top it up in My money.' });
      const q = await bestRoundTrip(d.pub, tripSizes(poolBal));
      if (!q) return pub2({ state: 'watching', note: 'Waiting for prices from at least two pools.' });
      const amount = q.amount;
      const gapNote = `Best round trip now: ${q.gain >= 0n ? '+' : '−'}${(Math.abs(Number(q.gain)) / 1e18).toFixed(4)} MON on ${(Number(amount) / 1e18).toFixed(3)} MON (gas ≈ ${(Number(gas) / 1e18).toFixed(3)} MON).`;
      if (!shouldTrade(force ? { ...s, needsGasCover: false } : s, { amount, gain: q.gain, gas })) return pub2({ state: 'watching', gapBps: q.gapBps, note: `${gapNote} ${force ? 'No round trip gains anything right now, so nothing was sent.' : 'Not worth sending.'}` });
      pub2({ state: 'sending', gapBps: q.gapBps, note: `${gapNote} Simulating, then sending…` });
      const args = tripArgs(q, s.floorBps ?? 0, s.acceptShortBps ?? 0);
      const data = s.kind === 'clip' ? encodeFunctionData({ abi: clipAbi, functionName: 'clip', args }) : encodeFunctionData({ abi: spreadAbi, functionName: 'capture', args });
      try {
        const h = await d.sendKey(key, { to: p.address, data });
        const label = `Agent round trip ${(Number(amount) / 1e18).toFixed(3)} MON (${q.sell} → ${q.buy})`;
        d.log?.({ label, tx: h, from: p.agent! });
        addJournal(d.net.id, d.account, p.id, { h, dir: 'act', label });
        publish({ ...prev, id: p.id, at: Date.now(), state: 'traded', note: `Traded: ${gapNote}`, trades: prev.trades + 1, lastTx: h, gapBps: q.gapBps, everySec: every, checks: prev.checks + 1 });
      } catch (e: any) {
        pub2({ state: 'watching', note: e?.simulated ? `${gapNote} The simulation said it would revert, so nothing was sent.` : `Send failed: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 140)}` });
      }
    } catch (e: any) {
      pub2({ state: 'error', note: `Reconnecting to the network… (${String(e?.shortMessage ?? e?.message ?? e).slice(0, 80)})` });
    }
  };
  const t = setInterval(() => void run(), 4_000);
  const off = subscribe(() => void 0);
  void run();
  return () => { stopped = true; clearInterval(t); off(); };
}

export const setLoop = (net: number, account: string, id: string, on: boolean) => updatePos(net, account, id, p => ({ ...p, loop: on }));
