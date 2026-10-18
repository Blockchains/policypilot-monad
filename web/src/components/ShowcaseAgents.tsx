'use client';
import { everyVisible } from '../lib/rpcLimit';
import { useEffect, useState } from 'react';
import { formatEther, parseEther, type PublicClient } from 'viem';
import { Card, Pill } from './ui';
import { fetchTeamSnapshot, TEAM_LABEL, vaultAbi, type Net, type TeamSnapshot } from '@/lib/vault';

type Live = Record<string, { nonce: number; bal: bigint; spent: bigint; paused: boolean; gas: bigint }>;
const MIN_AGENT_GAS = parseEther('0.08');
const n4 = (v: bigint) => Number(formatEther(v)).toLocaleString(undefined, { maximumFractionDigits: 4 });
const ago = (t: string) => { const s = Math.max(0, (Date.now() - Date.parse(t)) / 1000); return s < 90 ? `${Math.round(s)}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };

/** Team-operated demo agents. Kept visually and numerically separate from organic users. */
export default function ShowcaseAgents({ net, pub, base, totalVaults, extraTeamVaults = 0 }: { net: Net; pub: PublicClient; base: string; totalVaults?: number; extraTeamVaults?: number }) {
  const [snap, setSnap] = useState<TeamSnapshot | null>(null); const [live, setLive] = useState<Live>({}); const [err, setErr] = useState(false);
  useEffect(() => { if (net.id !== 143) return; fetchTeamSnapshot(net, base).then(s => (s ? setSnap(s) : setErr(true))).catch(() => setErr(true)); }, [net, base]);
  useEffect(() => {
    if (!snap) return; let stop = false;
    const tick = async () => {
      const out: Live = {};
      await Promise.all(snap.agents.filter(a => a.vault && a.agent).map(async a => {
        try {
          const [nonce, bal, spent, paused, gas] = await Promise.all([pub.getTransactionCount({ address: a.agent! }), pub.getBalance({ address: a.vault! }), pub.readContract({ address: a.vault!, abi: vaultAbi, functionName: 'totalSpent' }) as Promise<bigint>, pub.readContract({ address: a.vault!, abi: vaultAbi, functionName: 'paused' }) as Promise<boolean>, pub.getBalance({ address: a.agent! })]);
          out[a.id] = { nonce, bal, spent, paused, gas };
        } catch { /* rpc hiccup */ }
      }));
      if (!stop) setLive(out);
    };
    tick(); const off = everyVisible(tick, 45_000); return () => { stop = true; off(); };
  }, [snap, pub]);
  if (net.id !== 143 || err || !snap) return null;
  const liveTx = Object.values(live).reduce((s, x) => s + x.nonce, 0);
  const active = snap.agents.filter(a => a.vault); const team = active.length + extraTeamVaults;
  return (
    <section data-testid="showcase-agents" className="grid min-w-0 max-w-full gap-3 rounded-3xl border border-amber-400/25 bg-amber-400/[0.04] p-3 sm:p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 text-base font-semibold text-amber-100">{TEAM_LABEL}</h2>
        <Pill tone="zinc">{snap.status.startsWith('running') ? 'running' : 'stopped'}</Pill>
      </div>
      <p className="text-xs text-amber-100/70">{snap.note} Real Monad mainnet transactions, one round over every team vault every ~10 minutes from GitHub Actions. Counts below exclude organic users.</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[['Team agent txs (live nonce)', String(liveTx || '–')], ['✅ Allowed', String(snap.totals.allowed)], ['⛔ Blocked on-chain', String(snap.totals.blocked)], ['Organic (non-team) vaults', totalVaults != null ? String(Math.max(0, totalVaults - team)) : '–']].map(([k, v]) => (
          <Card key={k} className="p-3"><div className="font-mono text-lg tabular-nums text-white">{v}</div><div className="text-[11px] leading-tight text-zinc-400">{k}</div></Card>))}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {snap.agents.map(a => { const l = live[a.id]; const idle = a.lastSkip && snap.recent.find(r => r.persona === a.id && Date.parse(r.ts) > Date.parse(a.lastSkip!.ts)) == null; return (
          <Card key={a.id} className={`min-w-0 p-3 ${a.vault ? '' : 'opacity-75'}`}>
            <div className="flex min-w-0 items-center gap-2"><span className="text-xl">{a.emoji}</span><span className="min-w-0 flex-1 truncate font-medium text-white">{a.name}</span>{a.vault ? <span className="shrink-0 text-xs text-zinc-400">{l ? `${l.nonce} txs` : '…'}</span> : <Pill tone="warn">pending</Pill>}</div>
            <p className="mt-1 text-xs text-zinc-400">{a.about}</p>
            {a.vault ? <>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-300"><span>✅ {a.allowed}</span><span>⛔ {a.blocked}</span><span>cap {a.perActionCapMON} MON</span>{l && <span>spent {n4(l.spent)} MON</span>}{l && <span>vault {n4(l.bal)} MON</span>}{l?.paused && <Pill tone="warn">paused</Pill>}</div>
              {idle && <p className="mt-2 break-words rounded-xl bg-amber-400/10 p-2 text-[11px] text-amber-100/80">⏸ idle since {ago(a.lastSkip!.ts)}: {a.lastSkip!.reason}</p>}
              {a.agent && <p data-testid={`topup-${a.id}`} className={`mt-2 break-words rounded-xl p-2 text-[11px] ${l && l.gas < MIN_AGENT_GAS ? 'bg-amber-400/10 text-amber-100' : 'bg-white/5 text-zinc-300'}`}>Top up <a className="break-all font-mono text-violet-300 underline" href={`${net.exp}/address/${a.agent}`} target="_blank" rel="noreferrer">{a.agent}</a> so this agent does not pause. The runner skips it under 0.08 MON.{l ? ` It holds ${n4(l.gas)} MON.` : ''}</p>}
              <a className="mt-2 inline-flex min-h-11 items-center break-all font-mono text-[11px] text-violet-300 underline" href={`${net.exp}/address/${a.vault}`} target="_blank" rel="noreferrer">vault {a.vault} ↗</a>
            </> : <p className="mt-2 break-words rounded-xl bg-white/5 p-2 text-[11px] text-zinc-400">Not live yet: the team still has to create this vault and add its agent key. Until then the runner skips it and logs why.</p>}
          </Card>); })}
      </div>
      <details className="min-w-0">
        <summary className="flex min-h-11 cursor-pointer items-center text-sm text-zinc-300">Latest team transactions · snapshot {ago(snap.updatedAt)}</summary>
        <ol className="mt-2 grid gap-1">
          {snap.recent.slice(0, 20).map(r => (
            <li key={r.tx} className="min-w-0"><a href={`${net.exp}/tx/${r.tx}`} target="_blank" rel="noreferrer" className={`block min-h-11 rounded-xl border px-3 py-2 text-xs ${r.status === 'blocked' ? 'border-red-500/25 text-red-100' : r.status === 'allowed' ? 'border-emerald-500/20 text-emerald-100' : 'border-white/10 text-zinc-300'}`}>
              <span className="break-words">{r.status === 'blocked' ? '⛔' : r.status === 'allowed' ? '✅' : '👤'} {r.label}</span>{r.reason && <span className="block break-words text-red-300/80">vault said: {r.reason}</span>}<span className="block text-zinc-500">{ago(r.ts)} ↗</span></a></li>))}
        </ol>
      </details>
    </section>
  );
}
