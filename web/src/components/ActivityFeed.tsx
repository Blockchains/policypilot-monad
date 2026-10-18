'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatEther } from 'viem';
import { KIND_GROUP, mergeRows, type Row } from '@/lib/activityCore';
import { loadIndex, loadPage, tailFrom, tick, type Index, type Tail, type VaultMeta } from '@/lib/activity';
import { dappInfo, dappName, selName, short, TEAM_LABEL, type Net } from '@/lib/vault';
import { TOKENS } from '@/lib/services';
import { Card, Pill } from './ui';

const TICK_MS = 4000; const INDEX_MS = 90_000; const PAGE = 40; const FRESH_MS = 9000;
const GROUPS: [string, string][] = [['all', 'All'], ['create', '🛡️ Created'], ['deposit', '📥 Deposits'], ['agent', '🤖 Agent actions'], ['withdraw', '↩️ Withdrawals'], ['sweep', '🧹 Sweeps'], ['pause', '⏸ Pause'], ['refill', '⛽ Refills'], ['monadefi', '🌱 MonaDefi'], ['config', '⚙️ Settings'], ['reverted', '⛔ Reverted']];
const tokenName = (a?: string) => (a ? Object.entries(TOKENS).find(([, t]) => t.address.toLowerCase() === a)?.[0] ?? short(a) : 'tokens');
const fmtMon = (m?: string) => { if (!m) return ''; const x = Number(formatEther(BigInt(m))); return `${x >= 1 ? x.toLocaleString(undefined, { maximumFractionDigits: 4 }) : x.toPrecision(3).replace(/\.?0+$/, '')} MON`; };
const ERA: Record<string, string> = { v1: 'v1 factory', v2: 'v2 factory', v3: 'v3 factory', 'showcase-v4': 'showcase v4 factory', unlimited: 'Unlimited factory', live: 'new factory' };
export function rel(t: number, now = Date.now()) {
  if (!t) return ''; const s = Math.max(0, Math.round(now / 1000 - t));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}

function describe(r: Row, v?: VaultMeta): { icon: string; title: string } {
  const amt = fmtMon(r.m); const who = r.a ? short(r.a) : '';
  if (r.s === 'reverted') return { icon: '⛔', title: r.l ?? 'Reverted transaction' };
  if (r.l) return { icon: r.k === 'showcase' ? '🤖' : dappInfo(r.a)?.icon ?? '🤖', title: r.l };
  switch (r.k) {
    case 'create': return { icon: '🛡️', title: `Vault created${amt ? ` with a ${amt} deposit` : ''}${v?.f ? ` · ${ERA[v.f] ?? v.f}` : ''}` };
    case 'deposit': return { icon: '📥', title: `Deposit of ${amt || 'MON'} into the vault` };
    case 'withdraw': return { icon: '↩️', title: `Owner withdrew ${amt || 'MON'}` };
    case 'token-out': return { icon: '↩️', title: `Owner withdrew ${tokenName(r.out)}` };
    case 'pay': return { icon: '💸', title: `Agent paid ${amt} to ${who}` };
    case 'call': { const d = dappInfo(r.a); return { icon: d?.icon ?? '🧩', title: `Agent ${selName(r.sel) ?? 'call'} on ${d?.name ?? dappName(r.a ?? '')}${amt ? ` with ${amt}` : ''}${r.out ? ` → ${tokenName(r.out)}` : ''}` }; }
    case 'sweep': return { icon: '🧹', title: `Daily return: ${amt} swept to the owner (vault keeps 1 MON)` };
    case 'pause': return { icon: '⏸', title: 'Vault paused' };
    case 'unpause': return { icon: '▶️', title: 'Vault unpaused' };
    case 'executor': return { icon: '🔑', title: `Agent key changed to ${who}` };
    case 'config': return { icon: '⚙️', title: `Owner changed vault settings${r.n && r.n > 1 ? ` (${r.n} changes)` : ''}` };
    case 'refill': return { icon: '⛽', title: amt ? `Refiller topped up ${r.n && r.n > 1 ? `${r.n - 1 || 1} addresses` : who} with ${amt}` : 'Refiller run (nothing to top up)' };
    case 'refill-failed': return { icon: '⚠️', title: `Refiller could not top up ${who}` };
    case 'refill-fund': return { icon: '🏦', title: `Refiller funded with ${amt}` };
    case 'refill-out': return { icon: '🏦', title: `Refiller withdrew ${amt}` };
    case 'md-deposit': return { icon: '🌱', title: `MonaDefi deposit: ${amt} into aPriori aprMON` };
    case 'md-request': return { icon: '⏳', title: `MonaDefi withdrawal requested: about ${amt}` };
    case 'md-redeem': return { icon: '✅', title: `MonaDefi withdrawal claimed: ${amt}` };
    default: return { icon: '🤖', title: 'Showcase agent transaction' };
  }
}

