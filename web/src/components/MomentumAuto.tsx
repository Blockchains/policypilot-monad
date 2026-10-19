'use client';
// MonaDefi Momentum "Automatic within limits" (R3 automated exits + R4 bounded automatic entries + optional auto-sweep).
// One owner signature authorises the keeper and records the limits on-chain; one signature revokes it.
import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import { Bot, Loader2, Pause, Play, ShieldOff } from 'lucide-react';
import { Btn, Card, Pill, Sheet } from './ui';
import { sendFault } from '@/lib/vault';
import { loadJson, type Settings } from '@/lib/momentumData';
import { KEEPER, KEEPER_CAPS, KEEPER_SCHEDULE, cleanSettings, optInCall, revokeCall, type KeeperSettings } from '@/lib/momentumKeeper';
import type { MomentumProps } from './Momentum';

export const AUTO_COPY = {
  honest: 'Automatic mode is switched on ahead of the research gate. The backtest has under 60 days of history, so its results are anecdotal; this is a live alpha experiment, not a proven strategy. Exit prices are not guaranteed and it may stay inactive for long periods.',
  power: 'The keeper becomes your vault’s executor. The vault contract has no on-chain spending limits, so the keeper key could technically move everything in this vault. Its published code only buys enabled assets within your limits, sells back to MON into your vault and sends MON only to you (the vault owner). Revoke takes one signature and gives you full manual control back.',
  sweepKeep: 'Auto-sweep sends free MON above “keep in vault” to your wallet after each run. MON you sweep out can no longer be used for new entries.',
};
export type AutoExtra = { share: number; slip: number; sweep: boolean; keep: number; ackCost: boolean; hold: number; maxOpen: number; entries: boolean; exits: boolean; eng: 'v1' | 'v2'; twap: number; atr: boolean; dloss: number; split: boolean };
export const defaultAutoExtra = (s: Settings): AutoExtra => ({ share: 50, slip: 1, sweep: false, keep: 0, ackCost: false, hold: s.exits.maxHoldHours, maxOpen: Math.min(KEEPER_CAPS.maxOpen, s.maxPositions), entries: true, exits: true, eng: 'v1', twap: 1, atr: false, dloss: 3, split: true });
export const toKeeperSettings = (s: Settings, x: AutoExtra): KeeperSettings => cleanSettings({
  a: s.assets, pos: s.maxPerPositionMon, max: x.maxOpen, share: x.share, loss: s.exits.lossExitPct, tp: s.exits.profitTargetPct, mode: s.exits.profitMode,
  trail: s.exits.trailingPct, hold: x.hold, slip: x.slip, entries: x.entries, exits: x.exits, sweep: x.sweep, keep: x.keep, ackCost: x.ackCost, cost: s.maxCostPct ?? 1,
  eng: x.eng, twap: x.twap, atr: x.atr, dloss: x.dloss, split: x.split,
});

