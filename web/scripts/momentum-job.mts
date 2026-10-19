// MonaDefi Momentum data job (Release 1 + 2). Public RPCs only, no keys, no transactions.
//   - samples pool mid prices (slot0) and real buy/sell quotes every few minutes,
//   - builds hourly asset/MON candles from on-chain Swap logs (forward) and backfills older logs within a per-run budget,
//   - indexes Momentum vaults (v4 vaults whose executor is their owner) into a public ledger,
//   - evaluates rule v1, keeps paper positions and a decisions log, computes exit-alert state for real positions,
//   - rebuilds the backtest / walk-forward report when a new hour completes.
// Writes web/public/momentum/143/*. Run: node --experimental-strip-types web/scripts/momentum-job.mts [--loop 300 --for 28] [--commit]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, keccak256, toHex, type Address, type Hex } from 'viem';
import {
  ASSETS, COPY, EXITS_V1, HOUR, MON_USDC_POOL, PCS, RULES_V1, V4_FACTORY, WMON, addBackfill, addTicks, backtest, benchmarks, buildPositions, completed, evaluate,
  evaluateExits, factoryAbi, metrics, monPerAsset, quoteData, quoteOut, refDev, result, slot0Abi, trendBroken, usdPerAsset, usdPerMon, vaultCallAbi, walkForward,
  type Candle, type LedgerEv, type Position,
} from '../src/lib/momentumCore.ts';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const OUT = path.join(ROOT, 'web/public/momentum/143');
const args = process.argv.slice(2);
const flag = (k: string, d?: string) => { const i = args.indexOf(k); return i >= 0 ? (args[i + 1] ?? '1') : d; };
const LOOP = Number(flag('--loop', '0')); const FOR_MIN = Number(flag('--for', '0')); const COMMIT = args.includes('--commit');
const BACKFILL_DAYS = Number(flag('--backfill-days', '120')); const BACK_BUDGET = Number(flag('--back-chunks', '40'));
const LOG_RPC = 'https://rpc2.monad.xyz'; // 10,000-block getLogs range; the others allow 100
const RPCS = ['https://rpc2.monad.xyz', 'https://rpc.monad.xyz', 'https://rpc3.monad.xyz', 'https://rpc-mainnet.monadinfra.com', 'https://rpc1.monad.xyz'];
const CHUNK = 10_000; const PAPER_SIZE = 10; const GAS_UNITS_RT = 2 * 360_000; // measured: entry ≈ 342k, exit ≈ 350k gas
const SWAP_PCS = '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83';
const T_DAPP = keccak256(toHex('DappCalled(bytes32,address,bytes4,uint256,address,uint256,uint256)'));
const T_DEP = keccak256(toHex('Deposited(address,uint256,uint256)'));
const T_WD = keccak256(toHex('Withdrawn(address,uint256,uint256)'));
const T_TWD = keccak256(toHex('TokenWithdrawn(address,address,uint256)'));
const T_CREATED = keccak256(toHex('VaultCreated(address,address,address)'));
const FACTORY_BLOCK = 114549753;

// ---------------------------------------------------------------- rpc (paced: ≤ 4 requests/s across the whole job)
let last = 0; let reqs = 0;
async function rpc(method: string, params: unknown[], prefer = 0): Promise<any> {
  for (let i = 0; i < RPCS.length * 2; i++) {
    const url = method === 'eth_getLogs' ? LOG_RPC : RPCS[(prefer + i) % RPCS.length];
    const wait = last + 250 - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait)); last = Date.now(); reqs++;
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
      const j: any = await r.json();
      if (j.error) { if (/revert|execution/i.test(j.error.message ?? '')) throw Object.assign(new Error(j.error.message), { revert: true }); throw new Error(j.error.message); }
      return j.result;
    } catch (e: any) { if (e.revert) throw e; await new Promise(r => setTimeout(r, 600 * (i + 1))); }
  }
  throw new Error(`rpc failed: ${method}`);
}
const call = async (to: Address, data: Hex): Promise<Hex | undefined> => { try { return await rpc('eth_call', [{ to, data }, 'latest']); } catch { return undefined; } };
const head = async () => parseInt(await rpc('eth_blockNumber', []), 16);
const logs = (fromBlock: number, toBlock: number, address: Address[] | Address, topics: (string | string[] | null)[]) => rpc('eth_getLogs', [{ fromBlock: toHex(fromBlock), toBlock: toHex(toBlock), address, topics }]) as Promise<any[]>;

