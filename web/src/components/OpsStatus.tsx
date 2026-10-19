'use client';
// System status: health of every GitHub job (no box needed), float/gas runway and box-only tasks.
// Public data only (web/public/ops-status/status.json from the meta-watchdog), three mirrors. No RPC calls from here.
import { useEffect, useState } from 'react';
import { Card, Pill } from './ui';
import { loadPublic } from '@/lib/publicData';

type Job = { id: string; workflow: string; name: string; critical?: boolean; mode?: string; chain?: string | null; state: string; stuck?: boolean; lastSuccessAt?: string | null; lastSuccessAgeMin?: number | null; maxAgeMin?: number;
  lastRun?: { id: number; event: string; actor: string | null; status: string; conclusion: string | null; createdAt: string; url: string } | null; dispatched?: string };
type Pool = { id: string; name: string; address: string; mon: number | null; burnPerDay: number | null; burnSource: string | null; runwayDays: number | null; ownDays?: number; freeMon?: number; coversDays?: number | null; note?: string; source?: boolean };
type Status = { updatedAt: string; run: string; summary: { jobs: number; ok: number; late: number; stuck: number; disabled: number }; jobs: Job[];
  humanDispatches24h?: { count: number; last: { workflow: string; actor: string; at: string } | null } | null;
  runway: { alertDays: number; pools: Pool[]; alerts: string[] }; boxTasks: { id: string; what: string; claimableMon?: number; lockedMon?: number; alert?: boolean; howTo?: string }[]; issues?: Record<string, string> };

const REPO = 'https://github.com/Blockchains/policypilot-monad';
const ago = (iso?: string | null) => { if (!iso) return 'never'; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 90 ? `${m} min ago` : m < 2880 ? `${(m / 60).toFixed(1)} h ago` : `${(m / 1440).toFixed(1)} d ago`; };
const tone = (j: Job) => (j.state === 'ok' ? 'ok' : j.state === 'disabled' ? 'zinc' : j.stuck ? 'bad' : 'warn') as 'ok' | 'bad' | 'warn' | 'zinc';
const days = (d: number | null | undefined) => (d == null ? '–' : !Number.isFinite(d) ? '∞' : d >= 365 ? `${(d / 365).toFixed(1)} years` : `${Math.round(d)} days`);

