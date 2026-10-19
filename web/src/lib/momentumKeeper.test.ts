import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeFunctionData, type Hex } from 'viem';
import { ASSETS, decodeRid, type EntryQuote, type Position } from './momentumCore.ts';
import { DEFAULT_SETTINGS, KEEPER, cleanSettings, decodeOptIn, entrySize, keeperVaultAbi, optInCall, plan, revokeCall, sweepCall, sweepRid, type PlanIn } from './momentumKeeper.ts';

const V = '0x00000000000000000000000000000000000000aa' as const, O = '0x00000000000000000000000000000000000000bb' as const;
const WETH = ASSETS[0];
const pos = (o: Partial<Position> = {}): Position => ({ id: 'WETH-1', asset: WETH, pos: 1, openedAt: 1000, entryTx: '0x1' as Hex, committedMon: 1, qty: 10n ** 14n, entryGasMon: 0.036, parts: [], remainingQty: 10n ** 14n, remainingBasisMon: 1, receivedMon: 0, gasMon: 0.036, status: 'OPEN', ruleVersion: 'v1', lastReconciledQty: null, ...o });
// a cheap, healthy WETH quote for exactly `mon`: 0.05% each way, mid = 10000 MON per WETH
const quote = (mon: number, at = 5000): EntryQuote => { const amountIn = BigInt(Math.round(mon * 1e6)) * 10n ** 12n; const out = (amountIn * 9995n) / 10000n / 10000n; return { at, amountIn, out, back: (out * 10000n * 9995n) / 10000n, midMonPerAsset: 10000, refMonPerAsset: 10000, gasRoundTripMon: 0.0001 }; };
const base = (o: Partial<PlanIn> = {}): PlanIn => ({ now: 5000, settings: cleanSettings({ ...DEFAULT_SETTINGS }), vaultMon: 2, positions: [], exitQuotes: {}, peaks: {}, lastExitAt: null, signals: { WETH: { pass: true, why: '' } }, dataFresh: true, entryQuotes: {}, pauses: { entries: false, exits: false }, keeperMon: 4, ...o });

describe('keeper settings and calldata', () => {
  it('opt-in is setExecutor(KEEPER) with the settings appended, and round-trips', () => {
    const s = cleanSettings({ pos: 0.7, max: 2, sweep: true, keep: 0.2, hold: 0.25, ackCost: true });
    const c = optInCall(V, s); assert.equal(c.to, V);
    const d = decodeFunctionData({ abi: keeperVaultAbi, data: c.data }); assert.equal(d.functionName, 'setExecutor'); assert.equal((d.args[0] as string).toLowerCase(), KEEPER.toLowerCase());
    assert.deepEqual(decodeOptIn(c.data), s);
  });
  it('plain setExecutor(KEEPER) gives defaults; other executors and garbage are handled', () => {
    assert.deepEqual(decodeOptIn(revokeCall(V, KEEPER).data), DEFAULT_SETTINGS);
    assert.equal(decodeOptIn(revokeCall(V, O).data), null);
    assert.deepEqual(decodeOptIn(`${revokeCall(V, KEEPER).data}4d4f4d4b01zz` as Hex), DEFAULT_SETTINGS);
  });
  it('clamps to the alpha caps and drops unknown assets; max cost only tightens', () => {
    const s = cleanSettings({ a: ['WETH', 'WBTC', 'cbBTC', 'SOL', 'XYZ'], pos: 999, max: 9, share: 500, loss: 0, hold: 0, slip: 50, cost: 5 });
    assert.deepEqual(s.a, ['WETH', 'WBTC', 'cbBTC', 'SOL']); assert.equal(s.cost, 1); assert.equal(cleanSettings({ cost: 0.3 }).cost, 0.3); assert.equal(s.pos, 250); assert.equal(s.max, 3); assert.equal(s.share, 100); assert.equal(s.loss, 0.5); assert.equal(s.hold, 0.25); assert.equal(s.slip, 5);
  });
  it('sweep ids are unique per run and never read as a position event; recipient is the owner', () => {
    assert.notEqual(sweepRid(1, 5n), sweepRid(2, 5n)); assert.equal(decodeRid(sweepRid(1, 5n)), null);
    const d = decodeFunctionData({ abi: keeperVaultAbi, data: sweepCall(V, O, 7n, 9).data }); assert.equal(d.functionName, 'execute'); assert.equal((d.args[1] as string).toLowerCase(), O); assert.equal(d.args[2], 7n);
  });
});

