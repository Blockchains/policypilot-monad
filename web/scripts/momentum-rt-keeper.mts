// MonaDefi Momentum REAL-TIME exit keeper. ALPHA / UNAUDITED. Exits only (take-profit, loss-exit, trailing, time stop):
// entries, TWAP slices and sweeps stay with the 15-min GitHub Actions keeper, which also remains the backup sweep for exits.
// Each new Monad block (WebSocket newHeads; ~1 s HTTP polling if the socket drops) → executable sell quote for every open position
// in every opted-in vault (in parallel) → the same plan() as the 15-min keeper → close tx simulated, signed locally with a
// locally managed nonce and bumped fees, broadcast at once. Several vaults close in parallel (consecutive nonces).
// No duplicate fires: an in-memory + on-disk lock per request id, and the vault itself rejects a reused request id on chain.
// Key: the keeper's own key from the environment (MOMENTUM_KEEPER_KEY), server-side only, never printed. Never the deployer key.
//   env: MOMENTUM_KEEPER_KEY, QN_WSS, QN_HTTP (never logged), DRY_RUN=1 (simulate + sign, never broadcast),
//        RT_DIR (status/lock/log dir), STATE_URL (keeper state.json; default: the repo's raw file), FORCE_TRIGGER_VAULT (DRY_RUN only: treat
//        that vault's positions as past their level, to measure the path end-to-end without moving funds), RT_MAX_SECONDS (stop after N s)
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, decodeEventLog, fallback, http, keccak256, parseAbi, toHex, webSocket, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ASSETS, PCS, WMON, buildPositions, exitCall, encodeRid, quoteData, quoteOut, vaultCallAbi, type LedgerEv, type Position } from '../src/lib/momentumCore.ts';
import { KEEPER, cleanSettings, plan, type ExitQuote, type KeeperSettings } from '../src/lib/momentumKeeper.ts';

const E = process.env; const DRY = E.DRY_RUN === '1';
const DIR = E.RT_DIR || path.join(process.env.HOME || '/tmp', '.policypilot/rt-keeper'); fs.mkdirSync(DIR, { recursive: true });
const STATE_URL = E.STATE_URL || 'https://raw.githubusercontent.com/Blockchains/policypilot-monad/main/web/public/momentum/keeper-143/state.json';
const PUB = ['https://rpc3.monad.xyz', 'https://rpc.monad.xyz', 'https://rpc2.monad.xyz'];
const FORK = E.RPC || ''; // fork / local node: only that endpoint is used, nothing reaches Monad
const HTTPS = (FORK ? [FORK] : [E.QN_HTTP, ...PUB]).filter(Boolean) as string[];
const WSS = FORK ? E.RPC_WSS : E.QN_WSS;
if (!DRY && !FORK && E.RT_LIVE !== '1') { console.error('LIVE on Monad needs RT_LIVE=1 (use DRY_RUN=1 or RPC=<fork>)'); process.exit(1); }
const chain = { id: 143, name: 'Monad', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: HTTPS } } } as const;
const pc = createPublicClient({ chain, transport: fallback(HTTPS.map(u => http(u, { timeout: 4000, retryCount: 1, batch: { wait: 0 } }))) });
const KEY = (E.MOMENTUM_KEEPER_KEY || '').trim() as Hex;
if (!/^0x[0-9a-fA-F]{64}$/.test(KEY)) { console.error('MOMENTUM_KEEPER_KEY missing or malformed (value not printed)'); process.exit(1); }
const account = privateKeyToAccount(KEY);
if (account.address.toLowerCase() !== KEEPER.toLowerCase()) { console.error('key does not match the published keeper address'); process.exit(1); }
const redact = (s: string) => s.replace(/(quiknode\.pro\/)[A-Za-z0-9]+/g, '$1<redacted>').replace(/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g, m => m); // tx hashes stay; no key is ever in a message
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a.map(x => typeof x === 'string' ? redact(x) : x));
const short = (e: any) => redact(String(e?.shortMessage || e?.details || e?.message || e).split('\n')[0].slice(0, 200));
const mon = (w: bigint) => Number(w) / 1e18;
const big = (_k: string, x: unknown) => typeof x === 'bigint' ? x.toString() : x;
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const T_DAPP = keccak256(toHex('DappCalled(bytes32,address,bytes4,uint256,address,uint256,uint256)'));
const T_TWD = keccak256(toHex('TokenWithdrawn(address,address,uint256)'));
const actLog = (row: Record<string, unknown>) => { fs.appendFileSync(path.join(DIR, 'actions.jsonl'), JSON.stringify({ t: Math.floor(Date.now() / 1000), ...row }, big) + '\n'); log('ACTION', JSON.stringify(row, big)); };

