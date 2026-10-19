'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatEther, getAddress, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { ChevronDown } from 'lucide-react';
import { Btn, Card, Pill, Slider } from './ui';
import { agentKeys, discoveredPoolsKey, idxCache, savedPools } from './Positions';
import { loadIndex } from '@/lib/activity';
import {
  aprWithdrawSteps, discoverTokens, FACTORIES, KNOWN, scoutPaused, type PoolRef, findPools, findVaults, poolWithdrawStep, readRates, readVaultPositions, readWalletPositions, summarize, vaultWithdrawSteps,
  type AgentAccess, type Discovered, type Rates, type Step, type VaultPos,
} from '@/lib/positionsCore';
import { monUsdcPrice, sendFault, short, type Net } from '@/lib/vault';
import { everyVisible } from '@/lib/rpcLimit';
import type { Receipt } from '@/lib/journeyRun';

export type HoldProps = {
  net: Net; pub: PublicClient; account: Address; wallet: WalletClient | null; need: () => Promise<boolean>;
  send: (w: WalletClient, req: { to?: Address; data?: Hex; value?: bigint; gas?: bigint }) => Promise<Receipt & { status: string }>;
  sendAgent: (key: Hex, req: { to: Address; data?: Hex; value?: bigint }) => Promise<Receipt>;
  refreshBal: () => void;
};
const fmt = (x: bigint | null | undefined, d = 4) => (x == null ? 'unknown' : `${Number(formatEther(x)).toLocaleString('en-GB', { maximumFractionDigits: d })} MON`);
const REFRESH_MS = 60_000;
const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
const TOKENS_MS = 300_000;
const kv = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* full */ } } };
const tokCache = new Map<string, { at: number; v: Awaited<ReturnType<typeof discoverTokens>> }>();

/** Everything the connected wallet owns or is the agent of, discovered on-chain (not from this device). `d` stays null until the first discovery has finished. */
export function useDiscovery(net: Net, pub: PublicClient, account: Address | null) {
  const [d, setD] = useState<Discovered | null>(null);
  const [rates, setRates] = useState<Rates | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const seq = useRef(0);
  const enrich = useCallback(async (fv: Awaited<ReturnType<typeof findVaults>>, r: Rates, pools: PoolRef[], my: number) => {
    for (const f of fv) {
      if (my !== seq.current) return;
      const k = f.vault.toLowerCase(); const hit = tokCache.get(k);
      if (hit && Date.now() - hit.at < TOKENS_MS) continue;
      if (scoutPaused()) return; // the public index asked us to slow down: try again on the next refresh
      const v = await discoverTokens(f.vault).catch(() => null);
      if (!v || !v.ok) { if (v) tokCache.set(k, { at: Date.now() - TOKENS_MS + 60_000, v }); continue; }
      tokCache.set(k, { at: Date.now(), v });
      if (v.tokens.some(t => !KNOWN.some(x => x.address.toLowerCase() === t.address.toLowerCase()))) {
        const np = await readVaultPositions(pub, f, { rates: r, pools, discovered: v }).catch(() => null);
        if (np && my === seq.current) setD(x => (x ? { ...x, vaults: x.vaults.map(y => (y.vault === np.vault ? np : y)) } : x));
      }
    }
  }, [pub]);
  const load = useCallback(async () => {
    if (!account || net.id !== 143) return;
    const my = ++seq.current; setBusy(true);
    try {
      const keys = agentKeys();
      const price = await monUsdcPrice(pub, account).catch(() => null);
      const r = await readRates(pub, price && price.usdcPerMon > 0n ? price : null);
      const [fv, pr] = await Promise.all([
        // Owned vaults: vaultsOf on every factory (always live). Vaults it is only the agent of: from the activity index
        // (its executor column), so no executor() read per vault in every factory.
        Promise.all([findVaults(pub, { account, scanAgents: false, cache: idxCache, includeShowcase: false }), loadIndex(BASE).catch(() => null)]).then(([own, idx]) => {
          const agents = new Set([account.toLowerCase(), ...[...keys.keys()].map(k => k.toLowerCase())]);
          const seen = new Set(own.map(v => v.vault.toLowerCase()));
          for (const v of idx?.vaults ?? []) {
            const f = FACTORIES.find(x => x.address.toLowerCase() === Object.entries(idx!.factories).find(([, l]) => l === v.f)?.[0]);
            if (!f || f.showcase || seen.has(v.a.toLowerCase()) || !agents.has(v.e.toLowerCase())) continue;
            seen.add(v.a.toLowerCase()); own.push({ vault: getAddress(v.a), factory: f, relations: [v.e.toLowerCase() === account.toLowerCase() ? 'agent' : 'browser-key'] });
          }
          return own;
        }),
        findPools(pub, account, { netId: net.id, kv, extra: savedPools(net, account) }),
      ]);
      kv.set(discoveredPoolsKey(net.id, account), JSON.stringify(pr.pools));
      // Phase 1 (chain only): known tokens (WMON, USDC, sMON, aprMON, gMON) are always read, so the total is right without
      // the public index. Phase 2 (background, throttled): Blockscout lists any other ERC-20 a vault received.
      const cached = fv.map(f => tokCache.get(f.vault.toLowerCase())?.v ?? null);
      const [vs, w] = await Promise.all([
        Promise.all(fv.map((f, i) => readVaultPositions(pub, f, { rates: r, pools: pr.pools, discovered: cached[i] }).catch(() => null))),
        readWalletPositions(pub, account, { rates: r, pools: pr.pools }),
      ]);
      if (my !== seq.current) return;
      const list = vs.filter((x): x is VaultPos => !!x);
      setRates(r); setD({ vaults: list, wallet: w, poolsOk: pr.ok }); setErr(null);
      void enrich(fv, r, pr.pools, my);
    } catch (e) { if (my === seq.current) setErr(sendFault(e).text); } finally { if (my === seq.current) setBusy(false); }
  }, [net, pub, account]);
  const ref = useRef(load); ref.current = load;
  useEffect(() => { setD(null); if (!account) return; void ref.current(); return everyVisible(() => ref.current(), REFRESH_MS); }, [account, net.id]);
  return { d, rates, busy, err, reload: load };
}

