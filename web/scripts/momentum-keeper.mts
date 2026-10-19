// MonaDefi Momentum keeper: R3 automated exits, R4 bounded automatic entries, optional auto-sweep. ALPHA / UNAUDITED.
// One pass per run (GitHub Actions, every 15 min). Its own agent key (secret MOMENTUM_KEEPER_KEY); never the deployer key.
// Acts only on genuine v4 Unlimited vaults (factory 0x41d6…557D) whose CURRENT executor is the keeper and whose owner
// signed the opt-in (setExecutor(KEEPER) + settings). Every send is simulated first; every action is logged with its hash.
//   node --experimental-strip-types web/scripts/momentum-keeper.mts [--commit]
//   env: MOMENTUM_KEEPER_KEY, ENTRIES_PAUSED=1, EXITS_PAUSED=1, DRY_RUN=1, TEST_FORCE_ENTRY=1 (deployer-owned vaults only), RPC=… (fork)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPublicClient, createWalletClient, decodeEventLog, decodeFunctionResult, encodeFunctionData, keccak256, toHex, http, fallback, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  ASSETS, MON_USDC_POOL, PCS, WMON, V4_FACTORY, buildPositions, completed, entryCall, exitCall, factoryAbi, monPerAsset, quoteData, quoteOut,
  refDev, slot0Abi, trendBroken, usdPerAsset, usdPerMon, vaultCallAbi, type Candle, type EntryQuote, type LedgerEv, type Position,
} from '../src/lib/momentumCore.ts';
import { KEEPER, KEEPER_CAPS, cleanSettings, decodeOptIn, keeperVaultAbi, plan, sweepCall, type ExitQuote, type KeeperSettings, type Signal } from '../src/lib/momentumKeeper.ts';
// @ts-ignore plain JS helper shared with the other ops jobs (nonce management + stuck-tx replacement)
import { sendSafe } from '../../runner/chain-util.mjs';

const E = process.env; const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const OUT = E.KEEPER_DIR || path.join(ROOT, 'web/public/momentum/keeper-143'); const DATA = path.join(ROOT, 'web/public/momentum/143');
const COMMIT = process.argv.includes('--commit'); const DRY = E.DRY_RUN === '1';
const PAUSE = { entries: E.ENTRIES_PAUSED === '1' || E.ENTRIES_PAUSED === 'true', exits: E.EXITS_PAUSED === '1' || E.EXITS_PAUSED === 'true' };
const FORCE = E.TEST_FORCE_ENTRY === '1' || E.TEST_FORCE_ENTRY === 'true';
const TEST_OWNERS = ['0xc0c4e411e41becad6da860f67063c2d6363a6113']; // TEST_FORCE_ENTRY applies to vaults of these owners only
const START_BLOCK = Number(E.KEEPER_START_BLOCK || 114670000); // before the keeper key existed: no earlier opt-in is possible
const FORK = E.RPC || '';
const RPCS = FORK ? [FORK] : ['https://rpc2.monad.xyz', 'https://rpc.monad.xyz', 'https://rpc3.monad.xyz', 'https://rpc-mainnet.monadinfra.com', 'https://rpc1.monad.xyz'];
const LOG_RPC = FORK || 'https://rpc2.monad.xyz'; const CHUNK = 10_000;
const chain = { id: 143, name: 'Monad', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: RPCS } } } as const;
const transport = fallback(RPCS.map(u => http(u, { retryCount: 2, retryDelay: 700, timeout: 20_000 })), { rank: false, retryCount: 3 });
const pc = createPublicClient({ chain, transport });
const logPc = createPublicClient({ chain, transport: http(LOG_RPC, { retryCount: 3, retryDelay: 1000, timeout: 30_000 }) });
const KEY = (E.MOMENTUM_KEEPER_KEY || '').trim() as Hex;
if (!/^0x[0-9a-fA-F]{64}$/.test(KEY)) { console.error('MOMENTUM_KEEPER_KEY missing or malformed (value not printed)'); process.exit(1); }
const account = privateKeyToAccount(KEY);
if (account.address.toLowerCase() !== KEEPER.toLowerCase()) { console.error(`key does not match the published keeper address ${KEEPER}`); process.exit(1); }
const wc = createWalletClient({ chain, transport, account });
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
let skew = 0; // chain time is the clock (block timestamps); set at start
const now = () => Math.floor(Date.now() / 1000) + skew;
const rd = <T,>(f: string, d: T): T => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const big = (_k: string, x: unknown) => typeof x === 'bigint' ? x.toString() : x;
const wr = (f: string, v: unknown) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, big, 1)); };
const mon = (wei: bigint) => Number(wei) / 1e18;
const toWei = (m: number) => BigInt(Math.round(m * 1e6)) * 10n ** 12n;
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const T_EXEC_SET = keccak256(toHex('ExecutorSet(address)'));
const T_DAPP = keccak256(toHex('DappCalled(bytes32,address,bytes4,uint256,address,uint256,uint256)'));
const T_TWD = keccak256(toHex('TokenWithdrawn(address,address,uint256)'));
const short = (e: any) => String(e?.shortMessage || e?.details || e?.message || e).split('\n')[0].slice(0, 220);
const topicAddr = (a: string) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