const numIn = (id: string, label: string, v: number, on: (n: number) => void, hint: string, step = '0.1') => (
  <label className="grid gap-1 text-sm" htmlFor={id}><span className="text-zinc-200">{label}</span>
    <input id={id} data-testid={id} inputMode="decimal" type="number" step={step} value={Number.isFinite(v) ? v : ''} onChange={e => on(Number(e.target.value))} className="min-h-12 rounded-2xl border border-white/15 bg-black/30 px-3 font-mono text-white outline-none focus:border-monad" />
    <span className="text-xs text-zinc-500">{hint}</span></label>
);
/** The keeper-only limits (the exit rules themselves come from "Your limits"). */
export function AutoFields({ x, onChange }: { x: AutoExtra; onChange: (x: AutoExtra) => void }) {
  return (
    <div className="grid gap-3" data-testid="m-auto-fields">
      {numIn('m-auto-share', 'Share of the vault in Momentum (%)', x.share, n => onChange({ ...x, share: n }), 'Open positions can never be worth more than this share of the vault (MON + positions).', '1')}
      {numIn('m-auto-max', 'Max open positions', x.maxOpen, n => onChange({ ...x, maxOpen: n }), `One per underlying (cbBTC and WBTC are one BTC exposure). Alpha cap: ${KEEPER_CAPS.maxOpen}.`, '1')}
      {numIn('m-auto-hold', 'Time stop (hours)', x.hold, n => onChange({ ...x, hold: n }), `Sell after this long whatever the price. Minimum ${KEEPER_CAPS.minHoldHours} h.`, '0.25')}
      {numIn('m-auto-dloss', 'Daily loss circuit breaker (%)', x.dloss, n => onChange({ ...x, dloss: n }), 'If the vault loses more than this share of its value within 24 hours (sales plus open positions at sell quotes), new entries pause. Exits keep running.')}
      {numIn('m-auto-twap', 'Entry slices (TWAP)', x.twap, n => onChange({ ...x, twap: n }), `Split each entry into up to ${KEEPER_CAPS.maxSlices} slices, one per keeper run (about 15 min apart). Each slice gets a fresh quote and every check again.`, '1')}
      <label className="flex min-w-0 items-start gap-3 text-sm"><input type="checkbox" className="mt-1 h-5 w-5" checked={x.eng === 'v2'} onChange={e => onChange({ ...x, eng: e.target.checked ? 'v2' : 'v1' })} data-testid="m-auto-v2" /><span className="min-w-0 flex-1"><span className="block text-zinc-100">Use signal engine v2 for entries</span><span className="text-xs text-zinc-500">One composite score with every factor shown, including X sentiment as a small confirming factor. Its backtest so far does not beat v1 out of sample (anecdotal, under 60 days).</span></span></label>
      <label className="flex min-w-0 items-start gap-3 text-sm"><input type="checkbox" className="mt-1 h-5 w-5" checked={x.atr} onChange={e => onChange({ ...x, atr: e.target.checked })} data-testid="m-auto-atr" /><span className="min-w-0 flex-1"><span className="block text-zinc-100">Volatility-based (ATR) loss-exit trigger and trailing exit</span><span className="text-xs text-zinc-500">Uses 1.5× and 1.2× the daily ATR, and is never wider than your own loss-exit trigger and trailing settings.</span></span></label>
      <label className="flex min-w-0 items-start gap-3 text-sm"><input type="checkbox" className="mt-1 h-5 w-5" checked={x.split} onChange={e => onChange({ ...x, split: e.target.checked })} data-testid="m-auto-split" /><span className="min-w-0 flex-1"><span className="block text-zinc-100">Split large entries across routes</span><span className="text-xs text-zinc-500">From {KEEPER_CAPS.splitMinMon} MON, PancakeSwap routes are quoted together and split only when that beats the best single route. One minimum covers the whole entry.</span></span></label>
      {numIn('m-auto-slip', 'Exit slippage ceiling (%)', x.slip, n => onChange({ ...x, slip: n }), 'Exits try at up to 0.5% first and retry up to this ceiling only. Above it the exit is recorded as failed and you are alerted.')}
      <label className="flex min-w-0 items-start gap-3 text-sm"><input type="checkbox" className="mt-1 h-5 w-5" checked={x.sweep} onChange={e => onChange({ ...x, sweep: e.target.checked })} data-testid="m-auto-sweep" /><span className="min-w-0 flex-1"><span className="block text-zinc-100">Auto-sweep free MON to my wallet</span><span className="block text-xs text-zinc-400">{AUTO_COPY.sweepKeep}</span></span></label>
      {x.sweep && numIn('m-auto-keep', 'Keep in vault for future entries (MON)', x.keep, n => onChange({ ...x, keep: n }), 'Not swept. Set it to at least your per-position size if you want more entries.')}
      <label className="flex min-w-0 items-start gap-3 text-sm"><input type="checkbox" className="mt-1 h-5 w-5" checked={x.ackCost} onChange={e => onChange({ ...x, ackCost: e.target.checked })} data-testid="m-auto-ack" /><span className="min-w-0 flex-1"><span className="block text-zinc-100">Allow small entries where gas is a large share</span><span className="block text-xs text-zinc-400">Gas for one round trip is about 0.07 MON. Below roughly 5 MON per position that is more than 1.5% of the position. Off by default.</span></span></label>
    </div>
  );
}

type KStatus = { updated: number; keeperMon: number; runwayRoundTrips: number; pauses: { entries: boolean; exits: boolean }; vaults: Record<string, { active: boolean; settings: KeeperSettings; lastNote: string | null; failures: { t: number; pos: string; why: string }[] }> } | null;
const ago = (t: number) => { const s = Math.max(0, Math.floor(Date.now() / 1000) - t); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
const mon = (x: number | null | undefined, d = 4) => x == null || !Number.isFinite(x) ? '–' : `${x.toLocaleString('en-GB', { maximumFractionDigits: d })} MON`;
export const LABEL: Record<string, string> = { 'opt-in': 'authorised', settings: 'limits', entry: 'bought', exit: 'sold', 'partial-exit': 'sold part', sweep: 'swept', revoked: 'revoked', 'exit-failed': 'exit failed', 'entry-failed': 'no entry', 'sweep-failed': 'sweep failed', 'entry-slice': 'bought slice', 'twap-done': 'slices done' };

export function useKeeper(vault: Address) {
  const [st, setSt] = useState<KStatus>(null); const [acts, setActs] = useState<any[]>([]);
  const load = useCallback(async () => {
    const [s, a] = await Promise.all([loadJson<KStatus>('../keeper-143/status.json', 60_000), loadJson<any[]>('../keeper-143/actions.json', 60_000)]);
    setSt(s ?? null); setActs((a ?? []).filter((r: any) => r.vault === vault.toLowerCase()));
  }, [vault]);
  useEffect(() => { void load(); const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 90_000); return () => clearInterval(t); }, [load]);
  return { st, acts, reload: load };
}