// ---------------------------------------------------------------- files
const rd = <T,>(f: string, d: T): T => { try { return JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')); } catch { return d; } };
const wr = (f: string, v: unknown) => { const p = path.join(OUT, f); fs.mkdirSync(path.dirname(p), { recursive: true }); const s = JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? x.toString() : x); if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== s) fs.writeFileSync(p, s); };
const SERIES = [...ASSETS.map(a => ({ id: `${a.symbol}-MON`, pool: a.pool, price: (sq: bigint) => monPerAsset(sq, a.token0IsMon, a.decimals) })), { id: 'MON-USD', pool: MON_USDC_POOL, price: usdPerMon }];
const month = (t: number) => new Date(t * 1000).toISOString().slice(0, 7);
function loadSeries(id: string): Candle[] { const idx = rd<any>('candles/index.json', { series: {} }); return (idx.series[id]?.months ?? []).flatMap((m: string) => rd<Candle[]>(`candles/${id}/${m}.json`, [])); }
function saveSeries(id: string, cs: Candle[], idx: any) {
  const by = new Map<string, Candle[]>(); for (const c of cs) { const m = month(c[0]); if (!by.has(m)) by.set(m, []); by.get(m)!.push(c.map((x, i) => i === 0 || i === 5 ? x : +x.toPrecision(8)) as Candle); }
  for (const [m, xs] of by) wr(`candles/${id}/${m}.json`, xs);
  idx.series[id] = { months: [...by.keys()].sort(), first: cs[0]?.[0] ?? null, last: cs[cs.length - 1]?.[0] ?? null, count: cs.length, unit: id === 'MON-USD' ? 'USDC per MON' : 'MON per whole asset' };
}

// ---------------------------------------------------------------- swap logs → candles
function ticksFrom(ls: any[]): Map<string, { t: number; p: number }[]> {
  const m = new Map<string, { t: number; p: number }[]>();
  for (const l of ls) {
    const s = SERIES.find(x => x.pool.toLowerCase() === l.address.toLowerCase()); if (!s) continue;
    const sq = BigInt('0x' + l.data.slice(2 + 64 * 2, 2 + 64 * 3)); // amount0, amount1, sqrtPriceX96, ...
    const t = parseInt(l.blockTimestamp, 16); const p = s.price(sq);
    if (!m.has(s.id)) m.set(s.id, []); m.get(s.id)!.push({ t, p });
  }
  return m;
}

async function scanCandles(st: any, tip: number, series: Map<string, Candle[]>) {
  const pools = SERIES.map(s => s.pool);
  // forward
  let from = st.fwdBlock ? st.fwdBlock + 1 : tip - 2 * CHUNK;
  if (!st.backBlock) st.backBlock = from;
  let n = 0;
  while (from <= tip && n < 60) {
    const to = Math.min(tip, from + CHUNK - 1);
    const ls = await logs(from, to, pools, [SWAP_PCS]);
    for (const [id, ticks] of ticksFrom(ls)) series.set(id, addTicks(series.get(id) ?? [], ticks));
    st.fwdBlock = to; from = to + 1; n++;
  }
  // backward, bounded per run
  const target = st.backTarget ?? (tip - Math.round((BACKFILL_DAYS * 86400) / 0.4)); st.backTarget = target;
  let b = 0;
  while (st.backBlock > target && b < BACK_BUDGET) {
    const to = st.backBlock - 1, fromB = Math.max(target, to - CHUNK + 1);
    const ls = await logs(fromB, to, pools, [SWAP_PCS]);
    for (const [id, ticks] of ticksFrom(ls)) series.set(id, addBackfill(series.get(id) ?? [], ticks));
    st.backBlock = fromB; b++;
  }
  return { forwardChunks: n, backChunks: b };
}

