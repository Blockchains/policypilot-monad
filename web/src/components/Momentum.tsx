'use client';
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatEther, formatUnits, parseEther, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { AlertTriangle, ArrowLeft, Check, ChevronRight, Loader2, Pause, Play, RefreshCw, TrendingUp, X } from 'lucide-react';
import { Btn, Card, Pill, Sheet } from './ui';
import { AUTO_COPY, AutoCard, AutoFields, defaultAutoExtra, toKeeperSettings, useKeeper, LABEL, type AutoExtra } from './MomentumAuto';
import { KEEPER, optInCall, revokeCall } from '@/lib/momentumKeeper';
import { everyVisible } from '@/lib/rpcLimit';
import { sendFault, type Net } from '@/lib/vault';
import {
  ASSETS, COPY, ENABLED, ENTRY_LIMITS, EXITS_V1, RULES_V1, V4_FACTORY, assetBy, completed, encodeRid, entryCall, entryGates, evaluate, evaluateExits, exitCall, minEconomical, result, size, trendBroken, vaultCallAbi,
  type Asset, type Candle, type Check as RuleCheck, type EntryQuote, type Position, type Trigger,
} from '@/lib/momentumCore';
import {
  GAS_UNITS, createVaultData, defaultSettings, findVaults, gasPrice, loadCandles, loadJson, loadSettings, monUsd, positionsOf, quoteEntry, quoteSell, readLedger, readVaultState, rememberVault, rememberedVault,
  saveSettings, tokenBalance, vaultTx, wmonUnwrapCall, type LedgerSrc, type MVault, type Settings,
} from '@/lib/momentumData';

