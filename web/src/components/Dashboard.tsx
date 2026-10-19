'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatUnits, isAddress, keccak256, parseUnits, toHex, type Address } from 'viem';
import { Activity, BadgeCheck, CheckCircle2, Copy, Database, ExternalLink, FlaskConical, Radio, ShieldAlert, ShieldCheck, Wallet, XCircle } from 'lucide-react';
import { client, DEPLOYMENT, explorerAddr, explorerTx, MAINNET, policyPilotAbi, precheck, readPolicy, simulateExecute, type CheckResult, type PolicySnapshot } from '@/lib/monad';
import { ENVIO_URL, fetchEnvio, fetchRpc, type Feed } from '@/lib/envio';
import { AMOUNT_INPUT, blankAmount, cleanAmount } from './ui';

const POLL_MS = 8000;
const fmt = (v: bigint | null | undefined, d = 2) => (v == null ? '—' : Number(formatUnits(v, 18)).toLocaleString(undefined, { maximumFractionDigits: d }));
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const base = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`min-w-0 rounded-3xl border border-white/10 bg-white/[0.04] p-4 sm:p-5 shadow-[0_0_40px_-20px_#836EF9] backdrop-blur-xl ${className}`}>{children}</div>;
}
function Metric({ label, value, sub, children }: { label: string; value: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode }) {
  return <Card><div className="text-xs uppercase tracking-wider text-zinc-400">{label}</div><div className="mt-2 truncate font-mono text-xl tabular-nums text-zinc-50 sm:text-2xl">{value}</div>{sub && <div className="mt-1 text-xs text-zinc-400">{sub}</div>}{children}</Card>;
}