// ---------------------------------------------------------------- live sample (slot0 mids + real quotes)
type AssetSample = { mid: number | null; usdAsset: number | null; refMonPerAsset: number | null; refDevPct: number | null; quotes: { mon: number; out: string; back: string; rtPct: number | null }[] };
async function sample(): Promise<{ t: number; usdPerMon: number | null; assets: Record<string, AssetSample> }> {
  const s0 = async (pool: Address) => { const d = await call(pool, encodeFunctionData({ abi: slot0Abi, functionName: 'slot0' })); if (!d) return null; return decodeFunctionResult({ abi: slot0Abi, functionName: 'slot0', data: d })[0] as bigint; };
  const mu = await s0(MON_USDC_POOL); const usdMon = mu ? usdPerMon(mu) : null;
  const out: Record<string, AssetSample> = {};
  for (const a of ASSETS) {
    const sq = await s0(a.pool); const mid = sq ? monPerAsset(sq, a.token0IsMon, a.decimals) : null;
    const rq = a.refPool ? await s0(a.refPool) : null; const usdA = rq ? usdPerAsset(rq, a) : null;
    const rf = mid && usdA && usdMon ? refDev(mid, usdA, usdMon) : null;
    const quotes = [];
    for (const mon of a.status === 'enabled' ? [1, PAPER_SIZE] : [1, PAPER_SIZE, 30]) {
      const amt = BigInt(Math.round(mon * 1e6)) * 10n ** 12n;
      const o = quoteOut(await call(PCS.quoter, quoteData(WMON, a.address, amt, a.fee)));
      const bk = o > 0n ? quoteOut(await call(PCS.quoter, quoteData(a.address, WMON, o, a.fee))) : 0n;
      quotes.push({ mon, out: o.toString(), back: bk.toString(), rtPct: bk > 0n ? +((1 - Number(bk) / Number(amt)) * 100).toFixed(4) : null });
    }
    out[a.symbol] = { mid, usdAsset: usdA, refMonPerAsset: rf?.ref ?? null, refDevPct: rf ? +rf.devPct.toFixed(4) : null, quotes };
  }
  return { t: Math.floor(Date.now() / 1000), usdPerMon: usdMon, assets: out };
}

// ---------------------------------------------------------------- ledger of Momentum vaults (executor == owner)
async function scanLedger(st: any, tip: number, ledger: any) {
  let from = st.ledgerBlock ? st.ledgerBlock + 1 : FACTORY_BLOCK; let n = 0;
  while (from <= tip && n < 30) {
    const to = Math.min(tip, from + CHUNK - 1);
    for (const l of await logs(from, to, V4_FACTORY, [T_CREATED])) {
      const owner = ('0x' + l.topics[1].slice(26)) as Address, vault = ('0x' + l.topics[2].slice(26)) as Address, exec = ('0x' + l.topics[3].slice(26)) as Address;
      if (owner.toLowerCase() === exec.toLowerCase()) ledger.vaults[vault.toLowerCase()] ??= { owner: owner.toLowerCase(), createdBlock: parseInt(l.blockNumber, 16), createdTx: l.transactionHash, events: [] };
    }
    const vs = Object.keys(ledger.vaults);
    if (vs.length) for (const l of await logs(from, to, vs as Address[], [[T_DAPP, T_DEP, T_WD, T_TWD]])) {
      const v = ledger.vaults[l.address.toLowerCase()]; if (!v || v.events.some((e: any) => e.tx === l.transactionHash && e.li === l.logIndex)) continue;
      const ev = decodeEventLog({ abi: vaultCallAbi, data: l.data, topics: l.topics });
      const tx = await rpc('eth_getTransactionByHash', [l.transactionHash]); const rc = await rpc('eth_getTransactionReceipt', [l.transactionHash]);
      const gasMon = (Number(BigInt(tx.gas)) * Number(BigInt(rc.effectiveGasPrice))) / 1e18; // Monad charges the gas limit
      const base = { block: parseInt(l.blockNumber, 16), t: parseInt(l.blockTimestamp, 16), tx: l.transactionHash, li: l.logIndex, gasMon, from: tx.from.toLowerCase() };
      const a: any = ev.args;
      if (ev.eventName === 'DappCalled') v.events.push({ kind: 'call', ...base, rid: a.requestId, valueWei: a.value.toString(), outAsset: a.outToken, received: a.received.toString() });
      else if (ev.eventName === 'Deposited') v.events.push({ kind: 'deposit', ...base, mon: Number(a.amount) / 1e18 });
      else if (ev.eventName === 'Withdrawn') v.events.push({ kind: 'withdraw', ...base, mon: Number(a.amount) / 1e18 });
      else if (ev.eventName === 'TokenWithdrawn') v.events.push({ kind: 'tokenWithdraw', ...base, token: a.token, qty: a.amount.toString() });
    }
    st.ledgerBlock = to; from = to + 1; n++;
  }
  ledger.lastBlock = st.ledgerBlock;
}
export const ledgerEvents = (v: any): LedgerEv[] => v.events.map((e: any) => e.kind === 'call' ? { ...e, valueWei: BigInt(e.valueWei), received: BigInt(e.received) } : e.kind === 'tokenWithdraw' ? { ...e, qty: BigInt(e.qty) } : e);

