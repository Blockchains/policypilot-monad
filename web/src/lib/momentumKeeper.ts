// MonaDefi Momentum keeper (R3 automated exits + R4 bounded automatic entries + optional auto-sweep). Pure logic + calldata.
// ALPHA / UNAUDITED. The keeper is a GitHub Actions job with its own agent key; it acts only on v4 Unlimited vaults whose
// owner set the keeper as the vault executor with ONE signed transaction that also carries the owner's settings.
import { encodeFunctionData, hexToString, parseAbi, stringToHex, type Address, type Hex } from 'viem';
import {
  ASSETS, ENTRY_LIMITS, EXITS_V1, HOUR, assetBy, entryGates, evaluateExits,
  type Asset, type EntryQuote, type ExitParams, type Gate, type Position, type Trigger,
} from './momentumCore.ts';
import { partialAllowed } from './momentumDepth.ts';

export const KEEPER: Address = '0xDC079c2c18e5AA4844fB4a62b522962205ac7ad7';
export const KEEPER_SCHEDULE = 'every 15 minutes (GitHub Actions; scheduled runs can start late)';
/** Hard caps the keeper applies on top of the owner's settings during alpha. */
export const KEEPER_CAPS = {
  /** Alpha ceiling per position. The real per-asset cap is the measured depth: the largest size whose round trip stays within the
   *  owner's max cost (depth.json, refreshed hourly). If depth data is stale or missing, the old fixed cap applies. */
  maxPositionMon: 250, fallbackPositionMon: 10, maxOpen: 3, minEntryMon: 0.1, minSweepMon: 0.05, entryGasFloorMon: 1, exitGasFloorMon: 0.1, minHoldHours: 0.25,
  maxSlices: 6, splitMinMon: 20, corrLimit: 0.7, corrSizeFactor: 0.5,
};

// ---------------------------------------------------------------- settings (owner-signed, carried in the opt-in calldata)
export type KeeperSettings = {
  v: 1;
  a: string[];            // assets the keeper may buy (enabled assets only are honoured)
  pos: number;            // MON per position
  max: number;            // max open positions
  share: number;          // % of the vault's value that may be in Momentum positions
  loss: number;           // loss-exit trigger, % below the executable cost basis
  tp: number;             // profit target %
  mode: 'partial' | 'full';
  trail: number;          // trailing exit % below the best executable value (after the target / partial)
  hold: number;           // time stop, hours
  slip: number;           // exit slippage ceiling %, used only on the retry
  entries: boolean;       // R4 automatic entries on/off
  exits: boolean;         // R3 automated exits on/off
  sweep: boolean;         // auto-sweep free MON to the owner's wallet
  keep: number;           // MON kept in the vault (not swept) for future entries
  ackCost: boolean;       // owner accepts that gas is a large share at small sizes
  cost: number;           // max round-trip swap cost % for an entry (fresh quote); can only tighten rules v1's 1%
  // ---- v2 (optional; older opt-ins get the v1 defaults)
  eng: 'v1' | 'v2';       // signal engine for automatic entries
  twap: number;           // entry slices (1 = one shot); one slice per keeper run, each with its own fresh quote and checks
  split: boolean;         // allow a multi-route split within PancakeSwap v3 when it beats the best single route
  atr: boolean;           // ATR-based loss-exit trigger and trailing exit (only ever tighter than loss/trail above)
  dloss: number;          // daily loss circuit breaker: % of the vault's value lost in 24 h that pauses new entries
};
export const DEFAULT_SETTINGS: KeeperSettings = { v: 1, a: ['WETH'], pos: 1, max: 1, share: 50, loss: 5, tp: 8, mode: 'partial', trail: 4, hold: 168, slip: 1, entries: true, exits: true, sweep: false, keep: 0, ackCost: false, cost: 1, eng: 'v1', twap: 1, split: true, atr: false, dloss: 3 };
const clamp = (x: unknown, lo: number, hi: number, d: number) => { const n = typeof x === 'number' && Number.isFinite(x) ? x : d; return Math.min(hi, Math.max(lo, n)); };
export function cleanSettings(s: Partial<KeeperSettings> | null | undefined): KeeperSettings {
  const d = DEFAULT_SETTINGS; const x = s ?? {};
  const a = Array.isArray(x.a) ? [...new Set(x.a.map(String))].filter(sym => assetBy(sym)?.status === 'enabled') : d.a;
  return {
    v: 1, a, pos: clamp(x.pos, KEEPER_CAPS.minEntryMon, KEEPER_CAPS.maxPositionMon, d.pos), max: Math.round(clamp(x.max, 1, KEEPER_CAPS.maxOpen, d.max)),
    share: clamp(x.share, 1, 100, d.share), loss: clamp(x.loss, 0.5, 50, d.loss), tp: clamp(x.tp, 0.5, 100, d.tp), mode: x.mode === 'full' ? 'full' : 'partial',
    trail: clamp(x.trail, 0.5, 50, d.trail), hold: clamp(x.hold, KEEPER_CAPS.minHoldHours, 720, d.hold), slip: clamp(x.slip, 0.1, 5, d.slip),
    entries: x.entries !== false, exits: x.exits !== false, sweep: x.sweep === true, keep: clamp(x.keep, 0, 1e6, d.keep), ackCost: x.ackCost === true, cost: clamp(x.cost, 0.1, 1, d.cost),
    eng: x.eng === 'v2' ? 'v2' : 'v1', twap: Math.round(clamp(x.twap, 1, KEEPER_CAPS.maxSlices, d.twap)), split: x.split !== false, atr: x.atr === true, dloss: clamp(x.dloss, 0.5, 20, d.dloss),
  };
}
export const exitParams = (s: KeeperSettings): ExitParams => ({ ...EXITS_V1, lossExitPct: s.loss, profitTargetPct: s.tp, profitMode: s.mode, trailingPct: s.trail, maxHoldHours: s.hold });