export default function OpsStatus() {
  const [s, setS] = useState<Status | null>(null); const [err, setErr] = useState(false);
  useEffect(() => { let on = true; const go = () => loadPublic<Status>('ops-status/status.json', 60_000).then(v => { if (on) { setS(v); setErr(!v); } });
    go(); const t = setInterval(go, 120_000); return () => { on = false; clearInterval(t); }; }, []);
  const age = s ? (Date.now() - Date.parse(s.updatedAt)) / 60000 : null;
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-4" data-testid="ops-status">
      <div className="grid gap-1">
        <h1 className="text-xl font-semibold text-zinc-50">System status</h1>
        <p className="text-sm text-zinc-300">Everything here runs on GitHub Actions: the Momentum keeper and data, sentiment, the showcase agents with their refills and daily sweep, the indexers, and this watchdog. Each job starts its own next run, and a watchdog checks every job about every 15 minutes, starts any that are late and opens one GitHub issue for anything stuck. Only funding the floats (and claiming the team’s aPriori withdrawals) needs the team’s own key, which never goes to GitHub. You get at least 30 days’ notice before that matters.</p>
      </div>
      {!s && <Card><p className="text-sm text-zinc-400" data-testid="ops-loading">{err ? 'Status file not reachable on any mirror (raw GitHub, this site, jsDelivr).' : 'Loading…'}</p></Card>}
      {s && <>
        <Card className="grid gap-2" data-testid="ops-summary">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={s.summary.stuck ? 'bad' : s.summary.late ? 'warn' : 'ok'}>{s.summary.ok} of {s.summary.jobs} jobs healthy</Pill>
            {s.summary.late > 0 && <Pill tone="warn">{s.summary.late} late (restarted automatically)</Pill>}
            {s.summary.stuck > 0 && <Pill tone="bad">{s.summary.stuck} stuck (issue opened)</Pill>}
            <Pill tone={age != null && age < 40 ? 'ok' : 'warn'}>checked {ago(s.updatedAt)}</Pill>
          </div>
          {s.humanDispatches24h && <p className="text-xs text-zinc-400" data-testid="ops-human">Runs started by a person or the bot box in the last 24 h: {s.humanDispatches24h.count}{s.humanDispatches24h.last ? ` (latest ${s.humanDispatches24h.last.workflow}, ${ago(s.humanDispatches24h.last.at)})` : ''}. Every other run was started by a schedule or by another GitHub job.</p>}
        </Card>
        <Card className="grid gap-2" data-testid="ops-jobs">
          <h2 className="text-sm font-semibold text-zinc-100">Jobs</h2>
          <ul className="grid gap-2">{s.jobs.map(j => (
            <li key={j.id} className="grid gap-1 rounded-lg border border-zinc-800 p-3" data-testid={`ops-job-${j.id}`}>
              <div className="flex flex-wrap items-center gap-2 text-sm"><span className="font-medium text-zinc-100">{j.name}</span><Pill tone={tone(j)}>{j.state === 'ok' ? 'healthy' : j.state === 'late' ? (j.stuck ? 'stuck' : 'late') : j.state}</Pill>{j.critical && <Pill tone="monad">critical</Pill>}</div>
              <div className="text-xs text-zinc-400">Last success {ago(j.lastSuccessAt)} (expected within {j.maxAgeMin} min){j.lastRun && <> · last run <a className="text-violet-300 underline" href={j.lastRun.url} target="_blank" rel="noreferrer">#{j.lastRun.id}</a> ({j.lastRun.event}{j.lastRun.actor ? ` by ${j.lastRun.actor}` : ''}, {j.lastRun.conclusion ?? j.lastRun.status})</>}{j.chain ? ` · ${j.chain}` : ''}{j.dispatched ? ' · restarted by the watchdog' : ''}</div>
            </li>))}</ul>
        </Card>
        <Card className="grid gap-2" data-testid="ops-runway">
          <h2 className="text-sm font-semibold text-zinc-100">Runway (alert at {s.runway.alertDays} days)</h2>
          <ul className="grid gap-2">{s.runway.pools.map(p => (
            <li key={p.id} className="grid gap-1 rounded-lg border border-zinc-800 p-3 text-xs text-zinc-300" data-testid={`ops-pool-${p.id}`}>
              <div className="flex flex-wrap items-center gap-2 text-sm"><a className="font-medium text-zinc-100 underline decoration-zinc-600" href={`https://monadvision.com/address/${p.address}`} target="_blank" rel="noreferrer">{p.name}</a>
                <span>{p.mon == null ? '–' : `${p.mon.toFixed(2)} MON`}</span>
                {!p.source && <Pill tone={p.runwayDays != null && p.runwayDays < s.runway.alertDays ? 'bad' : 'ok'}>{days(p.runwayDays)}</Pill>}
                {p.source && <Pill tone="zinc">covers {days(p.coversDays)}</Pill>}</div>
              {!p.source && <div className="text-zinc-400">Burn {p.burnPerDay ?? '–'} MON/day ({p.burnSource})</div>}
              {p.source && <div className="text-zinc-400">{p.freeMon} MON {p.note}</div>}
            </li>))}</ul>
          {s.runway.alerts.length > 0 && <p className="text-xs text-rose-300">{s.runway.alerts.join(' · ')}</p>}
        </Card>
        <Card className="grid gap-2" data-testid="ops-box">
          <h2 className="text-sm font-semibold text-zinc-100">Still needs the team’s key (never on GitHub)</h2>
          <ul className="grid gap-1 text-xs text-zinc-300">
            <li>Funding the two floats above (the watchdog opens an issue at least 30 days before either runs dry).</li>
            {s.boxTasks.map(t => <li key={t.id}>{t.what}: {t.claimableMon} MON claimable, {t.lockedMon} MON still locked{t.alert ? ' (alert open)' : ''}.</li>)}
          </ul>
          <p className="text-xs text-zinc-500">Source: <a className="underline" href={s.run} target="_blank" rel="noreferrer">meta-watchdog run</a> · <a className="underline" href={`${REPO}/blob/main/docs/resilience.md`} target="_blank" rel="noreferrer">docs/resilience.md</a> · <a className="underline" href={`${REPO}/issues`} target="_blank" rel="noreferrer">issues</a></p>
        </Card>
      </>}
    </div>
  );
}
