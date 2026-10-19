'use client';
import { MomentumMoneyHook } from './Momentum';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { formatEther, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { ExternalLink, Plus, RefreshCw } from 'lucide-react';
import { Btn, Card, Pill, Slider, Switch } from './ui';
import { CloseAll } from './Positions';
import { Holdings, useDiscovery } from './Holdings';
import { agentGasFor, DEFAULT_GAS_PRICE, keyNeeds } from '@/lib/journey';
import { addJournal, agentKey, isSynthetic, positions, subscribe, updatePos, type JourneyPos } from '@/lib/journeyStore';
import { loopStatus, onLoopStatus, setLoop, tradeNow, type LoopStatus } from '@/lib/agentLoop';
import { aprEffects, gasBack, readHolding, withdrawSteps, type Holding } from '@/lib/money';
import { readRates, summarize, type Rates } from '@/lib/positionsCore';
import { loadIndex } from '@/lib/activity';
import type { Row } from '@/lib/activityCore';
import { everyVisible } from '@/lib/rpcLimit';
import { feeCaps } from '@/lib/fastPath';
import { isSimulationRevert } from '@/lib/preflight';
import { sendFault, short, type Net } from '@/lib/vault';
import type { Receipt } from '@/lib/journeyRun';

type Props = {
  net: Net; pub: PublicClient; account: Address | null; wallet: WalletClient | null;
  need: () => Promise<boolean>;
  send: (w: WalletClient, req: { to?: Address; data?: Hex; value?: bigint; gas?: bigint }) => Promise<Receipt & { status: string }>;
  sendAgent: (key: Hex, req: { to: Address; data?: Hex; value?: bigint }) => Promise<Receipt>;
  toast: (t: React.ReactNode, k?: 'ok' | 'bad' | 'info') => void;
  openConnect: () => void; goStart: () => void; goActivity: () => void; refreshBal: () => void; gasPrice: bigint | null; base: string;
  goMomentum?: () => void; // Momentum section hook
};
const fmt = (x: bigint | null | undefined, d = 4) => (x == null ? 'unknown' : `${Number(formatEther(x)).toLocaleString('en-GB', { maximumFractionDigits: d })} MON`);
const REFRESH_MS = 20_000;

function usePositions(netId: number, account: Address | null): JourneyPos[] {
  const raw = useSyncExternalStore(subscribe, () => JSON.stringify(positions(netId, account)), () => '[]');
  return useMemo(() => JSON.parse(raw) as JourneyPos[], [raw]);
}
function useLoop(id: string): LoopStatus | undefined {
  const raw = useSyncExternalStore(onLoopStatus, () => JSON.stringify(loopStatus(id) ?? null), () => 'null');
  return useMemo(() => JSON.parse(raw) ?? undefined, [raw]);
}

export default function MyMoney(p: Props) {
  const { net, pub, account } = p;
  const list = usePositions(net.id, account);
  const [hold, setHold] = useState<Map<string, Holding>>(new Map());
  const [rates, setRates] = useState<Rates | null>(null);
  const [loading, setLoading] = useState(false);
  const [readAt, setReadAt] = useState(0);
  const [closeAll, setCloseAll] = useState(false);
  const [idxRows, setIdxRows] = useState<Row[]>([]);
  const listKey = list.map(x => `${x.id}:${x.journal.length}`).join();
  const listRef = useRef(list); listRef.current = list;
  const disc = useDiscovery(net, pub, account);

  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!account) return;
    const my = ++seq.current; // only the newest read may land, so a slow older read never shows stale values
    setLoading(true);
    try {
      const r = await readRates(pub, null); if (my !== seq.current) return; setRates(r);
      const hs = await Promise.all(listRef.current.map(x => readHolding(pub, account, x, r)));
      if (my !== seq.current) return;
      for (const h of hs) if (h.derivedShares != null && h.pos.shares == null) updatePos(net.id, account, h.pos.id, x => ({ ...x, shares: h.derivedShares!.toString() }));
      setHold(new Map(hs.map(h => [h.pos.id, h]))); setReadAt(Date.now());
    } finally { if (my === seq.current) setLoading(false); }
  }, [pub, account]);
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => { void loadRef.current(); return everyVisible(() => loadRef.current(), REFRESH_MS); }, [account, listKey]);
  // Indexed activity (no RPC): rows for my vaults and my aPriori deposits.
  useEffect(() => {
    if (!account || net.id !== 143) return;
    let on = true;
    const go = () => loadIndex(p.base).then(idx => {
      if (!on || !idx) return;
      const mine = new Set(listRef.current.filter(x => x.strategy !== 'earn-low').map(x => x.address.toLowerCase()));
      const me = account.toLowerCase();
      setIdxRows(idx.latest.filter(r => (r.v && mine.has(r.v)) || (r.a === me && r.k.startsWith('md-'))));
    }).catch(() => {});
    go(); return everyVisible(go, 120_000);
  }, [account, net.id, listKey, p.base]);

  if (!account) return (
    <Card className="mx-auto grid max-w-xl gap-3 text-center" data-testid="money-empty">
      <h1 className="text-xl font-semibold text-zinc-50">My money</h1>
      <p className="text-sm text-zinc-400">Connect your wallet to see what you put in, what it is worth now, and to withdraw.</p>
      <Btn kind="pri" className="min-h-14" onClick={p.openConnect} data-testid="money-connect">Connect wallet</Btn>
    </Card>
  );

  const sum = disc.d && disc.rates ? summarize(disc.d, account, disc.rates) : null;
  const hide = new Set(list.map(x => x.address.toLowerCase()));
  const discovering = !disc.d;
  return (
    <div className="mx-auto grid w-full max-w-xl gap-4" data-testid="money" data-discovery={discovering ? 'running' : 'done'}>
      {p.goMomentum && <MomentumMoneyHook net={net} pub={pub} account={account} go={p.goMomentum} />}
      <Card>
        <div className="flex items-center gap-2"><h1 className="mr-auto text-xl font-semibold text-zinc-50">My money</h1>
          <Btn kind="ghost" className="px-3" onClick={() => { void load(); void disc.reload(); }} disabled={loading || disc.busy} data-testid="money-refresh" aria-label="Refresh"><RefreshCw className={`h-4 w-4 ${loading || disc.busy ? 'animate-spin' : ''}`} /></Btn></div>
        <div className="mt-2 font-mono text-3xl tabular-nums text-white" data-testid="money-total">{!sum ? <span className="inline-block h-8 w-40 animate-pulse rounded-lg bg-white/10" data-testid="money-total-skeleton" /> : fmt(sum.total)}</div>
        <p className="mt-1 text-xs text-zinc-500" data-testid="money-total-note">{!sum ? 'Finding everything this wallet owns on-chain (vaults in every factory, pools, aprMON, staked tokens)…' : `Everything this wallet owns, read on-chain: ${sum.owned.length} vault(s), ${disc.d!.wallet?.pools.length ?? 0} pool position(s)${(disc.d!.wallet?.aprMon ?? 0n) > 0n ? ', aprMON' : ''}${disc.d!.wallet?.aprRequests.length ? `, ${disc.d!.wallet.aprRequests.length} queued aPriori withdrawal(s)` : ''}${disc.d!.wallet?.tokens?.length ? ', staked tokens' : ''}. Your wallet's spare MON balance is not included. ${sum.unknown ? `${sum.unknown} item(s) with no live price are left out. ` : ''}Network gas is not included.`}</p>
        {disc.err && <p className="mt-1 text-xs text-amber-200">Couldn&apos;t finish reading ({disc.err}). Retrying.</p>}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Btn kind="pri" className="min-h-12" onClick={p.goStart} data-testid="money-add"><Plus className="h-4 w-4" />Add money</Btn>
          <Btn kind="danger" className="min-h-12" disabled={!p.wallet} onClick={async () => { if (await p.need()) setCloseAll(true); }} data-testid="close-all">Withdraw everything</Btn>
        </div>
      </Card>

      {discovering && !list.length && <Card className="grid gap-3" data-testid="money-loading">{[0, 1, 2].map(i => <div key={i} className="flex items-center gap-3"><span className="h-4 flex-1 animate-pulse rounded bg-white/10" /><span className="h-4 w-20 animate-pulse rounded bg-white/10" /></div>)}</Card>}

      {sum?.nothing && !list.length && <Card className="grid gap-2 text-center" data-testid="money-none">
        <p className="text-sm text-zinc-300">Nothing here yet.</p>
        <p className="text-xs text-zinc-500">This wallet owns no vault, pool, aprMON or staked tokens on Monad mainnet. Start one in a few taps.</p>
        <Btn kind="pri" className="min-h-12" onClick={p.goStart}>Start</Btn>
      </Card>}

      {list.map(x => <PositionCard key={x.id} pos={x} h={hold.get(x.id)} {...p} account={account} reload={load} idxRows={idxRows.filter(r => r.t * 1000 >= x.createdAt - 120_000 && (x.strategy === 'earn-low' ? r.k.startsWith('md-') && r.a === account.toLowerCase() : r.v === x.address.toLowerCase()))} />)}

      {disc.d && disc.rates && <Holdings p={{ net, pub, account, wallet: p.wallet, need: p.need, send: p.send, sendAgent: p.sendAgent, refreshBal: p.refreshBal }} d={disc.d} rates={disc.rates} hide={hide} reload={() => { void disc.reload(); void load(); }} aprNote={list.some(x => x.strategy === 'earn-low') ? 'includes your Earn · Low position above' : undefined} />}

      {(list.length > 0 || (sum && !sum.nothing)) && <button className="min-h-11 text-sm text-violet-300 underline" onClick={p.goActivity}>All activity →</button>}
      {closeAll && p.wallet && <CloseAll net={net} pub={pub} account={account} wallet={p.wallet} need={p.need} send={p.send as any} toast={p.toast}
        onClose={() => setCloseAll(false)} onDone={async () => { await returnAgentGas(p, list); void load(); void disc.reload(); p.refreshBal(); }} />}
    </div>
  );
}

