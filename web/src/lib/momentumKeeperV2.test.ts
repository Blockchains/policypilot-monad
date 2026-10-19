import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeFunctionData, type Hex } from 'viem';
import { ASSETS, assetBy, buildPositions, encodeRid, vaultCallAbi, type EntryQuote, type LedgerEv, type Position } from './momentumCore.ts';
import { DEFAULT_SETTINGS, cleanSettings, correlation, corrKey, dayPnl, plan, type PlanIn } from './momentumKeeper.ts';
import { chooseLegs, forcedHalves, splitAbi, splitEntryCall, splitExitCall } from './momentumSplit.ts';
import type { Route } from './momentumDepth.ts';

const WETH = ASSETS[0], WBTC = assetBy('WBTC')!;
const pos = (o: Partial<Position> = {}): Position => ({ id: 'WETH-1', asset: WETH, pos: 1, openedAt: 1000, entryTx: '0x1' as Hex, committedMon: 1, qty: 10n ** 14n, entryGasMon: 0.036, parts: [], remainingQty: 10n ** 14n, remainingBasisMon: 1, receivedMon: 0, gasMon: 0.036, status: 'OPEN', ruleVersion: 'v1', lastReconciledQty: null, slices: 1, ...o });
const quote = (mon: number, at = 5000): EntryQuote => { const amountIn = BigInt(Math.round(mon * 1e6)) * 10n ** 12n; const out = (amountIn * 9995n) / 10000n / 10000n; return { at, amountIn, out, back: (out * 10000n * 9995n) / 10000n, midMonPerAsset: 10000, refMonPerAsset: 10000, gasRoundTripMon: 0.03 }; };
const eq = (m: number) => ({ execMon: m, refDevPct: 0, roundTripPct: 0.1, trendBroken: false });
const base = (o: Partial<PlanIn> = {}): PlanIn => ({ now: 5000, settings: cleanSettings({ ...DEFAULT_SETTINGS, share: 100, pos: 100 }), vaultMon: 200, positions: [], exitQuotes: {}, peaks: {}, lastExitAt: null, signals: { WETH: { pass: true, why: '' } }, dataFresh: true, entryQuotes: {}, pauses: { entries: false, exits: false }, keeperMon: 3, ...o });