// ---------------------------------------------------------------- vault book (refreshed every 30 s; ledger scanned incrementally)
type V = { owner: string; settings: KeeperSettings; peaks: Record<string, number>; lastExitAt: number | null; evBlock: number; events: any[]; positions: Position[]; vaultMon: number; active: boolean };
const book: Record<string, V> = {};
async function refresh() {
  const st = (STATE_URL.startsWith('http') ? await (await fetch(STATE_URL, { cache: 'no-store' })).json() : JSON.parse(fs.readFileSync(STATE_URL, 'utf8'))) as { vaults: Record<string, any> };
  const tip = Number(await pc.getBlockNumber());
  await Promise.all(Object.entries(st.vaults).map(async ([vault, s]) => {
    const prev = book[vault];
    const v: V = prev && prev.evBlock >= s.evBlock ? { ...prev, settings: cleanSettings(s.settings) } : { owner: s.owner, settings: cleanSettings(s.settings), peaks: { ...(s.peaks ?? {}), ...(prev?.peaks ?? {}) }, lastExitAt: s.lastExitAt ?? null, evBlock: s.evBlock, events: s.events ?? [], positions: [], vaultMon: 0, active: false };
    const exec = await pc.readContract({ address: vault as Address, abi: vaultCallAbi, functionName: 'executor' }) as string;
    const paused = await pc.readContract({ address: vault as Address, abi: vaultCallAbi, functionName: 'paused' }) as boolean;
    v.active = exec.toLowerCase() === KEEPER.toLowerCase() && !paused && v.settings.exits;
    if (v.active) {
      for (let from = v.evBlock + 1; from <= tip; from += 10_000) { // only this keeper's opt-in vaults; QuickNode first
        const to = Math.min(tip, from + 9_999);
        const ls = await pc.request({ method: 'eth_getLogs', params: [{ fromBlock: toHex(from), toBlock: toHex(to), address: vault as Address, topics: [[T_DAPP, T_TWD]] }] as any }) as any[];
        for (const l of ls) {
          if (v.events.some(e => e.tx === l.transactionHash && e.li === l.logIndex)) continue;
          const ev: any = decodeEventLog({ abi: vaultCallAbi, data: l.data, topics: l.topics });
          const [tx, rc, blk] = await Promise.all([pc.getTransaction({ hash: l.transactionHash }), pc.getTransactionReceipt({ hash: l.transactionHash }), pc.getBlock({ blockNumber: BigInt(l.blockNumber) })]);
          const base = { block: parseInt(l.blockNumber, 16), t: Number(blk.timestamp), tx: l.transactionHash, li: l.logIndex, gasMon: (Number(tx.gas) * Number(rc.effectiveGasPrice)) / 1e18, from: tx.from.toLowerCase() };
          v.events.push(ev.eventName === 'DappCalled' ? { kind: 'call', ...base, rid: ev.args.requestId, valueWei: ev.args.value.toString(), outAsset: ev.args.outToken, received: ev.args.received.toString() } : { kind: 'tokenWithdraw', ...base, token: ev.args.token, qty: ev.args.amount.toString() });
        }
        v.evBlock = to;
      }
      const bal: Record<string, bigint> = {};
      await Promise.all(ASSETS.map(async a => { bal[a.address.toLowerCase()] = await pc.readContract({ address: a.address, abi: erc20, functionName: 'balanceOf', args: [vault as Address] }) as bigint; }));
      const evs: LedgerEv[] = v.events.map(e => e.kind === 'call' ? { ...e, valueWei: BigInt(e.valueWei), received: BigInt(e.received) } : { ...e, qty: BigInt(e.qty) });
      v.positions = buildPositions(evs, bal).filter(p => p.remainingQty > 0n && p.status !== 'CLOSED');
      v.vaultMon = mon(await pc.getBalance({ address: vault as Address }));
      await Promise.all(v.positions.flatMap(p => [p.remainingQty, (p.remainingQty * BigInt(Math.round(v.settings.part * 100))) / 10_000n].map(async qty => { // pre-simulate the closes
        const c = exitCall(p.asset, vault as Address, { action: 2, asset: p.asset.idx, pos: p.pos, step: p.parts.length + 1, amount: qty }, 1n, BigInt(Math.floor(Date.now() / 1000) + 600));
        try { gasCache[`${vault}:${p.id}:${qty}`] = await pc.estimateGas({ account, to: c.to, data: c.data }); } catch { delete gasCache[`${vault}:${p.id}:${qty}`]; }
      })));
    } else v.positions = [];
    book[vault] = v;
  }));
}