// ---------------------------------------------------------------- one run
async function once() {
  reqs = 0; const t0 = Date.now();
  const st = rd<any>('state.json', {}); const idx = rd<any>('candles/index.json', { series: {} });
  const series = new Map(SERIES.map(s => [s.id, loadSeries(s.id)]));
  const tip = await head();
  const scan = await scanCandles(st, tip, series);
  const smp = await sample();
  // a sampled mid is a price observation too: candles move even in hours without swaps
  for (const a of ASSETS) { const m = smp.assets[a.symbol].mid; if (m) series.set(`${a.symbol}-MON`, addTicks(series.get(`${a.symbol}-MON`)!, [{ t: smp.t, p: m }])); }
  if (smp.usdPerMon) series.set('MON-USD', addTicks(series.get('MON-USD')!, [{ t: smp.t, p: smp.usdPerMon }]));
  for (const s of SERIES) saveSeries(s.id, series.get(s.id)!, idx);
  idx.updated = smp.t; wr('candles/index.json', idx);
  const samples = rd<any[]>('samples.json', []).filter(x => x.t > smp.t - 2 * 86400); samples.push(smp); wr('samples.json', samples);

  // gas estimate for a round trip at the current price
  const gp = Number(BigInt(await rpc('eth_gasPrice', []))); const gasRt = (GAS_UNITS_RT * gp) / 1e18;

  // signals + decisions (one per asset per completed hour)
  const now = smp.t; const hourDone = Math.floor(now / HOUR) * HOUR - HOUR;
  const decisions = rd<any[]>('decisions.json', []);
  const paper = rd<any>('paper.json', { note: `Paper positions: illustrative ${PAPER_SIZE} MON each, filled at real executable quotes from this job, never real money.`, open: [], closed: [] });
  const signals: any = {};
  for (const a of ASSETS) {
    const cs = series.get(`${a.symbol}-MON`)!; const s = smp.assets[a.symbol];
    const q = s.quotes.find(x => x.mon === PAPER_SIZE);
    const ev = evaluate(cs, now, { roundTripPct: q?.rtPct ?? null, refDevPct: s.refDevPct, gasRoundTripMon: gasRt, sizeMon: PAPER_SIZE });
    signals[a.symbol] = { status: a.status, pass: ev.pass, ruleVersion: ev.ruleVersion, checks: ev.checks, at: now, sizeMon: PAPER_SIZE };
    const seen = decisions.some(d => d.asset === a.symbol && d.hour === hourDone && d.scope === 'signal');
    const op = paper.open.find((p: any) => p.asset === a.symbol);
    // paper exits on executable sell quotes for the paper quantity
    if (op) {
      const bk = quoteOut(await call(PCS.quoter, quoteData(a.address, WMON, BigInt(op.qty), a.fee)));
      const execMon = bk > 0n ? Number(bk) / 1e18 - gasRt / 2 : null;
      const trig = evaluateExits({ execMon, remainingBasisMon: op.basisMon, peakRatio: op.peak, partialDone: op.partial, openedAt: op.openedAt, now, trendBroken: trendBroken(cs, now), refDevPct: s.refDevPct, roundTripPct: q?.rtPct ?? null }, EXITS_V1);
      if (execMon != null) op.peak = Math.max(op.peak, execMon / op.basisMon); op.execMon = execMon; op.triggers = trig;
      const hit = trig.find(t => t.hit);
      if (hit && hit.sellPct < 100 && !op.partial) {
        const part = BigInt(op.qty) * BigInt(hit.sellPct) / 100n; const got = Number(quoteOut(await call(PCS.quoter, quoteData(a.address, WMON, part, a.fee)))) / 1e18 - gasRt / 2;
        const basisOut = op.basisMon * hit.sellPct / 100; op.partials.push({ t: now, qty: part.toString(), monOut: got, basisOut }); op.received += got; op.basisMon -= basisOut; op.qty = (BigInt(op.qty) - part).toString(); op.partial = true;
        decisions.push({ t: now, hour: hourDone, asset: a.symbol, scope: 'paper', action: 'sold', reason: `Paper: ${hit.why}` });
      } else if (hit && execMon != null) {
        op.received += execMon; op.closedAt = now; op.reason = hit.id; op.netMon = op.received - op.committed; op.netPct = (op.netMon / op.committed) * 100;
        paper.open = paper.open.filter((p: any) => p !== op); paper.closed.push(op);
        decisions.push({ t: now, hour: hourDone, asset: a.symbol, scope: 'paper', action: 'sold', reason: `Paper close: ${hit.why}. Net ${op.netMon.toFixed(4)} MON (${op.netPct.toFixed(2)}%).` });
      }
    }
    if (!seen) {
      const failing = ev.checks.filter(c => c.pass !== true).map(c => c.label);
      if (ev.pass && !paper.open.some((p: any) => p.asset === a.symbol || ASSETS.find(x => x.symbol === p.asset)?.exposure === a.exposure) && q && BigInt(q.out) > 0n) {
        const committed = PAPER_SIZE + gasRt / 2;
        paper.open.push({ id: `paper-${a.symbol}-${now}`, asset: a.symbol, openedAt: now, qty: q.out, committed, basisMon: committed, received: 0, peak: 1, partial: false, partials: [], ruleVersion: RULES_V1.version });
        decisions.push({ t: now, hour: hourDone, asset: a.symbol, scope: 'signal', action: 'bought', reason: `Paper buy: all v1 checks passed (${a.status === 'enabled' ? 'eligible for a reviewed entry' : 'watchlist asset, paper only'}).` });
      } else decisions.push({ t: now, hour: hourDone, asset: a.symbol, scope: 'signal', action: ev.pass ? 'skipped' : 'no-entry', reason: ev.pass ? 'Checks passed but this exposure is already held (no adding).' : `No entry: ${failing.join(', ')}.` });
    }
  }
  wr('decisions.json', decisions.slice(-600)); wr('paper.json', paper);

  // ledger + exit alerts for real positions
  const ledger = rd<any>('ledger.json', { note: 'Momentum vaults (UnlimitedAgentVault v4 whose executor is its owner) and their on-chain events. Rebuilt from logs; anyone can verify.', vaults: {} });
  await scanLedger(st, tip, ledger); wr('ledger.json', ledger);
  const alerts: any[] = [];
  for (const [vault, v] of Object.entries<any>(ledger.vaults)) {
    const pos: Position[] = buildPositions(ledgerEvents(v));
    for (const p of pos.filter(x => x.remainingQty > 0n)) {
      const bk = quoteOut(await call(PCS.quoter, quoteData(p.asset.address, WMON, p.remainingQty, p.asset.fee)));
      const execMon = bk > 0n ? Number(bk) / 1e18 : null; const s = smp.assets[p.asset.symbol];
      const trig = evaluateExits({ execMon, remainingBasisMon: p.remainingBasisMon, peakRatio: 1, partialDone: p.parts.length > 0, openedAt: p.openedAt, now, trendBroken: trendBroken(series.get(`${p.asset.symbol}-MON`)!, now), refDevPct: s.refDevPct, roundTripPct: s.quotes[0]?.rtPct ?? null }, EXITS_V1);
      const r = result(p, { execMon, exitGasMon: gasRt / 2, usdPerMon: smp.usdPerMon });
      alerts.push({ vault, owner: v.owner, position: p.id, asset: p.asset.symbol, execMon, netMon: r.netMon, triggered: trig.filter(t => t.hit).map(t => ({ id: t.id, why: t.why, sellPct: t.sellPct })), state: trig.some(t => t.hit) ? 'EXIT_TRIGGERED' : p.status, at: now });
    }
  }

  // backtest: rebuild when a new hour completed
  const bt = rd<any>('backtest.json', {});
  if (bt.hour !== hourDone) wr('backtest.json', buildReport(series, gasRt, smp, hourDone));

  st.updated = now; st.lastRunRequests = reqs; wr('state.json', st);
  const freshest = Math.max(...SERIES.map(s => series.get(s.id)!.at(-1)?.[0] ?? 0));
  wr('status.json', {
    product: COPY.name, release: 'R1 watchlist + R2 assisted execution + R3 keeper exits + R4 bounded automatic entries (opt-in, alpha, ahead of the research gate).',
    updated: now, block: tip, cadence: 'GitHub Actions: samples every 5 minutes inside a ~28-minute loop, started twice an hour; swap logs scanned forward every sample and backfilled within a per-run budget.',
    rpcRequestsLastRun: reqs, runSeconds: Math.round((Date.now() - t0) / 1000), backfill: { toBlock: st.backBlock, targetBlock: st.backTarget, done: st.backBlock <= st.backTarget, scan },
    dataFresh: now - freshest < 2 * HOUR, gasRoundTripMon: gasRt, usdPerMon: smp.usdPerMon,
    signals, paperOpen: paper.open.length, alerts, notifications: 'In-app only. Nobody is emailed.',
    pauses: { newEntries: 'per user, in the dashboard', automation: 'not enabled (R3)', closeAndStop: 'per user, in the dashboard' },
  });
  console.log(`momentum: block ${tip}, ${reqs} rpc requests, fwd ${scan.forwardChunks} back ${scan.backChunks} chunks, ${Math.round((Date.now() - t0) / 1000)} s`);
}