type Receipt = { transactionHash: Hex; blockNumber: bigint; status: string };
export type MomentumProps = {
  net: Net; pub: PublicClient; account: Address | null; wallet: WalletClient | null; bal: bigint | null;
  need: () => Promise<boolean>;
  send: (w: WalletClient, req: { to?: Address; data?: Hex; value?: bigint; gas?: bigint }, onHash?: (h: Hex) => void) => Promise<Receipt>;
  toast: (t: React.ReactNode, k?: 'ok' | 'bad' | 'info') => void; openConnect: () => void; refreshBal: () => void;
};
const m = (x: number | null | undefined, d = 4) => x == null || !Number.isFinite(x) ? '–' : `${x.toLocaleString('en-GB', { maximumFractionDigits: d })} MON`;
const sgn = (x: number | null | undefined, d = 4) => x == null || !Number.isFinite(x) ? '–' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toLocaleString('en-GB', { maximumFractionDigits: d })} MON`;
const usd = (x: number | null | undefined) => x == null || !Number.isFinite(x) ? '–' : `${x >= 0 ? '+' : '−'}$${Math.abs(x).toFixed(2)}`;
const pc = (x: number | null | undefined, d = 2) => x == null || !Number.isFinite(x) ? '–' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}%`;
const ago = (t: number) => { const s = Math.max(0, Math.floor(Date.now() / 1000) - t); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
const Alpha = () => <p className="text-center text-xs text-amber-200" data-testid="alpha">{COPY.alpha}.</p>;

// ================================================================= public data hook (no RPC)
type Pub = { status: any; decisions: any[]; paper: any; backtest: any; candles: Record<string, Candle[]> };
function usePublic(): Pub | null {
  const [d, setD] = useState<Pub | null>(null);
  useEffect(() => {
    let on = true;
    const load = async () => {
      const [status, decisions, paper, backtest] = await Promise.all(['status.json', 'decisions.json', 'paper.json', 'backtest.json'].map(f => loadJson(f)));
      const ids = [...ASSETS.map(a => `${a.symbol}-MON`), 'MON-USD'];
      const cs = await Promise.all(ids.map(id => loadCandles(id, 2)));
      if (on) setD({ status, decisions: decisions ?? [], paper, backtest, candles: Object.fromEntries(ids.map((id, i) => [id, cs[i]])) });
    };
    void load(); const stop = everyVisible(load, 120_000);
    return () => { on = false; stop(); };
  }, []);
  return d;
}

// ================================================================= the Momentum page
export default function Momentum(p: MomentumProps & { goSetup: () => void }) {
  const d = usePublic();
  const [explore, setExplore] = useState(false);
  const [vault, setVault] = useState<Address | null>(null);
  const [vaults, setVaults] = useState<Address[] | null>(null);
  const live = p.account && p.net.id === 143;
  useEffect(() => {
    if (!live) { setVaults(null); setVault(null); return; }
    let on = true;
    findVaults(p.pub, p.account!).then(vs => {
      if (!on) return; setVaults(vs);
      const rem = rememberedVault(p.net.id, p.account!);
      setVault((rem && vs.find(v => v.toLowerCase() === rem.vault.toLowerCase())) || vs[vs.length - 1] || null);
    }).catch(() => on && setVaults([]));
    return () => { on = false; };
  }, [p.account, p.net.id, live]); // eslint-disable-line
  return (
    <div className="mx-auto grid w-full max-w-2xl gap-4" data-testid="momentum">
      <StrategyCard onExplore={() => setExplore(x => !x)} explore={explore} onSetup={p.goSetup} hasVault={!!vault} />
      {live && vault && <Dashboard {...p} vault={vault} vaults={vaults ?? []} setVault={v => { setVault(v); rememberVault(p.net.id, p.account!, v, 0); }} pubd={d} />}
      {!p.account && <Card className="flex flex-wrap items-center gap-3"><span className="min-w-0 flex-1 text-sm text-zinc-300">Look around freely. Connect when you want to set limits and review entries.</span><Btn kind="pri" onClick={p.openConnect} data-testid="m-connect">Connect wallet</Btn></Card>}
      {p.account && p.net.id !== 143 && <Card className="text-sm text-amber-100">Momentum runs on Monad mainnet only. Switch the network at the top.</Card>}
      <Safe title="Watchlist"><Watchlist d={d} /></Safe>
      {(explore || !vault) && <>
        <Safe title="Paper positions"><Paper d={d} /></Safe>
        <Safe title="Recent decisions"><Decisions rows={d?.decisions ?? []} title="Recent decisions (rules v1, public job)" /></Safe>
        <Safe title="Research report"><Research bt={d?.backtest} /></Safe>
        <Roadmap />
      </>}
      {vault && !explore && <button className="min-h-11 text-sm text-violet-300" onClick={() => setExplore(true)} data-testid="m-explore-more">Paper positions, research and roadmap →</button>}
      <Alpha />
    </div>
  );
}

function StrategyCard({ onExplore, explore, onSetup, hasVault }: { onExplore: () => void; explore: boolean; onSetup: () => void; hasVault: boolean }) {
  return (
    <Card className="grid gap-3" data-testid="m-card">
      <div className="flex items-center gap-2"><TrendingUp className="h-5 w-5 text-monad" /><h1 className="text-xl font-semibold text-zinc-50">{COPY.name}</h1><Pill tone="warn">Alpha</Pill></div>
      <p className="text-base text-zinc-100">{COPY.tagline}</p>
      <p className="text-sm text-zinc-300">{COPY.what}</p>
      <div className="grid gap-2 text-sm sm:grid-cols-2">
        <div className="rounded-2xl bg-black/30 p-3"><div className="text-xs uppercase tracking-wider text-zinc-400">Where a return could come from</div><p className="mt-1 text-zinc-200">Only from the asset rising against MON while you hold it. No yield, no lending, no leverage.</p></div>
        <div className="rounded-2xl bg-black/30 p-3"><div className="text-xs uppercase tracking-wider text-zinc-400">Risks</div><p className="mt-1 text-zinc-200">Prices can gap past your loss-exit trigger; swaps and gas cost MON every round trip; wrapped assets depend on their bridge and issuer; the vault contract is unaudited.</p></div>
      </div>
      <div className="flex flex-wrap gap-2">
        {!hasVault && <Btn kind="pri" onClick={onSetup} data-testid="m-setup">Set up Momentum</Btn>}
        <Btn kind="ghost" onClick={onExplore} data-testid="m-explore">{explore ? 'Hide details' : 'Explore'}</Btn>
      </div>
      <p className="text-xs text-zinc-500">{COPY.hypothesis}</p>
    </Card>
  );
}

// ================================================================= R1: watchlist, relative strength, checks, liquidity
function RSChart({ series, hours }: { series: { label: string; cs: Candle[]; color: string }[]; hours: number }) {
  const now = Math.floor(Date.now() / 1000);
  const lines = series.map(s => { const c = completed(s.cs, now).slice(-hours); const b = c[0]?.[4]; return { ...s, pts: b ? c.map(x => (x[4] / b - 1) * 100) : [] }; }).filter(s => s.pts.length > 1);
  if (!lines.length) return <p className="text-sm text-zinc-500" data-testid="rs-empty">Not enough candles yet.</p>;
  const all = lines.flatMap(l => l.pts).concat(0); const lo = Math.min(...all), hi = Math.max(...all); const span = hi - lo || 1;
  const W = 320, H = 120; const y = (v: number) => H - ((v - lo) / span) * H;
  return (
    <div data-testid="rs-chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-32 w-full" preserveAspectRatio="none" role="img" aria-label="Relative strength against MON">
        <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="#71717a" strokeDasharray="3 3" strokeWidth={1} />
        {lines.map(l => <polyline key={l.label} fill="none" stroke={l.color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" points={l.pts.map((v, i) => `${(i / (l.pts.length - 1)) * W},${y(v)}`).join(' ')} />)}
      </svg>
      <div className="mt-1 flex flex-wrap gap-3 text-xs">{lines.map(l => <span key={l.label} style={{ color: l.color }}>{l.label} {pc(l.pts[l.pts.length - 1])}</span>)}<span className="text-zinc-500">dashed = holding MON</span></div>
    </div>
  );
}
const COLORS: Record<string, string> = { WETH: '#a78bfa', WBTC: '#f59e0b', cbBTC: '#38bdf8', SOL: '#34d399' };

function Watchlist({ d }: { d: Pub | null }) {
  const [hours, setHours] = useState(168);
  const [open, setOpen] = useState<string | null>(null);
  const st = d?.status;
  return (
    <Card className="grid gap-3" data-testid="m-watchlist">
      <div className="flex items-center gap-2"><h2 className="min-w-0 flex-1 text-lg font-semibold text-zinc-50">Watchlist: strength against MON</h2>
        {[[168, '7d'], [720, '30d']].map(([h, l]) => <button key={l} onClick={() => setHours(h as number)} className={`min-h-9 rounded-xl px-2 text-xs ${hours === h ? 'bg-white/10 text-white' : 'text-zinc-400'}`} data-testid={`rs-${l}`}>{l}</button>)}</div>
      {d ? <RSChart hours={hours} series={ASSETS.map(a => ({ label: a.symbol, cs: d.candles[`${a.symbol}-MON`] ?? [], color: COLORS[a.symbol] }))} /> : <p className="text-sm text-zinc-500">Loading public data…</p>}
      {st && <p className="text-xs text-zinc-500" data-testid="m-fresh">Data from the public GitHub job, updated {ago(st.updated)} at block {st.block}. {st.dataFresh ? '' : 'Data is stale: no entries until it is fresh.'} Hourly candles from on-chain swaps; sampled every 5 minutes.</p>}
      <div className="grid gap-2">
        {ASSETS.map(a => {
          const sig = st?.signals?.[a.symbol]; const smp = latestSample(d, a.symbol);
          const passed = sig?.checks?.filter((c: RuleCheck) => c.pass === true).length ?? 0; const total = sig?.checks?.length ?? 9;
          return (
            <div key={a.symbol} className="rounded-2xl border border-white/10 bg-black/20 p-3" data-testid={`m-asset-${a.symbol}`}>
              <button className="flex w-full min-w-0 items-center gap-2 text-left" onClick={() => setOpen(open === a.symbol ? null : a.symbol)}>
                <span className="font-semibold text-zinc-100">{a.symbol}</span>
                <Pill tone={a.status === 'enabled' ? 'ok' : 'zinc'}>{a.status === 'enabled' ? 'Enabled' : 'Watchlist'}</Pill>
                {sig && <Pill tone={sig.pass ? 'monad' : 'zinc'}>{sig.pass ? 'Signal: all checks pass' : `${passed}/${total} checks`}</Pill>}
                <span className="ml-auto text-xs text-zinc-400">{a.exposure}</span><ChevronRight className={`h-4 w-4 shrink-0 text-zinc-500 transition ${open === a.symbol ? 'rotate-90' : ''}`} />
              </button>
              {smp && <p className="mt-1 text-xs text-zinc-400" data-testid="m-liq">Round trip {smp.quotes.map((q: any) => `${q.rtPct == null ? 'n/a' : q.rtPct.toFixed(2) + '%'} at ${q.mon} MON`).join(' · ')}{smp.refDevPct != null ? ` · price vs USDC cross-rate ${pc(smp.refDevPct)}` : ' · no USDC reference'}</p>}
              {open === a.symbol && <div className="mt-2 grid gap-2">
                <p className="text-xs text-zinc-300">{a.why}</p>
                {sig ? <ChecksList checks={sig.checks} note={`Rules ${sig.ruleVersion} at the illustrative ${sig.sizeMon} MON size, evaluated ${ago(sig.at)}.`} /> : <p className="text-xs text-zinc-500">No evaluation yet.</p>}
              </div>}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
function latestSample(d: Pub | null, sym: string) { const s = d?.status; if (!s) return null; return (d as any).samplesLast?.[sym] ?? (s.signals?.[sym] ? sampleFromChecks(s.signals[sym]) : null); }
function sampleFromChecks(sig: any) { const liq = sig.checks.find((c: RuleCheck) => c.id === 'liquidity'); const w = sig.checks.find((c: RuleCheck) => c.id === 'wrapper'); const rt = liq ? parseFloat(liq.value) : NaN; const dv = w ? parseFloat(w.value) : NaN; return { quotes: [{ mon: sig.sizeMon, rtPct: Number.isFinite(rt) ? rt : null }], refDevPct: Number.isFinite(dv) ? dv : null }; }

function ChecksList({ checks, note }: { checks: RuleCheck[]; note?: string }) {
  return (
    <div className="grid gap-1" data-testid="m-checks">
      {checks.map(c => (
        <div key={c.id} className="flex min-w-0 items-start gap-2 text-xs" data-testid="m-check" data-pass={String(c.pass)}>
          <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full ${c.pass ? 'bg-emerald-500/80' : c.pass === false ? 'bg-red-500/70' : 'bg-zinc-600'}`}>{c.pass ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}</span>
          <span className="min-w-0 flex-1"><span className="text-zinc-100">{c.label}</span>: <span className="text-zinc-300">{c.value}</span> <span className="text-zinc-500">(needs {c.need})</span><span className="block text-zinc-500">{c.why}</span></span>
        </div>
      ))}
      {note && <p className="text-[11px] text-zinc-500">{note} {COPY.hypothesis}</p>}
    </div>
  );
}

function Paper({ d }: { d: Pub | null }) {
  const p = d?.paper; if (!p) return null;
  return (
    <Card className="grid gap-2" data-testid="m-paper">
      <h2 className="text-lg font-semibold text-zinc-50">Paper positions</h2>
      <p className="text-xs text-zinc-400">{p.note} Tracked by the GitHub job, so they do not depend on this browser.</p>
      {!p.open.length && !p.closed.length && <p className="text-sm text-zinc-400" data-testid="m-paper-none">None yet. No asset has passed every v1 check since tracking started; that is a normal outcome.</p>}
      {[...p.open, ...p.closed.slice(-10).reverse()].map((x: any) => (
        <div key={x.id} className="flex min-w-0 items-center gap-2 border-t border-white/5 pt-2 text-sm">
          <span className="font-medium text-zinc-100">{x.asset}</span><Pill tone={x.closedAt ? 'zinc' : 'monad'}>{x.closedAt ? `closed: ${x.reason}` : 'open'}</Pill>
          <span className="ml-auto font-mono text-xs text-zinc-300">{x.closedAt ? `${sgn(x.netMon)} (${pc(x.netPct)})` : `exec ${m(x.execMon)}`}</span>
        </div>
      ))}
    </Card>
  );
}

function Decisions({ rows, title }: { rows: any[]; title: string }) {
  const [n, setN] = useState(8);
  const xs = [...rows].reverse().slice(0, n);
  return (
    <Card className="grid gap-1" data-testid="m-decisions">
      <h2 className="text-lg font-semibold text-zinc-50">{title}</h2>
      {!xs.length && <p className="text-sm text-zinc-400">No decisions yet.</p>}
      {xs.map((r, i) => (
        <div key={i} className="flex min-w-0 items-start gap-2 border-t border-white/5 pt-1.5 text-xs">
          <Pill tone={/bought/.test(r.action) ? 'monad' : /sold|swept/.test(r.action) ? 'ok' : /failed/.test(r.action) ? 'bad' : 'zinc'}>{r.action}</Pill>
          <span className="shrink-0 font-medium text-zinc-200">{r.asset}</span>
          <span className="min-w-0 flex-1 text-zinc-400">{r.reason}{r.tx && <> <a className="font-mono text-violet-300 underline" href={`https://monadscan.com/tx/${r.tx}`} target="_blank" rel="noreferrer">{r.tx.slice(0, 10)}…</a></>}</span><span className="shrink-0 text-zinc-500">{ago(r.t)}</span>
        </div>
      ))}
      {rows.length > n && <button className="min-h-11 text-left text-xs text-violet-300" onClick={() => setN(n + 20)}>Show more</button>}
    </Card>
  );
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// A malformed public data file must never take the page down: show a plain note for that section instead.
class Safe extends Component<{ title: string; children: ReactNode }, { bad: boolean }> {
  state = { bad: false };
  static getDerivedStateFromError() { return { bad: true }; }
  componentDidCatch() { /* section hidden; nothing else to do */ }
  render() { return this.state.bad ? <Card data-testid="m-section-unavailable"><h2 className="text-lg font-semibold text-zinc-50">{this.props.title}</h2><p className="text-sm text-zinc-400">This section can't be shown right now. The rest of Momentum still works.</p></Card> : this.props.children; }
}

function Research({ bt }: { bt: any }) {
  if (!bt?.assets) return <Card data-testid="m-research"><h2 className="text-lg font-semibold text-zinc-50">Research report</h2><p className="text-sm text-zinc-400">The report appears after the job has collected enough history.</p></Card>;
  const row = (k: string, s: any) => s && <tr key={k} className="border-t border-white/5"><td className="py-1 pr-2 text-zinc-400">{k}</td><td className="pr-2">{pc(s.netMonPct)}</td><td className="pr-2">{pc(s.usdPct)}</td><td className="pr-2">{pc(-s.maxDrawdownPct)}</td><td className="pr-2">{Array.isArray(s.trades) ? s.trades.length : s.trades ?? '–'}</td><td className="pr-2">{pc(s.avgGainPct)} / {pc(s.avgLossPct)}</td><td className="pr-2">{num(s.timeInMarketPct) == null ? '–' : `${num(s.timeInMarketPct)!.toFixed(0)}%`}</td><td className="pr-2">{pc(s.benchmarks?.holdAssetPct)}</td><td>{pc(s.benchmarks?.slowTrendPct)}</td></tr>;
  return (
    <Card className="grid gap-3" data-testid="m-research">
      <h2 className="text-lg font-semibold text-zinc-50">Research report (backtest + walk-forward)</h2>
      <p className="text-xs text-zinc-400">{bt.note} Rules {bt.ruleVersion}. Benchmarks: hold MON = 0%, inactive = 0%, hold the asset, slow trend (EMA 72 h vs 168 h).</p>
      {ASSETS.map(a => { const x = bt.assets[a.symbol]; if (!x) return null; return (
        <div key={a.symbol} className="grid gap-1" data-testid={`m-bt-${a.symbol}`}>
          <div className="flex items-center gap-2"><span className="font-medium text-zinc-100">{a.symbol}</span><span className="text-xs text-zinc-500">{x.candles} hourly candles ({(num(x.days) ?? 0).toFixed(1)} days)</span></div>
          {!x.full ? <p className="text-xs text-amber-200">{x.reason || 'Not enough history yet.'}</p> : <>
            <p className="text-xs text-amber-200">{x.caution}</p>
            <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-left font-mono text-[11px] tabular-nums text-zinc-200"><thead className="text-zinc-500"><tr><th>Window</th><th>Net MON</th><th>USD</th><th>Max DD</th><th>Trades</th><th>Avg gain / loss</th><th>In market</th><th>Hold asset</th><th>Slow trend</th></tr></thead>
              <tbody>{row('Full', x.full)}{row('Train 60%', x.train)}{row('Validation 20%', x.validation)}{row('Out-of-sample 20%', x.outOfSample)}</tbody></table></div>
            <p className="text-[11px] text-zinc-500">Cost per round trip {num(x.full.costPerRoundTripPct)?.toFixed(2) ?? '–'}% (measured swaps at {x.costs?.sizeMon ?? '–'} MON + gas) · turnover {x.full.turnover} legs · failed exits: {x.full.failedExits} · concentration {num(x.full.concentrationPct) == null ? '–' : num(x.full.concentrationPct)!.toFixed(0) + '% from the largest trade'}</p>
            <p className="text-[11px] text-zinc-400">Walk-forward: {!x.walkForward ? 'not computed yet' : x.walkForward.ok ? `${x.walkForward.rows.map((r: any) => `fold ${r.fold} picked ${r.picked}: ${pc(r.oosNetPct)} (${r.trades} trades)`).join(' · ')} → out-of-sample ${pc(x.walkForward.oosNetPct)}` : x.walkForward.reason}</p>
          </>}
        </div>); })}
    </Card>
  );
}

function Roadmap() {
  return (
    <Card className="grid gap-2 text-sm" data-testid="m-roadmap">
      <h2 className="text-lg font-semibold text-zinc-50">Releases</h2>
      {[['R1 Watchlist', 'Live', 'Verified assets, relative-strength charts, liquidity checks, rule explanations, paper positions, decisions log, research report.'],
        ['R2 Assisted execution', 'Live', 'You approve every entry. Positions live in your own vault and are rebuilt from the chain. Sell 25% / 50% / Close, exit alerts in the app, both withdraw modes.'],
        ['R3 Automated exits', 'Live · alpha', 'Opt-in per vault (one signature). A GitHub Actions keeper with its own key sells back to MON into your vault on your loss-exit trigger, trailing exit, trend fade or time stop, using executable quotes; failed exits are shown here and raise an alert. Revoke with one signature.'],
        ['R4 Bounded automatic entries', 'Live · alpha', 'Opt-in per vault. Enabled ahead of the research gate (backtest under 60 days, anecdotal): the keeper buys only enabled assets when rules v1 pass, within your size, position-count and vault-share limits, after fresh-quote, cost, impact and simulation checks.']].map(([t, s, x]) => (
        <div key={t} className="border-t border-white/5 pt-2"><div className="flex items-center gap-2"><span className="font-medium text-zinc-100">{t}</span><Pill tone={s === 'Live' ? 'ok' : s.startsWith('Live') ? 'warn' : 'zinc'}>{s}</Pill></div><p className="text-xs text-zinc-400">{x}</p></div>))}
    </Card>
  );
}

// ================================================================= R2: dashboard
type Live = { st: MVault; led: LedgerSrc; pos: Position[]; exec: Record<string, number | null>; usdMon: number | null; gp: bigint; at: number; executor: Address | null };
function Dashboard(p: MomentumProps & { vault: Address; vaults: Address[]; setVault: (v: Address) => void; pubd: Pub | null }) {
  const { net, pub, vault } = p;
  const [live, setLive] = useState<Live | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [settings, setS] = useState<Settings>(() => loadSettings(net.id, vault) ?? defaultSettings(5));
  const [sheet, setSheet] = useState<null | { k: 'entry'; a: Asset; manual: boolean } | { k: 'pos'; id: string } | { k: 'withdraw' } | { k: 'add' } | { k: 'rules' }>(null);
  useEffect(() => { setS(loadSettings(net.id, vault) ?? defaultSettings(5)); }, [vault, net.id]);
  const save = (s: Settings) => { setS(s); saveSettings(net.id, vault, s); };
  const seq = useRef(0);
  const load = useCallback(async () => {
    const my = ++seq.current;
    try {
      const st = await readVaultState(pub, vault);
      const led = await readLedger(net, pub, vault, rememberedVault(net.id, p.account!)?.block || undefined);
      const pos = positionsOf(led, st);
      const exec: Record<string, number | null> = {};
      await Promise.all(pos.filter(x => x.remainingQty > 0n).map(async x => { const o = await quoteSell(pub, x.asset, x.remainingQty); exec[x.id] = o > 0n ? Number(o) / 1e18 : null; }));
      const [usdMon, gp, executor] = await Promise.all([monUsd(pub), gasPrice(pub), pub.readContract({ address: vault, abi: vaultCallAbi, functionName: 'executor' }).catch(() => null) as Promise<Address | null>]);
      if (my === seq.current) { setLive({ st, led, pos, exec, usdMon, gp, at: Date.now(), executor }); setErr(null); }
    } catch (e) { if (my === seq.current) setErr(sendFault(e).text); }
  }, [pub, vault, net]); // eslint-disable-line
  useEffect(() => { void load(); return everyVisible(() => void load(), 30_000); }, [load]);

  const exitGas = live ? Number(GAS_UNITS.exit * live.gp) / 1e18 : 0;
  const open = live?.pos.filter(x => x.remainingQty > 0n) ?? [];
  const rs = live?.pos.map(x => ({ x, r: result(x, { execMon: live.exec[x.id], exitGasMon: exitGas, usdPerMon: live.usdMon }) })) ?? [];
  const committed = live?.pos.reduce((a, x) => a + x.committedMon, 0) ?? 0;
  const realized = rs.reduce((a, { r, x }) => a + r.realizedMon - x.gasMon, 0);
  const netAll = rs.reduce((a, { r }) => a + r.netMon, 0);
  const execOpen = open.reduce((a, x) => a + (live?.exec[x.id] ?? 0), 0);
  const avail = live ? Number(live.st.mon) / 1e18 : null;
  const alerts: any[] = (p.pubd?.status?.alerts ?? []).filter((a: any) => a.vault === vault.toLowerCase() && a.triggered?.length);
  const liveTrig = open.map(x => ({ x, t: trig(x, live!, p.pubd, settings) })).filter(y => y.t.some(t => t.hit));
  const enabledSignals = ENABLED().filter(a => settings.assets.includes(a.symbol)).map(a => ({ a, sig: p.pubd?.status?.signals?.[a.symbol] }));
  const status = settings.pausedNew ? 'NEW_ENTRIES_PAUSED' : p.pubd?.status && !p.pubd.status.dataFresh ? 'DATA_UNAVAILABLE' : liveTrig.length || alerts.length ? 'EXIT_TRIGGERED' : open.some(x => x.status === 'MANUAL_ACTION_REQUIRED') ? 'MANUAL_ACTION_REQUIRED' : open.length ? (open.some(x => x.parts.length) ? 'PARTIALLY_EXITED' : 'OPEN') : enabledSignals.some(s => s.sig?.pass) ? 'CANDIDATE' : 'IDLE';
  const auto = live?.executor?.toLowerCase() === KEEPER.toLowerCase();
  const keeper = useKeeper(vault);
  const keeperRows = keeper.acts.map((r: any) => ({ t: r.t, asset: r.asset ?? '', action: `keeper: ${LABEL[r.kind] ?? r.kind}`, reason: r.why, tx: r.tx && r.tx !== 'dry-run' ? r.tx : undefined }));
  const myDecisions = [...keeperRows, ...(live?.pos ?? []).flatMap(x => [{ t: x.openedAt, asset: x.asset.symbol, action: 'bought', reason: `Entry ${m(x.committedMon)} → ${fmtQty(x.asset, x.qty)} (tx ${x.entryTx.slice(0, 10)}…)` }, ...x.parts.map(pt => ({ t: pt.t, asset: x.asset.symbol, action: 'sold', reason: `Sold ${fmtQty(x.asset, pt.qty)} for ${m(pt.monOut)} (basis out ${m(pt.basisOut)}, tx ${pt.tx.slice(0, 10)}…)` }))])].sort((a, b) => a.t - b.t);

  return (
    <>
      <Card className="grid gap-3" data-testid="m-dashboard">
        <div className="flex flex-wrap items-center gap-2"><h2 className="min-w-0 flex-1 text-lg font-semibold text-zinc-50">Your Momentum</h2><Pill tone={status === 'EXIT_TRIGGERED' || status === 'MANUAL_ACTION_REQUIRED' ? 'warn' : status === 'IDLE' ? 'zinc' : 'monad'}><span data-testid="m-status">{status}</span></Pill><Pill tone={auto ? 'warn' : 'zinc'}>{auto ? 'Automatic within limits' : 'Review each entry'}</Pill></div>
        <p className="text-xs text-zinc-500">Vault <a className="underline" href={`${net.exp}/address/${vault}`} target="_blank" rel="noreferrer">{vault.slice(0, 8)}…{vault.slice(-4)}</a> · {live?.executor == null ? 'reading the executor' : auto ? <>executor is the Momentum keeper <span className="font-mono">{KEEPER.slice(0, 8)}…</span> (you opted in; revoke below)</> : 'executor is your own wallet (no agent key)'} · rebuilt from {live ? `${live.led.fromIndex} indexed + ${live.led.fromTail} live on-chain events` : 'on-chain events'}{p.vaults.length > 1 && <> · <button className="underline" onClick={() => p.setVault(p.vaults[(p.vaults.indexOf(vault) + 1) % p.vaults.length])}>switch vault</button></>}</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="m-kpis">
          {[['Strategy equity', m(avail == null ? null : avail + execOpen)], ['Net realized', sgn(realized)], ['Available MON', m(avail)], ['Open exposure', open.length ? `${m(execOpen)} (${open.length})` : 'none'], ['Net result (MON)', sgn(netAll)], ['vs holding MON', committed ? pc((netAll / committed) * 100) : '–']].map(([k, v]) => (
            <div key={k} className="min-w-0 rounded-2xl bg-black/30 p-3"><div className="truncate font-mono text-base tabular-nums text-white">{v}</div><div className="truncate text-[11px] text-zinc-400">{k}</div></div>))}
        </div>
        <p className="text-[11px] text-zinc-500">USD estimate of the net result: {usd(live?.usdMon == null ? null : netAll * live.usdMon)} at {live?.usdMon ? `$${live.usdMon.toFixed(4)}` : '–'} per MON. Net MON = MON received − MON committed − gas you paid; pool fees are inside the quotes and are not subtracted twice.</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Btn kind="soft" onClick={() => setSheet({ k: 'add' })} data-testid="m-add">Add funds</Btn>
          <Btn kind="soft" onClick={() => setSheet({ k: 'rules' })} data-testid="m-edit">Edit rules</Btn>
          <Btn kind={settings.pausedNew ? 'pri' : 'soft'} onClick={() => save({ ...settings, pausedNew: !settings.pausedNew })} data-testid="m-pause-new">{settings.pausedNew ? <><Play className="h-4 w-4" />Resume new entries</> : <><Pause className="h-4 w-4" />Pause new entries</>}</Btn>
          <Btn kind="soft" onClick={() => setSheet({ k: 'withdraw' })} data-testid="m-withdraw">Withdraw</Btn>
        </div>
        {err && <p className="break-words rounded-2xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-100">{err}</p>}
        {!live && !err && <p className="flex items-center gap-2 text-sm text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" />Reading your vault and its on-chain history…</p>}
      </Card>
      {live && <AutoCard {...p} vault={vault} executor={live.executor} settings={settings} onChanged={() => void load()} exp={net.exp} />}

      {(liveTrig.length > 0 || alerts.length > 0) && <Card className="grid gap-2 border-amber-500/40" data-testid="m-alerts">
        <div className="flex items-center gap-2 text-amber-100"><AlertTriangle className="h-5 w-5" /><span className="font-medium">Exit alert</span></div>
        {liveTrig.map(({ x, t }) => <p key={x.id} className="text-sm text-amber-50">{x.asset.symbol}: {t.filter(z => z.hit).map(z => z.why).join(' · ')}. <button className="underline" onClick={() => setSheet({ k: 'pos', id: x.id })}>Review the exit</button></p>)}
        {!liveTrig.length && alerts.map((a: any) => <p key={a.position} className="text-sm text-amber-50">{a.asset}: {a.triggered.map((t: any) => t.why).join(' · ')} (public job, {ago(a.at)})</p>)}
        <p className="text-xs text-amber-200/80">{auto ? 'Automatic mode is on: the keeper acts on these on its next run (every 15 min). Exit prices are not guaranteed.' : 'Alerts are shown here only. Nothing sells automatically unless you turn on automatic mode, and nobody is emailed.'}</p>
      </Card>}

      <Card className="grid gap-2" data-testid="m-positions">
        <h2 className="text-lg font-semibold text-zinc-50">Open positions</h2>
        {!open.length && <p className="text-sm text-zinc-400">No open position. {settings.pausedNew ? 'New entries are paused.' : 'When an enabled asset passes every check you can review an entry below.'}</p>}
        {open.map(x => { const r = rs.find(y => y.x.id === x.id)!.r; return (
          <button key={x.id} onClick={() => setSheet({ k: 'pos', id: x.id })} className="flex min-w-0 items-center gap-2 rounded-2xl border border-white/10 bg-black/20 p-3 text-left" data-testid={`m-pos-${x.id}`}>
            <span className="font-semibold text-zinc-100">{x.asset.symbol}</span><Pill tone={x.status === 'MANUAL_ACTION_REQUIRED' ? 'warn' : 'monad'}>{x.status}</Pill>
            <span className="ml-auto text-right font-mono text-xs tabular-nums"><span className="block text-zinc-100">{sgn(r.netMon)}</span><span className="block text-zinc-500">{pc(r.vsHoldMonPct)} vs MON</span></span><ChevronRight className="h-4 w-4 text-zinc-500" />
          </button>); })}
        <div className="grid gap-2 border-t border-white/5 pt-2">
          {enabledSignals.map(({ a, sig }) => (
            <div key={a.symbol} className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 basis-56 text-zinc-300">{a.symbol}: {sig ? (sig.pass ? 'all v1 checks pass' : `no entry. Not yet passing: ${sig.checks.filter((c: RuleCheck) => c.pass !== true).map((c: RuleCheck) => c.label).join(', ')}`) : 'waiting for data'}</span>
              {auto ? <span className="text-xs text-zinc-500" data-testid={`m-auto-entry-${a.symbol}`}>The keeper handles entries</span> : <Btn kind={sig?.pass ? 'pri' : 'ghost'} disabled={settings.pausedNew} onClick={() => setSheet({ k: 'entry', a, manual: !sig?.pass })} data-testid={`m-review-${a.symbol}`}>{sig?.pass ? 'Review entry' : 'Manual entry (rules not met)'}</Btn>}
            </div>))}
        </div>
      </Card>

      <PauseControls settings={settings} save={save} onCloseStop={() => setSheet({ k: 'withdraw' })} auto={auto} onRevoke={async () => { if (!p.wallet || !p.account) return; try { if (!(await p.need())) return; const rc = await p.send(p.wallet, revokeCall(vault, p.account)); p.toast(`Keeper revoked. Tx ${rc.transactionHash}`, 'ok'); void load(); } catch (e) { p.toast(sendFault(e).text, 'bad'); } }} />
      <Decisions rows={myDecisions} title="Your decisions (from the chain)" />

      {sheet?.k === 'entry' && live && <EntrySheet {...p} a={sheet.a} manual={sheet.manual} live={live} settings={settings} pubd={p.pubd} onClose={() => setSheet(null)} onDone={() => { setSheet(null); void load(); }} />}
      {sheet?.k === 'pos' && live && (() => { const x = live.pos.find(y => y.id === sheet.id); return x ? <PositionSheet {...p} auto={auto} x={x} live={live} settings={settings} pubd={p.pubd} onClose={() => setSheet(null)} onDone={() => void load()} /> : null; })()}
      {sheet?.k === 'withdraw' && live && <WithdrawSheet {...p} auto={auto} live={live} settings={settings} save={save} onClose={() => setSheet(null)} onDone={() => void load()} />}
      {sheet?.k === 'add' && <AddSheet {...p} onClose={() => setSheet(null)} onDone={() => { setSheet(null); void load(); }} />}
      {sheet?.k === 'rules' && <Sheet open title="Edit rules" onClose={() => setSheet(null)}><RulesForm s={settings} onChange={save} /><Btn kind="pri" className="mt-3 w-full" onClick={() => setSheet(null)}>Done</Btn></Sheet>}
    </>
  );
}
const fmtQty = (a: Asset, q: bigint) => `${Number(formatUnits(q, a.decimals)).toPrecision(6)} ${a.symbol}`;
function trig(x: Position, live: Live, pubd: Pub | null, s: Settings): Trigger[] {
  const sig = pubd?.status?.signals?.[x.asset.symbol]; const dev = sig?.checks?.find((c: RuleCheck) => c.id === 'wrapper'); const devPct = dev ? parseFloat(dev.value) : NaN;
  return evaluateExits({ execMon: live.exec[x.id] ?? null, remainingBasisMon: x.remainingBasisMon, peakRatio: 1, partialDone: x.parts.length > 0, openedAt: x.openedAt, now: Math.floor(Date.now() / 1000), trendBroken: trendBroken(pubd?.candles[`${x.asset.symbol}-MON`] ?? [], Math.floor(Date.now() / 1000)), refDevPct: Number.isFinite(devPct) ? devPct : null, roundTripPct: null }, s.exits);
}

function PauseControls({ settings, save, onCloseStop, auto, onRevoke }: { settings: Settings; save: (s: Settings) => void; onCloseStop: () => void; auto: boolean; onRevoke: () => void }) {
  return (
    <Card className="grid gap-2" data-testid="m-pauses">
      <h2 className="text-lg font-semibold text-zinc-50">Pause controls</h2>
      <div className="flex min-w-0 items-center gap-2 text-sm"><span className="min-w-0 flex-1"><span className="block text-zinc-100">Pause new entries</span><span className="block text-xs text-zinc-400">{auto ? 'Manual entries are already handed to the keeper: use “Pause automatic entries” on the Automatic card (one signature). Exits keep running.' : 'No new positions. Exits, alerts and withdrawals keep working.'}</span></span><Btn kind="soft" onClick={() => save({ ...settings, pausedNew: !settings.pausedNew })} data-testid="m-pause-new-2">{settings.pausedNew ? 'Resume' : 'Pause'}</Btn></div>
      <div className={`flex min-w-0 items-center gap-2 text-sm ${auto ? '' : 'opacity-60'}`}><span className="min-w-0 flex-1"><span className="block text-zinc-100">Pause automation</span><span className="block text-xs text-zinc-400">{auto ? 'Revokes the keeper with one signature: nothing automatic happens after that and you sign everything yourself.' : 'Automatic mode is off for this vault: every entry and exit is signed by you. Turn it on from the Automatic card.'}</span></span><Btn kind={auto ? 'danger' : 'ghost'} disabled={!auto} onClick={onRevoke} data-testid="m-pause-auto">{auto ? 'Revoke keeper' : 'Off'}</Btn></div>
      <div className="flex min-w-0 items-center gap-2 text-sm"><span className="min-w-0 flex-1"><span className="block text-zinc-100">Close &amp; stop</span><span className="block text-xs text-zinc-400">Pause new entries, sell every position to MON, withdraw, and pause the vault.</span></span><Btn kind="danger" onClick={() => { save({ ...settings, pausedNew: true }); onCloseStop(); }} data-testid="m-close-stop">Close &amp; stop</Btn></div>
    </Card>
  );
}

// ================================================================= entry review (the pipeline)
function EntrySheet(p: MomentumProps & { a: Asset; manual: boolean; live: Live; settings: Settings; pubd: Pub | null; onClose: () => void; onDone: () => void }) {
  const { a, live, settings, pub, vault } = p as any;
  const open = live.pos.filter((x: Position) => x.remainingQty > 0n);
  const exposureHeld = open.some((x: Position) => x.asset.exposure === a.exposure);
  const lastExit = Math.max(0, ...live.pos.flatMap((x: Position) => x.parts.map(pt => pt.t)));
  const avail = Number(live.st.mon) / 1e18; const gasRt = Number((GAS_UNITS.entry + GAS_UNITS.exit) * live.gp) / 1e18;
  const sz = size({ allocationMon: settings.allocationMon, availableMon: avail, openExposureMon: open.reduce((s: number, x: Position) => s + x.remainingBasisMon, 0), riskPerTradePct: settings.riskPerTradePct, lossExitPct: settings.exits.lossExitPct, maxPerPositionMon: settings.maxPerPositionMon, maxTotalExposureMon: settings.maxTotalExposureMon, liquidityCapMon: 30, gasRoundTripMon: gasRt, roundTripPct: 0.11, maxTotalCostPct: ENTRY_LIMITS.maxTotalCostPct, gasReserveMon: 0, hasOpenSameExposure: exposureHeld });
  const [amt, setAmt] = useState(() => sz.notionalMon > 0 ? String(+sz.notionalMon.toFixed(4)) : '');
  const [q, setQ] = useState<(EntryQuote & { usdPerMon: number | null }) | null>(null);
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  const [ack, setAck] = useState(false); const [ackManual, setAckManual] = useState(!p.manual);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [done, setDone] = useState<string | null>(null);
  const sentRef = useRef(false);
  useEffect(() => { const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000); return () => clearInterval(t); }, []);
  let wei = 0n; try { wei = parseEther((amt || '0').replace(',', '.')); } catch { /* */ }
  const requote = async () => { setErr(null); if (wei <= 0n) return; try { setQ(await quoteEntry(pub, a, wei)); } catch (e) { setErr(sendFault(e).text); } };
  useEffect(() => { setQ(null); const t = setTimeout(() => void requote(), 400); return () => clearTimeout(t); }, [amt]); // eslint-disable-line
  // Keep the quote fresh while the review is open: an expired quote is replaced, never used.
  const stale = !!q && !busy && !done && now - q.at >= ENTRY_LIMITS.quoteTtlSec - 3;
  useEffect(() => { if (stale) void requote(); }, [stale]); // eslint-disable-line
  const g = q && q.amountIn === wei ? entryGates(a, q, now, { lastExitAt: lastExit || undefined, openPositions: open.length, maxPositions: settings.maxPositions, exposureHeld, pausedNew: settings.pausedNew, dataOk: !!p.pubd?.status?.dataFresh }) : null;
  const overAvail = wei > live.st.mon;
  const needAck = g?.gates.some(x => x.ack) ?? false;
  const pos = Math.max(0, ...live.pos.filter((x: Position) => x.asset.idx === a.idx).map((x: Position) => x.pos)) + 1;
  const go = async () => {
    if (!g || !p.wallet || sentRef.current) return; setErr(null);
    try { if (!(await p.need())) return; } catch (e) { setErr(sendFault(e).text); return; }
    // Quote expiry: re-quote right before signing if it is older than the limit, and re-check every gate.
    let qq = q!; if (Math.floor(Date.now() / 1000) - qq.at > ENTRY_LIMITS.quoteTtlSec - 5) { qq = await quoteEntry(pub, a, wei); setQ(qq); }
    const g2 = entryGates(a, qq, Math.floor(Date.now() / 1000), { lastExitAt: lastExit || undefined, openPositions: open.length, maxPositions: settings.maxPositions, exposureHeld, pausedNew: settings.pausedNew, dataOk: !!p.pubd?.status?.dataFresh });
    if (!g2.ok) { setErr('A check failed on the fresh quote. Nothing was sent.'); return; }
    const rid = { action: 1 as const, asset: a.idx, pos, step: 0, amount: wei };
    const before = await tokenBalance(pub, a.address, vault);
    sentRef.current = true; setBusy(true);
    try {
      const rc = await p.send(p.wallet, entryCall(a, vault, rid, g2.minOut)); // send() simulates first; a revert sends nothing
      const after = await tokenBalance(pub, a.address, vault);
      const got = after - before;
      if (got < g2.minOut) throw new Error(`The vault balance rose by ${fmtQty(a, got)}, less than the minimum. Check the transaction.`);
      setDone(`Bought ${fmtQty(a, got)} for ${m(Number(wei) / 1e18)}. Confirmed in the vault balance. Tx ${rc.transactionHash}`);
      p.toast('Entry confirmed in your vault.', 'ok');
    } catch (e) { sentRef.current = false; setErr(sendFault(e).text); }
    finally { setBusy(false); }
  };
  return (
    <Sheet open title={`Review entry: ${a.symbol}`} onClose={p.onClose}>
      <div className="grid gap-3" data-testid="m-entry">
        {p.manual && <p className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100" data-testid="m-manual-note">Rules v1 do not currently qualify {a.symbol}. A manual entry is recorded as outside the rules. Every safety check below still applies.</p>}
        <label className="text-sm text-zinc-300" htmlFor="m-amt">MON to commit</label>
        <input id="m-amt" data-testid="m-amount" inputMode="decimal" value={amt} onChange={e => setAmt(e.target.value)} className="min-h-12 rounded-2xl border border-white/15 bg-black/30 px-3 font-mono text-lg text-white outline-none focus:border-monad" />
        <p className="text-xs text-zinc-400" data-testid="m-sizing">Suggested size: {m(sz.notionalMon)} = your risk per trade ({settings.riskPerTradePct}% of {m(settings.allocationMon)}) ÷ the loss-exit distance ({settings.exits.lossExitPct}%){sz.caps.length ? `, capped by ${sz.caps.join(', ')}` : ''}. Below about {m(minEconomical(gasRt, 0.11, ENTRY_LIMITS.maxTotalCostPct), 2)} gas is more than {ENTRY_LIMITS.maxTotalCostPct - 0.11}% of a round trip. No leverage, no averaging down. Available in the vault: {m(avail)}.</p>
        {overAvail && <p className="text-sm text-red-200">More than the MON available in your vault. Add funds first.</p>}
        <div className="rounded-2xl bg-black/30 p-3 text-sm text-zinc-200" data-testid="m-plain">{COPY.review}</div>
        {!g && wei > 0n && <p className="flex items-center gap-2 text-sm text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" />Getting a fresh quote for exactly this size…</p>}
        {g && q && <>
          <div className="grid gap-1 rounded-2xl border border-white/10 p-3 text-sm" data-testid="m-quote">
            <Row k="You commit" v={m(Number(wei) / 1e18)} />
            <Row k={`You receive (quote)`} v={fmtQty(a, q.out)} />
            <Row k="Minimum, or the vault reverts" v={fmtQty(a, g.minOut)} />
            <Row k="Selling it straight back (exit route)" v={m(Number(q.back) / 1e18, 6)} />
            <Row k="Round trip in the pools" v={`${g.roundTripPct.toFixed(3)}%`} />
            <Row k="Gas, buy + sell (estimate, paid by your wallet)" v={m(q.gasRoundTripMon)} />
            <Row k="Quote expires in" v={`${Math.max(0, ENTRY_LIMITS.quoteTtlSec - (now - q.at))} s`} />
            <Row k="Exits set now" v={`loss-exit trigger −${settings.exits.lossExitPct}%, ${settings.exits.profitMode === 'full' ? `profit target +${settings.exits.profitTargetPct}%` : `sell ${settings.exits.partialSellPct}% at +${settings.exits.profitTargetPct}% then trail ${settings.exits.trailingPct}%`}, max ${settings.exits.maxHoldHours / 24} days, trend invalidation`} />
          </div>
          <div className="grid gap-1" data-testid="m-gates">{g.gates.map(x => <div key={x.id} className="flex items-start gap-2 text-xs" data-testid="m-gate" data-pass={String(x.pass)}><span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full ${x.pass ? 'bg-emerald-500/80' : x.ack ? 'bg-amber-500/80' : 'bg-red-500/70'}`}>{x.pass ? <Check className="h-3 w-3" /> : '!'}</span><span className="min-w-0 flex-1"><span className="text-zinc-100">{x.label}</span> <span className="text-zinc-400">{x.detail}</span></span></div>)}</div>
          {needAck && <label className="flex items-start gap-2 text-sm text-amber-100"><input type="checkbox" className="mt-1 h-5 w-5" checked={ack} onChange={e => setAck(e.target.checked)} data-testid="m-ack" />I understand gas is a large share of this small position.</label>}
          {p.manual && <label className="flex items-start gap-2 text-sm text-amber-100"><input type="checkbox" className="mt-1 h-5 w-5" checked={ackManual} onChange={e => setAckManual(e.target.checked)} data-testid="m-ack-manual" />Enter anyway, outside the v1 rules.</label>}
        </>}
        {err && <p className="break-words rounded-2xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-100" data-testid="m-entry-error">{err}</p>}
        {done ? <><p className="break-words rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-100" data-testid="m-entry-done">{done}</p><Btn kind="pri" onClick={p.onDone}>Done</Btn></> : <>
          <div className="flex gap-2"><Btn kind="ghost" onClick={requote} data-testid="m-requote"><RefreshCw className="h-4 w-4" />Re-quote</Btn>
            <Btn kind="pri" className="flex-1" data-testid="m-approve" disabled={busy || !g || !g.ok || overAvail || (needAck && !ack) || !ackManual || sentRef.current} onClick={go}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Approve entry · 1 signature</Btn></div>
          <p className="text-[11px] text-zinc-500">Simulated first: if it would fail, nothing is sent. Submitted once: the request id is fixed for this entry, so the vault refuses a duplicate. After it lands, the vault’s actual {a.symbol} balance is checked.</p>
        </>}
        <Alpha />
      </div>
    </Sheet>
  );
}
const Row = ({ k, v }: { k: string; v: string }) => <div className="flex min-w-0 items-start gap-3"><span className="min-w-0 flex-1 text-zinc-400">{k}</span><span className="shrink-0 text-right font-mono tabular-nums text-zinc-100">{v}</span></div>;

// ================================================================= position detail + manual sells
async function sellOnce(p: MomentumProps, vault: Address, x: Position, qty: bigint, pub: PublicClient): Promise<{ hash: Hex; got: number }> {
  const out = await quoteSell(pub, x.asset, qty); if (out <= 0n) throw new Error('No executable sell quote right now. Nothing was sent.');
  const minOut = (out * 9950n) / 10_000n;
  const rid = { action: 2 as const, asset: x.asset.idx, pos: x.pos, step: x.parts.length + 1, amount: qty };
  const before = await pub.getBalance({ address: vault });
  const rc = await p.send(p.wallet!, exitCall(x.asset, vault, rid, minOut, BigInt(Math.floor(Date.now() / 1000) + 300)));
  const after = await pub.getBalance({ address: vault });
  return { hash: rc.transactionHash, got: Number(after - before) / 1e18 };
}
function PositionSheet(p: MomentumProps & { auto?: boolean; x: Position; live: Live; settings: Settings; pubd: Pub | null; onClose: () => void; onDone: () => void }) {
  const { x, live } = p; const vault = (p as any).vault as Address;
  const exitGas = Number(GAS_UNITS.exit * live.gp) / 1e18;
  const r = result(x, { execMon: live.exec[x.id], exitGasMon: exitGas, usdPerMon: live.usdMon });
  const t = trig(x, live, p.pubd, p.settings);
  const [busy, setBusy] = useState<number | null>(null); const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const sentKey = useRef<string | null>(null);
  const sell = async (pctSell: number) => {
    if (!p.wallet) return; setMsg(null);
    try { if (!(await p.need())) return; } catch (e) { setMsg({ ok: false, text: sendFault(e).text }); return; }
    const qty = pctSell >= 100 ? x.remainingQty : (x.remainingQty * BigInt(pctSell)) / 100n;
    const key = `${x.id}:${x.parts.length + 1}`; if (sentKey.current === key) return; sentKey.current = key;
    setBusy(pctSell);
    try {
      if (p.auto && p.account) { const rv = await p.send(p.wallet, revokeCall(vault, p.account)); setMsg({ ok: true, text: `Keeper revoked (tx ${rv.transactionHash}); now selling…` }); } // you take control back first
      const s = await sellOnce(p, vault, x, qty, p.pub); setMsg({ ok: true, text: `Sold ${fmtQty(x.asset, qty)} for ${m(s.got)} (vault MON balance change). Tx ${s.hash}` }); p.toast('Sold. MON is back in your vault.', 'ok'); p.onDone(); }
    catch (e) { sentKey.current = null; setMsg({ ok: false, text: sendFault(e).text }); }
    finally { setBusy(null); }
  };
  return (
    <Sheet open title={`${x.asset.symbol} position`} onClose={p.onClose}>
      <div className="grid gap-3" data-testid="m-posdetail">
        <div className="grid gap-1 rounded-2xl border border-white/10 p-3 text-sm">
          <Row k="MON committed" v={m(x.committedMon)} />
          <Row k="Quantity left" v={fmtQty(x.asset, x.remainingQty)} />
          <Row k="Cost basis left (reduced after partial sells)" v={m(x.remainingBasisMon, 6)} />
          <Row k="Executable exit estimate (sell quote now)" v={m(live.exec[x.id], 6)} />
          <Row k="Received from sells so far" v={m(x.receivedMon, 6)} />
          <Row k="Gas paid (entry + sells)" v={m(x.gasMon, 5)} />
          <Row k="Net MON if closed now (after est. exit gas)" v={sgn(r.netMon, 5)} />
          <Row k="Estimated USD" v={usd(r.usd)} />
          <Row k="vs holding MON" v={pc(r.vsHoldMonPct)} />
          <Row k="Opened" v={`${new Date(x.openedAt * 1000).toLocaleString('en-GB')} · rules ${x.ruleVersion}`} />
        </div>
        <div className="grid gap-1 text-xs" data-testid="m-exitrules"><div className="text-zinc-400">Exit rules (set before entry; triggers use the executable sell quote)</div>{t.map(z => <div key={z.id} className={z.hit ? 'text-amber-200' : 'text-zinc-300'}>{z.hit ? '● ' : '○ '}{z.why}</div>)}</div>
        {x.parts.length > 0 && <div className="grid gap-1 text-xs text-zinc-400"><div>Partial history</div>{x.parts.map(pt => <div key={pt.tx}>{new Date(pt.t * 1000).toLocaleString('en-GB')}: {fmtQty(x.asset, pt.qty)} → {m(pt.monOut, 6)} (basis out {m(pt.basisOut, 6)}) <a className="underline" href={`${p.net.exp}/tx/${pt.tx}`} target="_blank" rel="noreferrer">tx</a></div>)}</div>}
        <div className="grid grid-cols-3 gap-2">
          {p.auto && <p className="basis-full text-xs text-amber-100" data-testid="m-auto-sell-note">The keeper manages exits for this vault. Selling yourself first revokes the keeper (one extra signature), then sells.</p>}
          {[25, 50, 100].map(v => <Btn key={v} kind={v === 100 ? 'danger' : 'soft'} disabled={busy != null || x.remainingQty === 0n} onClick={() => sell(v)} data-testid={`m-sell-${v}`}>{busy === v ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{v === 100 ? 'Close' : `Sell ${v}%`}</Btn>)}
        </div>
        <p className="text-[11px] text-zinc-500">Each sell gets a fresh quote for that exact quantity, accepts at most 0.5% less MON, is simulated first and sent once. Proceeds land in your vault as MON. Exit prices are not guaranteed.</p>
        {msg && <p className={`break-words rounded-2xl border p-3 text-sm ${msg.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100' : 'border-red-500/40 bg-red-500/10 text-red-100'}`} data-testid="m-sell-msg">{msg.text}</p>}
      </div>
    </Sheet>
  );
}

// ================================================================= withdraw (two modes)
function WithdrawSheet(p: MomentumProps & { auto?: boolean; live: Live; settings: Settings; save: (s: Settings) => void; onClose: () => void; onDone: () => void }) {
  const { live } = p; const vault = (p as any).vault as Address;
  const [mode, setMode] = useState<'available' | 'close'>('available');
  const [scope, setScope] = useState<'available' | 'position' | 'proportional'>('available');
  const [amt, setAmt] = useState(''); const [posId, setPosId] = useState<string>(''); const [pctW, setPctW] = useState(50);
  const [busy, setBusy] = useState(false); const [log, setLog] = useState<{ ok: boolean; text: string }[]>([]);
  const open = live.pos.filter(x => x.remainingQty > 0n);
  const exitGas = Number(GAS_UNITS.exit * live.gp) / 1e18;
  const add = (ok: boolean, text: string) => setLog(l => [...l, { ok, text }]);
  const availWei = live.st.mon;
  let wei = 0n; try { wei = parseEther((amt || '0').replace(',', '.')); } catch { /* */ }
  const expAfter = mode === 'close' ? 0 : scope === 'position' ? open.filter(x => x.id !== posId).reduce((a, x) => a + (live.exec[x.id] ?? 0), 0) : scope === 'proportional' ? open.reduce((a, x) => a + (live.exec[x.id] ?? 0), 0) * (1 - pctW / 100) : open.reduce((a, x) => a + (live.exec[x.id] ?? 0), 0);
  const run = async () => {
    if (!p.wallet || !p.account) return; setLog([]);
    try { if (!(await p.need())) return; } catch (e) { add(false, sendFault(e).text); return; }
    setBusy(true);
    try {
      if (mode === 'available' && scope === 'available') {
        if (wei <= 0n || wei > availWei) throw new Error('Enter an amount up to the available MON.');
        const rc = await p.send(p.wallet, vaultTx.withdraw(vault, p.account, wei)); add(true, `Withdrew ${m(Number(wei) / 1e18)} to your wallet. Tx ${rc.transactionHash}`);
      } else {
        if (mode === 'close') p.save({ ...p.settings, pausedNew: true });
        if (p.auto && (mode === 'close' || scope !== 'available')) { const rv = await p.send(p.wallet, revokeCall(vault, p.account)); add(true, `Keeper revoked so you can sell yourself. Tx ${rv.transactionHash}`); }
        const targets = mode === 'close' ? open.map(x => ({ x, qty: x.remainingQty })) : scope === 'position' ? open.filter(x => x.id === posId).map(x => ({ x, qty: x.remainingQty })) : open.map(x => ({ x, qty: (x.remainingQty * BigInt(pctW)) / 100n }));
        const before = await p.pub.getBalance({ address: vault });
        for (const { x, qty } of targets) { if (qty <= 0n) continue; const s = await sellOnce(p, vault, x, qty, p.pub); add(true, `Sold ${fmtQty(x.asset, qty)} → ${m(s.got, 6)}. Tx ${s.hash}`); }
        const st = await readVaultState(p.pub, vault);
        if (st.tokens.wmon > 0n) { const rc = await p.send(p.wallet, wmonUnwrapCall(vault, encodeRid({ action: 2, asset: 255, pos: 0, step: Number(st.tokens.wmon % 65535n), amount: st.tokens.wmon }), st.tokens.wmon)); add(true, `Unwrapped ${m(Number(st.tokens.wmon) / 1e18)} WMON. Tx ${rc.transactionHash}`); }
        const nowMon = await p.pub.getBalance({ address: vault });
        const take = mode === 'close' ? nowMon : scope === 'position' ? nowMon - before > 0n ? nowMon - before : 0n : (before * BigInt(pctW)) / 100n + (nowMon > before ? nowMon - before : 0n);
        if (take > 0n) { const rc = await p.send(p.wallet, vaultTx.withdraw(vault, p.account, take > nowMon ? nowMon : take)); add(true, `Withdrew ${m(Number(take) / 1e18)} to your wallet. Tx ${rc.transactionHash}`); }
        if (mode === 'close') { const rc = await p.send(p.wallet, vaultTx.setPaused(vault, true)); add(true, `Vault paused. Tx ${rc.transactionHash}`); }
        const fin = await readVaultState(p.pub, vault);
        const left = ASSETS.filter(a => (fin.tokens[a.address.toLowerCase()] ?? 0n) > 0n).map(a => fmtQty(a, fin.tokens[a.address.toLowerCase()]));
        if (mode === 'close') add(left.length === 0, left.length ? `Not complete: tokens are still in the vault (${left.join(', ')}). Sell or withdraw them as tokens.` : `Complete: no tokens left in the vault; ${m(Number(fin.mon) / 1e18, 6)} remains there.`);
      }
      p.refreshBal(); p.onDone();
    } catch (e) { add(false, sendFault(e).text); }
    finally { setBusy(false); }
  };
  return (
    <Sheet open title="Withdraw" onClose={p.onClose}>
      <div className="grid gap-3" data-testid="m-withdraw-sheet">
        <div className="grid grid-cols-2 gap-2">
          <Btn kind={mode === 'available' ? 'pri' : 'ghost'} onClick={() => setMode('available')} data-testid="m-w-available">Withdraw available MON</Btn>
          <Btn kind={mode === 'close' ? 'pri' : 'ghost'} onClick={() => setMode('close')} data-testid="m-w-close">Close positions and withdraw</Btn>
        </div>
        {mode === 'available' ? <>
          <p className="text-xs text-zinc-400">Does not touch your positions.</p>
          <div className="flex flex-wrap gap-2 text-xs">{(['available', 'position', 'proportional'] as const).map(s => <button key={s} onClick={() => setScope(s)} className={`min-h-9 rounded-xl px-3 ${scope === s ? 'bg-white/10 text-white' : 'text-zinc-400'}`} data-testid={`m-scope-${s}`}>{s === 'available' ? 'Available only' : s === 'position' ? 'A specific position' : 'Proportional'}</button>)}</div>
          {scope === 'available' && <div className="flex gap-2"><input data-testid="m-w-amount" inputMode="decimal" value={amt} onChange={e => setAmt(e.target.value)} placeholder="0.0" className="min-h-12 min-w-0 flex-1 rounded-2xl border border-white/15 bg-black/30 px-3 font-mono text-white outline-none" /><Btn kind="soft" onClick={() => setAmt(formatEther(availWei))} data-testid="m-w-max">Max {m(Number(availWei) / 1e18)}</Btn></div>}
          {scope === 'position' && <select value={posId} onChange={e => setPosId(e.target.value)} className="min-h-12 rounded-2xl border border-white/15 bg-black/30 px-3 text-white" data-testid="m-w-pos"><option value="">Choose a position</option>{open.map(x => <option key={x.id} value={x.id}>{x.asset.symbol}: {m(live.exec[x.id])}</option>)}</select>}
          {scope === 'proportional' && <label className="text-sm text-zinc-300">Sell {pctW}% of every position and withdraw {pctW}% of the available MON<input type="range" min={5} max={100} step={5} value={pctW} onChange={e => setPctW(Number(e.target.value))} className="h-11 w-full accent-[#836EF9]" /></label>}
        </> : <>
          <p className="text-xs text-zinc-400">Turns off new entries, then for each position: a fresh quote, one signature to sell to MON (unwrapped from WMON by the router), then one to withdraw all MON, then one to pause the vault.</p>
          {open.map(x => <Row key={x.id} k={`${x.asset.symbol}: sell ${fmtQty(x.asset, x.remainingQty)}`} v={`≈ ${m(live.exec[x.id], 5)} − gas ${m(exitGas, 4)}`} />)}
          <Row k="Available MON" v={m(Number(availWei) / 1e18)} />
          <Row k="Signatures" v={String(open.length + 2)} />
        </>}
        <p className="text-xs text-zinc-400" data-testid="m-exposure-after">Exposure after: {m(expAfter)}.</p>
        <Btn kind={mode === 'close' ? 'danger' : 'pri'} disabled={busy || (mode === 'available' && scope === 'position' && !posId)} onClick={run} data-testid="m-w-go">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{mode === 'close' ? 'Authorize: close and withdraw' : 'Withdraw'}</Btn>
        {log.map((l, i) => <p key={i} className={`break-words rounded-2xl border p-2 text-xs ${l.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100' : 'border-red-500/40 bg-red-500/10 text-red-100'}`} data-testid="m-w-log">{l.text}</p>)}
      </div>
    </Sheet>
  );
}

function AddSheet(p: MomentumProps & { onClose: () => void; onDone: () => void }) {
  const vault = (p as any).vault as Address; const [amt, setAmt] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    let wei = 0n; try { wei = parseEther(amt.replace(',', '.')); } catch { /* */ }
    if (wei <= 0n || !p.wallet) return; setBusy(true); setErr(null);
    try { if (!(await p.need())) return; await p.send(p.wallet, vaultTx.deposit(vault, wei)); p.toast('Added to your Momentum vault.', 'ok'); p.refreshBal(); p.onDone(); } catch (e) { setErr(sendFault(e).text); } finally { setBusy(false); }
  };
  return <Sheet open title="Add MON" onClose={p.onClose}><div className="grid gap-3"><input inputMode="decimal" value={amt} onChange={e => setAmt(e.target.value)} placeholder="0.0" className="min-h-12 rounded-2xl border border-white/15 bg-black/30 px-3 font-mono text-white outline-none" data-testid="m-add-amount" /><Btn kind="pri" disabled={busy} onClick={go}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}Add · 1 signature</Btn>{err && <p className="text-sm text-red-200">{err}</p>}<p className="text-xs text-zinc-500">MON only. It stays available until you approve an entry.</p></div></Sheet>;
}

// ================================================================= settings form (shared by setup and Edit rules)
export function RulesForm({ s, onChange }: { s: Settings; onChange: (s: Settings) => void }) {
  const num = (label: string, v: number, set: (n: number) => void, unit: string, tid: string) => (
    <label className="flex min-w-0 items-center gap-2 text-sm text-zinc-300">{label}<input data-testid={tid} inputMode="decimal" value={String(v)} onChange={e => { const n = Number(e.target.value.replace(',', '.')); if (Number.isFinite(n) && n >= 0) set(n); }} className="ml-auto min-h-11 w-24 rounded-xl border border-white/15 bg-black/30 px-2 text-right font-mono text-white outline-none" /><span className="w-10 text-xs text-zinc-500">{unit}</span></label>);
  const e = s.exits; const ex = (k: Partial<typeof e>) => onChange({ ...s, exits: { ...e, ...k } });
  return (
    <div className="grid gap-2" data-testid="m-rules">
      {num('Max per position', s.maxPerPositionMon, n => onChange({ ...s, maxPerPositionMon: n }), 'MON', 'r-maxpos')}
      {num('Max total exposure', s.maxTotalExposureMon, n => onChange({ ...s, maxTotalExposureMon: n }), 'MON', 'r-maxtot')}
      {num('Risk per trade', s.riskPerTradePct, n => onChange({ ...s, riskPerTradePct: n }), '%', 'r-risk')}
      {num('Loss-exit trigger', e.lossExitPct, n => ex({ lossExitPct: n }), '%', 'r-loss')}
      <div className="flex gap-2 text-xs">{(['partial', 'full'] as const).map(k => <button key={k} onClick={() => ex({ profitMode: k })} className={`min-h-11 flex-1 rounded-xl px-2 ${e.profitMode === k ? 'bg-white/10 text-white' : 'border border-white/10 text-zinc-400'}`} data-testid={`r-mode-${k}`}>{k === 'full' ? 'Take profit in full' : 'Partial + trailing'}</button>)}</div>
      {num('Profit target', e.profitTargetPct, n => ex({ profitTargetPct: n }), '%', 'r-target')}
      {e.profitMode === 'partial' && <>{num('Sell at target', e.partialSellPct, n => ex({ partialSellPct: Math.min(100, n) }), '%', 'r-part')}{num('Trailing distance', e.trailingPct, n => ex({ trailingPct: n }), '%', 'r-trail')}</>}
      {num('Max holding period', e.maxHoldHours / 24, n => ex({ maxHoldHours: Math.round(n * 24) }), 'days', 'r-hold')}
      {num('Daily loss threshold (stops new entries)', e.dailyLossStopPct, n => ex({ dailyLossStopPct: n }), '%', 'r-daily')}
      <p className="text-[11px] text-zinc-500">Loss-exit trigger: an alert to sell when the executable sell quote is this far below your cost. It is not a guaranteed price; fast moves can go past it.</p>
    </div>
  );
}

// ================================================================= setup wizard (rendered inside Start)
type Step = 'alloc' | 'assets' | 'exec' | 'risk' | 'review' | 'done';
export function MomentumSetup(p: MomentumProps & { onBack: () => void; goMomentum: () => void }) {
  const [stepS, setStep] = useState<Step>('alloc');
  const [amt, setAmt] = useState('');
  const [s, setS] = useState<Settings>(defaultSettings(5));
  const [mode, setMode] = useState<'review' | 'auto'>('review'); const [ax, setAx] = useState<AutoExtra>(() => defaultAutoExtra(defaultSettings(5)));
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [tx, setTx] = useState<string | null>(null); const [optTx, setOptTx] = useState<string | null>(null);
  let wei = 0n; try { wei = parseEther((amt || '0').replace(',', '.')); } catch { /* */ }
  const alloc = Number(wei) / 1e18;
  const gasCreate = 2_300_000n * 102_000_000_000n * 2n; // creation gas limit at the max fee the wallet reserves
  const enough = p.bal == null || wei + gasCreate <= p.bal;
  const order: Step[] = ['alloc', 'assets', 'exec', 'risk', 'review'];
  const next = () => setStep(order[order.indexOf(stepS) + 1]); const back = () => (stepS === 'alloc' ? p.onBack() : setStep(order[order.indexOf(stepS) - 1]));
  const ex = size({ allocationMon: alloc || 10, availableMon: alloc || 10, openExposureMon: 0, riskPerTradePct: s.riskPerTradePct, lossExitPct: s.exits.lossExitPct, maxPerPositionMon: s.maxPerPositionMon, maxTotalExposureMon: s.maxTotalExposureMon, liquidityCapMon: 30, gasRoundTripMon: 0.074, roundTripPct: 0.11, maxTotalCostPct: 2, gasReserveMon: 0, hasOpenSameExposure: false });
  const create = async () => {
    setErr(null); if (!p.account || !p.wallet) { p.openConnect(); return; }
    try { if (!(await p.need())) return; } catch (e) { setErr(sendFault(e).text); return; }
    setBusy(true);
    try {
      const rc = await p.send(p.wallet, { to: V4_FACTORY, data: createVaultData(p.account), value: wei });
      const vs = await findVaults(p.pub, p.account); const v = vs[vs.length - 1];
      if (v) { saveSettings(p.net.id, v, { ...s, allocationMon: alloc }); rememberVault(p.net.id, p.account, v, Number(rc.blockNumber)); }
      setTx(rc.transactionHash);
      if (mode === 'auto' && v) {
        try { const o = await p.send(p.wallet, optInCall(v, toKeeperSettings(s, ax))); setOptTx(o.transactionHash); }
        catch (e) { setErr(`Your vault was created, but the keeper was not authorised: ${sendFault(e).text} You can turn automatic on from the dashboard.`); }
      }
      setStep('done'); p.refreshBal();
    } catch (e) { setErr(sendFault(e).text); } finally { setBusy(false); }
  };
  return (
    <div className="grid gap-4" data-testid="m-setup-flow">
      {stepS !== 'done' && <button onClick={back} data-testid="m-back" className="flex min-h-11 w-fit items-center gap-1 rounded-xl px-2 text-sm text-zinc-400 hover:text-white"><ArrowLeft className="h-4 w-4" />Back</button>}
      {stepS !== 'done' && <ol className="flex gap-1" aria-label="Steps">{order.map((n, i) => <li key={n} className={`h-1.5 flex-1 rounded-full ${i <= order.indexOf(stepS) ? 'bg-monad' : 'bg-white/10'}`}><span className="sr-only">{n}</span></li>)}</ol>}
      {stepS === 'alloc' && <>
        <h1 className="text-2xl font-semibold text-zinc-50">{COPY.name}</h1><p className="-mt-2 text-sm text-zinc-300">{COPY.tagline} {COPY.what}</p>
        <Card className="grid gap-3"><label htmlFor="m-alloc" className="text-sm text-zinc-300">How much MON may it use?</label>
          <input id="m-alloc" data-testid="m-alloc" inputMode="decimal" placeholder="5" value={amt} onChange={e => setAmt(e.target.value)} className="min-h-14 rounded-2xl border border-white/15 bg-black/30 px-4 font-mono text-xl text-white outline-none focus:border-monad" />
          <p className="text-xs text-zinc-500">MON only. It goes into a new vault that you own; you stay the only one who can sign for it. {p.bal != null && `Wallet: ${m(Number(p.bal) / 1e18)}.`}</p>
          {!enough && <p className="text-sm text-amber-100" data-testid="m-short">Leave room for the vault-creation gas (up to about 0.5 MON is reserved by your wallet).</p>}
          <Btn kind="pri" className="min-h-14" disabled={!p.account ? false : wei <= 0n || !enough} onClick={() => (p.account ? next() : p.openConnect())} data-testid="m-next">{p.account ? 'Next' : 'Connect wallet'}</Btn></Card>
      </>}
      {stepS === 'assets' && <>
        <h1 className="text-2xl font-semibold text-zinc-50">Which exposure?</h1>
        <Card className="grid gap-2">{ASSETS.map(a => <label key={a.symbol} className={`flex min-w-0 items-start gap-3 rounded-2xl p-2 ${a.status === 'enabled' ? '' : 'opacity-60'}`}><input type="checkbox" className="mt-1 h-5 w-5" disabled={a.status !== 'enabled'} checked={s.assets.includes(a.symbol)} onChange={e => setS({ ...s, assets: e.target.checked ? [...s.assets, a.symbol] : s.assets.filter(x => x !== a.symbol) })} data-testid={`m-a-${a.symbol}`} /><span className="min-w-0 flex-1 text-sm"><span className="font-medium text-zinc-100">{a.symbol} ({a.exposure})</span> <Pill tone={a.status === 'enabled' ? 'ok' : 'zinc'}>{a.status === 'enabled' ? 'Enabled' : 'Watchlist only'}</Pill><span className="block text-xs text-zinc-400">{a.why}</span></span></label>)}
          <p className="text-xs text-zinc-500">cbBTC and WBTC count as one BTC exposure. Liquid staking tokens and unknown tokens are excluded.</p>
          <Btn kind="pri" disabled={!s.assets.length} onClick={next} data-testid="m-next">Next</Btn></Card>
      </>}
      {stepS === 'exec' && <>
        <h1 className="text-2xl font-semibold text-zinc-50">How should entries happen?</h1>
        <Card className="grid gap-2">
          <button type="button" onClick={() => setMode('review')} aria-pressed={mode === 'review'} className={`rounded-2xl border p-3 text-left ${mode === 'review' ? 'border-monad/60' : 'border-white/10'}`} data-testid="m-mode-review"><div className="flex flex-wrap items-center gap-2">{mode === 'review' && <Check className="h-4 w-4 text-monad" />}<span className="font-medium text-zinc-100">Review each entry</span><Pill tone="monad">Default</Pill></div><p className="text-xs text-zinc-400">When an asset qualifies you see the checks, a fresh quote and the costs, and you approve it with one signature. Nothing is bought without you.</p></button>
          <button type="button" onClick={() => setMode('auto')} aria-pressed={mode === 'auto'} className={`rounded-2xl border p-3 text-left ${mode === 'auto' ? 'border-monad/60' : 'border-white/10'}`} data-testid="m-mode-auto"><div className="flex flex-wrap items-center gap-2">{mode === 'auto' && <Check className="h-4 w-4 text-monad" />}<span className="font-medium text-zinc-100">Automatic within limits</span><Pill tone="warn">Alpha · ahead of research</Pill></div><p className="text-xs text-zinc-400">A keeper buys when rules v1 pass and sells on your exit rules, within the limits you sign. One extra signature authorises it; one signature revokes it.</p></button>
          {mode === 'auto' && <p className="rounded-2xl bg-amber-500/10 p-3 text-xs text-amber-100" data-testid="m-auto-honest">{AUTO_COPY.honest} {AUTO_COPY.power}</p>}
          <p className="text-xs text-zinc-400">Return asset: <b>MON</b>. Every exit sells back to MON.</p>
          <Btn kind="pri" onClick={next} data-testid="m-next">Next</Btn></Card>
      </>}
      {stepS === 'risk' && <>
        <h1 className="text-2xl font-semibold text-zinc-50">Your limits</h1>
        <Card className="grid gap-2"><RulesForm s={s} onChange={setS} />{mode === 'auto' && <><h2 className="mt-2 text-base font-semibold text-zinc-100">Keeper limits</h2><AutoFields x={ax} onChange={setAx} /></>}<Btn kind="pri" onClick={next} data-testid="m-next">Review</Btn></Card>
      </>}
      {stepS === 'review' && <>
        <h1 className="text-2xl font-semibold text-zinc-50">Check and confirm</h1>
        <Card className="grid gap-2 text-sm" data-testid="m-review">
          <p className="text-zinc-100" data-testid="m-review-sentence">{COPY.review}</p>
          <Row k="Approved amount (into your new vault)" v={m(alloc)} />
          <Row k="Assets" v={s.assets.join(', ')} />
          <Row k="Entries" v={mode === 'auto' ? `Automatic: the keeper buys when rules v1 pass (≤ ${ax.maxOpen} open, ≤ ${ax.share}% of the vault)` : 'You review and approve each one'} />
          {mode === 'auto' && <><Row k="Keeper" v={`${KEEPER.slice(0, 8)}…${KEEPER.slice(-4)} · every 15 min`} /><Row k="Time stop / exit slippage ceiling" v={`${ax.hold} h / ${ax.slip}%`} /><Row k="Auto-sweep" v={ax.sweep ? `free MON above ${m(ax.keep, 2)} to your wallet` : 'off'} /></>}
          <Row k="Max per position / total" v={`${m(s.maxPerPositionMon, 2)} / ${m(s.maxTotalExposureMon, 2)}`} />
          <Row k="Loss-exit trigger" v={`−${s.exits.lossExitPct}%`} />
          <Row k="Profit taking" v={s.exits.profitMode === 'full' ? `all at +${s.exits.profitTargetPct}%` : `${s.exits.partialSellPct}% at +${s.exits.profitTargetPct}%, trail ${s.exits.trailingPct}%`} />
          <Row k="Max holding period" v={`${s.exits.maxHoldHours / 24} days`} />
          <Row k="Daily loss threshold" v={`−${s.exits.dailyLossStopPct}% stops new entries`} />
          <Row k="Return asset" v="MON" />
          <Row k="Network gas to create the vault (estimate)" v="≈ 0.25 MON" />
          <p className="mt-1 rounded-2xl bg-black/30 p-2 text-xs text-zinc-300" data-testid="m-illustrative">Illustrative example, not a forecast: with {m(alloc || 10, 2)} and {s.riskPerTradePct}% risk per trade, a −{s.exits.lossExitPct}% loss-exit trigger gives a position of about {m(ex.notionalMon, 2)}{ex.caps.length ? ` (capped by ${ex.caps.join(', ')})` : ''}. If the trigger is hit at exactly that level, the loss is about {m(ex.notionalMon * s.exits.lossExitPct / 100, 3)} plus costs; prices can gap past it.</p>
        </Card>
        <Card className="grid gap-1 text-xs text-zinc-400">{mode === 'auto' ? <><p>• Signature 1 creates a v4 vault owned by you with your MON in it.</p><p>• Signature 2 makes the Momentum keeper its executor and records your limits on-chain. The vault contract has no spending limits: see the warning above. Revoke with one signature at any time; withdrawing free MON always works.</p></> : <><p>• One signature creates a v4 vault owned by you with your MON in it. Its executor is your own wallet: no agent key, nobody else can sign.</p><p>• The vault contract has no spending limits; you approve each trade yourself. Withdraw any time.</p></>}<p>• Simulated first: if it would fail, nothing is sent.</p></Card>
        <Alpha />
        {err && <p className="break-words rounded-2xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-100" data-testid="m-setup-error">{err}</p>}
        <Btn kind="pri" className="min-h-14 text-base" disabled={busy || wei <= 0n} onClick={create} data-testid="m-confirm">{busy && <Loader2 className="h-5 w-5 animate-spin" />}Confirm · {mode === 'auto' ? '2 signatures' : '1 signature'}</Btn>
      </>}
      {stepS === 'done' && <Card className="grid gap-3" data-testid="m-setup-done"><h1 className="text-2xl font-semibold text-zinc-50">Momentum is set up</h1><p className="text-sm text-zinc-300">Your vault holds {m(alloc)}. {optTx ? 'The keeper is authorised: it checks your vault every 15 min and only buys when rules v1 pass within your limits.' : 'Nothing is bought until an asset qualifies and you approve it.'}</p>{tx && <a className="text-xs underline" href={`${p.net.exp}/tx/${tx}`} target="_blank" rel="noreferrer">Vault creation tx ↗</a>}{optTx && <a className="text-xs underline" href={`${p.net.exp}/tx/${optTx}`} target="_blank" rel="noreferrer" data-testid="m-optin-tx">Keeper authorisation tx ↗</a>}{err && <p className="text-sm text-amber-100">{err}</p>}<Btn kind="pri" className="min-h-14" onClick={p.goMomentum} data-testid="m-go-dashboard">Open the Momentum dashboard</Btn></Card>}
    </div>
  );
}

/** Small card for My money: a hook only (the Momentum page owns the details). */
export function MomentumMoneyHook({ net, pub, account, go }: { net: Net; pub: PublicClient; account: Address | null; go: () => void }) {
  const [v, setV] = useState<{ n: number; mon: number } | null>(null);
  useEffect(() => { if (!account || net.id !== 143) return; let on = true; const go = () => findVaults(pub, account).then(async vs => { if (!vs.length || !on) return; const st = await Promise.all(vs.map(x => pub.getBalance({ address: x }))); on && setV({ n: vs.length, mon: st.reduce((a, b) => a + Number(b) / 1e18, 0) }); }).catch(() => {});
    // One-off read, deferred past My money's discovery burst so the screen stays under the RPC budget.
    const t = setTimeout(go, 25_000); return () => { on = false; clearTimeout(t); }; }, [account, net.id, pub]);
  if (!v) return null;
  return <Card className="flex min-w-0 items-center gap-3" data-testid="money-momentum"><TrendingUp className="h-5 w-5 text-monad" /><span className="min-w-0 flex-1 text-sm text-zinc-200">Momentum vault{v.n > 1 ? 's' : ''}: {m(v.mon)} available MON (positions on the Momentum page)</span><Btn kind="soft" onClick={go}>Open</Btn></Card>;
}