describe('keeper v2: sizing from measured depth', () => {
  it('caps at the depth-derived size; falls back to the old fixed 10 MON when depth is stale', () => {
    assert.deepEqual(plan(base({ depthCapMon: { WETH: 30 } })).wantQuotes.map(w => w.amountMon), [30]);
    assert.deepEqual(plan(base({ depthCapMon: { WETH: null } })).wantQuotes.map(w => w.amountMon), [10]);
    assert.deepEqual(plan(base({ depthCapMon: { WETH: 5000 } })).wantQuotes.map(w => w.amountMon), [100], 'owner size still binds');
  });
  it('halves a new position whose returns move with one already held', () => {
    const s = cleanSettings({ ...DEFAULT_SETTINGS, a: ['WETH', 'WBTC'], pos: 40, share: 100, max: 3 });
    const held = pos({ id: 'WBTC-1', asset: WBTC, qty: 100000n, remainingQty: 100000n });
    const p = plan(base({ settings: s, positions: [held], exitQuotes: { 'WBTC-1': eq(1) }, depthCapMon: { WETH: 500 }, corr: { [corrKey('WETH', 'WBTC')]: 0.82 } }));
    assert.deepEqual(p.wantQuotes.map(w => w.amountMon), [20]);
  });
});
describe('keeper v2: TWAP', () => {
  const s = cleanSettings({ ...DEFAULT_SETTINGS, pos: 15, share: 100, twap: 3 });
  it('starts with the first of N slices, each re-quoted and re-checked', () => {
    assert.deepEqual(plan(base({ settings: s, vaultMon: 20, depthCapMon: { WETH: 300 } })).wantQuotes.map(w => w.amountMon), [5]);
    const p = plan(base({ settings: s, vaultMon: 20, depthCapMon: { WETH: 300 }, entryQuotes: { WETH: quote(5) } }));
    assert.deepEqual(p.entry?.slice, { n: 1, of: 3, targetMon: 15, sliceMon: 5 }); assert.equal(p.entry?.add, undefined);
  });
  it('adds the next slice to the open position (one exposure rule does not block its own TWAP)', () => {
    const tw = { 'WETH-1': { targetMon: 15, sliceMon: 5, slices: 3, done: false } }; const open = pos({ committedMon: 5, remainingBasisMon: 5 });
    const p0 = plan(base({ settings: s, vaultMon: 15, positions: [open], exitQuotes: { 'WETH-1': eq(5) }, twap: tw }));
    assert.deepEqual(p0.wantQuotes.map(w => w.amountMon), [5]);
    const p1 = plan(base({ settings: s, vaultMon: 15, positions: [open], exitQuotes: { 'WETH-1': eq(5) }, twap: tw, entryQuotes: { WETH: quote(5) } }));
    assert.equal(p1.entry?.add?.id, 'WETH-1'); assert.equal(p1.entry?.slice?.n, 2);
    assert.match(plan(base({ settings: { ...s, sweep: true }, vaultMon: 15, positions: [open], exitQuotes: { 'WETH-1': eq(5) }, twap: tw, keeperMon: 0.5 })).skips.map(k => k.why).join(' '), /not swept/);
  });
  it('cancels the remaining slices when the signal is lost, an exit fires, or the target is reached', () => {
    const tw = { 'WETH-1': { targetMon: 15, sliceMon: 5, slices: 3, done: false } }; const open = pos({ committedMon: 5, remainingBasisMon: 5 });
    assert.match(plan(base({ settings: s, positions: [open], exitQuotes: { 'WETH-1': eq(5) }, twap: tw, signals: { WETH: { pass: false, why: 'trend' } } })).twapDone['WETH-1'], /no longer passes/);
    assert.match(plan(base({ settings: s, positions: [open], exitQuotes: { 'WETH-1': eq(4) }, twap: tw })).twapDone['WETH-1'], /exit rule fired/);
    assert.match(plan(base({ settings: s, positions: [pos({ committedMon: 15, remainingBasisMon: 15, slices: 3 })], exitQuotes: { 'WETH-1': eq(15) }, twap: tw })).twapDone['WETH-1'], /complete/);
  });
  it('ledger: a step ≥ 1 entry adds to the open position at its own cost', () => {
    const ev = (step: number, mon: number, got: bigint, block: number): LedgerEv => ({ kind: 'call', block, t: block, tx: `0x${block}` as Hex, rid: encodeRid({ action: 1, asset: WETH.idx, pos: 1, step, amount: BigInt(mon * 1e6) * 10n ** 12n }), valueWei: BigInt(mon * 1e6) * 10n ** 12n, outAsset: WETH.address, received: got, gasMon: 0.01 });
    const [p] = buildPositions([ev(0, 5, 1000n, 1), ev(1, 5, 990n, 2), ev(2, 5, 1010n, 3)]);
    assert.equal(p.slices, 3); assert.equal(p.committedMon, 15); assert.equal(p.remainingQty, 3000n); assert.equal(p.remainingBasisMon, 15); assert.ok(Math.abs(p.gasMon - 0.03) < 1e-12);
  });
});
describe('keeper v2: risk', () => {
  it('daily loss circuit breaker pauses entries, exits keep running', () => {
    const s = cleanSettings({ ...DEFAULT_SETTINGS, a: ['WETH', 'WBTC'], max: 3, dloss: 3 });
    const p = plan(base({ settings: s, vaultMon: 0.3, positions: [pos()], exitQuotes: { 'WETH-1': eq(0.96) } }));
    assert.equal(p.breaker.tripped, true); assert.match(p.skips.map(k => k.why).join(' '), /circuit breaker/); assert.equal(p.entry, null);
    assert.ok(Math.abs(dayPnl([pos()], { 'WETH-1': eq(0.96) }, 5000) + 0.04) < 1e-9);
  });
  it('ATR exits only tighten the owner\'s loss-exit trigger', () => {
    const q = { 'WETH-1': eq(0.97) };
    assert.equal(plan(base({ positions: [pos()], exitQuotes: q, atrExits: { WETH: { lossExitPct: 2, trailingPct: 2 } } })).exits.length, 0, 'atr off by default');
    const on = cleanSettings({ ...DEFAULT_SETTINGS, atr: true });
    assert.equal(plan(base({ settings: on, positions: [pos()], exitQuotes: q, atrExits: { WETH: { lossExitPct: 2, trailingPct: 2 } } })).exits.length, 1);
    assert.equal(plan(base({ settings: on, positions: [pos()], exitQuotes: q, atrExits: { WETH: { lossExitPct: 9, trailingPct: 6 } } })).exits.length, 0, 'never wider than 5%');
  });
  it('BTC fix: a partial sale too small for clean rounding becomes a full exit', () => {
    const btc = pos({ id: 'WBTC-1', asset: WBTC, qty: 259n, remainingQty: 259n });
    const p = plan(base({ positions: [btc], exitQuotes: { 'WBTC-1': eq(1.09) } }));
    assert.equal(p.exits[0].sellPct, 100); assert.equal(p.exits[0].qty, 259n); assert.match(p.exits[0].why, /rounding/);
    const big = pos({ id: 'WBTC-1', asset: WBTC, qty: 10n ** 6n, remainingQty: 10n ** 6n });
    assert.equal(plan(base({ positions: [big], exitQuotes: { 'WBTC-1': eq(1.09) } })).exits[0].sellPct, 50);
  });
  it('the v2 engine is opt-in and uses its own signal', () => {
    const v2 = cleanSettings({ ...DEFAULT_SETTINGS, eng: 'v2', share: 100, pos: 10 });
    assert.equal(plan(base({ settings: v2, vaultMon: 20, signalsV2: { WETH: { pass: false, why: 'composite' } }, entryQuotes: { WETH: quote(10) } })).entry, null);
    assert.ok(plan(base({ settings: v2, vaultMon: 20, signalsV2: { WETH: { pass: true, why: '' } }, entryQuotes: { WETH: quote(10) } })).entry);
    assert.equal(cleanSettings({}).eng, 'v1'); assert.equal(cleanSettings({ twap: 99 } as any).twap, 6);
  });
  it('correlation of MON-priced series', () => {
    const x = Array.from({ length: 200 }, (_, i) => 100 * (1 + 0.01 * Math.sin(i))); const y = x.map(v => v * 2); const z = x.map((_, i) => 100 * (1 + 0.01 * Math.cos(i * 3.3)));
    assert.ok(correlation(x, y)! > 0.99); assert.ok(Math.abs(correlation(x, z)!) < 0.5); assert.equal(correlation([1, 2], [1, 2]), null);
  });
});
describe('keeper v2: split router', () => {
  const r = (id: string, fees: number[]): Route => ({ id, venue: 'pcs', label: id, tokens: fees.length === 1 ? [WETH.address, WETH.address] : [WETH.address, WETH.address, WETH.address], fees });
  const routes = [r('a', [500]), r('b', [500, 2500])];
  it('splits only when it beats the best single route by ≥ 5 bps', () => {
    const lin = (k: number) => Array.from({ length: 10 }, (_, j) => BigInt(Math.round((j + 1) * k)));
    const conc = Array.from({ length: 10 }, (_, j) => BigInt(Math.round(1000 * Math.sqrt((j + 1) / 10) * 10)));
    assert.equal(chooseLegs(routes, [lin(100), lin(90)], 10n ** 18n).split, false);
    const c = chooseLegs(routes, [conc, conc], 10n ** 18n); assert.equal(c.split, true); assert.equal(c.legs.reduce((s, l) => s + l.amountIn, 0n), 10n ** 18n);
    assert.equal(forcedHalves(routes, [lin(100), lin(90)], 11n)!.reduce((s, l) => s + l.amountIn, 0n), 11n);
  });
  it('entry and exit calldata: one vault call, one aggregate minimum, legs add up', () => {
    const V = '0x00000000000000000000000000000000000000aa' as const; const rid = { action: 1 as const, asset: WETH.idx, pos: 1, step: 0, amount: 10n };
    const legs = [{ route: routes[0], amountIn: 6n }, { route: routes[1], amountIn: 4n }];
    const d = decodeFunctionData({ abi: vaultCallAbi, data: splitEntryCall(WETH, V, rid, legs, 7n, 99n).data });
    assert.equal(d.functionName, 'executeCall'); assert.equal((d.args as any)[2], 10n); assert.equal((d.args as any)[4].minOut, 7n);
    const mc = decodeFunctionData({ abi: splitAbi, data: (d.args as any)[3] }); assert.equal((mc.args as any)[1].length, 2);
    const x = decodeFunctionData({ abi: vaultCallAbi, data: splitExitCall(WETH, V, { ...rid, action: 2 }, legs, 7n, 99n).data });
    assert.equal((x.args as any)[4].approveAmount, 10n); assert.throws(() => splitEntryCall(WETH, V, { ...rid, amount: 11n }, legs, 7n, 99n));
  });
});
