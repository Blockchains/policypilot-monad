#!/usr/bin/env node
// Platform activity indexer (no paid APIs). Scans every PolicyPilot factory from its deploy block with eth_getLogs over
// chunked ranges (RPC fallback list, each with its own max range), discovers every vault from VaultCreated, then indexes
// all vault, refiller and MonaDefi (aPriori, platform wallets only) events, plus the showcase ledger (the only source of
// reverted showcase txs, which emit no logs). Output (incremental, committed with [skip ci]):
//   web/public/activity/143/index.json   cursor (lastBlock), vault list, page list, counts, newest rows
//   web/public/activity/143/p<bucket>.json   one file per 200k blocks, rows newest first
// Run: node --experimental-strip-types runner/activity-index.mjs [--loop SECONDS --for MINUTES]
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { aggregate, bucketOf, fromLedger, mergeRows, sortRows } from '../web/src/lib/activityCore.ts';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'web/public/activity/143');
const START = 112_936_396; // v1 AgentVaultFactory deploy block (the first platform contract on mainnet)
const FACTORIES = {
  '0x8738b74778502ff3623a8319837a819d8dbdeeb7': 'v1', '0x0342d29055d77ba155c50233f550539e3029ba6a': 'v2', '0x52727226af0efe2bfe3e5c97e46b704613344a92': 'v3',
  '0x7611405605a9d630f3e7f4703897fcf1dc17f945': 'showcase-v4', '0x41d6667aa35c3634d19068a39481d4c955f6557d': 'unlimited',
};
const REFILLERS = ['0x5d80e5f8a3628fd892b38d5f05864849191f87fc', '0xb5ff7b0548c03fe29d36870f0f2a6faff20df0fe', '0x6b4ea80c7207e25116ecdfb3e0c6f3dcc359573c'];
const APRMON = '0x0c65a0bc65a5d819235b71f554d210d3f80e0852';
const TEAM_OWNER = '0xc0c4e411e41becad6da860f67063c2d6363a6113';
const LEDGER = path.join(ROOT, 'runner/ledger/showcase-143.jsonl');
const LEGACY_SHOWCASE = path.join(ROOT, 'frontend/showcase-143.json');
const RPCS = (process.env.ACTIVITY_RPCS ? process.env.ACTIVITY_RPCS.split(',').map(u => [u, 100]) : [
  ['https://rpc2.monad.xyz', 10_000], ['https://rpc3.monad.xyz', 1_000], ['https://rpc.monad.xyz', 100], ['https://rpc1.monad.xyz', 100], ['https://rpc-mainnet.monadinfra.com', 100],
]);
const LATEST = 150; const ADDR_CHUNK = 200; const WALLET_CHUNK = 60; const SAFETY = 10;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lc = a => String(a).toLowerCase();
const hex = n => '0x' + BigInt(n).toString(16);
let calls = 0;

async function rpc(url, method, params) {
  calls++;
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(25_000) });
  if (!r.ok) throw new Error(`${url} HTTP ${r.status} ${(await r.text()).slice(0, 160)} [${method} ${JSON.stringify(params).slice(0, process.env.DEBUG ? 6000 : 80)}]`);
  const j = await r.json(); if (j.error) throw new Error(`${url} ${j.error.code}: ${j.error.message}`);
  return j.result;
}
async function any(method, params) {
  let last; for (let k = 0; k < 3; k++) for (const [u] of RPCS) { try { return await rpc(u, method, params); } catch (e) { last = e; await sleep(300); } }
  throw last;
}
/** eth_getLogs over [from, to] in chunks; on error drops to the next endpoint (smaller max range) and retries the chunk. */
async function logs(filter, from, to) {
  const out = []; let ep = 0; let fails = 0;
  for (let a = from; a <= to;) {
    const [url, max] = RPCS[ep]; const b = Math.min(to, a + max - 1);
    try { out.push(...await rpc(url, 'eth_getLogs', [{ ...filter, fromBlock: hex(a), toBlock: hex(b) }])); a = b + 1; fails = 0; if (ep && Math.random() < 0.05) ep = 0; }
    catch (e) { fails++; if (process.env.DEBUG) console.warn(String(e.message).slice(0, 8000)); if (fails > RPCS.length * 3) throw e; ep = (ep + 1) % RPCS.length; await sleep(250 * Math.min(fails, 8)); }
  }
  return out;
}
const chunks = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