/** Sends a list of close/withdraw steps in order (agent-key steps sign in this browser, the rest with the wallet). */
async function runSteps(p: HoldProps, steps: Step[], executorOf: (v: Address | null) => Address | undefined): Promise<Hex[]> {
  const hs: Hex[] = []; const keys = agentKeys();
  for (const s of steps) {
    if (s.signer === 'agent-key') {
      const ex = executorOf(s.vault); const key = ex && keys.get(ex.toLowerCase());
      if (!key) throw new Error('The agent key for this vault is no longer in this browser.');
      hs.push((await p.sendAgent(key, { to: s.to, data: s.data })).transactionHash);
    } else {
      if (!p.wallet || !(await p.need())) throw new Error('Connect your wallet first.');
      hs.push((await p.send(p.wallet, { to: s.to, data: s.data })).transactionHash);
    }
  }
  return hs;
}

function Withdraw({ testid, build, onDone, p, executorOf }: { testid: string; build: (pct: number) => { steps: Step[]; note: string }; onDone: () => void; p: HoldProps; executorOf: (v: Address | null) => Address | undefined }) {
  const [pct, setPct] = useState(100);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const plan = build(pct);
  const go = async () => {
    setBusy(true); setMsg(null);
    try { const hs = await runSteps(p, plan.steps, executorOf); setMsg({ ok: true, text: `Done (${hs.length} transaction${hs.length === 1 ? '' : 's'}). ${plan.note}` }); p.refreshBal(); onDone(); }
    catch (e) { setMsg({ ok: false, text: sendFault(e).text }); } finally { setBusy(false); }
  };
  return (
    <div className="grid gap-2 rounded-2xl border border-white/10 p-3" data-testid={`${testid}-withdraw`}>
      <div className="flex items-center justify-between text-sm"><span className="text-zinc-300">Withdraw</span><span className="font-mono text-zinc-50">{pct}%</span></div>
      <Slider label="Withdraw percentage" testid={`${testid}-slider`} min={25} max={100} step={25} value={pct} onChange={setPct} />
      <div className="grid grid-cols-3 gap-2">{[25, 50, 100].map(x => <Btn key={x} kind={pct === x ? 'soft' : 'ghost'} className="min-h-11" onClick={() => setPct(x)} data-testid={`${testid}-pct-${x}`}>{x}%</Btn>)}</div>
      <p className="text-[11px] text-zinc-400" data-testid={`${testid}-note`}>{plan.note}</p>
      <Btn kind="pri" className="min-h-12" disabled={busy || !plan.steps.length} onClick={go} data-testid={`${testid}-go`}>{busy ? 'Working…' : `Withdraw ${pct}%`}</Btn>
      {msg && <p className={`break-words rounded-2xl border p-3 text-xs ${msg.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100' : 'border-red-500/40 bg-red-500/10 text-red-100'}`} data-testid={msg.ok ? 'withdraw-ok' : 'withdraw-error'}>{msg.text}</p>}
    </div>
  );
}