// ---------------------------------------------------------------- sender: local nonce, bumped fees, lock, on-chain rid guard
const gasCache: Record<string, bigint> = {};
let nonce = -1; let fees = { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }; let keeperMon = 0;
const LOCKF = path.join(DIR, 'locks.json');
const locks: Record<string, number> = (() => { try { return JSON.parse(fs.readFileSync(LOCKF, 'utf8')); } catch { return {}; } })();
const saveLocks = () => fs.writeFileSync(LOCKF, JSON.stringify(locks));
async function syncAccount() {
  const [n, f, b] = await Promise.all([pc.getTransactionCount({ address: account.address, blockTag: 'pending' }), pc.estimateFeesPerGas(), pc.getBalance({ address: account.address })]);
  if (inflight === 0 || nonce < 0) nonce = n; // never rewind while our own sends are pending
  const tip = f.maxPriorityFeePerGas > 0n ? f.maxPriorityFeePerGas * 2n : 10n ** 9n; // bump: 2x tip, cap +50% and always above tip
  fees = { maxFeePerGas: (f.maxFeePerGas * 15n) / 10n + tip, maxPriorityFeePerGas: tip };
  keeperMon = mon(b);
}
let inflight = 0;
const lat: { detectMs: number; signedMs: number; sentMs: number | null; confirmMs: number | null; vault: string; pos: string; dry: boolean; block: number }[] = [];
async function close(vault: Address, v: V, x: ReturnType<typeof plan>['exits'][number], outW: bigint, tHead: number, blockN: number) {
  const rid = encodeRid({ action: 2, asset: x.pos.asset.idx, pos: x.pos.pos, step: x.pos.parts.length + 1, amount: x.qty });
  const key = `${vault}:${rid}`;
  if (locks[key] && Date.now() - locks[key] < 180_000) return; // already fired (or firing)
  locks[key] = Date.now(); saveLocks(); inflight++;
  const tDetect = performance.now();
  try {
    const qOut = x.qty === x.pos.remainingQty ? outW : (outW * x.qty) / x.pos.remainingQty;
    const minOut = (qOut * BigInt(Math.round((100 - v.settings.slip) * 100))) / 10_000n;
    const call = exitCall(x.pos.asset, vault, { action: 2, asset: x.pos.asset.idx, pos: x.pos.pos, step: x.pos.parts.length + 1, amount: x.qty }, minOut, BigInt(Math.max(Math.floor(Date.now() / 1000), headTs) + 120));
    // gas: pre-simulated off the hot path (refresh, every 30 s). Without a cached value, simulate now (a revert, incl. a reused request id, throws: nothing sent).
    const gas = gasCache[`${vault}:${x.pos.id}:${x.qty}`] ?? await pc.estimateGas({ account, to: call.to, data: call.data });
    const myNonce = nonce++;
    const raw = await account.signTransaction({ chainId: 143, type: 'eip1559', to: call.to, data: call.data, gas: (gas * 13n) / 10n, nonce: myNonce, ...fees }); // local signing, no RPC round trip
    const tSigned = performance.now();
    const row = { detectMs: Math.round(tDetect - tHead), signedMs: Math.round(tSigned - tHead), sentMs: null as number | null, confirmMs: null as number | null, vault, pos: x.pos.id, dry: DRY, block: blockN };
    if (DRY) { lat.push(row); actLog({ kind: 'rt-exit-dry', vault, pos: x.pos.id, sellPct: x.sellPct, qty: x.qty, quotedMon: mon(qOut), minOutMon: mon(minOut), gas, why: x.why, ...row }); delete locks[key]; saveLocks(); return; }
    const hash = await Promise.any(HTTPS.map(u => createPublicClient({ chain, transport: http(u, { timeout: 3000 }) }).request({ method: 'eth_sendRawTransaction', params: [raw] }))) as Hex; // broadcast to every node at once
    row.sentMs = Math.round(performance.now() - tHead);
    const rc = await pc.waitForTransactionReceipt({ hash, pollingInterval: 100, timeout: 60_000 });
    row.confirmMs = Math.round(performance.now() - tHead); lat.push(row);
    actLog({ kind: x.sellPct >= 100 ? 'exit' : 'partial-exit', via: 'rt', vault, owner: v.owner, asset: x.pos.asset.symbol, pos: x.pos.id, sellPct: x.sellPct, qty: x.qty, quotedMon: mon(qOut), minOutMon: mon(minOut), tx: hash, ok: rc.status === 'success', why: x.why, ...row });
    if (rc.status !== 'success') { delete locks[key]; saveLocks(); }
    if (x.sellPct >= 100) v.lastExitAt = Math.floor(Date.now() / 1000);
    needRefresh = true;
  } catch (e) {
    const m = short(e); actLog({ kind: 'rt-exit-failed', vault, pos: x.pos.id, ok: false, why: m });
    if (!/RequestAlreadyExecuted/.test(m)) { locks[key] = Date.now() - 178_000; saveLocks(); } nonce = -1; // retry after ~2 s (fresh quote), resync nonce
  } finally { inflight--; }
}