function readJSON(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function teamMaps() {
  const personaVault = {}; const team = new Set([TEAM_OWNER]);
  const v4 = readJSON(path.join(ROOT, 'runner/showcase-vaults-v4-143.json'), {});
  for (const [id, x] of Object.entries(v4.vaults ?? {})) { if (x?.vault) { personaVault[id] = lc(x.vault); team.add(lc(x.vault)); } if (x?.executor) team.add(lc(x.executor)); }
  const cfg = readJSON(path.join(ROOT, 'runner/showcase-config-143.json'), {});
  for (const x of cfg.agents ?? []) { if (x?.vault && !personaVault[x.id]) personaVault[x.id] = lc(x.vault); if (x?.vault) team.add(lc(x.vault)); if (x?.agent) team.add(lc(x.agent)); }
  return { personaVault, team };
}
const TXCACHE = path.join(ROOT, 'runner/activity-txblocks-143.json');
/** Ledger lines that carry a tx hash but no block (clip captures, agent gas top-ups): resolve block + status from the receipt once, cached. */
async function resolveBlocks(lines) {
  const cache = readJSON(TXCACHE, {}); const need = [...new Set(lines.filter(x => x.tx && !x.block && !cache[lc(x.tx)]).map(x => lc(x.tx)))];
  let i = 0; let got = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < need.length) {
      const h = need[i++];
      try { const rc = await any('eth_getTransactionReceipt', [h]); if (rc?.blockNumber) { cache[h] = [Number(BigInt(rc.blockNumber)), rc.status === '0x1' ? 1 : 0]; got++; } } catch { /* retry next run */ }
    }
  }));
  if (got) fs.writeFileSync(TXCACHE, JSON.stringify(cache));
  for (const x of lines) {
    const c = x.tx && cache[lc(x.tx)];
    if (c) { if (!x.block) x.block = c[0]; if (c[1] === 0 && x.status !== 'blocked') { x.status = 'blocked'; x.reason = x.reason ?? 'reverted on-chain'; } }
  }
  return need.length;
}
async function ledgerRows(personaVault) {
  const lines = [];
  if (fs.existsSync(LEDGER)) for (const l of fs.readFileSync(LEDGER, 'utf8').split('\n')) { if (!l.trim()) continue; try { const x = JSON.parse(l); lines.push({ ...x, vault: x.vault ?? x.pool }); } catch { /* torn line */ } }
  const legacy = readJSON(LEGACY_SHOWCASE, null);
  for (const s of legacy?.steps ?? []) lines.push({ tx: s.tx, block: s.block, label: s.label, status: s.status === 'reverted' ? 'blocked' : 'ok', reason: s.revertReason ?? undefined, vault: '0x379e0c3ecba46d62dadcf26dbecd0f26a2cdca97', persona: 'showcase-v1' });
  const n = await resolveBlocks(lines); if (n) console.log(`resolved ${n} ledger tx blocks from receipts`);
  return fromLedger(lines, personaVault);
}