export default function Dashboard({ embedded = false }: { embedded?: boolean }) {
  const pc = useMemo(() => client(), []);
  const [snap, setSnap] = useState<PolicySnapshot | null>(null);
  const [feed, setFeed] = useState<Feed | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'payouts' | 'audit'>('payouts');
  const [copied, setCopied] = useState(false);
  const lastBlock = useRef<bigint | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await readPolicy(pc); setSnap(s); setErr(null);
      if (ENVIO_URL) { try { setFeed(await fetchEnvio()); return; } catch { /* RPC fallback */ } }
      const from = lastBlock.current == null ? DEPLOYMENT.deployBlock : lastBlock.current + 1n;
      if (from > s.block) return;
      const f = await fetchRpc(pc, DEPLOYMENT.policyPilot, from); lastBlock.current = s.block;
      setFeed(prev => {
        if (!prev || prev.mode !== 'rpc') return f;
        const rec = new Map(prev.recipients.map(r => [r.id, r])); f.recipients.forEach(r => rec.set(r.id, r));
        return { mode: 'rpc', state: null, executions: [...f.executions, ...prev.executions], events: [...f.events, ...prev.events], recipients: [...rec.values()] };
      });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, [pc]);
  useEffect(() => { refresh(); const t = setInterval(refresh, POLL_MS); return () => clearInterval(t); }, [refresh]);

  const pct = snap && snap.budget > 0n ? Number((snap.totalSpent * 10000n) / snap.budget) / 100 : 0;
  const lowRemaining = snap ? snap.remaining * 5n < snap.budget : false;
  const allowedSet = useMemo(() => new Set((feed?.recipients ?? []).filter(r => r.allowed).map(r => r.id)), [feed]);

  return (
    <div className="min-w-0 text-zinc-200">
      {!embedded && <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">Alpha · unaudited contract · only deposit what you&apos;re happy to lose. This dashboard reads the PolicyPilot reference deployment on Monad testnet (test token, no value).</div>}
      {embedded && <p className="mb-3 break-words text-xs text-zinc-400">This page reads the original testnet contract and can simulate a payout. To run an agent, use Launch: pick a preset, pick a vault, and dispatch. No addresses to paste.</p>}
      <header className="mb-4 flex min-w-0 flex-wrap items-center gap-2">
        <div className="mr-auto flex items-center gap-2"><ShieldCheck className="h-6 w-6 text-monad" /><h1 className="text-xl font-semibold text-zinc-50">Policy <span className="text-monad">dashboard</span></h1></div>
        <span className="flex items-center gap-1 rounded-full border border-white/10 min-h-9 px-3 py-1 font-mono text-xs tabular-nums" data-testid="block"><Radio className="h-3 w-3 text-emerald-400" />block {snap ? snap.block.toLocaleString() : '…'}</span>
        <span className="rounded-full border border-white/10 min-h-9 px-3 py-1 font-mono text-xs">chain {DEPLOYMENT.chain.id}</span>
        <button onClick={() => { navigator.clipboard?.writeText(DEPLOYMENT.policyPilot); setCopied(true); setTimeout(() => setCopied(false), 1200); }} className="flex min-h-11 items-center gap-1 rounded-full border border-white/10 px-3 font-mono text-xs hover:border-monad"><Copy className="h-3 w-3" />{copied ? 'copied' : short(DEPLOYMENT.policyPilot)}</button>
        <a href={DEPLOYMENT.sourcify} target="_blank" rel="noreferrer" className="flex min-h-11 items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 text-xs text-emerald-300"><BadgeCheck className="h-3 w-3" />Sourcify verified</a>
        <span data-testid="mode" className="flex items-center gap-1 rounded-full border border-monad/40 bg-monad/10 px-3 py-1 text-xs text-monad"><Database className="h-3 w-3" />{feed?.mode === 'envio' ? 'Envio HyperIndex' : 'RPC fallback'}</span>
      </header>
      <p className="mb-4 text-xs text-zinc-400">The original PolicyPilot contract on Monad testnet: a test-token budget for one executor. It is live, read-only, and every number is an RPC read.</p>
      {err && <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-300">RPC error: {err}</div>}

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Metric label="Budget used" value={<>{fmt(snap?.totalSpent)} <span className="text-sm text-zinc-500">/ {fmt(snap?.budget)}</span></>} sub="pUSD (test token)">
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-monad transition-all" style={{ width: `${Math.min(100, pct)}%` }} /></div>
          <div className="mt-1 font-mono text-xs tabular-nums text-zinc-400">{pct.toFixed(2)}%</div>
        </Metric>
        <Metric label="Remaining" value={<span className={lowRemaining ? 'text-amber-300' : ''} data-testid="remaining">{fmt(snap?.remaining)}</span>} sub={lowRemaining ? <span className="text-amber-300">⚠ under 20% of budget left</span> : 'remainingBudget()'} />
        <Metric label="Per-request cap" value={fmt(snap?.perRequestLimit)} sub="perRequestLimit()" />
        <Metric label="Firewall" value={<span className="flex items-center gap-2" data-testid="firewall"><span className={`h-3 w-3 rounded-full ${snap?.paused ? 'bg-red-500 shadow-[0_0_12px_#ef4444]' : 'bg-emerald-400 shadow-[0_0_12px_#34d399]'} animate-pulse`} />{snap ? (snap.paused ? 'Paused' : 'Active') : '…'}</span>} sub="paused()" />
        <Metric label="Executions" value={<span data-testid="execs">{feed ? (feed.state?.executions ?? feed.executions.length) : '…'}</span>} sub={<>vault holds {fmt(snap?.vaultBalance)}</>} />
      </section>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Sandbox snap={snap} allowedSet={allowedSet} pc={pc} />
        <Card className="min-w-0 lg:col-span-2">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Activity className="h-4 w-4 text-monad" />
            {(['payouts', 'audit'] as const).map(t => <button key={t} onClick={() => setTab(t)} className={`min-h-11 rounded-xl px-4 text-sm ${tab === t ? 'bg-monad text-white' : 'border border-white/10 text-zinc-300'}`}>{t === 'payouts' ? 'Payouts' : 'Audit Log'}</button>)}
            <span className="ml-auto text-xs text-zinc-500">polling every {POLL_MS / 1000}s</span>
          </div>
          <div className="max-h-[420px] min-w-0 max-w-full overflow-auto">
            {!feed ? <div className="py-8 text-center text-sm text-zinc-500">Loading real on-chain history…</div> : tab === 'payouts' ? (
              <table className="w-full text-left text-sm" data-testid="payouts"><thead className="text-xs text-zinc-500"><tr><th className="py-2">Block</th><th>Recipient</th><th className="text-right">Amount</th><th className="text-right">Total spent</th><th /></tr></thead>
                <tbody className="font-mono tabular-nums">{feed.executions.map(e => <tr key={e.id} className="border-t border-white/5"><td className="py-2">{e.blockNumber.toLocaleString()}</td><td><a className="hover:text-monad" href={explorerAddr(e.recipient)} target="_blank" rel="noreferrer">{short(e.recipient)}</a></td><td className="text-right">{fmt(e.amount)}</td><td className="text-right">{fmt(e.totalSpent)}</td><td className="text-right"><a href={explorerTx(e.txHash)} target="_blank" rel="noreferrer" className="inline-flex text-monad"><ExternalLink className="h-3.5 w-3.5" /></a></td></tr>)}
                  {feed.executions.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-zinc-500">No executions yet.</td></tr>}</tbody></table>
            ) : (
              <table className="w-full text-left text-sm" data-testid="audit"><thead className="text-xs text-zinc-500"><tr><th className="py-2">Block</th><th>Event</th><th>Detail</th><th /></tr></thead>
                <tbody>{feed.events.map(e => <tr key={e.id} className="border-t border-white/5"><td className="py-2 font-mono tabular-nums">{e.blockNumber.toLocaleString()}</td><td><span className="rounded bg-monad/15 px-2 py-0.5 text-xs text-monad">{e.kind}</span></td><td className="max-w-[280px] truncate font-mono text-xs text-zinc-400">{e.detail}</td><td className="text-right"><a href={explorerTx(e.txHash)} target="_blank" rel="noreferrer" className="inline-flex text-monad"><ExternalLink className="h-3.5 w-3.5" /></a></td></tr>)}</tbody></table>
            )}
          </div>
        </Card>
      </div>
      <footer className="mt-6 break-words text-xs text-zinc-500">All numbers are live reads of {short(DEPLOYMENT.policyPilot)} on Monad testnet. Nothing is mocked. Executor {snap ? short(snap.executor) : '…'} · admin {snap ? short(snap.admin) : '…'}.</footer>
    </div>
  );
}

function Sandbox({ snap, allowedSet, pc }: { snap: PolicySnapshot | null; allowedSet: Set<string>; pc: ReturnType<typeof client> }) {
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState(''); // starts empty (placeholder only)
  const [res, setRes] = useState<{ pre: CheckResult | null; chain: CheckResult } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!snap || !isAddress(recipient)) { setRes({ pre: null, chain: { ok: false, error: 'InvalidAddress', via: 'precheck' } }); return; }
    setBusy(true);
    try {
      const amt = parseUnits(amount || '0', 18);
      const allowed = await pc.readContract({ address: DEPLOYMENT.policyPilot, abi: policyPilotAbi, functionName: 'allowedRecipient', args: [recipient as Address] });
      const pre = precheck(snap, allowed, recipient as Address, amt);
      if (pre && !pre.ok) { setRes({ pre, chain: pre }); return; }
      const reqId = keccak256(toHex(`sandbox-${Date.now()}-${Math.random()}`));
      const chain = await simulateExecute(pc, snap.executor, recipient as Address, amt, reqId);
      setRes({ pre, chain });
    } catch (e) { setRes({ pre: null, chain: { ok: false, error: e instanceof Error ? e.message : String(e), via: 'precheck' } }); }
    finally { setBusy(false); }
  };
  const ok = res?.chain.ok;
  return (
    <Card>
      <div className="mb-3 flex items-center gap-2"><FlaskConical className="h-4 w-4 text-monad" /><h2 className="font-medium text-zinc-50">Policy sandbox</h2></div>
      <p className="mb-3 text-xs text-zinc-400">Simulates <code className="font-mono">execute()</code> with a real <code className="font-mono">eth_call</code> from the on-chain executor. Nothing is sent.</p>
      <label className="text-xs text-zinc-400">Recipient</label>
      <input data-testid="sb-recipient" value={recipient} onChange={e => setRecipient(e.target.value.trim())} placeholder="0x…" className="mb-2 mt-1 min-h-11 w-full min-w-0 rounded-xl border border-white/10 bg-black/40 px-3 py-2 font-mono text-base outline-none focus:border-monad" />
      {allowedSet.size > 0 && <div className="mb-2 flex flex-wrap gap-1">{[...allowedSet].map(a => <button key={a} onClick={() => setRecipient(a)} className="min-h-11 rounded-lg border border-white/10 px-2 font-mono text-[11px] text-zinc-400 hover:border-monad"><Wallet className="mr-1 inline h-3 w-3" />{short(a)}</button>)}</div>}
      <label className="text-xs text-zinc-400">Amount (pUSD)</label>
      <input data-testid="sb-amount" {...AMOUNT_INPUT} placeholder="e.g. 10" value={amount} onChange={e => setAmount(cleanAmount(e.target.value))} className="mb-1 mt-1 min-h-11 w-full min-w-0 rounded-xl border border-white/10 bg-black/40 px-3 py-2 font-mono text-base tabular-nums outline-none focus:border-monad" />
      <p className="mb-3 text-[11px] text-zinc-500" data-testid="amount-hint">{blankAmount(amount) ? 'Type an amount in pUSD to check.' : '\u00a0'}</p>
      <button data-testid="sb-run" disabled={busy || !snap || blankAmount(amount)} onClick={run} className="min-h-12 w-full rounded-2xl bg-monad font-medium text-white transition active:scale-[0.98] disabled:opacity-50">{busy ? 'Simulating…' : 'Check policy'}</button>
      {res && (
        <div data-testid="sb-result" className={`mt-3 rounded-lg border p-3 text-sm ${ok ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-red-500/40 bg-red-500/10'}`}>
          <div className="flex items-center gap-2 font-semibold">{ok ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <XCircle className="h-4 w-4 text-red-400" />}{ok ? 'PASS' : 'FAIL'}{!res.chain.ok && <code className="font-mono text-red-300">{res.chain.error}</code>}</div>
          <div className="mt-1 text-xs text-zinc-400">{res.chain.via === 'precheck' ? <>local precheck: {res.chain.ok ? 'pass' : res.chain.error} · eth_call skipped</> : <>on-chain eth_call: {res.chain.ok ? 'would succeed' : res.chain.error}</>} · client precheck: {res.pre ? res.pre.ok ? 'pass' : (res.pre as any).error : 'pass'}{res.pre && !res.pre.ok && !res.chain.ok && (res.pre as any).error !== res.chain.error && <span className="text-amber-300"> (mismatch)</span>}</div>
          {!res.chain.ok && <div className="mt-1 flex items-center gap-1 text-xs text-zinc-500"><ShieldAlert className="h-3 w-3" />The contract would revert, so an agent could not make this payout.</div>}
        </div>
      )}
    </Card>
  );
}