export default function ActivityFeed({ net, account, block, base }: { net: Net; account: string | null; block: bigint | null; base: string }) {
  const [idx, setIdx] = useState<Index | null>(null); const [err, setErr] = useState('');
  const [rows, setRows] = useState<Row[]>([]); const [fresh, setFresh] = useState<Record<string, number>>({});
  const [pagesLeft, setPagesLeft] = useState<number[]>([]); const [loadingPage, setLoadingPage] = useState(false);
  const [group, setGroup] = useState('all'); const [vault, setVault] = useState(''); const [agent, setAgent] = useState(''); const [mine, setMine] = useState(false);
  const [shown, setShown] = useState(PAGE); const [now, setNow] = useState(Date.now()); const [hidden, setHidden] = useState(false);
  const tail = useRef<Tail | null>(null); const head = useRef<number>(0); const busy = useRef(false); const acct = useRef(account);
  const [, force] = useState(0);
  acct.current = account; if (block) head.current = Number(block);

  const absorb = useCallback((incoming: Row[], mark: boolean) => {
    if (!incoming.length) return;
    setRows(prev => { const known = new Set(prev.map(r => r.h)); const neu = incoming.filter(r => !known.has(r.h)); if (mark && neu.length) setFresh(f => { const g = { ...f }; for (const r of neu) g[r.h] = Date.now(); return g; }); return mergeRows(prev, incoming); });
  }, []);

  // history index: load, then refresh (free: GitHub raw) so reverted showcase txs from the ledger also arrive
  useEffect(() => {
    let on = true;
    const load = async (first: boolean) => {
      try {
        const x = await loadIndex(base); if (!on) return; if (!x) { if (first) setErr('History index unavailable: showing live blocks only.'); return; }
        setIdx(prev => (prev && prev.lastBlock >= x.lastBlock ? prev : x));
        if (first) { tail.current = tailFrom(x); setPagesLeft(x.pages.map(p => p.id)); setRows(x.latest); }
        else { absorb(x.latest, false); if (tail.current) for (const v of x.vaults) if (!tail.current.vaults.has(v.a)) { tail.current.vaults.set(v.a, v); tail.current.ctx.vaults.add(v.a); } }
      } catch (e) { if (first) setErr(String((e as Error).message)); }
    };
    load(true); const t = setInterval(() => { if (!document.hidden) load(false); }, INDEX_MS);
    return () => { on = false; clearInterval(t); };
  }, [base, absorb]);

  // live tail: one eth_getLogs per tick while visible
  useEffect(() => {
    const run = async () => {
      setHidden(document.hidden); setNow(Date.now());
      if (document.hidden || busy.current || !tail.current || !head.current) return;
      busy.current = true;
      try { for (let k = 0; k < 3; k++) { const before = tail.current.cursor; absorb(await tick(net, tail.current, head.current, acct.current), true); if (tail.current.cursor === before || head.current - tail.current.cursor < 50) break; } }
      finally { busy.current = false; force(x => x + 1); }
    };
    const t = setInterval(run, TICK_MS); const onVis = () => { setHidden(document.hidden); if (!document.hidden) run(); };
    document.addEventListener('visibilitychange', onVis); run();
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [net, absorb]);

  const vaults = tail.current?.vaults ?? new Map<string, VaultMeta>();
  const me = account?.toLowerCase();
  const filtered = useMemo(() => rows.filter(r => {
    if (group === 'reverted' ? r.s !== 'reverted' : group !== 'all' && KIND_GROUP[r.k] !== group) return false;
    if (vault && r.v !== vault) return false;
    const v = r.v ? vaults.get(r.v) : undefined;
    if (agent && v?.e !== agent) return false;
    if (mine && !(me && (r.a === me || v?.o === me || v?.e === me))) return false;
    return true;
  }), [rows, group, vault, agent, mine, me, vaults]);

  const loadOlder = useCallback(async () => {
    if (loadingPage || !pagesLeft.length) return;
    setLoadingPage(true);
    try { const [id, ...rest] = pagesLeft; absorb(await loadPage(base, id), false); setPagesLeft(rest); } finally { setLoadingPage(false); }
  }, [loadingPage, pagesLeft, base, absorb]);
  // infinite scroll: grow the list, and fetch the next older page when the loaded rows run out
  const sentinel = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    const el = sentinel.current; if (!el) return;
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { setShown(s => s + PAGE); if (filtered.length < shown + PAGE * 2) loadOlder(); } }, { rootMargin: '600px' });
    io.observe(el); return () => io.disconnect();
  }, [filtered.length, shown, loadOlder]);
  useEffect(() => { setShown(PAGE); }, [group, vault, agent, mine]);
  // a narrow filter (e.g. one vault, reverted only) keeps pulling older pages until the screen is full or history ends
  useEffect(() => { if (filtered.length < shown && pagesLeft.length && !loadingPage) loadOlder(); }, [filtered.length, shown, pagesLeft.length, loadingPage, loadOlder]);

  const t = tail.current; const lag = t && head.current ? head.current - t.cursor : null;
  const live = !!t && !hidden && !!t.okAt && now - t.okAt < TICK_MS * 4 && lag !== null && lag < 60;
  const state = hidden ? 'Paused while this tab is hidden' : !t ? 'Loading history…' : live ? 'Live' : t.err ? 'Reconnecting to Monad RPC…' : 'Catching up…';
  const newSinceIndex = idx ? rows.filter(r => r.b > idx.lastBlock).length : 0;
  const total = idx ? idx.total + newSinceIndex : rows.length;
  const agents = useMemo(() => { const m = new Map<string, string>(); for (const v of vaults.values()) if (v.e && !m.has(v.e)) m.set(v.e, v.p ? `${v.p} (team)` : short(v.e)); return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1])); }, [vaults.size]); // eslint-disable-line react-hooks/exhaustive-deps
  const vaultList = useMemo(() => [...vaults.values()].sort((a, b) => b.b - a.b), [vaults.size]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = filtered.slice(0, shown);

  return (
    <div className="grid gap-3" data-testid="activity-feed">
      <Card className="flex flex-wrap items-center gap-3 p-3">
        <span data-testid="activity-live" data-live={live ? '1' : '0'} className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${live ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>
          <span className={`h-2 w-2 rounded-full ${live ? 'animate-pulse bg-emerald-400' : 'bg-amber-400'}`} />{state}
        </span>
        <span className="min-w-0 flex-1 text-xs text-zinc-400">{t ? <>synced to block <span className="font-mono">{t.cursor.toLocaleString()}</span>{t.okAt ? ` · checked ${rel(Math.floor(t.okAt / 1000), now)}` : ''}</> : ''}</span>
        <span className="text-xs text-zinc-300" data-testid="activity-total" data-total={total}><span className="font-mono text-white">{total.toLocaleString()}</span> platform transactions{idx?.reverted ? ` · ${idx.reverted.toLocaleString()} reverted` : ''}</span>
      </Card>
      <p className="text-[11px] leading-4 text-zinc-500">Every executed transaction of every PolicyPilot vault (all factories, user vaults included), the refillers, MonaDefi deposits and withdrawals of platform wallets, and the showcase agents ({TEAM_LABEL}; reverted showcase txs come from the team’s ledger). History from a free index in this repo, then live from Monad blocks. Newest first.</p>
      {err && <p className="text-xs text-amber-300">{err}</p>}
      <div className="-mx-1 flex min-w-0 flex-wrap gap-2 px-1" data-testid="act-filters">
        {GROUPS.map(([v, l]) => <button key={v} data-testid={`act-f-${v}`} onClick={() => setGroup(v)} className={`min-h-10 rounded-full px-3 text-sm transition active:scale-95 ${group === v ? 'bg-monad text-white' : 'border border-white/10 text-zinc-300'}`}>{l}</button>)}
      </div>
      <div className="grid min-w-0 gap-2 sm:grid-cols-3">
        <select data-testid="act-vault" value={vault} onChange={e => setVault(e.target.value)} className="min-h-10 min-w-0 rounded-xl border border-white/10 bg-black/40 px-2 text-sm text-zinc-200">
          <option value="">All vaults ({vaults.size})</option>
          {vaultList.map(v => <option key={v.a} value={v.a}>{v.p ? `${v.p} · ` : ''}{short(v.a)} · {ERA[v.f] ?? v.f}{v.team ? ' · team' : ''}</option>)}
        </select>
        <select data-testid="act-agent" value={agent} onChange={e => setAgent(e.target.value)} className="min-h-10 min-w-0 rounded-xl border border-white/10 bg-black/40 px-2 text-sm text-zinc-200">
          <option value="">All agents</option>{agents.map(([a, l]) => <option key={a} value={a}>{l}</option>)}
        </select>
        <label className="flex min-h-10 items-center gap-2 rounded-xl border border-white/10 px-3 text-sm text-zinc-300"><input data-testid="act-mine" type="checkbox" checked={mine} disabled={!account} onChange={e => setMine(e.target.checked)} />{account ? 'Only mine' : 'Connect a wallet to filter yours'}</label>
      </div>
      <ol className="grid gap-2" data-testid="act-list">
        {!rows.length && <li className="text-sm text-zinc-500">{t ? 'Nothing here yet.' : 'Loading every platform transaction…'}</li>}
        {rows.length > 0 && !list.length && <li className="text-sm text-zinc-500">{pagesLeft.length ? 'Searching older history…' : 'No transaction matches these filters.'}</li>}
        {list.map(r => {
          const v = r.v ? vaults.get(r.v) : undefined; const d = describe(r, v); const isNew = fresh[r.h] && now - fresh[r.h] < FRESH_MS;
          const team = !!(r.p || v?.team);
          return (
            <li key={r.h} data-testid="act-row" data-h={r.h} data-b={r.b} data-k={r.k} data-s={r.s} className={`min-w-0 rounded-2xl border p-3 transition-colors duration-1000 ${isNew ? 'border-emerald-400/50 bg-emerald-500/10' : r.s === 'reverted' ? 'border-red-500/25 bg-red-500/[0.05]' : 'border-white/10 bg-white/[0.03]'}`}>
              <div className="flex min-w-0 items-start gap-2">
                <span className="shrink-0 text-lg leading-6">{d.icon}</span>
                <span className="min-w-0 flex-1 break-words text-sm font-medium text-zinc-100">{d.title}</span>
                {r.s === 'reverted' ? <Pill tone="bad">reverted</Pill> : <Pill tone="ok">executed</Pill>}
              </div>
              <div className="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 pl-7 text-xs text-zinc-400">
                {r.m && <span className="font-mono text-zinc-200">{fmtMon(r.m)}</span>}
                <span title={r.t ? new Date(r.t * 1000).toString() : ''}>{rel(r.t, now)}{r.t ? ` · ${new Date(r.t * 1000).toLocaleString()}` : ''}</span>
                <span>block {r.b.toLocaleString()}</span>
                {r.v && <span>{v?.p ?? 'vault'} {short(r.v)}</span>}
                {team && <span className="text-amber-300/90">showcase · operated by the team</span>}
                {me && (r.a === me || v?.o === me || v?.e === me) && <span className="text-violet-300">you</span>}
                <a className="text-violet-300 underline" href={`${net.exp}/tx/${r.h}`} target="_blank" rel="noreferrer">tx ↗</a>
              </div>
              {r.s === 'reverted' && r.r && <div className="mt-1 break-words pl-7 text-xs text-red-200">{r.r}</div>}
            </li>);
        })}
        <li ref={sentinel} data-testid="act-more" className="py-2 text-center text-xs text-zinc-500">{filtered.length > shown || pagesLeft.length ? (loadingPage ? 'Loading older transactions…' : <button onClick={() => { setShown(s => s + PAGE); loadOlder(); }} className="underline">Show older</button>) : rows.length ? 'Start of platform history' : ''}</li>
      </ol>
    </div>
  );
}