async function runOnce() {
  fs.mkdirSync(OUT, { recursive: true });
  const idxFile = path.join(OUT, 'index.json');
  const idx = readJSON(idxFile, null);
  const vaults = new Map((idx?.vaults ?? []).map(v => [v.a, v]));
  const cursor = idx?.lastBlock ?? START - 1;
  const head = Number(BigInt(await any('eth_blockNumber', []))) - SAFETY;
  const { personaVault, team } = teamMaps();
  const from = cursor + 1;
  let fresh = [];
  if (head >= from) {
    // 1) vault discovery
    const fl = await logs({ address: Object.keys(FACTORIES), topics: [['0x897c133dfbfe1f6239e98b4ffd7e4f6c86a62350a131a7a37790419f58af02f9']] }, from, head);
    for (const l of fl) {
      const a = '0x' + l.topics[2].slice(-40), owner = '0x' + l.topics[1].slice(-40), executor = '0x' + l.topics[3].slice(-40);
      if (!vaults.has(a)) vaults.set(a, { a, f: FACTORIES[lc(l.address)], o: owner, e: executor, b: Number(BigInt(l.blockNumber)), t: Number(BigInt(l.blockTimestamp ?? 0)) });
    }
    for (const v of vaults.values()) { if (team.has(v.a) || v.o === TEAM_OWNER) v.team = true; const p = Object.entries(personaVault).find(([, x]) => x === v.a)?.[0]; if (p) v.p = p; }
    // 2) vault + refiller events, 3) aPriori events of platform wallets
    const addrs = [...vaults.keys(), ...REFILLERS];
    const wallets = new Set([TEAM_OWNER, ...[...vaults.values()].flatMap(v => [v.o, v.e])]);
    const raw = [...fl];
    for (const c of chunks(addrs, ADDR_CHUNK)) raw.push(...await logs({ address: c }, from, head));
    for (const c of chunks([...wallets], WALLET_CHUNK)) raw.push(...await logs({ address: APRMON, topics: [['0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7', '0x110990b6c317a85848c161e269666a01fea23eb9e16150c2c46cae8c0faf4a9d', '0x8caf04742286d017f9ac3924388e188c73e6e5094311c5e59a61a7ef86dda8bf'], null, c.map(w => '0x' + w.slice(2).padStart(64, '0'))] }, from, head));
    const ctx = { factories: new Set(Object.keys(FACTORIES)), vaults: new Set(vaults.keys()), refillers: new Set(REFILLERS), aprmon: APRMON, wallets };
    const agg = aggregate(raw, ctx);
    for (const x of agg.executors.sort((p, q) => p.b - q.b || p.i - q.i)) { const v = vaults.get(x.vault); if (v) v.e = x.executor; }
    fresh = agg.rows;
  }
  // ledger: showcase rows (incl. reverted) — always re-merged, it is append-only and cheap
  const led = (await ledgerRows(personaVault)).filter(r => r.b <= Math.max(head, cursor));
  // load existing pages that the new rows touch
  const pages = new Map(); const pageIds = new Set((idx?.pages ?? []).map(p => p.id));
  const touched = new Set([...fresh, ...led].map(r => bucketOf(r.b)));
  for (const id of touched) pages.set(id, readJSON(path.join(OUT, `p${id}.json`), { id, rows: [] }).rows ?? []);
  const byBucket = new Map();
  for (const r of [...fresh, ...led]) { const k = bucketOf(r.b); if (!byBucket.has(k)) byBucket.set(k, []); byBucket.get(k).push(r); }
  // ledger-only rows without a timestamp (legacy steps): read their block time once
  const noTs = [...byBucket.values()].flat().filter(r => !r.t);
  const tsOf = new Map();
  for (const b of [...new Set(noTs.map(r => r.b))].slice(0, 200)) { try { tsOf.set(b, Number(BigInt((await any('eth_getBlockByNumber', [hex(b), false])).timestamp))); } catch { /* keep 0 */ } }
  for (const r of noTs) r.t = tsOf.get(r.b) ?? 0;
  let changed = 0;
  for (const [k, rs] of byBucket) {
    const before = pages.get(k) ?? []; const merged = mergeRows(before, rs);
    const was = JSON.stringify(before), now = JSON.stringify(merged);
    if (was !== now) { fs.writeFileSync(path.join(OUT, `p${k}.json`), JSON.stringify({ id: k, rows: merged })); changed++; }
    pages.set(k, merged); pageIds.add(k);
  }
  // page list + totals (recount from files so the index always matches the shards)
  const list = []; let total = 0; const counts = {}; let reverted = 0; let latest = [];
  for (const id of [...pageIds].sort((a, b) => b - a)) {
    const rows = pages.get(id) ?? readJSON(path.join(OUT, `p${id}.json`), { rows: [] }).rows;
    if (!rows.length) continue;
    list.push({ id, n: rows.length, from: rows[rows.length - 1].b, to: rows[0].b });
    total += rows.length; for (const r of rows) { counts[r.k] = (counts[r.k] ?? 0) + 1; if (r.s === 'reverted') reverted++; }
    if (latest.length < LATEST) latest = latest.concat(rows.slice(0, LATEST - latest.length));
  }
  const out = {
    v: 1, chainId: 143, label: 'PolicyPilot platform activity (every factory, every vault, refiller, showcase ledger, MonaDefi of platform wallets)',
    lastBlock: Math.max(head, cursor), updatedAt: new Date().toISOString(), start: START, bucket: 200_000, total, reverted, counts,
    factories: FACTORIES, refillers: REFILLERS, aprmon: APRMON, teamOwner: TEAM_OWNER,
    vaults: [...vaults.values()].sort((a, b) => a.b - b.b), pages: list, latest: sortRows(latest),
  };
  fs.writeFileSync(idxFile, JSON.stringify(out));
  console.log(`indexed ${from}..${head}: +${fresh.length} chain rows, ${led.length} ledger rows, ${changed} pages changed, total ${total} (${reverted} reverted), ${vaults.size} vaults, ${calls} rpc calls`);
  return { head, changed, total };
}