type VaultSt = { owner: string; optInTx: string; optInBlock: number; settings: KeeperSettings; peaks: Record<string, number>; lastExitAt: number | null; evBlock: number; events: any[]; active: boolean; lastNote?: string; failures: { t: number; pos: string; why: string }[] };
const state = rd<{ lastBlock: number; vaults: Record<string, VaultSt> }>(path.join(OUT, 'state.json'), { lastBlock: START_BLOCK - 1, vaults: {} });
const actions = rd<any[]>(path.join(OUT, 'actions.json'), []);
const act = (a: Record<string, unknown>) => { const row = { t: now(), ...a }; actions.unshift(row); log('ACTION', JSON.stringify(row, big)); };

async function slot0(pool: Address) { try { return (await pc.readContract({ address: pool, abi: slot0Abi, functionName: 'slot0' }))[0] as bigint; } catch { return null; } }
async function q(tokenIn: Address, tokenOut: Address, amt: bigint, fee: number) {
  try { const r = await pc.call({ to: PCS.quoter, data: quoteData(tokenIn, tokenOut, amt, fee) }); return quoteOut(r.data); } catch { return 0n; }
}
async function gasPriceWei() { const f = await pc.estimateFeesPerGas(); return f.maxFeePerGas; }

// ---------------------------------------------------------------- discovery: owner-signed opt-ins to this keeper
async function discover(tip: number) {
  let from = state.lastBlock + 1;
  while (from <= tip) {
    const to = Math.min(tip, from + CHUNK - 1);
    const ls = await logPc.request({ method: 'eth_getLogs', params: [{ fromBlock: toHex(from), toBlock: toHex(to), topics: [T_EXEC_SET, topicAddr(KEEPER)] }] as any }) as any[];
    for (const l of ls) {
      const vault = (l.address as string).toLowerCase() as Address;
      try {
        const tx = await pc.getTransaction({ hash: l.transactionHash });
        const owner = (await pc.readContract({ address: vault, abi: vaultCallAbi, functionName: 'owner' }) as string).toLowerCase();
        const genuine = ((await pc.readContract({ address: V4_FACTORY, abi: factoryAbi, functionName: 'vaultsOf', args: [owner as Address] })) as string[]).some(v => v.toLowerCase() === vault);
        const s = tx.to?.toLowerCase() === vault ? decodeOptIn(tx.input) : null;
        if (!genuine || tx.from.toLowerCase() !== owner || !s) { log('ignored ExecutorSet', vault, { genuine, fromOwner: tx.from.toLowerCase() === owner, settings: !!s }); continue; }
        const prev = state.vaults[vault];
        state.vaults[vault] = { owner, optInTx: l.transactionHash, optInBlock: parseInt(l.blockNumber, 16), settings: s, peaks: prev?.peaks ?? {}, lastExitAt: prev?.lastExitAt ?? null, evBlock: prev?.evBlock ?? START_BLOCK - 1, events: prev?.events ?? [], active: true, failures: prev?.failures ?? [] };
        act({ vault, owner, kind: prev ? 'settings' : 'opt-in', tx: l.transactionHash, ok: true, why: prev ? 'Owner signed new keeper settings.' : 'Owner authorised the keeper for this vault.', settings: s });
      } catch (e) { log('opt-in read failed', vault, short(e)); }
    }
    state.lastBlock = to; from = to + 1;
  }
}