export const keeperVaultAbi = parseAbi([
  'function setExecutor(address e)', 'function execute(bytes32 requestId,address recipient,uint256 amount)',
  'event ExecutorSet(address indexed executor)', 'event Executed(bytes32 indexed requestId, address indexed recipient, uint256 amount, uint256 totalSpent)',
]);
const MAGIC = '4d4f4d4b'; // "MOMK"
/** Opt-in: setExecutor(KEEPER) with the settings appended (Solidity ignores trailing calldata). One owner signature. */
export function optInCall(vault: Address, s: KeeperSettings, keeper: Address = KEEPER): { to: Address; data: Hex } {
  const base = encodeFunctionData({ abi: keeperVaultAbi, functionName: 'setExecutor', args: [keeper] });
  return { to: vault, data: `${base}${MAGIC}01${stringToHex(JSON.stringify(cleanSettings(s))).slice(2)}` as Hex };
}
/** Revoke: the owner becomes the executor again (manual control back, the keeper can do nothing). */
export const revokeCall = (vault: Address, owner: Address) => ({ to: vault, data: encodeFunctionData({ abi: keeperVaultAbi, functionName: 'setExecutor', args: [owner] }) });
/** Settings from an opt-in transaction's input; null if the input is not a keeper opt-in. */
export function decodeOptIn(input: Hex, keeper: Address = KEEPER): KeeperSettings | null {
  const x = input.toLowerCase();
  const head = encodeFunctionData({ abi: keeperVaultAbi, functionName: 'setExecutor', args: [keeper] }).toLowerCase();
  if (!x.startsWith(head)) return null;
  const rest = x.slice(head.length); if (!rest.startsWith(MAGIC + '01')) return cleanSettings(null);
  try { return cleanSettings(JSON.parse(hexToString(`0x${rest.slice(MAGIC.length + 2)}` as Hex))); } catch { return cleanSettings(null); }
}
/** Sweep request id: "MOM1" | action 3 | asset ff | unix time (4 bytes) | zero | amount. Unique per run and never a position event. */
export function sweepRid(ts: number, amount: bigint): Hex {
  const h = (n: number | bigint, b: number) => BigInt(n).toString(16).padStart(b * 2, '0');
  return `0x4d4f4d3103ff${h(ts >>> 0, 4)}${'0'.repeat(12)}${h(amount, 16)}` as Hex;
}
export const sweepCall = (vault: Address, owner: Address, amount: bigint, ts: number) => ({ to: vault, data: encodeFunctionData({ abi: keeperVaultAbi, functionName: 'execute', args: [sweepRid(ts, amount), owner, amount] }) });