// ---------------------------------------------------------------- per block
let headTs = 0; let needRefresh = true; let lastBlock = 0; let busy = false; let heads = 0; let src = 'ws';
const FORCE = DRY && E.FORCE_TRIGGER_VAULT ? E.FORCE_TRIGGER_VAULT.toLowerCase() : null;
async function onBlock(n: number, tHead: number) {
  if (n <= lastBlock || busy) return; lastBlock = n; heads++; busy = true;
  try {
    if (nonce < 0 || heads % 20 === 0) await syncAccount();
    const jobs: { vault: string; v: V; p: Position }[] = [];
    for (const [vault, v] of Object.entries(book)) if (v.active) for (const p of v.positions) jobs.push({ vault, v, p });
    if (!jobs.length) return;
    const outs = await Promise.all(jobs.map(j => pc.call({ to: PCS.quoter, data: quoteData(j.p.asset.address, WMON, j.p.remainingQty, j.p.asset.fee), blockNumber: BigInt(n) }).then(r => quoteOut(r.data)).catch(() => 0n)));
    const byVault: Record<string, { v: V; q: Record<string, ExitQuote>; out: Record<string, bigint> }> = {};
    jobs.forEach((j, i) => { const b = (byVault[j.vault] ??= { v: j.v, q: {}, out: {} }); b.out[j.p.id] = outs[i]; let e = outs[i] > 0n ? mon(outs[i]) : null; if (FORCE === j.vault && e != null) e = j.p.remainingBasisMon * (1 + (j.v.settings.tp + 0.01) / 100); b.q[j.p.id] = { execMon: e, refDevPct: null, roundTripPct: null, trendBroken: false }; });
    const fires: Promise<void>[] = [];
    for (const [vault, b] of Object.entries(byVault)) {
      const pl = plan({ now: Math.floor(Date.now() / 1000), settings: { ...b.v.settings, entries: false, sweep: false }, vaultMon: b.v.vaultMon, positions: b.v.positions, exitQuotes: b.q, peaks: b.v.peaks, lastExitAt: b.v.lastExitAt, signals: {}, dataFresh: false, entryQuotes: {}, pauses: { entries: true, exits: false }, keeperMon });
      b.v.peaks = pl.peaks;
      for (const x of pl.exits) fires.push(close(vault as Address, b.v, x, b.out[x.pos.id], tHead, n)); // parallel across vaults
    }
    await Promise.all(fires);
  } catch (e) { log('block', n, 'error', short(e)); } finally { busy = false; }
}