// ---------------------------------------------------------------- vault ledger (own incremental scan, exact before any exit)
async function scanEvents(vault: Address, v: VaultSt, tip: number) {
  let from = v.evBlock + 1;
  while (from <= tip) {
    const to = Math.min(tip, from + CHUNK - 1);
    const ls = await logPc.request({ method: 'eth_getLogs', params: [{ fromBlock: toHex(from), toBlock: toHex(to), address: vault, topics: [[T_DAPP, T_TWD]] }] as any }) as any[];
    for (const l of ls) {
      if (v.events.some(e => e.tx === l.transactionHash && e.li === l.logIndex)) continue;
      const ev: any = decodeEventLog({ abi: vaultCallAbi, data: l.data, topics: l.topics });
      const [tx, rc, blk] = await Promise.all([pc.getTransaction({ hash: l.transactionHash }), pc.getTransactionReceipt({ hash: l.transactionHash }), pc.getBlock({ blockNumber: BigInt(l.blockNumber) })]);
      const base = { block: parseInt(l.blockNumber, 16), t: Number(blk.timestamp), tx: l.transactionHash, li: l.logIndex, gasMon: (Number(tx.gas) * Number(rc.effectiveGasPrice)) / 1e18, from: tx.from.toLowerCase() };
      if (ev.eventName === 'DappCalled') v.events.push({ kind: 'call', ...base, rid: ev.args.requestId, valueWei: ev.args.value.toString(), outAsset: ev.args.outToken, received: ev.args.received.toString() });
      else v.events.push({ kind: 'tokenWithdraw', ...base, token: ev.args.token, qty: ev.args.amount.toString() });
    }
    v.evBlock = to; from = to + 1;
  }
}
const evs = (v: VaultSt): LedgerEv[] => v.events.map(e => e.kind === 'call' ? { ...e, valueWei: BigInt(e.valueWei), received: BigInt(e.received) } : { ...e, qty: BigInt(e.qty) });

