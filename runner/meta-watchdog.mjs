// Meta-watchdog (ops-watchdog.yml, every ~15 min, self-chaining). GITHUB_TOKEN only: no wallet key of any kind.
//   1. every registry job (runner/jobs-143.json): newest runs -> ok / late / stuck; late + idle + mode redispatch -> dispatch
//   2. ONE issue "ops: stuck jobs" listing every stuck job (closed automatically when none)
//   3. runway of every float / gas pool from balance samples (seeded until 24 h of samples), ONE issue "ops: box action
//      needed" when any pool is under alertDays (30) or aPriori withdrawals have been claimable for over 48 h
//   4. writes web/public/ops-status/{status,runway-history}.json and pushes [skip ci] (raw / Pages / jsDelivr serve it)
//   env: GITHUB_REPOSITORY, GH_TOKEN, SHOWCASE_ENABLED (vars), DRY=1 (read and print only), COMMIT=1
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
import { createPublicClient, formatEther, parseAbi } from 'viem';
import { rpcTransport, rpcList } from './chain-util.mjs';
import { assessJob, runway, addSample } from './watchdog-core.mjs';
const E = process.env; const R = E.GITHUB_REPOSITORY || 'Blockchains/policypilot-monad'; const DRY = E.DRY === '1';
const HERE = path.dirname(new URL(import.meta.url).pathname); const ROOT = path.join(HERE, '..');
const CFG = JSON.parse(fs.readFileSync(path.join(HERE, 'jobs-143.json'), 'utf8'));
const OUT = path.join(ROOT, 'web/public/ops-status'); fs.mkdirSync(OUT, { recursive: true });
const now = Math.floor(Date.now() / 1000); const log = (...a) => console.log(new Date().toISOString(), ...a);
const RUN_URL = `${E.GITHUB_SERVER_URL || 'https://github.com'}/${R}/actions/runs/${E.GITHUB_RUN_ID || 0}`;
async function gh(method, p, body) {
  const r = await fetch(`https://api.github.com${p}`, { method, headers: { authorization: `Bearer ${E.GH_TOKEN || E.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${method} ${p}: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
  return r.status === 204 ? null : r.json();
}
// ---- 1. jobs
const vars = { SHOWCASE_ENABLED: E.SHOWCASE_ENABLED ?? 'true' };
const jobs = []; const did = []; const errors = [];
for (const j of CFG.jobs) {
  try {
    const d = await gh('GET', `/repos/${R}/actions/workflows/${j.workflow}/runs?per_page=15&branch=main`);
    const runs = d.workflow_runs.filter(r => r.event !== 'pull_request' && r.event !== 'push' || j.id === 'pages');
    const a = assessJob(j, runs, now, { vars });
    if (j.id === 'ops-watchdog' && E.GITHUB_RUN_ID) { a.state = 'ok'; a.stuck = false; } // this run is the proof of life
    if (a.dispatch) {
      if (DRY) a.dispatched = 'dry-run';
      else { try { await gh('POST', `/repos/${R}/actions/workflows/${j.workflow}/dispatches`, { ref: 'main', inputs: j.inputs ?? {} }); a.dispatched = new Date().toISOString(); did.push(`re-dispatched ${j.workflow} (last success ${a.lastSuccessAt ?? 'never'})`); }
        catch (e) { a.dispatchError = String(e.message).slice(0, 160); errors.push(a.dispatchError); } }
    }
    jobs.push(a);
  } catch (e) { errors.push(`${j.workflow}: ${String(e.message).slice(0, 160)}`); jobs.push({ id: j.id, workflow: j.workflow, name: j.name, state: 'unknown', error: String(e.message).slice(0, 160) }); }
}
// box / human dispatches in the last 24 h (proof that nothing needs the box)
let human = null;
try {
  const since = new Date((now - 86400) * 1000).toISOString();
  const d = await gh('GET', `/repos/${R}/actions/runs?per_page=100&event=workflow_dispatch&created=%3E%3D${since}`);
  const h = d.workflow_runs.filter(r => r.triggering_actor?.login && r.triggering_actor.login !== 'github-actions[bot]');
  human = { windowH: 24, count: h.length, last: h[0] ? { workflow: h[0].name, actor: h[0].triggering_actor.login, at: h[0].created_at, id: h[0].id } : null, note: 'workflow_dispatch runs started by a person or the box (not by a GitHub job)' };
} catch (e) { errors.push(`human-dispatch audit: ${String(e.message).slice(0, 120)}`); }
// ---- 3. runway + box tasks (public RPC reads only)
const pc = createPublicClient({ transport: rpcTransport(rpcList(E)) });
const balances = {}; for (const p of CFG.runway.pools) { try { balances[p.id] = +formatEther(await pc.getBalance({ address: p.address })).slice(0, 14); } catch (e) { errors.push(`balance ${p.id}: ${String(e.shortMessage || e.message).slice(0, 100)}`); } }
const histF = path.join(OUT, 'runway-history.json'); let hist = []; try { hist = JSON.parse(fs.readFileSync(histF, 'utf8')); } catch { /* first run */ }
if (Object.keys(balances).length === CFG.runway.pools.length) hist = addSample(hist, { t: now, b: balances }, now);
const rw = runway(CFG.runway, balances, hist, now);
const boxTasks = [];
try {
  const B = CFG.boxTasks; const abi = parseAbi(['function getUserRequestDataCount(address) view returns (uint256)', 'function getUserRequestData(address,uint256,uint256) view returns ((uint256 id, bool claimed, bool claimable, uint256 shares, uint256 assets, uint256 timestamp, uint64 unlockEpoch)[])']);
  const n = await pc.readContract({ address: B.aprMON, abi, functionName: 'getUserRequestDataCount', args: [B.aprioriController] });
  const rows = n ? await pc.readContract({ address: B.aprMON, abi, functionName: 'getUserRequestData', args: [B.aprioriController, 0n, n] }) : [];
  const open = rows.filter(r => !r.claimed); const claimable = open.filter(r => r.claimable);
  const mon = claimable.reduce((a, r) => a + Number(formatEther(r.assets)), 0); const oldest = claimable.reduce((a, r) => Math.min(a, Number(r.timestamp)), now);
  boxTasks.push({ id: 'apriori-claim', what: 'aPriori queued withdrawals of the deployer (redeem must be signed by the deployer, so this stays on the box)',
    claimableMon: +mon.toFixed(4), claimableIds: claimable.map(r => String(r.id)), lockedMon: +open.filter(r => !r.claimable).reduce((a, r) => a + Number(formatEther(r.assets)), 0).toFixed(4),
    alert: mon >= B.claimAlertMon && (now - oldest) / 3600 > B.claimAlertAfterH, howTo: 'on the box: node runner/apriori-claim.mjs (deployer key, simulated first)' });
} catch (e) { errors.push(`apriori: ${String(e.shortMessage || e.message).slice(0, 120)}`); }
// ---- 2 + 3. issues
async function issue(title, problems, intro) {
  if (DRY) return 'dry-run';
  const list = await gh('GET', `/repos/${R}/issues?state=all&per_page=100&creator=github-actions%5Bbot%5D`);
  const ex = list.filter(i => i.title === title && !i.pull_request).sort((a, b) => a.number - b.number)[0];
  if (!problems.length) { if (ex && ex.state === 'open') { await gh('POST', `/repos/${R}/issues/${ex.number}/comments`, { body: `Resolved. ${RUN_URL}` }); await gh('PATCH', `/repos/${R}/issues/${ex.number}`, { state: 'closed' }); return `closed #${ex.number}`; } return 'none'; }
  const body = `@Blockchains ${intro}\n\n${problems.map(p => `- ${p}`).join('\n')}\n\nLast check: ${RUN_URL} · health page: https://blockchains.github.io/policypilot-monad/#status\n`;
  if (!ex) { const c = await gh('POST', `/repos/${R}/issues`, { title, body }); return `opened #${c.number}`; }
  if (ex.state !== 'open') { await gh('PATCH', `/repos/${R}/issues/${ex.number}`, { state: 'open', body }); await gh('POST', `/repos/${R}/issues/${ex.number}/comments`, { body: `Reopened: ${RUN_URL}` }); return `reopened #${ex.number}`; }
  if (ex.body !== body) await gh('PATCH', `/repos/${R}/issues/${ex.number}`, { body }); return `updated #${ex.number}`;
}
const stuck = jobs.filter(j => j.stuck).map(j => `${j.name} (\`${j.workflow}\`): last success ${j.lastSuccessAt ?? 'never'}${j.failStreak ? `, ${j.failStreak} failed in a row` : ''}${j.dispatched ? ' (re-dispatched)' : ''}`);
const boxProblems = [...rw.alerts, ...boxTasks.filter(t => t.alert).map(t => `${t.what}: ${t.claimableMon} MON claimable (ids ${t.claimableIds.join(', ')}) for over ${CFG.boxTasks.claimAlertAfterH} h. ${t.howTo}`)];
const issues = {};
try { issues.stuck = await issue('ops: stuck jobs', stuck, 'these GitHub jobs are stuck (the meta-watchdog already re-dispatched what it could).'); } catch (e) { errors.push(`issue stuck: ${e.message}`); }
try { issues.box = await issue('ops: box action needed (runway / claims)', boxProblems, 'the deployer/box has to act (the deployer key is never on GitHub). Alerts fire at least 30 days before a pool runs dry.'); } catch (e) { errors.push(`issue box: ${e.message}`); }
// ---- 4. status
const status = { v: 1, updatedAt: new Date(now * 1000).toISOString(), run: RUN_URL, note: 'ALPHA. Health of every GitHub job (no box needed). Written by ops-watchdog.yml (meta-watchdog) every ~15 min.',
  summary: { jobs: jobs.length, ok: jobs.filter(j => j.state === 'ok').length, late: jobs.filter(j => j.state === 'late').length, stuck: stuck.length, disabled: jobs.filter(j => j.state === 'disabled').length },
  jobs, actions: did, humanDispatches24h: human, runway: rw, boxTasks, issues, errors };
fs.writeFileSync(path.join(OUT, 'status.json'), JSON.stringify(status, null, 1) + '\n');
fs.writeFileSync(histF, JSON.stringify(hist) + '\n');
log(JSON.stringify({ summary: status.summary, actions: did, runway: rw.pools.map(p => `${p.id} ${p.mon} ${p.runwayDays ?? p.coversDays}d`), alerts: boxProblems, issues, errors }, null, 1));
if (E.COMMIT === '1' && !DRY) execFileSync('bash', [path.join(ROOT, 'web/scripts/momentum-commit.sh')], { cwd: ROOT, stdio: 'inherit', env: { ...E, DIR: 'web/public/ops-status', BRANCH: 'main', MSG: `ops: meta-watchdog ${status.summary.ok}/${status.summary.jobs} ok [skip ci]` } });