function buildReport(series: Map<string, Candle[]>, gasRt: number, smp: any, hourDone: number) {
  const usd = completed(series.get('MON-USD')!, smp.t);
  const out: any = { hour: hourDone, generated: smp.t, ruleVersion: RULES_V1.version, exits: EXITS_V1, note: 'Backtest on the on-chain history this job has collected. Prices are pool mid prices from Swap logs; costs are the measured round trip at the illustrative size plus gas. Wrapper and liquidity checks are assumed to pass historically (not recorded then). No lookahead: each decision uses completed candles only and fills at that candle’s close.', assets: {} };
  for (const a of ASSETS) {
    const cs = completed(series.get(`${a.symbol}-MON`)!, smp.t);
    const q = smp.assets[a.symbol].quotes.find((x: any) => x.mon === PAPER_SIZE);
    const costs = { roundTripPct: q?.rtPct ?? 1, gasRoundTripMon: gasRt, sizeMon: PAPER_SIZE };
    const days = cs.length / 24;
    if (cs.length < 300) { out.assets[a.symbol] = { candles: cs.length, days, enough: false, reason: `Only ${days.toFixed(1)} days of history. Too short for any conclusion; nothing is reported rather than inventing results.` }; continue; }
    const n = cs.length; const iTr = Math.floor(n * 0.6), iVa = Math.floor(n * 0.8);
    const usdAt = (t: number) => { let v: number | null = null; for (const c of usd) { if (c[0] > t) break; v = c[4]; } return v; };
    const usdRatio = (from: number, to: number) => { const a0 = usdAt(cs[from][0]), a1 = usdAt(cs[to - 1][0]); return a0 && a1 ? a1 / a0 : null; };
    const seg = (from: number, to: number) => { const r = backtest(cs, RULES_V1, EXITS_V1, costs, from, to); return { from: cs[from]?.[0], to: cs[to - 1]?.[0], ...metrics(r, costs, usdRatio(from, to)), benchmarks: benchmarks(cs, costs, from, to), tradeList: r.trades.slice(-20) }; };
    out.assets[a.symbol] = {
      candles: n, days, enough: days >= 60, costs, status: a.status,
      caution: days < 60 ? `Only ${days.toFixed(0)} days of history: treat every number as anecdotal.` : 'Short sample; not evidence of an edge.',
      full: seg(0, n), train: seg(0, iTr), validation: seg(iTr, iVa), outOfSample: seg(iVa, n), walkForward: walkForward(cs, EXITS_V1, costs),
    };
  }
  return out;
}

function commit() {
  try {
    execFileSync('git', ['add', '--', 'web/public/momentum/143'], { cwd: ROOT });
    try { execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: ROOT }); return; } catch { /* changes */ }
    execFileSync('bash', ['web/scripts/momentum-commit.sh'], { cwd: ROOT, stdio: 'inherit' });
  } catch (e: any) { console.error('commit failed', e.message); }
}

const end = Date.now() + FOR_MIN * 60_000;
for (;;) {
  try { await once(); } catch (e: any) { console.error('run failed:', e.message); }
  if (COMMIT) commit();
  if (!LOOP || Date.now() + LOOP * 1000 > end) break;
  await new Promise(r => setTimeout(r, LOOP * 1000));
}