describe('keeper planner', () => {
  it('loss-exit trigger sells 100% on the executable quote', () => {
    const p = plan(base({ positions: [pos()], exitQuotes: { 'WETH-1': { execMon: 0.94, refDevPct: 0, roundTripPct: 0.1, trendBroken: false } } }));
    assert.equal(p.exits.length, 1); assert.equal(p.exits[0].sellPct, 100); assert.equal(p.exits[0].qty, 10n ** 14n); assert.match(p.exits[0].why, /Loss-exit trigger/);
    assert.equal(p.entry, null);
  });
  it('time stop fires after the owner\'s holding period', () => {
    const s = cleanSettings({ hold: 0.25 });
    assert.equal(plan(base({ settings: s, now: 1000 + 800, positions: [pos()], exitQuotes: { 'WETH-1': { execMon: 1, refDevPct: 0, roundTripPct: 0.1, trendBroken: false } } })).exits.length, 0);
    const p = plan(base({ settings: s, now: 1000 + 901, positions: [pos()], exitQuotes: { 'WETH-1': { execMon: 1, refDevPct: 0, roundTripPct: 0.1, trendBroken: false } } }));
    assert.equal(p.exits.length, 1); assert.match(p.exits[0].why, /Time limit/);
  });
  it('trailing exit uses the stored peak; partial profit sells the partial share', () => {
    const q = (m: number) => ({ 'WETH-1': { execMon: m, refDevPct: 0, roundTripPct: 0.1, trendBroken: false } });
    const p1 = plan(base({ positions: [pos()], exitQuotes: q(1.09) })); assert.equal(p1.exits[0].sellPct, 50);
    const p2 = plan(base({ positions: [pos({ parts: [{ t: 1, tx: '0x2' as Hex, qty: 1n, monOut: 1, basisOut: 1, gasMon: 0 }] })], exitQuotes: q(1.04), peaks: { 'WETH-1': 1.1 } }));
    assert.equal(p2.exits[0].sellPct, 100); assert.match(p2.exits[0].why, /Trailing/);
  });
  it('exit pause and exits-off stop exits; MANUAL_ACTION_REQUIRED is never touched', () => {
    const q = { 'WETH-1': { execMon: 0.5, refDevPct: 0, roundTripPct: 0.1, trendBroken: false } };
    assert.equal(plan(base({ positions: [pos()], exitQuotes: q, pauses: { entries: false, exits: true } })).exits.length, 0);
    assert.equal(plan(base({ settings: cleanSettings({ exits: false }), positions: [pos()], exitQuotes: q })).exits.length, 0);
    assert.equal(plan(base({ positions: [pos({ status: 'MANUAL_ACTION_REQUIRED' })], exitQuotes: q })).exits.length, 0);
  });
  it('entry: asks for a quote at the bounded size, then enters only when every gate passes', () => {
    const s = cleanSettings({ pos: 1, share: 25 });
    const p0 = plan(base({ settings: s, vaultMon: 2 })); assert.equal(p0.entry, null); assert.deepEqual(p0.wantQuotes.map(w => w.amountMon), [0.5]);
    const p1 = plan(base({ settings: s, vaultMon: 2, entryQuotes: { WETH: quote(0.5) } })); assert.ok(p1.entry); assert.equal(p1.entry!.amountMon, 0.5);
    assert.ok(p1.entry!.minOut < quote(0.5).out && p1.entry!.minOut > 0n);
  });
  it('entry is refused: rules not met, stale data, entries paused, one exposure held, cooldown, expired quote, low keeper gas', () => {
    const ok = { entryQuotes: { WETH: quote(1) } };
    assert.equal(plan(base({ ...ok, signals: { WETH: { pass: false, why: 'breakout' } } })).entry, null);
    assert.equal(plan(base({ ...ok, dataFresh: false })).entry, null);
    assert.equal(plan(base({ ...ok, pauses: { entries: true, exits: false } })).entry, null);
    assert.equal(plan(base({ ...ok, settings: cleanSettings({ max: 3 }), positions: [pos()], exitQuotes: { 'WETH-1': { execMon: 1, refDevPct: 0, roundTripPct: 0.1, trendBroken: false } }, vaultMon: 10 })).entry, null, 'no second ETH position');
    assert.equal(plan(base({ ...ok, lastExitAt: 5000 - 600 })).entry, null);
    assert.equal(plan(base({ entryQuotes: { WETH: quote(1, 5000 - 120) } })).entry, null);
    assert.equal(plan(base({ ...ok, keeperMon: 0.5 })).entry, null);
  });
  it('force entry skips only the rule check: cost gates still apply, and small sizes need the owner\'s cost ack', () => {
    const small = (ack: boolean) => { const q = quote(1); q.gasRoundTripMon = 0.073; return plan(base({ settings: cleanSettings({ ackCost: ack }), signals: { WETH: { pass: false, why: 'x' } }, forceEntry: true, entryQuotes: { WETH: q } })); };
    assert.equal(small(false).entry, null); assert.ok(small(true).entry); assert.match(small(true).entry!.why, /TEST entry/);
    const bad = quote(1); bad.back = bad.back / 2n; // 50% round trip
    assert.equal(plan(base({ forceEntry: true, entryQuotes: { WETH: bad }, settings: cleanSettings({ ackCost: true }) })).entry, null);
  });
  it('sweep: only free MON above keep, never while an exit or entry runs, respects the exit pause', () => {
    const s = cleanSettings({ sweep: true, keep: 0.3, entries: false });
    assert.equal(plan(base({ settings: s, vaultMon: 1.2 })).sweep?.amountMon, 0.9);
    assert.equal(plan(base({ settings: s, vaultMon: 0.32 })).sweep, null);
    assert.equal(plan(base({ settings: s, vaultMon: 1.2, pauses: { entries: false, exits: true } })).sweep, null);
    assert.equal(plan(base({ settings: s, vaultMon: 1.2, positions: [pos()], exitQuotes: { 'WETH-1': { execMon: 0.5, refDevPct: 0, roundTripPct: 0.1, trendBroken: false } } })).sweep, null);
  });
  it('entry size respects the vault share including open positions', () => {
    assert.equal(entrySize(cleanSettings({ pos: 5, share: 50 }), 4, [pos()], { 'WETH-1': { execMon: 1, refDevPct: 0, roundTripPct: 0, trendBroken: false } }).mon, 1.5);
    assert.equal(entrySize(cleanSettings({ pos: 5, share: 20 }), 4, [pos()], { 'WETH-1': { execMon: 1, refDevPct: 0, roundTripPct: 0, trendBroken: false } }).mon, 0);
  });
});