/** Dashboard card: status, one-signature opt-in / limits / pause entries / revoke, the keeper's actions for this vault. */
export function AutoCard(p: MomentumProps & { vault: Address; executor: Address | null; settings: Settings; onChanged: () => void; exp: string }) {
  const on = p.executor?.toLowerCase() === KEEPER.toLowerCase();
  const { st, acts, reload } = useKeeper(p.vault);
  const mine = st?.vaults?.[p.vault.toLowerCase()];
  const [sheet, setSheet] = useState<null | 'optin'>(null);
  const [x, setX] = useState<AutoExtra>(() => defaultAutoExtra(p.settings));
  const [busy, setBusy] = useState<string | null>(null); const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const sign = async (what: string, req: { to: Address; data: `0x${string}` }, okText: string) => {
    if (!p.wallet || !p.account) { p.openConnect(); return; }
    setMsg(null); try { if (!(await p.need())) return; } catch (e) { setMsg({ ok: false, text: sendFault(e).text }); return; }
    setBusy(what);
    try { const rc = await p.send(p.wallet, req); setMsg({ ok: true, text: `${okText} Tx ${rc.transactionHash}` }); setSheet(null); p.onChanged(); void reload(); }
    catch (e) { setMsg({ ok: false, text: sendFault(e).text }); } finally { setBusy(null); }
  };
  const signed = mine?.settings;
  const pauseEntries = () => signed && sign('pause', optInCall(p.vault, { ...signed, entries: !signed.entries }), signed.entries ? 'Automatic entries paused. Automated exits keep running.' : 'Automatic entries resumed.');
  return (
    <Card className="grid gap-3" data-testid="m-auto">
      <div className="flex flex-wrap items-center gap-2"><Bot className="h-5 w-5 text-monad" /><h2 className="min-w-0 flex-1 text-lg font-semibold text-zinc-50">Automatic within limits</h2><Pill tone={on ? 'monad' : 'zinc'}><span data-testid="m-auto-state">{on ? (signed && !signed.entries ? 'ON · entries paused' : 'ON') : 'OFF'}</span></Pill><Pill tone="warn">Alpha · ahead of research</Pill></div>
      <p className="text-xs text-amber-100/90">{AUTO_COPY.honest}</p>
      {on ? <>
        <p className="text-xs text-zinc-400">Keeper <a className="underline" href={`${p.exp}/address/${KEEPER}`} target="_blank" rel="noreferrer">{KEEPER.slice(0, 8)}…{KEEPER.slice(-4)}</a> runs {KEEPER_SCHEDULE}. {st ? `Last run ${ago(st.updated)}${st.pauses.entries ? ' · operator paused entries' : ''}${st.pauses.exits ? ' · operator paused exits' : ''}.` : 'Waiting for its first run.'}</p>
        {signed ? <p className="text-xs text-zinc-300" data-testid="m-auto-limits">Signed limits: {signed.a.join(', ')} · {mon(signed.pos, 2)} per position · max {signed.max} open · ≤ {signed.share}% of the vault · loss-exit trigger −{signed.loss}% · {signed.mode === 'full' ? `all at +${signed.tp}%` : `half at +${signed.tp}%, trail ${signed.trail}%`} · time stop {signed.hold} h · exit slippage ≤ {signed.slip}% · {signed.entries ? 'entries on' : 'entries paused'} · {signed.sweep ? `auto-sweep above ${mon(signed.keep, 2)}` : 'no auto-sweep'}</p>
          : <p className="text-xs text-zinc-400">The keeper picks up your signed limits on its next run.</p>}
        {mine?.lastNote && <p className="break-words text-xs text-zinc-500" data-testid="m-auto-note">Last check: {mine.lastNote}</p>}
        {!!mine?.failures?.length && <div className="rounded-2xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-100" data-testid="m-auto-failed">{mine.failures.slice(0, 3).map(f => <p key={f.t + f.pos}>{f.pos}: {f.why} ({ago(f.t)})</p>)}<p className="mt-1 text-xs">The keeper retries every run within your slippage ceiling. You can also revoke and sell yourself.</p></div>}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Btn kind="soft" disabled={!!busy || !signed} onClick={pauseEntries} data-testid="m-auto-pause-entries">{busy === 'pause' ? <Loader2 className="h-4 w-4 animate-spin" /> : signed && !signed.entries ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}{signed && !signed.entries ? 'Resume automatic entries' : 'Pause automatic entries'}</Btn>
          <Btn kind="soft" disabled={!!busy} onClick={() => { setX(signed ? { share: signed.share, slip: signed.slip, sweep: signed.sweep, keep: signed.keep, ackCost: signed.ackCost, hold: signed.hold, maxOpen: signed.max, entries: signed.entries, exits: signed.exits, eng: signed.eng ?? "v1", twap: signed.twap ?? 1, atr: !!signed.atr, dloss: signed.dloss ?? 3, split: signed.split !== false } : defaultAutoExtra(p.settings)); setSheet('optin'); }} data-testid="m-auto-edit">Edit automatic limits</Btn>
          <Btn kind="danger" disabled={!!busy} onClick={() => p.account && sign('revoke', revokeCall(p.vault, p.account), 'Keeper revoked. You have full manual control; nothing automatic happens now.')} data-testid="m-auto-revoke">{busy === 'revoke' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldOff className="h-4 w-4" />}Revoke keeper · 1 signature</Btn>
        </div>
      </> : <>
        <p className="text-sm text-zinc-300">The keeper can buy for you when the rules pass, sell on your loss-exit trigger, trailing exit, trend fade or time stop, return everything to MON and, if you want, sweep free MON to your wallet. All within the limits you sign.</p>
        <Btn kind="pri" disabled={!!busy || !p.account} onClick={() => { setX(defaultAutoExtra(p.settings)); setSheet('optin'); }} data-testid="m-auto-on">Turn on automatic…</Btn>
      </>}
      {msg && <p className={`break-words rounded-2xl border p-3 text-sm ${msg.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100' : 'border-red-500/40 bg-red-500/10 text-red-100'}`} data-testid="m-auto-msg">{msg.text}</p>}
      <div className="grid gap-1" data-testid="m-auto-actions">
        <h3 className="text-sm font-medium text-zinc-200">Keeper actions on this vault</h3>
        {!acts.length && <p className="text-xs text-zinc-500">None yet.</p>}
        {acts.slice(0, 12).map((r, i) => (
          <div key={i} className="flex min-w-0 flex-wrap items-start gap-2 border-t border-white/5 pt-1.5 text-xs">
            <Pill tone={r.ok === false ? 'bad' : r.kind === 'entry' ? 'monad' : /exit|sweep/.test(r.kind) ? 'ok' : 'zinc'}>{LABEL[r.kind] ?? r.kind}</Pill>
            <span className="min-w-0 flex-1 basis-48 text-zinc-400">{r.asset ? `${r.asset} · ` : ''}{r.kind === 'entry' ? `${mon(r.amountMon)} in` : r.monOut != null ? `${mon(r.monOut)} back` : r.amountMon != null ? mon(r.amountMon) : ''} {r.why}</span>
            {r.tx && r.tx !== 'dry-run' && <a className="shrink-0 font-mono text-violet-300 underline" href={`${p.exp}/tx/${r.tx}`} target="_blank" rel="noreferrer" data-testid="m-auto-tx">{r.tx.slice(0, 10)}…</a>}
            <span className="shrink-0 text-zinc-500">{ago(r.t)}</span>
          </div>))}
      </div>
      {sheet === 'optin' && <Sheet open title={on ? 'Edit automatic limits' : 'Turn on automatic'} onClose={() => setSheet(null)}>
        <div className="grid gap-3 text-sm" data-testid="m-auto-sheet">
          <p className="text-amber-100/90">{AUTO_COPY.honest}</p>
          <p className="text-xs text-zinc-300">{AUTO_COPY.power}</p>
          <p className="text-xs text-zinc-400">Exit rules (loss-exit trigger −{p.settings.exits.lossExitPct}%, profit taking, trailing) and {mon(p.settings.maxPerPositionMon, 2)} per position come from “Edit rules”. Assets: {p.settings.assets.join(', ')} (enabled assets only).</p>
          <AutoFields x={x} onChange={setX} />
          <Btn kind="pri" className="min-h-14" disabled={!!busy} onClick={() => sign('optin', optInCall(p.vault, toKeeperSettings(p.settings, x)), on ? 'New limits signed. The keeper uses them from its next run.' : 'Keeper authorised. It acts from its next run (every 15 min).')} data-testid="m-auto-confirm">{busy === 'optin' && <Loader2 className="h-5 w-5 animate-spin" />}{on ? 'Sign new limits · 1 signature' : 'Authorise the keeper · 1 signature'}</Btn>
          <p className="text-xs text-zinc-500">Simulated first: if it would fail, nothing is sent. Revoke any time with one signature.</p>
        </div>
      </Sheet>}
    </Card>
  );
}