// ---------------------------------------------------------------- feeds: WebSocket newHeads, ~1 s HTTP polling fallback
let lastHeadAt = Date.now();
function startWs() {
  if (!WSS) { src = 'http'; return; }
  const ws = createPublicClient({ chain, transport: webSocket(WSS, { reconnect: { attempts: 1e9, delay: 1000 }, keepAlive: { interval: 15_000 } }) });
  ws.watchBlocks({ emitOnBegin: false, onBlock: b => { lastHeadAt = Date.now(); src = 'ws'; headTs = Number(b.timestamp); void onBlock(Number(b.number), performance.now()); }, onError: e => log('ws error', short(e)) });
}
setInterval(async () => { // fallback: if the socket has been quiet > 2 s, poll every second
  if (Date.now() - lastHeadAt < 2000) return; src = 'http';
  try { const b = await pc.getBlock(); headTs = Number(b.timestamp); void onBlock(Number(b.number), performance.now()); } catch (e) { log('poll error', short(e)); }
}, 1000);
setInterval(() => { needRefresh = true; }, 30_000);
setInterval(async () => { if (!needRefresh) return; needRefresh = false; try { await refresh(); } catch (e) { needRefresh = true; log('refresh error', short(e)); } }, 1000);
const t0 = Date.now();
setInterval(() => { // heartbeat for the watchdog + status (no secrets, no URLs)
  const act = Object.values(book).filter(v => v.active); const p = (k: 'detectMs' | 'signedMs' | 'sentMs' | 'confirmMs') => { const xs = lat.map(r => r[k]).filter((x): x is number => x != null).sort((a, b) => a - b); return xs.length ? { n: xs.length, p50: xs[Math.floor(xs.length / 2)], p90: xs[Math.floor(xs.length * 0.9)], max: xs[xs.length - 1] } : null; };
  fs.writeFileSync(path.join(DIR, 'status.json'), JSON.stringify({ at: Math.floor(Date.now() / 1000), dry: DRY, feed: src, lastBlock, heads, uptimeS: Math.round((Date.now() - t0) / 1000), vaultsActive: act.length, openPositions: act.reduce((a, v) => a + v.positions.length, 0), keeperMon: +keeperMon.toFixed(4), latency: { detect: p('detectMs'), signed: p('signedMs'), sent: p('sentMs'), confirmed: p('confirmMs') } }, null, 1));
  if (E.RT_MAX_SECONDS && Date.now() - t0 > Number(E.RT_MAX_SECONDS) * 1000) process.exit(0);
}, 2000);
log(`rt-keeper start: ${DRY ? 'DRY RUN (nothing is broadcast)' : FORK ? 'LIVE on a local fork' : 'LIVE'}, feed ${WSS ? (FORK ? 'fork WebSocket' : 'QuickNode WebSocket') + ' + 1 s HTTP fallback' : 'HTTP 1 s polling'}${FORCE ? `, FORCE_TRIGGER ${FORCE}` : ''}`);
await refresh().catch(e => { log('first refresh failed', short(e)); needRefresh = true; }); needRefresh = false;
startWs();
