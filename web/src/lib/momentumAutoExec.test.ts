// Replay test on REAL hourly WETH/MON candles (Monad mainnet, PancakeSwap v3, public/momentum/143/candles).
// Checks the keeper planner fires take-profit at +1% and the loss-exit at the configured threshold, on the first
// hour the executable value crosses the level, and sells EXACTLY the configured share of the position. No chain I/O.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { Hex } from 'viem';
import { ASSETS, type Position } from './momentumCore.ts';
import { DEFAULT_SETTINGS, TP_PRESETS, cleanSettings, plan, type KeeperSettings, type PlanIn } from './momentumKeeper.ts';

const C: number[][] = JSON.parse(readFileSync(new URL('../../public/momentum/143/candles/WETH-MON/2026-10.json', import.meta.url), 'utf8'));
const QTY = 10n ** 18n; const BASIS = 10; // 10 MON position, 1 WETH-unit qty (amounts are checked in base units)
const pos = (t: number): Position => ({ id: 'WETH-1', asset: ASSETS[0], pos: 1, openedAt: t, entryTx: '0x1' as Hex, committedMon: BASIS, qty: QTY, entryGasMon: 0, parts: [], remainingQty: QTY, remainingBasisMon: BASIS, receivedMon: 0, gasMon: 0, status: 'OPEN', ruleVersion: 'v1', lastReconciledQty: null });
const run = (s: KeeperSettings, i0: number, horizon = 72) => {
  const entry = C[i0][4]; let peak = 1;
  for (let i = i0 + 1; i < Math.min(C.length, i0 + 1 + horizon); i++) {
    const execMon = BASIS * C[i][4] / entry; // executable value at that hour's real close
    const x: PlanIn = { now: C[i][0], settings: s, vaultMon: 0, positions: [pos(C[i0][0])], exitQuotes: { 'WETH-1': { execMon, refDevPct: 0, roundTripPct: 0.1, trendBroken: false } }, peaks: { 'WETH-1': peak }, lastExitAt: null, signals: {}, dataFresh: true, entryQuotes: {}, pauses: { entries: false, exits: false }, keeperMon: 4 };
    const p = plan(x); peak = p.peaks['WETH-1'];
    if (p.exits.length) return { i, r: (execMon / BASIS - 1) * 100, ex: p.exits[0] };
  }
  return null;
};
const firstCross = (i0: number, f: (r: number) => boolean) => { for (let i = i0 + 1; i < Math.min(C.length, i0 + 73); i++) if (f((C[i][4] / C[i0][4] - 1) * 100)) return i; return null; };

describe('auto-execute on real WETH/MON candles', () => {
  it('1% is a take-profit preset and survives the settings clamp', () => { assert.ok(TP_PRESETS.includes(1)); assert.equal(cleanSettings({ tp: 1 }).tp, 1); });
  const full = cleanSettings({ ...DEFAULT_SETTINGS, tp: 1, mode: 'full', loss: 5, hold: 720, entries: false });
  const part = cleanSettings({ ...DEFAULT_SETTINGS, tp: 1, mode: 'partial', part: 30, loss: 5, hold: 720, entries: false });
  let tpHits = 0, slHits = 0;
  for (let i0 = 0; i0 < C.length - 73; i0 += 6) {
    const res = run(full, i0); const tpAt = firstCross(i0, r => r >= 1), slAt = firstCross(i0, r => r <= -5);
    const want = tpAt != null && (slAt == null || tpAt < slAt) ? tpAt : slAt;
    if (want == null) { assert.equal(res, null, `entry ${i0}: no level crossed, nothing should sell`); continue; }
    assert.ok(res && res.i === want, `entry ${i0}: fires at the first crossing hour`);
    assert.equal(res!.ex.qty, QTY); assert.equal(res!.ex.sellPct, 100);
    if (want === tpAt) { tpHits++; assert.ok(res!.r >= 1); } else { slHits++; assert.ok(res!.r <= -5); }
  }
  it('full mode: every replayed entry closes 100% at the first +1% or −5% hour (real candles)', () => { assert.ok(tpHits > 0); console.log(`  replay: ${tpHits} take-profit closes, ${slHits} loss-exit closes`); });
  it('partial mode sells exactly the owner\'s "Sell at target" share (30%), not a hard-coded half', () => {
    const i0 = C.findIndex((_, k) => k < C.length - 73 && firstCross(k, r => r >= 1) != null && (firstCross(k, r => r <= -5) ?? 1e9) > firstCross(k, r => r >= 1)!);
    const res = run(part, i0); assert.ok(res); assert.equal(res!.ex.sellPct, 30); assert.equal(res!.ex.qty, QTY * 30n / 100n);
    console.log(`  partial: entry ${C[i0][4]} MON/WETH, fired at ${C[res!.i][4]} (+${res!.r.toFixed(3)}%), sold ${res!.ex.qty} of ${QTY} base units`);
  });
  it('loss-exit at exactly the threshold sells 100%; 0.01% short of it does not', () => {
    const at = (execMon: number, s: KeeperSettings) => plan({ now: 2000, settings: s, vaultMon: 0, positions: [pos(1000)], exitQuotes: { 'WETH-1': { execMon, refDevPct: 0, roundTripPct: 0.1, trendBroken: false } }, peaks: {}, lastExitAt: null, signals: {}, dataFresh: true, entryQuotes: {}, pauses: { entries: false, exits: false }, keeperMon: 4 }).exits;
    assert.equal(at(BASIS * 0.95, full)[0].qty, QTY); assert.equal(at(BASIS * 0.9501, full).length, 0);
    assert.equal(at(BASIS * 1.01, full)[0].qty, QTY); assert.equal(at(BASIS * 1.0099, full).length, 0);
    assert.equal(at(BASIS * 1.01, part)[0].qty, QTY * 30n / 100n);
  });
  it('auto-execute off (exits=false) never sells', () => { const off = cleanSettings({ ...full, exits: false }); assert.equal(run(off, 0), null); });
});