describe('keeper planner: WBTC, cbBTC, SOL', () => {
  const [, WBTC, CBBTC, SOL] = ASSETS;
  // healthy BTC quote: 8 decimals, mid 0.0025 BTC... expressed as MON per BTC = 4_000_000; 0.2% round trip
  const bq = (mon: number, a = WBTC, rtBps = 20n): EntryQuote => { const amountIn = BigInt(Math.round(mon * 1e6)) * 10n ** 12n; const out = (amountIn * 9990n) / 10000n / (4_000_000n * 10n ** 10n); return { at: 5000, amountIn, out, back: (amountIn * (10000n - rtBps)) / 10000n, midMonPerAsset: 4_000_000, refMonPerAsset: 4_000_000, gasRoundTripMon: 0.07 }; };
  const sig = { WETH: { pass: false, why: 'x' }, WBTC: { pass: true, why: '' }, cbBTC: { pass: true, why: '' }, SOL: { pass: true, why: '' } };
  it('BTC below its 10 MON minimum is skipped before quoting', () => {
    const p = plan(base({ settings: cleanSettings({ a: ['WBTC'], pos: 5, share: 100 }), vaultMon: 30, signals: sig }));
    assert.equal(p.entry, null); assert.equal(p.wantQuotes.length, 0); assert.ok(p.skips.some(k => k.asset === 'WBTC' && /at least 10 MON/.test(k.why)));
  });
  it('WBTC is preferred over cbBTC when both qualify, whatever order the owner listed them', () => {
    const s = cleanSettings({ a: ['cbBTC', 'WBTC'], pos: 10, share: 100 });
    const p0 = plan(base({ settings: s, vaultMon: 30, signals: sig })); assert.deepEqual(p0.wantQuotes.map(w => w.asset.symbol), ['WBTC', 'cbBTC']);
    const p1 = plan(base({ settings: s, vaultMon: 30, signals: sig, entryQuotes: { WBTC: bq(10), cbBTC: bq(10, CBBTC) } }));
    assert.equal(p1.entry?.asset.symbol, 'WBTC'); assert.equal(p1.entry?.amountMon, 10);
  });
  it('cbBTC enters when WBTC fails the cost check (2% round trip vs 1%)', () => {
    const p = plan(base({ settings: cleanSettings({ a: ['WBTC', 'cbBTC'], pos: 10, share: 100 }), vaultMon: 30, signals: sig, entryQuotes: { WBTC: bq(10, WBTC, 200n), cbBTC: bq(10, CBBTC) } }));
    assert.equal(p.entry?.asset.symbol, 'cbBTC'); assert.ok(p.skips.some(k => k.asset === 'WBTC' && /Round-trip swap cost/.test(k.why)));
  });
  it('the owner max cost tightens the check (0.1% refuses a 0.2% round trip)', () => {
    const p = plan(base({ settings: cleanSettings({ a: ['WBTC'], pos: 10, share: 100, cost: 0.1 }), vaultMon: 30, signals: sig, entryQuotes: { WBTC: bq(10) } }));
    assert.equal(p.entry, null);
  });
  it('one BTC exposure: holding WBTC blocks cbBTC', () => {
    const held = pos({ id: 'WBTC-1', asset: WBTC, remainingBasisMon: 10, committedMon: 10 });
    const p = plan(base({ settings: cleanSettings({ a: ['cbBTC'], pos: 10, max: 2, share: 100 }), vaultMon: 30, positions: [held], exitQuotes: { 'WBTC-1': { execMon: 10, refDevPct: 0, roundTripPct: 0.5, trendBroken: false } }, signals: sig, entryQuotes: { cbBTC: bq(10, CBBTC) } }));
    assert.equal(p.entry, null); assert.ok(p.skips.some(k => k.asset === 'cbBTC' && /BTC exposure/.test(k.why)));
  });
  it('SOL at a real quote (6.6% round trip, no USDC reference) is refused, never traded', () => {
    const amountIn = 10n ** 17n; const q: EntryQuote = { at: 5000, amountIn, out: 18_000n, back: (amountIn * 9339n) / 10000n, midMonPerAsset: 5500, refMonPerAsset: null, gasRoundTripMon: 0.07 };
    const p = plan(base({ settings: cleanSettings({ a: ['SOL'], pos: 0.1, share: 100, ackCost: true }), vaultMon: 2, signals: sig, entryQuotes: { SOL: q } }));
    assert.equal(p.entry, null); const k = p.skips.find(x => x.asset === 'SOL')!; assert.match(k.why, /Round-trip swap cost/); assert.match(k.why, /No USDC price for SOL/);
  });
});
