// Pure logic for runner/meta-watchdog.mjs (tested in watchdog-core.test.mjs). No I/O.
const ts = s => (s ? Date.parse(s) / 1000 : 0);
/** Health of one registry job from its newest runs (GitHub API objects, newest first). */
export function assessJob(job, runs, nowSec, opts = {}) {
  const active = runs.filter(r => r.status !== 'completed');
  const completed = runs.filter(r => r.status === 'completed');
  const lastOk = completed.find(r => r.conclusion === 'success');
  const last = runs[0] ?? null;
  const okAge = lastOk ? (nowSec - ts(lastOk.updated_at || lastOk.created_at)) / 60 : Infinity;
  const running = active.some(r => r.status === 'in_progress');
  const failStreak = (() => { let n = 0; for (const r of completed) { if (r.conclusion === 'failure' || r.conclusion === 'timed_out') n++; else if (r.conclusion === 'success') break; } return n; })();
  const disabled = job.enabledVar && opts.vars && opts.vars[job.enabledVar] !== 'true';
  let state = 'ok';
  if (disabled) state = 'disabled';
  else if (okAge <= job.maxAgeMin || (job.longRunning && running && okAge <= job.maxAgeMin * 3)) state = 'ok';
  else state = 'late';
  const stuck = !disabled && (okAge > job.maxAgeMin * 3 || failStreak >= 3) && !(job.longRunning && running && failStreak < 3 && okAge <= job.maxAgeMin * 6);
  const dispatch = job.mode === 'redispatch' && !disabled && state === 'late' && active.length === 0;
  return {
    id: job.id, workflow: job.workflow, name: job.name, critical: !!job.critical, mode: job.mode, chain: job.chain ?? null, maxAgeMin: job.maxAgeMin,
    state, stuck, dispatch, failStreak, active: active.length, running,
    lastSuccessAt: lastOk ? new Date(ts(lastOk.updated_at || lastOk.created_at) * 1000).toISOString() : null,
    lastSuccessAgeMin: Number.isFinite(okAge) ? Math.round(okAge) : null,
    lastRun: last ? { id: last.id, event: last.event, actor: last.triggering_actor?.login ?? null, status: last.status, conclusion: last.conclusion, createdAt: last.created_at, url: last.html_url } : null,
  };
}
/** Burn per day from balance samples [{t, mon}] (oldest first): sum of drops only (top-ups ignored) over the span. */
export function burnPerDay(samples, minSpanH = 24) {
  if (samples.length < 2) return null;
  const span = (samples.at(-1).t - samples[0].t) / 86400; if (span * 24 < minSpanH) return null;
  let drop = 0; for (let i = 1; i < samples.length; i++) drop += Math.max(0, samples[i - 1].mon - samples[i].mon);
  return drop / span;
}
/** Runway for every pool. balances: {id: mon}; hist: [{t, b:{id:mon}}] oldest first. */
export function runway(cfg, balances, hist, nowSec) {
  const pools = cfg.pools.map(p => {
    const s = hist.filter(h => h.b?.[p.id] != null && h.t >= nowSec - 7 * 86400).map(h => ({ t: h.t, mon: h.b[p.id] }));
    const measured = p.source ? null : burnPerDay(s);
    const burn = p.source ? null : (measured ?? p.seedBurnPerDay ?? null);
    return { id: p.id, name: p.name, address: p.address, mon: balances[p.id] ?? null, burnPerDay: burn == null ? null : +burn.toFixed(4),
      burnSource: p.source ? null : measured != null ? `measured over ${((s.at(-1).t - s[0].t) / 86400).toFixed(1)} d of samples` : `seed: ${p.seedNote ?? 'none'}`,
      fedBy: p.fedBy ?? null, topUp: p.topUp ?? null, source: !!p.source };
  });
  const by = Object.fromEntries(pools.map(p => [p.id, p]));
  for (const p of pools) {
    if (p.source || p.mon == null || !p.burnPerDay) { p.runwayDays = p.source ? null : p.mon != null && p.burnPerDay === 0 ? Infinity : null; continue; }
    const own = p.mon / p.burnPerDay; const feed = p.fedBy && by[p.fedBy]?.mon != null ? by[p.fedBy].mon / p.burnPerDay : 0;
    p.runwayDays = +(own + feed).toFixed(1); p.ownDays = +own.toFixed(1);
  }
  const dep = pools.find(p => p.source);
  if (dep) {
    const floats = pools.filter(p => !p.source && !p.fedBy && p.burnPerDay);
    const total = floats.reduce((a, p) => a + p.burnPerDay, 0); const free = Math.max(0, (dep.mon ?? 0) - cfg.reserveMon);
    dep.freeMon = +free.toFixed(4); dep.coversDays = total ? +(free / total).toFixed(1) : null;
    dep.note = `free above the ${cfg.reserveMon} MON reserve, if it alone had to fund the floats' combined burn (${total.toFixed(2)} MON/day)`;
  }
  const alerts = pools.filter(p => !p.source && Number.isFinite(p.runwayDays) && p.runwayDays != null && p.runwayDays < cfg.alertDays)
    .map(p => `${p.name}: ${p.mon?.toFixed(2)} MON, about ${p.runwayDays} days at ${p.burnPerDay} MON/day (alert under ${cfg.alertDays} d). Top up from the box: \`${p.topUp ?? (p.fedBy && by[p.fedBy]?.topUp) ?? 'see docs/resilience.md'}\``);
  if (dep && dep.coversDays != null) {
    const sys = pools.filter(p => !p.source && !p.fedBy && Number.isFinite(p.runwayDays));
    const minFloat = Math.min(...sys.map(p => p.runwayDays));
    if (Number.isFinite(minFloat) && minFloat + dep.coversDays < cfg.alertDays * 2) alerts.push(`Deployer: ${dep.freeMon} MON free covers about ${dep.coversDays} more days of float burn; plan a deposit to the deployer.`);
  }
  return { alertDays: cfg.alertDays, pools, alerts };
}
/** Keep one sample per >= 20 min, 14 days. */
export function addSample(hist, sample, nowSec) {
  const out = hist.filter(h => h.t >= nowSec - 14 * 86400);
  if (!out.length || sample.t - out.at(-1).t >= 1200) out.push(sample);
  return out;
}