function Row({ title, sub, value, testid, children, open, onToggle, addr, net }: { title: string; sub?: string; value: string; testid: string; children?: React.ReactNode; open: boolean; onToggle: () => void; addr?: string; net: Net }) {
  return (
    <div className="border-t border-white/5 first:border-0" data-testid={testid} data-address={addr}>
      <button className="flex min-h-14 w-full items-center gap-2 py-2 text-left" onClick={onToggle} aria-expanded={open}>
        <span className="min-w-0 flex-1"><span className="block truncate text-sm text-zinc-100">{title}</span>{sub && <span className="block truncate text-[11px] text-zinc-500">{sub}</span>}</span>
        <span className="font-mono text-sm tabular-nums text-zinc-50" data-testid="row-value">{value}</span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-zinc-500 transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="grid gap-2 pb-3">{addr && <a className="font-mono text-xs text-violet-300" href={`${net.exp}/address/${addr}`} target="_blank" rel="noreferrer">{short(addr)} ↗</a>}{children}</div>}
    </div>
  );
}

const vaultSub = (v: VaultPos) => [v.native > 0n ? fmt(v.native) : '', ...v.tokens.map(t => `${(Number(t.amount) / 10 ** t.decimals).toLocaleString('en-GB', { maximumFractionDigits: 4 })} ${t.sym}`), v.pools.length ? `${v.pools.length} pool position(s)` : '', v.aprRequests.length ? `${v.aprRequests.length} aPriori request(s)` : ''].filter(Boolean).join(' · ');