// ---------------------------------------------------------------- planner (no I/O: the job feeds it chain reads and quotes)
export type Signal = { pass: boolean; why: string };
export type ExitQuote = { execMon: number | null; refDevPct: number | null; roundTripPct: number | null; trendBroken: boolean };
export type PlanIn = {
  now: number; settings: KeeperSettings; vaultMon: number; positions: Position[];
  exitQuotes: Record<string, ExitQuote>; peaks: Record<string, number>; lastExitAt: number | null;
  signals: Record<string, Signal>; dataFresh: boolean; entryQuotes: Record<string, EntryQuote | undefined>;
  pauses: { entries: boolean; exits: boolean }; keeperMon: number; forceEntry?: boolean;
  /** v2 inputs (all optional: missing = v1 behaviour, fixed caps). */
  signalsV2?: Record<string, Signal>; depthCapMon?: Record<string, number | null>; atrExits?: Record<string, { lossExitPct: number; trailingPct: number } | null>;
  corr?: Record<string, number>; twap?: Record<string, { targetMon: number; sliceMon: number; slices: number; done: boolean }>;
};
export type ExitPlan = { kind: 'exit'; pos: Position; sellPct: number; qty: bigint; triggers: Trigger[]; why: string; execMon: number };
export type EntryPlan = { kind: 'entry'; asset: Asset; amountMon: number; quote: EntryQuote; gates: Gate[]; minOut: bigint; why: string;
  /** TWAP: add to this open position (rid step = slices filled), or start a new plan. */ add?: Position; slice?: { n: number; of: number; targetMon: number; sliceMon: number } };
export type SweepPlan = { kind: 'sweep'; amountMon: number; why: string };
export type Skip = { kind: 'skip'; what: 'entry' | 'exit' | 'sweep'; asset?: string; pos?: string; why: string };
export type Plan = { exits: ExitPlan[]; entry: EntryPlan | null; sweep: SweepPlan | null; skips: Skip[]; peaks: Record<string, number>; wantQuotes: { asset: Asset; amountMon: number }[];
  twapDone: Record<string, string>; breaker: { pnlMon: number; limitMon: number; tripped: boolean } };

const open = (ps: Position[]) => ps.filter(p => p.remainingQty > 0n && p.status !== 'CLOSED');
/** Value of open positions at executable sell quotes (unknown quotes count at cost basis, so caps stay conservative). */
export const openValue = (ps: Position[], q: Record<string, ExitQuote>) => open(ps).reduce((a, p) => a + Math.max(q[p.id]?.execMon ?? 0, p.remainingBasisMon), 0);

/** Size of the next entry: min(per-position size, room under the vault share, free MON). 0 = no room. */
export function entrySize(s: KeeperSettings, vaultMon: number, ps: Position[], q: Record<string, ExitQuote>): { mon: number; why: string } {
  const inPos = openValue(ps, q); const total = vaultMon + inPos;
  const room = (s.share / 100) * total - inPos;
  const mon = Math.min(s.pos, room, vaultMon);
  const why = `size = min(${s.pos} MON per position, ${room.toFixed(4)} MON room under ${s.share}% of ${total.toFixed(4)} MON, ${vaultMon.toFixed(4)} MON free)`;
  return { mon: mon >= KEEPER_CAPS.minEntryMon ? Math.floor(mon * 1e4) / 1e4 : 0, why };
}

