import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeAbiParameters } from 'viem';
import { bestSplit, buyPath, depthCap, maxSensible, minSensible, partialAllowed, sellPath, type Depth, type Route } from './momentumDepth.ts';

describe('depth: split router', () => {
  const A = Array.from({ length: 10 }, (_, i) => BigInt((i + 1) * 100));
  const B = [150n, 250n, 300n, 320n, 330n, 335n, 338n, 340n, 341n, 342n];
  it('exact DP beats any single route on concave curves', () => { const r = bestSplit([A, B]); assert.equal(r.out, 1050n); assert.deepEqual(r.alloc, [8, 2]); });
  it('a dead route gets nothing; all-dead returns zero', () => {
    assert.deepEqual(bestSplit([A, Array(10).fill(0n)]).alloc, [10, 0]); assert.equal(bestSplit([Array(10).fill(0n)]).out, 0n);
  });
  it('paths encode tokens and fees in order and reverse for the sell', () => {
    const r: Route = { id: 'x', venue: 'pcs', label: '', tokens: ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002', '0x0000000000000000000000000000000000000003'], fees: [500, 2500] };
    assert.equal(buyPath(r).length, 2 + 2 * (20 * 3 + 3 * 2)); assert.ok(buyPath(r).endsWith('0000000000000000000000000000000000000003'));
    assert.ok(sellPath(r).endsWith('0000000000000000000000000000000000000001')); assert.ok(sellPath(r).includes('0009c4' + '0000000000000000000000000000000000000002' + '0001f4'));
  });
});
describe('depth: sensible sizes', () => {
  const weth = [{ mon: 1, rtPct: 0.1 }, { mon: 100, rtPct: 0.22 }, { mon: 250, rtPct: 0.4 }, { mon: 500, rtPct: 0.66 }, { mon: 1000, rtPct: 0.95 }];
  const wbtc = [{ mon: 1, rtPct: 7.5 }, { mon: 10, rtPct: 0.59 }, { mon: 50, rtPct: 0.2 }, { mon: 1000, rtPct: 0.15 }];
  it('monotonic curve: interpolated between measured sizes, never extrapolated', () => {
    const m = maxSensible(weth, 0.5); assert.ok(m > 250 && m < 500); assert.equal(maxSensible(weth, 1), 1000); assert.equal(maxSensible([{ mon: 1, rtPct: 5 }], 1), 0);
  });
  it('U-shaped 8-decimal curve: tiny sizes are skipped, a minimum size appears', () => {
    assert.equal(maxSensible(wbtc, 0.5), 1000); const mn = minSensible(wbtc, 0.5)!; assert.ok(mn > 10 && mn < 50); assert.equal(minSensible([{ mon: 1, rtPct: 9 }], 1), null);
  });
  it('depthCap is null when depth is stale or missing (callers keep the fixed caps)', () => {
    const d = { v: 1, generated: 1000, block: 1, sizes: [], note: '', assets: { WETH: { symbol: 'WETH', routes: [], rows: weth.map(r => ({ mon: r.mon, single: {} as any, split: { rtPct: r.rtPct } as any })), maxSensible: {}, minSensible: {}, splitHelpsFrom: null } } } as Depth;
    assert.equal(depthCap(d, 'WETH', 1, 2000), 1000); assert.equal(depthCap(d, 'WETH', 1, 1000 + 27 * 3600), null); assert.equal(depthCap(null, 'WETH', 1, 1), null); assert.equal(depthCap(d, 'SOL', 1, 2000), null);
  });
  it('partial exits need enough base units that rounding stays ≤ 0.04% (BTC fix)', () => {
    assert.equal(partialAllowed(259n), false); assert.equal(partialAllowed(2500n), true); assert.equal(partialAllowed(0n), false);
  });
});