/** The on-chain holdings list in My money: wallet (aprMON, queued requests, pool shares, staked tokens), then vaults. */
export function Holdings({ p, d, rates, hide, reload, aprNote }: { p: HoldProps; d: Discovered; rates: Rates; hide: Set<string>; reload: () => void; aprNote?: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const s = summarize(d, p.account, rates);
  const w = d.wallet;
  const keys = agentKeys();
  const access = (v: VaultPos): AgentAccess => (keys.has(v.executor.toLowerCase()) ? 'key' : v.executor.toLowerCase() === p.account.toLowerCase() ? 'wallet' : null);
  const exOf = (a: Address | null) => d.vaults.find(v => a && v.vault.toLowerCase() === a.toLowerCase())?.executor;
  const tog = (k: string) => setOpen(o => (o === k ? null : k));
  const vaults = s.nonEmpty.filter(v => !hide.has(v.vault.toLowerCase())).sort((a, b) => (b.navMon > a.navMon ? 1 : b.navMon < a.navMon ? -1 : 0));
  const pools = (w?.pools ?? []).filter(x => !hide.has(x.pool.toLowerCase()));
  const shown = all ? vaults : vaults.slice(0, 6);
  const queued = w?.aprRequests.filter(q => !q.claimable) ?? [];
  const claimable = w?.aprRequests.filter(q => q.claimable) ?? [];
  const hasWallet = !!w && (w.aprMon > 0n || w.aprRequests.length > 0 || pools.length > 0 || (w.tokens?.length ?? 0) > 0);
  return (
    <>
      {hasWallet && w && <Card data-testid="hold-wallet">
        <div className="mb-1 text-[11px] uppercase tracking-wider text-zinc-500">In your wallet</div>
        {(w.aprMon > 0n || w.aprRequests.length > 0) && <Row net={p.net} testid="hold-aprmon" title="aprMON (aPriori staking)" sub={`${(Number(w.aprMon) / 1e18).toLocaleString('en-GB', { maximumFractionDigits: 4 })} aprMON${queued.length ? ` · ${queued.length} withdrawal(s) queued` : ''}${claimable.length ? ` · ${claimable.length} ready to claim` : ''}${aprNote ? ` · ${aprNote}` : ''}`} value={fmt((w.aprMonValue ?? 0n) + w.aprRequests.reduce((a, q) => a + q.assets, 0n))} open={open === 'apr'} onToggle={() => tog('apr')}>
          {queued.length > 0 && <p className="text-xs text-amber-200" data-testid="hold-queued">{queued.length} withdrawal(s) queued at aPriori ({fmt(queued.reduce((a, q) => a + q.assets, 0n))}). Claim appears here when ready (about 12–18 hours).</p>}
          <Withdraw testid="hold-aprmon" p={p} executorOf={exOf} onDone={reload} build={pct => aprWithdrawSteps(w, p.account, pct)} />
        </Row>}
        {pools.map(x => <Row key={`${x.pool}:${x.tranche ?? ''}`} net={p.net} testid="hold-pool" addr={x.pool} title={`${x.kind === 'clip' ? 'Clip' : x.kind === 'spread' ? 'Spread' : 'Prime'} pool${x.kind === 'prime' ? (x.tranche === 0 ? ' (senior)' : ' (junior)') : ''}`} sub="Your pool shares · comes back as MON in one signature" value={fmt(x.assets)} open={open === x.pool} onToggle={() => tog(x.pool)}>
          <Withdraw testid="hold-pool" p={p} executorOf={exOf} onDone={reload} build={pct => ({ steps: [poolWithdrawStep(x, p.account, pct)], note: `${pct}% comes back to your wallet as MON, one signature.` })} />
        </Row>)}
        {(w.tokens ?? []).map(t => <Row key={t.address} net={p.net} testid="hold-token" title={`${t.sym} in your wallet`} sub={t.note} value={t.monValue == null ? 'unknown value' : fmt(t.monValue)} open={false} onToggle={() => {}} />)}
      </Card>}

      {vaults.length > 0 && <Card data-testid="hold-vaults">
        <div className="mb-1 flex items-center text-[11px] uppercase tracking-wider text-zinc-500"><span className="flex-1">Your vaults ({vaults.length})</span><span className="font-mono normal-case">{fmt(vaults.reduce((a, v) => a + v.navMon, 0n))}</span></div>
        {shown.map(v => <Row key={v.vault} net={p.net} testid="hold-vault" addr={v.vault} title={`${v.factory.label} vault`} sub={vaultSub(v)} value={fmt(v.navMon)} open={open === v.vault} onToggle={() => tog(v.vault)}>
          {v.unknown > 0 && <p className="text-[11px] text-zinc-500">{v.unknown} item(s) here have no live price and are left out of the total.</p>}
          <Withdraw testid="hold-vault" p={p} executorOf={exOf} onDone={reload} build={pct => vaultWithdrawSteps(v, p.account, pct, access(v))} />
        </Row>)}
        {vaults.length > shown.length && <Btn kind="ghost" className="mt-1 w-full" onClick={() => setAll(true)} data-testid="hold-more">Show all {vaults.length} vaults</Btn>}
      </Card>}

      {(s.empty.length > 0 || s.agentOnly.length > 0) && <Card className="grid gap-1 text-xs text-zinc-400" data-testid="hold-other">
        {s.empty.length > 0 && <p data-testid="hold-empty">{s.empty.length} more vault(s) you own are empty (0 MON).</p>}
        {s.agentOnly.length > 0 && <p data-testid="hold-agent">You are the agent of {s.agentOnly.length} vault(s) owned by other wallets ({fmt(s.agentOnly.reduce((a, v) => a + v.navMon, 0n))}). That money is theirs, so it is not in your total and only their owner can withdraw it.</p>}
      </Card>}
      {!d.poolsOk && <p className="text-[11px] text-amber-200" data-testid="hold-partial">The public transaction index (Blockscout) did not answer, so pools you opened directly may be missing. Retrying in the background.</p>}
      {s.unknown > 0 && <p className="text-[11px] text-zinc-500"><Pill>{s.unknown}</Pill> item(s) without a live price are left out of the total.</p>}
    </>
  );
}
