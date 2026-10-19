import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HOUR, type Candle } from './momentumCore.ts';
import { V2, atrDailyPct, atrExits, efficiency, evaluateV2, factorsV2 } from './momentumV2.ts';
const T0 = 1_780_000_000 - (1_780_000_000 % HOUR);
const mk = (f: (i: number) => number, n = 400, swaps = (_i: number) => 10): Candle[] => Array.from({ length: n }, (_, i) => { const p = f(i); return [T0 + i * HOUR, p, p * 1.002, p * 0.998, p, swaps(i)] as Candle; });
const NOW = (cs: Candle[]) => cs[cs.length - 1][0] + HOUR + 60;
const LIVE = { roundTripPct: 0.2, refDevPct: 0, gasRoundTripMon: 0.03, sizeMon: 10 };
const wiggle = (i: number) => 1 + 0.004 * Math.sin(i * 1.7) + 0.003 * Math.sin(i * 0.9);
describe('momentum v2 engine', () => {
  it('a steady uptrend vs MON scores positive and passes; contributions sum to the composite', () => {
    const cs = mk(i => 100 * Math.exp(0.0012 * i) * wiggle(i)); const s = evaluateV2(cs, NOW(cs), LIVE, null);
    assert.equal(s.regime, 'trend-up'); assert.ok(s.composite >= V2.entry, String(s.composite)); assert.equal(s.pass, true);
    assert.ok(Math.abs(s.factors.reduce((a, f) => a + f.contribution, 0) - s.composite) < 1e-3);
  });
  it('sentiment alone can never open a position', () => {
    const cs = mk(i => 100 * wiggle(i)); const s = evaluateV2(cs, NOW(cs), LIVE, { score: 1, confidence: 1 });
    assert.equal(s.pass, false); assert.equal(s.factors.find(f => f.id === 'sentiment')!.contribution, 0.1);
  });
  it('stale/missing sentiment is ignored and says so', () => {
    const cs = mk(i => 100 * Math.exp(0.0012 * i) * wiggle(i)); const f = factorsV2(cs, null)!;
    assert.equal(f.factors.find(x => x.id === 'sentiment')!.contribution, 0); assert.match(f.factors.find(x => x.id === 'sentiment')!.detail, /ignored/);
  });
  it('a downtrend is blocked by regime and rs', () => {
    const cs = mk(i => 100 * Math.exp(-0.0012 * i) * wiggle(i)); const s = evaluateV2(cs, NOW(cs), LIVE, null);
    assert.equal(s.regime, 'trend-down'); assert.equal(s.pass, false); assert.ok(s.composite < 0);
  });
  it('choppy prices are classed as chop (factor 0, higher bar)', () => {
    const cs = mk(i => 100 * (1 + 0.01 * Math.sin(i * 2.1))); assert.ok(efficiency(cs.map(c => c[4]), 48) < V2.chopEr);
    assert.equal(factorsV2(cs, null)!.regime, 'chop');
  });
  it('ATR exits are clamped to sane ranges; the v1 hard gates still apply', () => {
    assert.deepEqual(atrExits(0.5), { lossExitPct: 2, trailingPct: 2 }); assert.deepEqual(atrExits(20), { lossExitPct: 8, trailingPct: 6 }); assert.equal(atrExits(null), null);
    const cs = mk(i => 100 * Math.exp(0.0012 * i) * wiggle(i)); assert.ok(atrDailyPct(cs)! > 0);
    assert.equal(evaluateV2(cs, NOW(cs), { ...LIVE, roundTripPct: 5 }, null).pass, false);
  });
});