/** After Withdraw everything: stop the agents and send each agent key's leftover gas back to the wallet. */
async function returnAgentGas(p: Omit<Props, 'account'> & { account: Address | null }, list: JourneyPos[]) {
  const acct = p.account!;
  for (const x of list) {
    if (x.loop) setLoop(p.net.id, acct, x.id, false);
    const key = agentKey(x.agent); if (!key || !x.agent) continue;
    const bal = await p.pub.getBalance({ address: x.agent }).catch(() => 0n);
    const v = gasBack(bal, feeCaps().maxFeePerGas);
    if (v <= 0n) continue;
    try { const rc = await p.sendAgent(key, { to: acct, value: v }); addJournal(p.net.id, acct, x.id, { h: rc.transactionHash, dir: 'act', label: `Agent returned ${fmt(v)} of unused gas` }); }
    catch { /* dust or a busy key: shown on the card, user can retry */ }
  }
}

function PositionCard(p: Props & { pos: JourneyPos; h?: Holding; account: Address; reload: () => Promise<void>; idxRows: Row[] }) {
  const { pos, h, net } = p;
  const s = h?.s;
  const loop = useLoop(pos.id);
  const [pct, setPct] = useState(100);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const isPool = s?.kind === 'clip' || s?.kind === 'spread';
  const price = p.gasPrice ?? DEFAULT_GAS_PRICE;
  const plan = h ? withdrawSteps(h, p.account, pct) : null;
  const claimable = h?.requests.filter(r => r.claimable) ?? [];
  const queued = h?.requests.filter(r => !r.claimable) ?? [];

  const withdraw = async () => {
    if (!h || !plan || !p.wallet) return;
    setBusy('withdraw'); setMsg(null);
    try {
      if (plan.steps.some(x => x.who === 'wallet') && !(await p.need())) return;
      const before = h.value;
      const hashes: Hex[] = [];
      // Agent-key steps need gas on the key; if it ran low, the wallet tops it up first (one signature, returned at 100%).
      const agentSteps = plan.steps.filter(x => x.who === 'agent').length; const key0 = agentKey(pos.agent);
      if (agentSteps && key0 && pos.agent) {
        let need = 0n; for (let i = 0; i < agentSteps; i++) need += keyNeeds(200_000n, price);
        const kb = await p.pub.getBalance({ address: pos.agent }).catch(() => need);
        if (kb < need) {
          if (!(await p.need())) return;
          const rc = await p.send(p.wallet, { to: pos.agent, value: need - kb + 1_000_000_000_000_000n });
          addJournal(net.id, p.account, pos.id, { h: rc.transactionHash, dir: 'act', label: 'Topped up agent gas for the withdrawal' });
          for (let i = 0; i < 15 && (await p.pub.getBalance({ address: pos.agent }).catch(() => 0n)) < need; i++) await new Promise(r => setTimeout(r, 1000));
        }
      }
      for (const st of plan.steps) {
        let rc: Receipt;
        const key = agentKey(pos.agent);
        if (st.who === 'agent' && key) {
          try { rc = await p.sendAgent(key, st.req); }
          catch (e) { if (!(isSimulationRevert(e) && st.fallback)) throw e; if (!(await p.need())) return; rc = await p.send(p.wallet, st.fallback); }
        } else if (st.who === 'agent') {
          if (!st.fallback) throw new Error('The agent key for this vault is not in this browser. Use Withdraw everything: it moves everything back with your wallet as the owner.');
          if (!(await p.need())) return; rc = await p.send(p.wallet, st.fallback);
        } else rc = await p.send(p.wallet, st.req);
        hashes.push(rc.transactionHash);
        if (s?.kind === 'aprmon') {
          // On-chain effects of the request / claim, so this position only ever counts its own aprMON.
          const fx = aprEffects(rc.logs ?? [], p.account);
          updatePos(net.id, p.account, pos.id, x => ({ ...x, shares: (() => { const cur = BigInt(x.shares ?? h.shares.toString()) - fx.reqShares; return (cur > 0n ? cur : 0n).toString(); })(), reqIds: [...(x.reqIds ?? []).filter(id => !fx.claimedIds.includes(id)), ...fx.reqIds] }));
          if (fx.claimedAssets > 0n) addJournal(net.id, p.account, pos.id, { h: rc.transactionHash, dir: 'out', amt: fx.claimedAssets.toString(), label: 'Claimed from aPriori' });
        }
      }
      // Withdrawn amount = the drop in the position's on-chain value (a queued request does not change it until claimed).
      const r = await readRates(p.pub, null); const after = await readHolding(p.pub, p.account, pos, r);
      const out = before != null && after.value != null && before > after.value ? before - after.value : 0n;
      if (s?.kind !== 'aprmon') hashes.forEach((hh, i) => addJournal(net.id, p.account, pos.id, { h: hh, dir: i === hashes.length - 1 && out > 0n ? 'out' : 'act', amt: i === hashes.length - 1 && out > 0n ? out.toString() : undefined, label: plan.steps[i]?.label }));
      else hashes.forEach((hh, i) => addJournal(net.id, p.account, pos.id, { h: hh, dir: 'act', label: plan.steps[i]?.label }));
      // 100%: the position is closed, so the agent stops and sends its unused gas back to you.
      if (pct >= 100 && s?.kind !== 'aprmon') await returnAgentGas(p, [pos]);
      p.refreshBal(); await p.reload();
      setMsg({ ok: true, text: s?.kind === 'aprmon' && !claimable.length ? 'Requested. aPriori releases it in about 12–18 hours; come back and press Claim.' : `Done. ${plan.note}` });
    } catch (e) { setMsg({ ok: false, text: sendFault(e).text }); } finally { setBusy(null); }
  };
  const topUp = async () => {
    if (!pos.agent || !p.wallet || !s) return;
    setBusy('gas'); setMsg(null);
    try {
      if (!(await p.need())) return;
      const want = agentGasFor(s, price);
      const rc = await p.send(p.wallet, { to: pos.agent, value: want });
      addJournal(net.id, p.account, pos.id, { h: rc.transactionHash, dir: 'act', label: `Topped up agent gas with ${fmt(want)}` });
      setMsg({ ok: true, text: `Sent ${fmt(want)} of gas to the agent key.` }); p.refreshBal(); await p.reload();
    } catch (e) { setMsg({ ok: false, text: sendFault(e).text }); } finally { setBusy(null); }
  };

  const recent = [...pos.journal].sort((a, b) => b.at - a.at).slice(0, 6);
  const idxNew = p.idxRows.filter(r => !pos.journal.some(j => j.h.toLowerCase() === r.h)).slice(0, 4);
  return (
    <Card className="grid gap-3" data-testid="money-pos" data-strategy={pos.strategy} data-address={pos.address}>
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1"><div className="truncate font-semibold text-zinc-50">{s?.name ?? pos.strategy}</div>
          <a className="font-mono text-xs text-violet-300" href={`${net.exp}/address/${pos.address}`} target="_blank" rel="noreferrer">{short(pos.address)} ↗</a></div>
        <div className="text-right"><div className="font-mono text-lg tabular-nums text-white" data-testid="pos-value">{!h ? <span className="inline-block h-6 w-24 animate-pulse rounded bg-white/10" /> : fmt(h.value)}</div>
          {h?.pnl && <div className={`font-mono text-xs tabular-nums ${h.pnl.abs >= 0n ? 'text-emerald-300' : 'text-red-300'}`} data-testid="pos-pnl">{h.pnl.abs >= 0n ? '+' : '−'}{fmt(h.pnl.abs < 0n ? -h.pnl.abs : h.pnl.abs, 5)} ({h.pnl.pct.toFixed(2)}%)</div>}
        </div>
      </div>
      {h && <p className="text-[11px] text-zinc-500" data-testid="pnl-note">{h.pnl ? `P&L since deposit: today's on-chain value + what you withdrew − what you deposited (${fmt(h.deposited)}), from your transactions recorded on this device. Gas not included.` : 'P&L: not tracked on this device.'}</p>}
      {h?.error && <p className="text-xs text-amber-200">Couldn&apos;t read this right now ({h.error}). Retrying in the background.</p>}
      {h && h.tokens.length > 0 && <div className="text-xs text-zinc-300">{h.native > 0n && <span>{fmt(h.native)} · </span>}{h.tokens.map(t => <span key={t.address}>{(Number(t.amount) / 10 ** t.decimals).toLocaleString('en-GB', { maximumFractionDigits: 4 })} {t.sym} </span>)}</div>}
      {h?.notes.map((n, i) => <p key={i} className="text-[11px] text-zinc-500">{n}</p>)}

      {isPool && <div className="rounded-2xl bg-black/30 p-2" data-testid="agent-status" data-state={loop?.state ?? (pos.loop ? 'starting' : 'paused')}>
        <Switch on={!!pos.loop} onChange={v => setLoop(net.id, p.account, pos.id, v)} testid="loop-toggle" label={pos.loop ? 'Agent on' : 'Agent off'} sub={pos.loop ? (loop?.note ?? 'Starting… it checks prices every few seconds while this page is open.') : 'Not trading. Your MON stays in the pool.'} />
        <div className="px-3 pb-1 text-[11px] text-zinc-500">Agent gas left: {fmt(h?.agentGas)} · {loop?.trades ?? 0} trade(s) this session · {loop?.checks ?? 0} checks{loop?.lastTx && <> · <a className="underline" href={`${net.exp}/tx/${loop.lastTx}`} target="_blank" rel="noreferrer">last trade ↗</a></>}. Profit is not guaranteed.</div>
        {pos.loop && <Btn kind="ghost" className="w-full" disabled={loop?.state === 'sending'} onClick={() => tradeNow(pos.id)} data-testid="trade-now">Run one round trip now (costs ≈ {fmt(((s?.kind === 'clip' ? 420_000n : 520_000n) * price), 3)} of agent gas; sends only if the pool gets back more than it sells)</Btn>}
        {(loop?.state === 'no-gas' || (h?.agentGas != null && h.agentGas < 50_000_000_000_000_000n)) && <Btn kind="soft" className="w-full" disabled={!!busy} onClick={topUp} data-testid="topup">{busy === 'gas' ? 'Sending…' : `Top up agent gas (${fmt(s ? agentGasFor(s, price) : 0n, 3)})`}</Btn>}
      </div>}

      {h && (h.value ?? 0n) > 0n || claimable.length ? <div className="grid gap-2 rounded-2xl border border-white/10 p-3" data-testid="withdraw-box">
        <div className="flex items-center justify-between text-sm"><span className="text-zinc-300">Withdraw</span><span className="font-mono text-zinc-50" data-testid="pct">{pct}%</span></div>
        <Slider label="Withdraw percentage" testid="pct-slider" min={25} max={100} step={25} value={pct} onChange={setPct} />
        <div className="grid grid-cols-3 gap-2">{[25, 50, 100].map(x => <Btn key={x} kind={pct === x ? 'soft' : 'ghost'} className="min-h-11" onClick={() => setPct(x)} data-testid={`pct-${x}`}>{x}%</Btn>)}</div>
        {plan && <p className="text-[11px] text-zinc-400" data-testid="withdraw-note">{plan.note}{plan.steps.length ? ` ${plan.steps.filter(x => x.who === 'wallet').length} wallet signature(s)${plan.steps.some(x => x.who === 'agent') ? ', agent-key steps sign in this browser' : ''}.` : ''}</p>}
        <Btn kind="pri" className="min-h-12" disabled={!!busy || !plan?.steps.length} onClick={withdraw} data-testid="withdraw">{busy === 'withdraw' ? 'Working…' : claimable.length && s?.kind === 'aprmon' ? `Claim${pct ? ` + request ${pct}%` : ''}` : `Withdraw ${pct}%`}</Btn>
      </div> : h ? <p className="text-xs text-zinc-500">Empty.</p> : null}
      {queued.length > 0 && <p className="text-xs text-amber-200" data-testid="queued">{queued.length} withdrawal(s) queued at aPriori ({fmt(queued.reduce((a, r) => a + r.assets, 0n))}). Claim appears here when ready (about 12–18 hours).</p>}
      {msg && <p className={`break-words rounded-2xl border p-3 text-xs ${msg.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100' : 'border-red-500/40 bg-red-500/10 text-red-100'}`} data-testid={msg.ok ? 'withdraw-ok' : 'withdraw-error'}>{msg.text}</p>}

      {(recent.length > 0 || idxNew.length > 0) && <div data-testid="pos-activity">
        <div className="mb-1 text-[11px] uppercase tracking-wider text-zinc-500">Activity</div>
        {recent.map(j => <a key={j.h} href={isSynthetic(j) ? `${net.exp}/address/${pos.address}` : `${net.exp}/tx/${j.h}`} target="_blank" rel="noreferrer" className="flex min-h-9 items-center gap-2 text-xs text-zinc-300 hover:text-white"><span className="min-w-0 flex-1 truncate">{j.dir === 'in' ? `📥 Deposit ${fmt(j.amt ? BigInt(j.amt) : null)}` : j.dir === 'out' ? `↩️ Withdrew ${fmt(j.amt ? BigInt(j.amt) : null)}` : `🤖 ${j.label ?? 'Agent action'}`}</span><span className="shrink-0 text-zinc-500">{ago(j.at)}</span><ExternalLink className="h-3 w-3 shrink-0 opacity-50" /></a>)}
        {idxNew.map(r => <a key={r.h} href={`${net.exp}/tx/${r.h}`} target="_blank" rel="noreferrer" className="flex min-h-9 items-center gap-2 text-xs text-zinc-400 hover:text-white"><span className="min-w-0 flex-1 truncate">{r.l ?? IDX_LABEL[r.k] ?? r.k}</span><Pill>indexed</Pill></a>)}
      </div>}
    </Card>
  );
}
const IDX_LABEL: Record<string, string> = { 'md-deposit': '🌱 aPriori deposit', 'md-request': '⏳ aPriori withdrawal requested', 'md-redeem': '↩️ aPriori withdrawal claimed', create: '🛡️ Vault created', deposit: '📥 Deposit', withdraw: '↩️ Withdrawal', pay: '💸 Agent payment', call: '🤖 Agent action', 'token-out': '↩️ Token withdrawn', sweep: '🧹 Sweep' };
const ago = (t: number) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
