import test from 'node:test'; import assert from 'node:assert/strict';
import { assessJob, burnPerDay, runway, addSample } from './watchdog-core.mjs';
const NOW = 1_800_000_000; const iso = s => new Date((NOW - s) * 1000).toISOString();
const run = (ago, status = 'completed', conclusion = 'success') => ({ id: ago, status, conclusion, created_at: iso(ago), updated_at: iso(ago), event: 'workflow_dispatch', triggering_actor: { login: 'github-actions[bot]' } });
const J = { id: 'k', workflow: 'k.yml', mode: 'redispatch', maxAgeMin: 35 };
test('fresh success is ok', () => { const a = assessJob(J, [run(600)], NOW); assert.equal(a.state, 'ok'); assert.equal(a.dispatch, false); });
test('late and idle -> dispatch, not stuck yet', () => { const a = assessJob(J, [run(3000)], NOW); assert.equal(a.state, 'late'); assert.equal(a.dispatch, true); assert.equal(a.stuck, false); });
test('late but queued -> no double dispatch', () => assert.equal(assessJob(J, [run(10, 'queued', null), run(3000)], NOW).dispatch, false));
test('stuck after 3x maxAge', () => assert.equal(assessJob(J, [run(7000)], NOW).stuck, true));
test('3 failures in a row is stuck', () => assert.equal(assessJob(J, [run(60, 'completed', 'failure'), run(120, 'completed', 'failure'), run(180, 'completed', 'failure'), run(240)], NOW).stuck, true));
test('long-running in progress counts as healthy', () => assert.equal(assessJob({ ...J, longRunning: true }, [run(60, 'in_progress', null), run(3000)], NOW).state, 'ok'));
test('monitor never dispatches; disabled var', () => {
  assert.equal(assessJob({ ...J, mode: 'monitor' }, [run(9000)], NOW).dispatch, false);
  const d = assessJob({ ...J, enabledVar: 'X' }, [run(9000)], NOW, { vars: { X: 'false' } }); assert.equal(d.state, 'disabled'); assert.equal(d.dispatch, false); assert.equal(d.stuck, false);
});
test('never ran -> late + stuck', () => { const a = assessJob(J, [], NOW); assert.equal(a.state, 'late'); assert.equal(a.stuck, true); assert.equal(a.lastSuccessAt, null); });
test('burn ignores top-ups and needs 24 h', () => {
  assert.equal(burnPerDay([{ t: 0, mon: 10 }, { t: 3600, mon: 9 }]), null);
  assert.equal(burnPerDay([{ t: 0, mon: 10 }, { t: 43200, mon: 9 }, { t: 43300, mon: 20 }, { t: 86400, mon: 19 }]), 2);
});
test('runway: seeds, fedBy, alert under 30 d, deployer cover', () => {
  const cfg = { alertDays: 30, reserveMon: 5, pools: [
    { id: 'f', name: 'F', seedBurnPerDay: 4, seedNote: 's', topUp: 'top f' }, { id: 'kf', name: 'KF', seedBurnPerDay: 0.5, topUp: 'top kf' },
    { id: 'kg', name: 'KG', seedBurnPerDay: 0.5, fedBy: 'kf' }, { id: 'd', name: 'D', source: true }] };
  const r = runway(cfg, { f: 400, kf: 10, kg: 3, d: 77 }, [], NOW);
  const by = Object.fromEntries(r.pools.map(p => [p.id, p]));
  assert.equal(by.f.runwayDays, 100); assert.equal(by.kf.runwayDays, 20); assert.equal(by.kg.runwayDays, 26); assert.equal(by.kg.ownDays, 6);
  assert.equal(by.d.freeMon, 72); assert.equal(by.d.coversDays, 16);
  assert.equal(r.alerts.length, 3); assert.match(r.alerts[0], /KF.*top kf/); assert.match(r.alerts[1], /KG.*top kf/); assert.match(r.alerts[2], /Deployer: 72 MON free covers about 16/);
});
test('samples thinned and pruned', () => {
  let h = []; h = addSample(h, { t: NOW - 15 * 86400, b: {} }, NOW); h = addSample(h, { t: NOW, b: {} }, NOW); h = addSample(h, { t: NOW + 60, b: {} }, NOW + 60);
  assert.equal(h.length, 1);
});