/** Last-24 h result for the circuit breaker: realised (sales in the window, after their gas) + unrealised on every open position. */
export function dayPnl(ps: Position[], q: Record<string, ExitQuote>, now: number): number {
  let pnl = 0;
  for (const p of ps) for (const pt of p.parts) if (pt.t >= now - 86_400) pnl += pt.monOut - pt.basisOut - pt.gasMon;
  for (const p of open(ps)) { const e = q[p.id]?.execMon; if (e != null) pnl += e - p.remainingBasisMon; }
  return pnl;
}
export const corrKey = (a: string, b: string) => [a, b].sort().join('|');
/** Pearson correlation of hourly log returns over the last `n` hours (both series priced in MON). */
export function correlation(x: number[], y: number[], n = 168): number | null {
  const k = Math.min(x.length, y.length, n + 1); if (k < 48) return null;
  const rx = x.slice(-k).slice(1).map((v, i, arr) => Math.log(v / x.slice(-k)[i])), ry = y.slice(-k).slice(1).map((v, i) => Math.log(v / y.slice(-k)[i]));
  const mx = rx.reduce((a, b) => a + b, 0) / rx.length, my = ry.reduce((a, b) => a + b, 0) / ry.length;
  let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < rx.length; i++) { sxy += (rx[i] - mx) * (ry[i] - my); sxx += (rx[i] - mx) ** 2; syy += (ry[i] - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

export function plan(x: PlanIn): Plan {
  const s = x.settings; const skips: Skip[] = []; const exits: ExitPlan[] = []; const peaks = { ...x.peaks };
  const ex0 = exitParams(s); const ops = open(x.positions); const twapDone: Record<string, string> = {};
  // ---- exits (R3): risk exits keep running even when entries are paused
  for (const p of ops) {
    const q = x.exitQuotes[p.id];
    const ratio = q?.execMon == null || p.remainingBasisMon <= 0 ? null : q.execMon / p.remainingBasisMon;
    if (ratio != null) peaks[p.id] = Math.max(peaks[p.id] ?? 1, ratio);
    if (p.status === 'MANUAL_ACTION_REQUIRED') { skips.push({ kind: 'skip', what: 'exit', pos: p.id, why: 'Tokens left the vault outside Momentum: the owner needs to look (no automatic action).' }); continue; }
    if (!s.exits) { skips.push({ kind: 'skip', what: 'exit', pos: p.id, why: 'Automated exits are off in your settings.' }); continue; }
    if (x.pauses.exits) { skips.push({ kind: 'skip', what: 'exit', pos: p.id, why: 'Keeper exits are paused by the operator.' }); continue; }
    const ax = s.atr ? x.atrExits?.[p.asset.symbol] : null; // ATR exits can only tighten the owner's settings
    const ex = ax ? { ...ex0, lossExitPct: Math.min(ex0.lossExitPct, ax.lossExitPct), trailingPct: Math.min(ex0.trailingPct, ax.trailingPct) } : ex0;
    const tr = evaluateExits({ execMon: q?.execMon ?? null, remainingBasisMon: p.remainingBasisMon, peakRatio: peaks[p.id] ?? 1, partialDone: p.parts.length > 0, openedAt: p.openedAt, now: x.now, trendBroken: !!q?.trendBroken, refDevPct: q?.refDevPct ?? null, roundTripPct: q?.roundTripPct ?? null }, ex);
    const hit = tr.filter(t => t.hit);
    if (!hit.length) { skips.push({ kind: 'skip', what: 'exit', pos: p.id, why: 'Holding: no exit rule reached.' }); continue; }
    if (q?.execMon == null) { skips.push({ kind: 'skip', what: 'exit', pos: p.id, why: 'Exit needed but there is no executable sell quote. Will retry next run.' }); continue; }
    if (x.keeperMon < KEEPER_CAPS.exitGasFloorMon) { skips.push({ kind: 'skip', what: 'exit', pos: p.id, why: 'Keeper gas too low to send the exit.' }); continue; }
    let sellPct = Math.max(...hit.map(t => t.sellPct)); let why = hit.map(t => t.why).join(' · ');
    let qty = sellPct >= 100 ? p.remainingQty : (p.remainingQty * BigInt(Math.round(sellPct * 100))) / 10_000n;
    if (sellPct < 100 && (!partialAllowed(qty) || !partialAllowed(p.remainingQty - qty))) { // BTC fix: tiny 8-decimal quantities lose to rounding
      sellPct = 100; qty = p.remainingQty; why += ` · A ${hit.map(t => t.sellPct)[0]}% sale of ${p.remainingQty} base units would lose more than 0.04% to token rounding, so the whole position is sold instead.`;
    }
    if (x.twap?.[p.id] && !x.twap[p.id].done) twapDone[p.id] = 'An exit rule fired: the remaining entry slices are cancelled.';
    exits.push({ kind: 'exit', pos: p, sellPct, qty, triggers: tr, why, execMon: q.execMon });
  }
  // ---- entry (R4): at most one per run
  let entry: EntryPlan | null = null; const wantQuotes: Plan['wantQuotes'] = [];
  const blockE = !s.entries ? 'Automatic entries are off in your settings.' : x.pauses.entries ? 'Keeper entries are paused by the operator.' : exits.length ? 'An exit runs this time; entries wait for the next run.'
    : x.keeperMon < KEEPER_CAPS.entryGasFloorMon ? `Keeper gas below ${KEEPER_CAPS.entryGasFloorMon} MON: entries stop so exits stay funded.` : null;
  const total = x.vaultMon + openValue(x.positions, x.exitQuotes); const pnl = dayPnl(x.positions, x.exitQuotes, x.now);
  const breaker = { pnlMon: +pnl.toFixed(6), limitMon: +(-(s.dloss / 100) * total).toFixed(6), tripped: pnl < -(s.dloss / 100) * total };
  const sigFor = (sym: string) => (s.eng === 'v2' ? x.signalsV2?.[sym] : x.signals[sym]);
  const engName = s.eng === 'v2' ? 'Signal v2' : 'Rules v1';
  const blockE2 = blockE ?? (breaker.tripped ? `Daily loss circuit breaker: ${pnl.toFixed(4)} MON in 24 h is past your −${s.dloss}% limit (${breaker.limitMon.toFixed(4)} MON). New entries pause; exits keep running.` : null);
  if (blockE2) { skips.push({ kind: 'skip', what: 'entry', why: blockE2 }); for (const [id, t] of Object.entries(x.twap ?? {})) if (!t.done && breaker.tripped && !blockE) twapDone[id] = 'Circuit breaker: remaining slices cancelled.'; }
  // ---- TWAP: the next slice of an entry already under way comes first (one entry action per run)
  if (!blockE2) for (const p of ops) {
    const tw = x.twap?.[p.id]; if (!tw || tw.done || twapDone[p.id]) continue;
    const a = p.asset; const sym = a.symbol; const left = tw.targetMon - p.committedMon;
    if (p.parts.length || p.slices >= tw.slices || left < Math.max(KEEPER_CAPS.minEntryMon, a.minEntryMon) - 1e-9) { twapDone[p.id] = `Entry complete: ${p.slices} slice(s), ${p.committedMon.toFixed(4)} MON.`; continue; }
    const sig = sigFor(sym);
    if (!x.forceEntry && (!x.dataFresh || !sig?.pass)) { twapDone[p.id] = `${engName} no longer passes (${sig?.why ?? 'stale data'}): remaining slices cancelled after ${p.slices}.`; continue; }
    const amt = Math.floor(Math.min(tw.sliceMon, left, x.vaultMon) * 1e4) / 1e4;
    if (amt + 1e-9 < Math.max(KEEPER_CAPS.minEntryMon, a.minEntryMon)) { skips.push({ kind: 'skip', what: 'entry', asset: sym, why: `TWAP slice waits: only ${x.vaultMon.toFixed(4)} MON free.` }); break; }
    const q = x.entryQuotes[sym];
    if (!q || Math.abs(Number(q.amountIn) / 1e18 - amt) > 1e-9) { wantQuotes.push({ asset: a, amountMon: amt }); break; }
    const g = entryGates(a, q, x.now, { openPositions: ops.length - 1, maxPositions: s.max, exposureHeld: false, pausedNew: false, dataOk: x.forceEntry ? true : x.dataFresh, maxCostPct: s.cost });
    const ok = g.gates.every(z => z.pass || (z.ack && s.ackCost));
    if (!ok) { skips.push({ kind: 'skip', what: 'entry', asset: sym, why: `TWAP slice ${p.slices + 1}/${tw.slices} waits, check failed: ${g.gates.filter(z => !z.pass && !(z.ack && s.ackCost)).map(z => `${z.label} (${z.detail})`).join('; ')}` }); break; }
    entry = { kind: 'entry', asset: a, amountMon: amt, quote: q, gates: g.gates, minOut: g.minOut, add: p, slice: { n: p.slices + 1, of: tw.slices, targetMon: tw.targetMon, sliceMon: tw.sliceMon },
      why: `TWAP slice ${p.slices + 1} of ${tw.slices} (${amt} of ${tw.targetMon} MON), fresh quote and every entry check passed again.` };
    break;
  }
  if (!blockE2 && !entry && !wantQuotes.length) for (const a of ASSETS.filter(z => s.a.includes(z.symbol))) { // registry order: WBTC is tried before cbBTC (same BTC exposure)
    const sym = a.symbol;
    if (a.status !== 'enabled') { skips.push({ kind: 'skip', what: 'entry', asset: sym, why: `${sym} is watchlist only.` }); continue; }
    const sig = sigFor(a.symbol);
    if (!x.forceEntry && !x.dataFresh) { skips.push({ kind: 'skip', what: 'entry', asset: sym, why: 'Price data is stale: no entry.' }); continue; }
    if (!x.forceEntry && !sig?.pass) { skips.push({ kind: 'skip', what: 'entry', asset: sym, why: `${engName} not met: ${sig?.why ?? 'no signal yet'}` }); continue; }
    const sz0 = entrySize(s, x.vaultMon, x.positions, x.exitQuotes);
    const dc = x.depthCapMon?.[sym]; const cap = Math.min(KEEPER_CAPS.maxPositionMon, dc == null ? KEEPER_CAPS.fallbackPositionMon : dc);
    const held = ops.map(p => ({ p, c: x.corr?.[corrKey(sym, p.asset.symbol)] ?? null })).filter(h => h.c != null && h.c >= KEEPER_CAPS.corrLimit);
    let mon = Math.min(sz0.mon, cap); let szWhy = `${sz0.why}; cap ${cap} MON (${dc == null ? 'fixed: depth data stale or missing' : `measured depth at your ${s.cost}% max cost`})`;
    if (held.length) { mon *= KEEPER_CAPS.corrSizeFactor; szWhy += `; halved: returns move with ${held.map(h => `${h.p.asset.symbol} (corr ${h.c!.toFixed(2)})`).join(', ')} already held`; }
    mon = mon >= KEEPER_CAPS.minEntryMon ? Math.floor(mon * 1e4) / 1e4 : 0;
    const slices = s.twap > 1 && mon / s.twap + 1e-9 >= Math.max(a.minEntryMon, KEEPER_CAPS.minEntryMon) ? s.twap : 1;
    const first = slices > 1 ? Math.floor((mon / slices) * 1e4) / 1e4 : mon;
    const sz = { mon: first, why: slices > 1 ? `${szWhy}; TWAP ${slices} slices of ${first} MON (one per run)` : szWhy };
    if (!sz.mon) { skips.push({ kind: 'skip', what: 'entry', asset: sym, why: `No room: ${sz.why}` }); continue; }
    if (sz.mon + 1e-9 < a.minEntryMon) { skips.push({ kind: 'skip', what: 'entry', asset: sym, why: `${sym} needs at least ${a.minEntryMon} MON per entry; ${sz.why}.` }); continue; }
    if (ops.some(p => p.asset.exposure === a.exposure)) { skips.push({ kind: 'skip', what: 'entry', asset: sym, why: `Already holding ${a.exposure} exposure (one position per underlying).` }); continue; }
    const q = x.entryQuotes[a.symbol];
    if (!q || Math.abs(Number(q.amountIn) / 1e18 - sz.mon) > 1e-9) { wantQuotes.push({ asset: a, amountMon: sz.mon }); continue; }
    const g = entryGates(a, q, x.now, { lastExitAt: x.lastExitAt ?? undefined, openPositions: ops.length, maxPositions: s.max, exposureHeld: ops.some(p => p.asset.exposure === a.exposure), pausedNew: false, dataOk: x.forceEntry ? true : x.dataFresh, maxCostPct: s.cost }, ENTRY_LIMITS);
    const ok = g.gates.every(z => z.pass || (z.ack && s.ackCost));
    if (!ok) { skips.push({ kind: 'skip', what: 'entry', asset: sym, why: `Check failed: ${g.gates.filter(z => !z.pass && !(z.ack && s.ackCost)).map(z => `${z.label} (${z.detail})`).join('; ')}` }); continue; }
    entry = { kind: 'entry', asset: a, amountMon: sz.mon, quote: q, gates: g.gates, minOut: g.minOut, ...(slices > 1 ? { slice: { n: 1, of: slices, targetMon: mon, sliceMon: first } } : {}), why: `${x.forceEntry ? 'TEST entry on a deployer-owned test vault (rule check skipped; every cost, impact and simulation check still applies). ' : 'Rules v1 pass. '}${sz.why}` };
    break;
  }
  // ---- sweep: free MON above `keep` goes to the owner (recipient pinned to vault.owner() by the job)
  let sweep: SweepPlan | null = null;
  const twapActive = Object.entries(x.twap ?? {}).some(([id, t]) => !t.done && !twapDone[id] && ops.some(p => p.id === id));
  if (s.sweep && twapActive) skips.push({ kind: 'skip', what: 'sweep', why: 'An entry is still being filled in slices: its MON is not swept.' });
  if (s.sweep && !twapActive && !exits.length && !entry && !wantQuotes.length) {
    const amt = Math.floor((x.vaultMon - s.keep) * 1e6 + 1e-6) / 1e6;
    if (x.pauses.exits) skips.push({ kind: 'skip', what: 'sweep', why: 'Keeper exits and sweeps are paused by the operator.' });
    else if (amt >= KEEPER_CAPS.minSweepMon && x.keeperMon >= KEEPER_CAPS.exitGasFloorMon) sweep = { kind: 'sweep', amountMon: amt, why: `Auto-sweep: ${amt} MON free above the ${s.keep} MON you keep for entries.` };
  }
  return { exits, entry, sweep, skips, peaks, wantQuotes, twapDone, breaker };
}
export const heldHours = (p: Position, now: number) => (now - p.openedAt) / HOUR;
export const ASSET_LIST = ASSETS;