function commitAndPush(msg) {
  const sh = c => execSync(c, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  try {
    sh('git add -- web/public/activity runner/activity-txblocks-143.json');
    if (!sh('git diff --cached --name-only')) return false;
    sh(`git -c user.name=policypilot-activity-bot -c user.email=activity-bot@users.noreply.github.com commit -q -m "${msg} [skip ci]"`);
    for (let k = 1; k <= 5; k++) {
      try { sh(`git fetch -q origin ${process.env.BRANCH ?? 'main'}`); sh(`git rebase -q -X theirs origin/${process.env.BRANCH ?? 'main'}`); sh(`git push -q origin HEAD:${process.env.BRANCH ?? 'main'}`); return true; }
      catch (e) { try { sh('git rebase --abort'); } catch { /* none */ } execSync(`sleep ${k * 3}`); }
    }
  } catch (e) { console.warn('commit failed:', String(e.message).slice(0, 200)); }
  return false;
}

const argv = process.argv.slice(2); const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const loopS = Number(arg('--loop', 0)); const forMin = Number(arg('--for', 0)); const doCommit = argv.includes('--commit');
const until = Date.now() + forMin * 60_000;
for (;;) {
  const t0 = Date.now();
  try {
    if (doCommit) { try { execSync(`git pull -q --rebase -X theirs origin ${process.env.BRANCH ?? 'main'}`, { cwd: ROOT, stdio: 'ignore' }); } catch { /* keep going on the local copy */ } }
    const r = await runOnce();
    let committed = 0; if (doCommit) try { committed = JSON.parse(execSync('git show HEAD:web/public/activity/143/index.json', { cwd: ROOT, maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }).toString()).lastBlock ?? 0; } catch { /* first commit */ }
    // commit new rows, or just the cursor every ~5000 blocks (~35 min) so the browser's catch-up stays one getLogs call
    if (doCommit && (r.changed || r.head - committed > 5000)) console.log(commitAndPush(`activity: index to block ${r.head}`) ? 'pushed' : 'not pushed');
  } catch (e) { console.error('index run failed:', e.message); if (!loopS) process.exit(1); }
  if (!loopS || Date.now() + loopS * 1000 > until) break;
  await sleep(Math.max(1000, loopS * 1000 - (Date.now() - t0)));
}
