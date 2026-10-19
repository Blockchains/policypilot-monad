'use client';
// Momentum v2 panels: public data only (data job, sentiment snapshot, depth, keeper status). No RPC calls from here.
import { useEffect, useState } from 'react';
import { Card, Pill } from './ui';
import { loadJson } from '@/lib/momentumData';
import { maxSensible, minSensible, type Depth } from '@/lib/momentumDepth';
import { STALE_AFTER_H, type SentSnapshot } from '@/lib/sentiment';

const ago = (t: number | null | undefined) => { if (!t) return '–'; const s = Math.max(0, Math.floor(Date.now() / 1000) - t); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
const at = (t: number | null | undefined) => t ? new Date(t * 1000).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) + ' UK' : '–';
const sg = (x: number | null | undefined, d = 2) => x == null || !Number.isFinite(x) ? '–' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}`;
const H = ({ children }: { children: React.ReactNode }) => <h2 className="text-lg font-semibold text-zinc-50">{children}</h2>;
const Src = ({ children }: { children: React.ReactNode }) => <p className="text-xs text-zinc-500">{children}</p>;

type V2Data = { depth: Depth | null; sent: SentSnapshot | null; keeper: any };
function useV2(): V2Data | null {
  const [d, setD] = useState<V2Data | null>(null);
  useEffect(() => {
    let on = true;
    const load = async () => {
      const [depth, sent, keeper] = await Promise.all([loadJson<Depth>('depth.json', 300_000), loadJson<SentSnapshot>('../sentiment-143/latest.json', 300_000), loadJson<any>('../keeper-143/status.json', 60_000)]);
      if (on) setD({ depth, sent, keeper });
    };
    load(); const t = setInterval(load, 120_000); return () => { on = false; clearInterval(t); };
  }, []);
  return d;
}

export function V2Panels({ status, backtest, vault, maxCostPct = 1 }: { status: any; backtest: any; vault?: string | null; maxCostPct?: number }) {
  const d = useV2();
  return (
    <div className="grid gap-4" data-testid="m-v2">
      <SignalV2 status={status} />
      <Sentiment s={d?.sent ?? null} />
      <DepthCard depth={d?.depth ?? null} maxCostPct={maxCostPct} />
      <KeeperHealth k={d?.keeper} vault={vault} />
      <Compare bt={backtest} />
    </div>
  );
}

function SignalV2({ status }: { status: any }) {
  const sig = status?.signals ?? {}; const syms = Object.keys(sig).filter(k => sig[k]?.v2);
  return (
    <Card className="grid gap-3" data-testid="m-v2-signal">
      <H>Signal v2: one score, every factor shown</H>
      <p className="text-sm text-zinc-300">Composite of strength vs MON (1 h, 4 h, 24 h, 7 d), trend vs chop, swap activity, X sentiment (confirming only) and an overextension penalty. An entry needs a score of at least 0.35 (0.5 in chop), positive strength on its own, and every v1 safety check. v1 stays the default engine; v2 is opt-in.</p>
      {!syms.length && <p className="text-sm text-zinc-400">No v2 signal published yet. The data job adds it on its next run.</p>}
      {syms.map(k => { const v = sig[k].v2; return (
        <details key={k} className="rounded-lg border border-zinc-800 p-3" data-testid={`m-v2-sig-${k}`}>
          <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm"><span className="font-semibold text-zinc-100">{k}</span>
            <Pill tone={v.pass ? 'ok' : 'zinc'}>{v.pass ? 'entry signal' : 'no entry'}</Pill><span className="text-zinc-300">score {sg(v.composite, 3)}</span><span className="text-zinc-500">{v.regime}</span></summary>
          <p className="mt-2 text-sm text-zinc-300">{v.why}</p>
          <table className="mt-2 w-full text-left text-xs"><thead className="text-zinc-500"><tr><th className="py-1">Factor</th><th>Value</th><th>Weight</th><th>Adds</th></tr></thead>
            <tbody>{(v.factors ?? []).map((f: any) => <tr key={f.id} className="border-t border-zinc-800 align-top"><td className="py-1 pr-2 text-zinc-200">{f.label}<div className="text-zinc-500">{f.detail}</div></td><td>{sg(f.value, 2)}</td><td>{f.weight}</td><td className={f.contribution >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{sg(f.contribution, 3)}</td></tr>)}</tbody></table>
          {v.lossExitPct != null && <p className="mt-2 text-xs text-zinc-400">Volatility (ATR, daily) {v.atrDailyPct?.toFixed(2)}%: ATR loss-exit trigger {v.lossExitPct}% and trailing exit {v.trailingPct}% (used only when you turn ATR exits on, and never wider than your own settings).</p>}
          <Src>Source: public data job, completed hourly candles from on-chain swaps · computed {at(v.at)} ({ago(v.at)})</Src>
        </details>); })}
    </Card>
  );
}

function Sentiment({ s }: { s: SentSnapshot | null }) {
  const age = s ? (Date.now() / 1000 - s.generated) / 3600 : null; const stale = age == null || age > STALE_AFTER_H;
  return (
    <Card className="grid gap-3" data-testid="m-v2-sentiment">
      <div className="flex flex-wrap items-center gap-2"><H>X sentiment (confirming only)</H>{s && <Pill tone={stale ? 'warn' : 'ok'}>{stale ? `stale, ignored (older than ${STALE_AFTER_H} h)` : 'fresh'}</Pill>}</div>
      <p className="text-sm text-zinc-300">A public word list scored on recent English posts, weighted by engagement and account quality, with bots and spam filtered out. It can nudge the v2 score by at most 0.10 and never opens a trade on its own. A keyword method misses sarcasm, and the samples are small: treat it as weak context.</p>
      {!s && <p className="text-sm text-zinc-400">No snapshot yet.</p>}
      {s && <div className="grid gap-2">{(Object.keys(s.assets) as (keyof SentSnapshot['assets'])[]).map(k => { const a = s.assets[k]; return (
        <details key={k} className="rounded-lg border border-zinc-800 p-3" data-testid={`m-v2-sent-${k}`}>
          <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm"><span className="font-semibold text-zinc-100">{k}</span><span className={a.score >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{sg(a.score, 2)}</span>
            <span className="text-zinc-400">confidence {a.confidence.toFixed(2)}</span><span className="text-zinc-500">volume {a.attention.volRatio == null ? '–' : `×${a.attention.volRatio.toFixed(2)}`} vs baseline</span></summary>
          <ul className="mt-2 grid gap-1 text-xs text-zinc-300">
            <li>Crowd {sg(a.crowd.value)} from {a.crowd.n} scored posts · curated accounts {sg(a.influencers.value)} from {a.influencers.n}</li>
            <li>Mentions: {a.attention.vol24.toLocaleString('en-GB')} in 24 h (baseline {a.attention.baseline24?.toLocaleString('en-GB') ?? '–'}), last 6 h {a.attention.accel6h == null ? '–' : `${sg(a.attention.accel6h * 100, 0)}%`} vs before</li>
            <li>Sample: kept {a.sample.kept} of {a.sample.fetched}; filtered {Object.entries(a.sample.dropped).map(([r, n]) => `${r} ${n}`).join(', ') || 'none'}</li>
            {a.sources.length > 0 && <li>Top sources: {a.sources.map((x, i) => <a key={i} href={x.url} target="_blank" rel="noreferrer" className="mr-2 text-violet-300 underline">@{x.user} ({sg(x.pol)})</a>)}</li>}
          </ul>
        </details>); })}</div>}
      {s && <Src>Source: {s.source} · {s.callsThisRun} calls · snapshot {at(s.generated)} ({ago(s.generated)}) · method: docs/sentiment.md</Src>}
    </Card>
  );
}

function DepthCard({ depth, maxCostPct }: { depth: Depth | null; maxCostPct: number }) {
  if (!depth) return <Card data-testid="m-v2-depth"><H>Depth and max sensible size</H><p className="text-sm text-zinc-400">No depth measurement yet.</p></Card>;
  const syms = Object.keys(depth.assets);
  return (
    <Card className="grid gap-3" data-testid="m-v2-depth">
      <H>Depth and max sensible size</H>
      <p className="text-sm text-zinc-300">Buy and sell-back quotes on every PancakeSwap v3 and Uniswap v3 route (direct, or two hops through USDC on one venue), split across routes where that helps. The round trip excludes gas. Sizes are never extrapolated beyond 1000 MON.</p>
      <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="text-zinc-500"><tr><th className="py-1">Size</th>{syms.map(k => <th key={k}>{k}</th>)}</tr></thead>
        <tbody>{depth.sizes.map((s, i) => <tr key={s} className="border-t border-zinc-800"><td className="py-1 text-zinc-300">{s} MON</td>{syms.map(k => { const r = depth.assets[k].rows[i]?.split?.rtPct; return <td key={k} className={r == null ? 'text-zinc-600' : r <= maxCostPct ? 'text-emerald-300' : 'text-rose-300'}>{r == null ? '–' : `${r.toFixed(2)}%`}</td>; })}</tr>)}</tbody></table></div>
      <ul className="grid gap-1 text-sm" data-testid="m-v2-maxsize">{syms.map(k => { const rr = depth.assets[k].rows.map(r => ({ mon: r.mon, rtPct: r.split?.rtPct ?? null })); const lo = minSensible(rr, maxCostPct), hi = maxSensible(rr, maxCostPct); return (
        <li key={k} className="text-zinc-200"><span className="font-semibold">{k}</span>: {hi > 0 && lo != null ? <>sensible size {lo.toLocaleString('en-GB')}–{hi.toLocaleString('en-GB')} MON at your {maxCostPct}% max cost{hi >= 1000 ? ' (largest size measured)' : ''}</> : <span className="text-rose-300">no size keeps the round trip within {maxCostPct}%</span>}{depth.assets[k].splitHelpsFrom ? <span className="text-zinc-500"> · splitting helps from {depth.assets[k].splitHelpsFrom} MON</span> : null}</li>); })}</ul>
      <Src>Source: public data job, {depth.rpcCalls ?? '–'} quote calls at block {depth.block} · measured {at(depth.generated)} ({ago(depth.generated)}) · refreshed hourly</Src>
    </Card>
  );
}

function KeeperHealth({ k, vault }: { k: any; vault?: string | null }) {
  const hb = k?.heartbeat?.at ?? k?.updated ?? null; const late = hb ? Date.now() / 1000 - hb > 30 * 60 : true;
  const vs = Object.entries<any>(k?.vaults ?? {}).filter(([a, v]) => (vault ? a.toLowerCase() === vault.toLowerCase() : v.active));
  const tw = vs.flatMap(([a, v]) => Object.entries<any>(v.twap ?? {}).filter(([, t]) => !t.done).map(([id, t]) => ({ vault: a, id, ...t })));
  const mine = vault ? k?.vaults?.[vault.toLowerCase()] : null;
  return (
    <Card className="grid gap-2" data-testid="m-v2-keeper">
      <div className="flex flex-wrap items-center gap-2"><H>Keeper health</H><Pill tone={late ? 'warn' : 'ok'}>{hb ? (late ? `late: last run ${ago(hb)}` : `ran ${ago(hb)}`) : 'no heartbeat'}</Pill></div>
      <p className="text-sm text-zinc-300">The keeper runs about every 15 minutes on GitHub Actions. If it is late, exits wait until it runs again; you can always exit or withdraw yourself.</p>
      {k && <p className="text-xs text-zinc-400">Keeper gas {k.keeperMon?.toFixed?.(3)} MON (about {k.runwayRoundTrips} round trips){k.pauses?.entries ? ' · entries paused by the operator' : ''}{k.pauses?.exits ? ' · exits paused by the operator' : ''}</p>}
      {mine?.breaker && <p className={`text-xs ${mine.breaker.tripped ? 'text-amber-200' : 'text-zinc-400'}`} data-testid="m-v2-breaker">Daily loss circuit breaker: {sg(mine.breaker.pnlMon, 4)} MON in 24 h vs limit {sg(mine.breaker.limitMon, 4)} MON{mine.breaker.tripped ? '. New entries are paused; exits keep running.' : '.'}</p>}
      <div data-testid="m-v2-twap"><p className="text-sm font-semibold text-zinc-200">Entries being filled in slices (TWAP)</p>
        {!tw.length ? <p className="text-xs text-zinc-500">None right now.</p> : tw.map(t => <p key={t.vault + t.id} className="text-xs text-zinc-300">{t.id}{vault ? '' : ` in ${t.vault.slice(0, 6)}…${t.vault.slice(-4)}`}: target {t.targetMon} MON in {t.slices} slices of {t.sliceMon} MON. Each slice gets a fresh quote and every check again; the remaining slices are cancelled if the signal is lost or an exit fires.</p>)}</div>
      <Src>Source: keeper status file (published by each run) · {at(hb)}</Src>
    </Card>
  );
}

function Compare({ bt }: { bt: any }) {
  const rows = Object.entries<any>(bt?.assets ?? {}).filter(([, a]) => a.v1v2);
  return (
    <Card className="grid gap-2" data-testid="m-v2-compare">
      <H>v1 vs v2 backtest</H>
      <p className="text-sm text-amber-100/90">Anecdotal: under 60 days of on-chain history and only a couple of trades per segment. Not evidence of an edge, and past results don’t predict future ones. v2’s weights were fixed before this comparison; sentiment has no history, so it adds nothing here.</p>
      {!rows.length ? <p className="text-sm text-zinc-400">The comparison appears after the next hourly report.</p> :
        <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="text-zinc-500"><tr><th className="py-1">Asset</th><th>Segment</th><th>v1 net (MON)</th><th>v2 net (MON)</th><th>v1 max drawdown</th><th>v2 max drawdown</th><th>Trades v1/v2</th></tr></thead>
          <tbody>{rows.flatMap(([k, a]) => ['outOfSample', 'full'].map(seg => { const r = a.v1v2[seg]; return <tr key={k + seg} className="border-t border-zinc-800"><td className="py-1 text-zinc-200">{k}</td><td className="text-zinc-400">{seg === 'outOfSample' ? 'out of sample (last 20%)' : 'full period'}</td><td>{sg(r.v1.netMonPct)}%</td><td>{sg(r.v2.netMonPct)}%</td><td>{r.v1.maxDrawdownPct}%</td><td>{r.v2.maxDrawdownPct}%</td><td>{r.v1.trades}/{r.v2.trades}</td></tr>; }))}</tbody></table></div>}
      <Src>Source: backtest.json (public data job, real hourly candles, measured costs) · {at(bt?.generated)}</Src>
    </Card>
  );
}