// ---------------------------------------------------------------- market inputs
const candles = (id: string): Candle[] => { const idx = rd<any>(path.join(DATA, 'candles/index.json'), { series: {} }); return (idx.series[id]?.months ?? []).flatMap((m: string) => rd<Candle[]>(path.join(DATA, `candles/${id}/${m}.json`), [])); };
async function market() {
  const st = rd<any>(path.join(DATA, 'status.json'), {});
  const fresh = !!st.dataFresh && now() - (st.updated ?? 0) < 45 * 60;
  const signals: Record<string, Signal> = {};
  for (const a of ASSETS) { const s = st.signals?.[a.symbol]; signals[a.symbol] = { pass: !!s?.pass, why: s ? (s.checks ?? []).filter((c: any) => c.pass !== true).map((c: any) => c.label).join(', ') || 'all pass' : 'no signal' }; }
  const mu = await slot0(MON_USDC_POOL); const usdMon = mu ? usdPerMon(mu) : null;
  const ref: Record<string, number | null> = {}; const mid: Record<string, number | null> = {}; const trend: Record<string, boolean> = {};
  for (const a of ASSETS) {
    const sq = await slot0(a.pool); mid[a.symbol] = sq ? monPerAsset(sq, a.token0IsMon, a.decimals) : null;
    const rq = a.refPool ? await slot0(a.refPool) : null; const usdA = rq ? usdPerAsset(rq, a) : null;
    ref[a.symbol] = mid[a.symbol] && usdA && usdMon ? refDev(mid[a.symbol]!, usdA, usdMon).ref : null;
    const cs = completed(candles(`${a.symbol}-MON`), now()); const lastT = cs.length ? cs[cs.length - 1][0] : 0;
    trend[a.symbol] = cs.length > 0 && now() - lastT < 3 * 3600 ? trendBroken(cs, now()) : false;
  }
  return { fresh, signals, ref, mid, trend, gasRt: Number(st.gasRoundTripMon ?? 0.0735) };
}
async function entryQuote(a: typeof ASSETS[number], amountMon: number, m: Awaited<ReturnType<typeof market>>): Promise<EntryQuote> {
  const amountIn = toWei(amountMon); const out = await q(WMON, a.address, amountIn, a.fee); const back = out > 0n ? await q(a.address, WMON, out, a.fee) : 0n;
  return { at: now(), amountIn, out, back, midMonPerAsset: m.mid[a.symbol] ?? Infinity, refMonPerAsset: m.ref[a.symbol], gasRoundTripMon: m.gasRt };
}

// ---------------------------------------------------------------- sending (simulate → send once → confirm)
async function send(to: Address, data: Hex, what: string) {
  const gas = await pc.estimateGas({ account, to, data }); // simulation: a revert throws here and nothing is sent
  if (DRY) { log(`DRY ${what}: simulated OK, gas ${gas}`); return { hash: 'dry-run' as Hex, gasMon: 0, ok: true }; }
  const limit = (gas * 12n) / 10n;
  const r = await sendSafe({ pc, wc, tx: { to, data, gas: limit }, log: (m: string) => log(what, m) });
  const gasMon = (Number(limit) * Number(r.receipt.effectiveGasPrice)) / 1e18; // Monad charges the gas limit
  return { hash: r.hash as Hex, gasMon, ok: r.receipt.status === 'success' };
}

