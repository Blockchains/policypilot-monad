// MonaDefi Momentum keeper (R3 automated exits + R4 bounded automatic entries + optional auto-sweep). Pure logic + calldata.
// ALPHA / UNAUDITED. The keeper is a GitHub Actions job with its own agent key; it acts only on v4 Unlimited vaults whose
// owner set the keeper as the vault executor with ONE signed transaction that also carries the owner's settings.
import { encodeFunctionData, hexToString, parseAbi, stringToHex, type Address, type Hex } from 'viem';
import {
  ASSETS, ENTRY_LIMITS, EXITS_V1, HOUR, assetBy, entryGates, evaluateExits,
  type Asset, type EntryQuote, type ExitParams, type Gate, type Position, type Trigger,
} from './momentumCore.ts';

export const KEEPER: Address = '0xDC079c2c18e5AA4844fB4a62b522962205ac7ad7';
export const KEEPER_SCHEDULE = 'every 15 minutes (GitHub Actions; scheduled runs can start late)';
/** Hard caps the keeper applies on top of the owner's settings during alpha. */
export const KEEPER_CAPS = { maxPositionMon: 10, maxOpen: 3, minEntryMon: 0.1, minSweepMon: 0.05, entryGasFloorMon: 1, exitGasFloorMon: 0.1, minHoldHours: 0.25 };

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
};
export const DEFAULT_SETTINGS: KeeperSettings = { v: 1, a: ['WETH'], pos: 1, max: 1, share: 50, loss: 5, tp: 8, mode: 'partial', trail: 4, hold: 168, slip: 1, entries: true, exits: true, sweep: false, keep: 0, ackCost: false };
const clamp = (x: unknown, lo: number, hi: number, d: number) => { const n = typeof x === 'number' && Number.isFinite(x) ? x : d; return Math.min(hi, Math.max(lo, n)); };
export function cleanSettings(s: Partial<KeeperSettings> | null | undefined): KeeperSettings {
  const d = DEFAULT_SETTINGS; const x = s ?? {};
  const a = Array.isArray(x.a) ? [...new Set(x.a.map(String))].filter(sym => assetBy(sym)?.status === 'enabled') : d.a;
  return {
    v: 1, a, pos: clamp(x.pos, KEEPER_CAPS.minEntryMon, KEEPER_CAPS.maxPositionMon, d.pos), max: Math.round(clamp(x.max, 1, KEEPER_CAPS.maxOpen, d.max)),
    share: clamp(x.share, 1, 100, d.share), loss: clamp(x.loss, 0.5, 50, d.loss), tp: clamp(x.tp, 0.5, 100, d.tp), mode: x.mode === 'full' ? 'full' : 'partial',
    trail: clamp(x.trail, 0.5, 50, d.trail), hold: clamp(x.hold, KEEPER_CAPS.minHoldHours, 720, d.hold), slip: clamp(x.slip, 0.1, 5, d.slip),
    entries: x.entries !== false, exits: x.exits !== false, sweep: x.sweep === true, keep: clamp(x.keep, 0, 1e6, d.keep), ackCost: x.ackCost === true,
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
};
export type ExitPlan = { kind: 'exit'; pos: Position; sellPct: number; qty: bigint; triggers: Trigger[]; why: string; execMon: number };
export type EntryPlan = { kind: 'entry'; asset: Asset; amountMon: number; quote: EntryQuote; gates: Gate[]; minOut: bigint; why: string };
export type SweepPlan = { kind: 'sweep'; amountMon: number; why: string };
export type Skip = { kind: 'skip'; what: 'entry' | 'exit' | 'sweep'; asset?: string; pos?: string; why: string };
export type Plan = { exits: ExitPlan[]; entry: EntryPlan | null; sweep: SweepPlan | null; skips: Skip[]; peaks: Record<string, number>; wantQuotes: { asset: Asset; amountMon: number }[] };

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

export function plan(x: PlanIn): Plan {
  const s = x.settings; const skips: Skip[] = []; const exits: ExitPlan[] = []; const peaks = { ...x.peaks };
  const ex = exitParams(s); const ops = open(x.positions);
  // ---- exits (R3): risk exits keep running even when entries are paused
  for (const p of ops) {
    const q = x.exitQuotes[p.id];
    const ratio = q?.execMon == null || p.remainingBasisMon <= 0 ? null : q.execMon / p.remainingBasisMon;
    if (ratio != null) peaks[p.id] = Math.max(peaks[p.id] ?? 1, ratio);
    if (p.status === 'MANUAL_ACTION_REQUIRED') { skips.push({ kind: 'skip', what: 'exit', pos: p.id, why: 'Tokens left the vault outside Momentum: the owner needs to look (no automatic action).' }); continue; }
    if (!s.exits) { skips.push({ kind: 'skip', what: 'exit', pos: p.id, why: 'Automated exits are off in your settings.' }); continue; }
    if (x.pauses.exits) { skips.push({ kind: 'skip', what: 'exit', pos: p.id, why: 'Keeper exits are paused by the operator.' }); continue; }
    const tr = evaluateExits({ execMon: q?.execMon ?? null, remainingBasisMon: p.remainingBasisMon, peakRatio: peaks[p.id] ?? 1, partialDone: p.parts.length > 0, openedAt: p.openedAt, now: x.now, trendBroken: !!q?.trendBroken, refDevPct: q?.refDevPct ?? null, roundTripPct: q?.roundTripPct ?? null }, ex);
    const hit = tr.filter(t => t.hit);
    if (!hit.length) { skips.push({ kind: 'skip', what: 'exit', pos: p.id, why: 'Holding: no exit rule reached.' }); continue; }
    if (q?.execMon == null) { skips.push({ kind: 'skip', what: 'exit', pos: p.id, why: 'Exit needed but there is no executable sell quote. Will retry next run.' }); continue; }
    if (x.keeperMon < KEEPER_CAPS.exitGasFloorMon) { skips.push({ kind: 'skip', what: 'exit', pos: p.id, why: 'Keeper gas too low to send the exit.' }); continue; }
    const sellPct = Math.max(...hit.map(t => t.sellPct));
    const qty = sellPct >= 100 ? p.remainingQty : (p.remainingQty * BigInt(Math.round(sellPct * 100))) / 10_000n;
    exits.push({ kind: 'exit', pos: p, sellPct, qty, triggers: tr, why: hit.map(t => t.why).join(' · '), execMon: q.execMon });
  }
  // ---- entry (R4): at most one per run
  let entry: EntryPlan | null = null; const wantQuotes: Plan['wantQuotes'] = [];
  const blockE = !s.entries ? 'Automatic entries are off in your settings.' : x.pauses.entries ? 'Keeper entries are paused by the operator.' : exits.length ? 'An exit runs this time; entries wait for the next run.'
    : x.keeperMon < KEEPER_CAPS.entryGasFloorMon ? `Keeper gas below ${KEEPER_CAPS.entryGasFloorMon} MON: entries stop so exits stay funded.` : null;
  if (blockE) skips.push({ kind: 'skip', what: 'entry', why: blockE });
  else for (const sym of s.a) {
    const a = assetBy(sym); if (!a) continue;
    if (a.status !== 'enabled') { skips.push({ kind: 'skip', what: 'entry', asset: sym, why: `${sym} is watchlist only.` }); continue; }
    const sig = x.signals[a.symbol];
    if (!x.forceEntry && !x.dataFresh) { skips.push({ kind: 'skip', what: 'entry', asset: sym, why: 'Price data is stale: no entry.' }); continue; }
    if (!x.forceEntry && !sig?.pass) { skips.push({ kind: 'skip', what: 'entry', asset: sym, why: `Rules v1 not met: ${sig?.why ?? 'no signal yet'}` }); continue; }
    const sz = entrySize(s, x.vaultMon, x.positions, x.exitQuotes);
    if (!sz.mon) { skips.push({ kind: 'skip', what: 'entry', asset: sym, why: `No room: ${sz.why}` }); continue; }
    const q = x.entryQuotes[a.symbol];
    if (!q || Math.abs(Number(q.amountIn) / 1e18 - sz.mon) > 1e-9) { wantQuotes.push({ asset: a, amountMon: sz.mon }); continue; }
    const g = entryGates(a, q, x.now, { lastExitAt: x.lastExitAt ?? undefined, openPositions: ops.length, maxPositions: s.max, exposureHeld: ops.some(p => p.asset.exposure === a.exposure), pausedNew: false, dataOk: x.forceEntry ? true : x.dataFresh }, ENTRY_LIMITS);
    const ok = g.gates.every(z => z.pass || (z.ack && s.ackCost));
    if (!ok) { skips.push({ kind: 'skip', what: 'entry', asset: sym, why: `Check failed: ${g.gates.filter(z => !z.pass && !(z.ack && s.ackCost)).map(z => `${z.label} (${z.detail})`).join('; ')}` }); continue; }
    entry = { kind: 'entry', asset: a, amountMon: sz.mon, quote: q, gates: g.gates, minOut: g.minOut, why: `${x.forceEntry ? 'TEST entry on a deployer-owned test vault (rule check skipped; every cost, impact and simulation check still applies). ' : 'Rules v1 pass. '}${sz.why}` };
    break;
  }
  // ---- sweep: free MON above `keep` goes to the owner (recipient pinned to vault.owner() by the job)
  let sweep: SweepPlan | null = null;
  if (s.sweep && !exits.length && !entry && !wantQuotes.length) {
    const amt = Math.floor((x.vaultMon - s.keep) * 1e6 + 1e-6) / 1e6;
    if (x.pauses.exits) skips.push({ kind: 'skip', what: 'sweep', why: 'Keeper exits and sweeps are paused by the operator.' });
    else if (amt >= KEEPER_CAPS.minSweepMon && x.keeperMon >= KEEPER_CAPS.exitGasFloorMon) sweep = { kind: 'sweep', amountMon: amt, why: `Auto-sweep: ${amt} MON free above the ${s.keep} MON you keep for entries.` };
  }
  return { exits, entry, sweep, skips, peaks, wantQuotes };
}
export const heldHours = (p: Position, now: number) => (now - p.openedAt) / HOUR;
export const ASSET_LIST = ASSETS;