// ---------------------------------------------------------------- one vault
async function runVault(vault: Address, v: VaultSt, m: Awaited<ReturnType<typeof market>>, keeperMon: () => Promise<number>, tip: number, alerts: any[]) {
  const [exec, paused] = await Promise.all([pc.readContract({ address: vault, abi: vaultCallAbi, functionName: 'executor' }), pc.readContract({ address: vault, abi: vaultCallAbi, functionName: 'paused' })]);
  if ((exec as string).toLowerCase() !== KEEPER.toLowerCase()) { if (v.active) act({ vault, owner: v.owner, kind: 'revoked', ok: true, why: 'Owner revoked the keeper (vault executor changed). Nothing more happens here.' }); v.active = false; return; }
  v.active = true; if (paused) { v.lastNote = 'Vault is paused by its owner: the keeper does nothing.'; return; }
  await scanEvents(vault, v, tip);
  const bal: Record<string, bigint> = {}; for (const a of ASSETS) bal[a.address.toLowerCase()] = await pc.readContract({ address: a.address, abi: erc20, functionName: 'balanceOf', args: [vault] }) as bigint;
  const positions: Position[] = buildPositions(evs(v), bal);
  const vaultWei = await pc.getBalance({ address: vault });
  const exitQuotes: Record<string, ExitQuote> = {};
  for (const p of positions.filter(p => p.remainingQty > 0n)) {
    const outW = await q(p.asset.address, WMON, p.remainingQty, p.asset.fee);
    const mid = m.mid[p.asset.symbol], ref = m.ref[p.asset.symbol];
    exitQuotes[p.id] = { execMon: outW > 0n ? mon(outW) : null, refDevPct: mid && ref ? (mid / ref - 1) * 100 : null, roundTripPct: null, trendBroken: m.trend[p.asset.symbol] };
  }
  const force = FORCE && TEST_OWNERS.includes(v.owner);
  const input = { now: now(), settings: v.settings, vaultMon: mon(vaultWei), positions, exitQuotes, peaks: v.peaks, lastExitAt: v.lastExitAt, signals: m.signals, dataFresh: m.fresh, entryQuotes: {} as Record<string, EntryQuote>, pauses: PAUSE, keeperMon: await keeperMon(), forceEntry: force };
  let p = plan(input);
  if (p.wantQuotes.length) { for (const w of p.wantQuotes) input.entryQuotes[w.asset.symbol] = await entryQuote(w.asset, w.amountMon, m); input.now = now(); p = plan(input); }
  v.peaks = p.peaks;
  const notes = p.skips.map(s => `${s.what}${s.asset ? ' ' + s.asset : ''}${s.pos ? ' ' + s.pos : ''}: ${s.why}`);
  // exits first
  for (const x of p.exits) {
    const rid = { action: 2 as const, asset: x.pos.asset.idx, pos: x.pos.pos, step: x.pos.parts.length + 1, amount: x.qty };
    const tries = [Math.min(0.5, v.settings.slip), v.settings.slip].filter((s, i, arr) => arr.indexOf(s) === i);
    let done = false; let lastErr = '';
    for (const slip of tries) {
      const outW = await q(x.pos.asset.address, WMON, x.qty, x.pos.asset.fee);
      if (outW === 0n) { lastErr = 'no executable sell quote'; continue; }
      const minOut = (outW * BigInt(Math.round((100 - slip) * 100))) / 10_000n;
      const before = await pc.getBalance({ address: vault });
      try {
        const r = await send(vault, exitCall(x.pos.asset, vault, rid, minOut, BigInt(now() + 300)).data, `exit ${x.pos.id}`);
        if (!r.ok) { lastErr = `tx reverted ${r.hash}`; continue; }
        const got = DRY ? mon(outW) : mon((await pc.getBalance({ address: vault })) - before);
        act({ vault, owner: v.owner, kind: x.sellPct >= 100 ? 'exit' : 'partial-exit', asset: x.pos.asset.symbol, pos: x.pos.id, sellPct: x.sellPct, qty: x.qty, monOut: got, quotedMon: mon(outW), slipPct: slip, gasMon: r.gasMon, tx: r.hash, ok: true, why: x.why });
        if (x.sellPct >= 100) v.lastExitAt = now();
        done = true; break;
      } catch (e) { lastErr = short(e); log(`exit ${x.pos.id} at ${slip}% failed: ${lastErr}`); }
    }
    if (!done) { const why = `Exit failed after ${tries.length} attempt(s) within your ${v.settings.slip}% slippage ceiling: ${lastErr}`; act({ vault, owner: v.owner, kind: 'exit-failed', asset: x.pos.asset.symbol, pos: x.pos.id, ok: false, why }); v.failures.unshift({ t: now(), pos: x.pos.id, why }); v.failures = v.failures.slice(0, 20); alerts.push({ vault, owner: v.owner, pos: x.pos.id, why }); }
  }
  if (p.entry) {
    const e = p.entry; const pos = Math.max(0, ...positions.filter(z => z.asset.idx === e.asset.idx).map(z => z.pos)) + 1;
    const rid = { action: 1 as const, asset: e.asset.idx, pos, step: 0, amount: e.quote.amountIn };
    const before = bal[e.asset.address.toLowerCase()] ?? 0n;
    try {
      const r = await send(vault, entryCall(e.asset, vault, rid, e.minOut).data, `entry ${e.asset.symbol}`);
      const got = DRY ? e.quote.out : (await pc.readContract({ address: e.asset.address, abi: erc20, functionName: 'balanceOf', args: [vault] }) as bigint) - before;
      act({ vault, owner: v.owner, kind: 'entry', asset: e.asset.symbol, pos: `${e.asset.symbol}-${pos}`, amountMon: e.amountMon, qty: got, minOut: e.minOut, gasMon: r.gasMon, tx: r.hash, ok: r.ok && got >= e.minOut, why: e.why, gates: e.gates.map(g => ({ id: g.id, pass: g.pass, detail: g.detail })) });
    } catch (err) { act({ vault, owner: v.owner, kind: 'entry-failed', asset: e.asset.symbol, ok: false, why: `Simulation or send failed, nothing bought: ${short(err)}` }); }
  }
  if (p.sweep) {
    const owner = (await pc.readContract({ address: vault, abi: vaultCallAbi, functionName: 'owner' }) as string) as Address; // recipient is always the vault owner
    const amt = toWei(p.sweep.amountMon); const cur = await pc.getBalance({ address: vault });
    const send_ = amt > cur ? cur : amt;
    try {
      const r = await send(vault, sweepCall(vault, owner, send_, now()).data, 'sweep');
      act({ vault, owner: owner.toLowerCase(), kind: 'sweep', amountMon: mon(send_), to: owner, gasMon: r.gasMon, tx: r.hash, ok: r.ok, why: p.sweep.why });
    } catch (err) { act({ vault, owner: v.owner, kind: 'sweep-failed', ok: false, why: `Sweep simulation or send failed, nothing moved: ${short(err)}` }); }
  }
  v.lastNote = notes.join(' | ').slice(0, 600);
}

// ---------------------------------------------------------------- run
const t0 = Date.now(); const alerts: any[] = [];
const tipBlk = await pc.getBlock(); const tip = Number(tipBlk.number); skew = Math.max(0, Number(tipBlk.timestamp) - Math.floor(Date.now() / 1000));
await discover(tip);
const kMon = async () => mon(await pc.getBalance({ address: KEEPER }));
const m = await market();
for (const [vault, v] of Object.entries(state.vaults)) {
  try { await runVault(vault as Address, v, m, kMon, tip, alerts); }
  catch (e) { log('vault run failed', vault, short(e)); v.lastNote = `Keeper run failed for this vault: ${short(e)}`; }
}
const keeperMon = await kMon();
const gasPerRoundTrip = m.gasRt + 0.006; const runway = Math.floor(keeperMon / gasPerRoundTrip);
const low = keeperMon < 1.5;
const status = {
  product: 'MonaDefi Momentum keeper', keeper: KEEPER, updated: now(), block: tip, runSeconds: Math.round((Date.now() - t0) / 1000),
  enabled: true, pauses: PAUSE, dryRun: DRY, keeperMon: +keeperMon.toFixed(6), runwayRoundTrips: runway, lowGas: low,
  caps: KEEPER_CAPS, release: 'R3 automated exits + R4 automatic entries (enabled ahead of the research gate: backtest < 60 days, anecdotal)',
  vaults: Object.fromEntries(Object.entries(state.vaults).map(([k, v]) => [k, { owner: v.owner, active: v.active, optInTx: v.optInTx, settings: v.settings, lastNote: v.lastNote ?? null, failures: v.failures.slice(0, 5), lastExitAt: v.lastExitAt }])),
};
fs.mkdirSync(OUT, { recursive: true });
wr(path.join(OUT, 'state.json'), state); wr(path.join(OUT, 'actions.json'), actions.slice(0, 400)); wr(path.join(OUT, 'status.json'), status);
wr(E.KEEPER_OUT || '/tmp/momentum-keeper.json', { alert: { active: low || alerts.length > 0, lowGas: low, keeperMon, runway, failed: alerts }, keeper: KEEPER });
log(`done: ${Object.keys(state.vaults).length} vault(s), keeper ${keeperMon.toFixed(4)} MON (~${runway} round trips)`);
if (COMMIT && !DRY) execFileSync('bash', ['web/scripts/momentum-commit.sh'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, DIR: 'web/public/momentum/keeper-143', MSG: `momentum-keeper: run ${E.GITHUB_RUN_NUMBER ?? 'local'} [skip ci]` } });
