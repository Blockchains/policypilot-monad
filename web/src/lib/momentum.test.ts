import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { decodeFunctionData, parseEther, type Hex } from 'viem';
import {
  ASSETS, COPY, ENABLED, EXITS_V1, EXIT_STATES, HOUR, RULES_V1, STATES, addBackfill, addTicks, backtest, benchmarks, buildPositions, can, completed, decodeRid, encodeRid,
  costStatus, entryCall, entryGates, evaluate, evaluateExits, exitCall, metrics, minEconomical, monPerAsset, preferredOver, netByFlows, refDev, result, routerAbi, size, step, usdPerAsset, vaultCallAbi, walkForward,
  type Candle, type LedgerEv,
} from './momentumCore.ts';

const WETH = ASSETS[0];
const H0 = 1_790_000_000 - (1_790_000_000 % HOUR);
const series = (n: number, f: (i: number) => number): Candle[] => Array.from({ length: n }, (_, i) => { const p = f(i); return [H0 + i * HOUR, p, p * 1.001, p * 0.999, p, 3]; });
const LIVE = { roundTripPct: 0.1, refDevPct: 0.2, gasRoundTripMon: 0.07, sizeMon: 10 };

describe('registry', () => {
  it('matches the public versioned JSON; all four are enabled with per-asset minimums', () => {
    const j = JSON.parse(fs.readFileSync(new URL('../../public/momentum/143/assets.v1.json', import.meta.url), 'utf8'));
    assert.equal(j.version, 1);
    for (const a of ASSETS) {
      const x = j.assets.find((y: any) => y.symbol === a.symbol);
      assert.ok(x, a.symbol); assert.equal(x.address, a.address); assert.equal(x.decimals, a.decimals); assert.equal(x.status, a.status);
      assert.equal(x.minEntryMon, a.minEntryMon); assert.equal(x.route.pool, a.pool); assert.equal(x.route.fee, a.fee); assert.equal(x.route.token0IsMon, a.token0IsMon);
      assert.ok(x.issuer && x.bridge && x.upgradeability && x.transfer, 'issuer, bridge, upgradeability and transfer are recorded');
    }
    assert.deepEqual(ENABLED().map(a => a.symbol), ['WETH', 'WBTC', 'cbBTC', 'SOL']);
    assert.deepEqual(ASSETS.map(a => a.minEntryMon), [0.1, 10, 10, 0.1]);
    assert.deepEqual(j.exposures.BTC.members.sort(), ['WBTC', 'cbBTC'], 'cbBTC and WBTC are one BTC exposure');
  });
  it('copy: the review sentence, the alpha warning and no guaranteed-return wording', () => {
    assert.equal(COPY.review, 'This strategy may invest up to your approved amount in eligible assets. It will attempt to sell when a profit target, loss threshold, trend failure, or time limit is reached. Exit prices are not guaranteed. It may remain inactive when no trade qualifies.');
    assert.equal(COPY.alpha, 'Alpha · unaudited contract · only deposit what you’re happy to lose');
    const all = JSON.stringify(COPY) + JSON.stringify(EXITS_V1);
    assert.doesNotMatch(all, /guarantee(d)? (return|profit)|risk[- ]free|max loss/i);
  });
});

describe('prices and candles', () => {
  it('pool prices in MON per asset for both token orders', () => {
    // token0 = WMON, 1 MON = 1e-5 WETH  → 100,000 MON per WETH
    const sq = BigInt(Math.round(Math.sqrt(1e-5) * 2 ** 96));
    assert.ok(Math.abs(monPerAsset(sq, true, 18) - 100_000) / 100_000 < 1e-9);
    // token0 = WBTC (8 dp), 1 sat = 0.04 MON → raw ratio = 0.04e18 / 1 = 4e16 → 4,000,000 MON per BTC
    const sq2 = BigInt(Math.round(Math.sqrt(4e16) * 2 ** 96));
    assert.ok(Math.abs(monPerAsset(sq2, false, 8) - 4_000_000) / 4e6 < 1e-6);
    const r = refDev(101, 2000, 20); assert.equal(r.ref, 100); assert.ok(Math.abs(r.devPct - 1) < 1e-9);
    assert.ok(usdPerAsset(BigInt(Math.round(Math.sqrt(1 / 2400e12) * 2 ** 96)), WETH) > 2399); // USDC is token0 for WETH
  });
  it('hourly candles: OHLC, gap fill, only completed hours, backfill never rewrites known hours', () => {
    let cs = addTicks([], [{ t: H0 + 10, p: 10 }, { t: H0 + 20, p: 12 }, { t: H0 + 30, p: 9 }, { t: H0 + 40, p: 11 }, { t: H0 + 2 * HOUR + 5, p: 13 }]);
    assert.deepEqual(cs[0], [H0, 10, 12, 9, 11, 4]);
    const done = completed(cs, H0 + 3 * HOUR + 1);
    assert.equal(done.length, 3); assert.deepEqual(done[1], [H0 + HOUR, 11, 11, 11, 11, 0]);
    assert.equal(completed(cs, H0 + 2 * HOUR + 100).length, 1, 'the forming hour is excluded and trailing gaps are not invented');
    cs = addBackfill(cs, [{ t: H0 + 50, p: 99 }, { t: H0 - HOUR + 1, p: 8 }]);
    assert.equal(cs[1][4], 11, 'known hour untouched'); assert.equal(cs[0][4], 8);
  });
});

describe('rule engine v1', () => {
  const up = series(300, i => 100 * (1 + 0.0004 * i) * (1 + 0.002 * Math.sin(i / 3)));
  const now = up[up.length - 1][0] + HOUR + 5;
  it('a steady uptrend vs MON passes every check, each with an explanation', () => {
    const ev = evaluate(up, now, LIVE);
    for (const c of ev.checks) { assert.ok(c.label && c.value && c.need && c.why, c.id); }
    assert.deepEqual(ev.checks.map(c => c.id), ['data', 'momentum', 'trend', 'breakout', 'extension', 'volatility', 'liquidity', 'wrapper', 'cost']);
    assert.equal(ev.pass, true, JSON.stringify(ev.checks.filter(c => !c.pass)));
    assert.equal(ev.ruleVersion, 'v1');
  });
  it('a downtrend fails momentum and trend; missing quotes are not a pass', () => {
    const down = series(300, i => 100 * (1 - 0.0004 * i));
    const ev = evaluate(down, now, null);
    const by = Object.fromEntries(ev.checks.map(c => [c.id, c.pass]));
    assert.equal(by.momentum, false); assert.equal(by.trend, false); assert.equal(by.liquidity, null); assert.equal(ev.pass, false);
  });
  it('stale or short data blocks entry', () => {
    assert.equal(evaluate(up, now + 5 * HOUR, LIVE).checks[0].pass, false);
    assert.equal(evaluate(up.slice(0, 100), up[99][0] + HOUR + 5, LIVE).pass, false);
  });
  it('cost check includes gas: 1 MON fails, 10 MON passes', () => {
    assert.equal(evaluate(up, now, { ...LIVE, sizeMon: 1 }).checks.find(c => c.id === 'cost')!.pass, false);
    assert.equal(evaluate(up, now, LIVE).checks.find(c => c.id === 'cost')!.pass, true);
  });
});

describe('exits', () => {
  const base = { remainingBasisMon: 10, peakRatio: 1, partialDone: false, openedAt: 0, now: HOUR, trendBroken: false, refDevPct: 0.1, roundTripPct: 0.1 };
  const hit = (x: any, e = EXITS_V1) => evaluateExits({ ...base, ...x }, e).filter(t => t.hit).map(t => t.id);
  it('uses executable sell proceeds', () => {
    assert.deepEqual(hit({ execMon: 10.2 }), []);
    assert.deepEqual(hit({ execMon: 9.4 }), ['loss']);
    assert.deepEqual(hit({ execMon: 10.9 }), ['partial']);
    assert.deepEqual(hit({ execMon: 10.9 }, { ...EXITS_V1, profitMode: 'full' }), ['profit']);
  });
  it('trailing after the partial, time limit, trend, incident (no sell quote)', () => {
    assert.deepEqual(hit({ execMon: 10.3, partialDone: true, peakRatio: 1.1 }), ['trailing']);
    assert.deepEqual(hit({ execMon: 10, now: 169 * HOUR }), ['time']);
    assert.deepEqual(hit({ execMon: 10, trendBroken: true }), ['trend']);
    assert.ok(hit({ execMon: null }).includes('incident'));
    assert.ok(hit({ execMon: 10, refDevPct: 4 }).includes('incident'));
  });
});

describe('sizing', () => {
  const x = { allocationMon: 50, availableMon: 50, openExposureMon: 0, riskPerTradePct: 1, lossExitPct: 5, maxPerPositionMon: 20, maxTotalExposureMon: 30, liquidityCapMon: 100, gasRoundTripMon: 0.07, roundTripPct: 0.1, maxTotalCostPct: 2, gasReserveMon: 0.5, hasOpenSameExposure: false };
  it('notional = risk budget / loss distance, then caps', () => {
    const s = size(x); assert.equal(s.raw, 10); assert.equal(s.notionalMon, 10); assert.deepEqual(s.caps, []);
    assert.equal(size({ ...x, riskPerTradePct: 4 }).notionalMon, 20); assert.deepEqual(size({ ...x, riskPerTradePct: 4 }).caps, ['max per position']);
    assert.equal(size({ ...x, riskPerTradePct: 4, openExposureMon: 25 }).notionalMon, 5);
    assert.equal(size({ ...x, availableMon: 3 }).notionalMon, 2.5, 'no leverage: never more than available minus the gas reserve');
  });
  it('no averaging down, minimum economical size', () => {
    assert.match(size({ ...x, hasOpenSameExposure: true }).blocked!, /No averaging down/);
    assert.ok(Math.abs(minEconomical(0.07, 0.1, 2) - 3.684) < 0.01);
    assert.equal(size({ ...x, allocationMon: 5, availableMon: 5 }).belowEconomical, true);
    assert.equal(minEconomical(0.07, 3, 2), Infinity);
  });
});

describe('request ids and calldata', () => {
  it('round-trips and is deterministic (submit once)', () => {
    const r = { action: 1 as const, asset: 0, pos: 7, step: 0, amount: parseEther('0.5') };
    const id = encodeRid(r); assert.equal(id.length, 66); assert.deepEqual(decodeRid(id), r); assert.equal(encodeRid(r), id);
    assert.equal(decodeRid('0x' + '00'.repeat(32)), null);
  });
  it('entry and exit calls decode to the vault call with the router swap, approval and minOut', () => {
    const vault = '0x000000000000000000000000000000000000bEEF' as const;
    const e = entryCall(WETH, vault, { action: 1, asset: 0, pos: 1, step: 0, amount: 10n ** 18n }, 123n);
    const d = decodeFunctionData({ abi: vaultCallAbi, data: e.data });
    assert.equal(d.functionName, 'executeCall'); const [, target, value, inner, o] = d.args as any;
    assert.equal(value, 10n ** 18n); assert.equal(target, '0x21114915Ac6d5A2e156931e20B20b038dEd0Be7C'); assert.equal(o.outToken, WETH.address); assert.equal(o.minOut, 123n);
    const sw = decodeFunctionData({ abi: routerAbi, data: inner as Hex }); assert.equal((sw.args as any)[0].recipient, vault);
    const x = exitCall(WETH, vault, { action: 2, asset: 0, pos: 1, step: 1, amount: 555n }, 99n, 1n);
    const dx = decodeFunctionData({ abi: vaultCallAbi, data: x.data }); const ox = (dx.args as any)[4];
    assert.equal(ox.approveToken, WETH.address); assert.equal(ox.approveAmount, 555n); assert.equal(ox.outToken, '0x0000000000000000000000000000000000000000'); assert.equal(ox.minOut, 99n);
  });
  it('entry gates: every gate must pass; low economics needs an explicit tick, not a silent pass', () => {
    const q = { at: 1000, amountIn: parseEther('1'), out: 8_828_148_476_185n, back: parseEther('0.99899'), midMonPerAsset: 113_216.7, refMonPerAsset: 112_828, gasRoundTripMon: 0.07 };
    const g = entryGates(WETH, q, 1010, { openPositions: 0, maxPositions: 2, exposureHeld: false, pausedNew: false, dataOk: true });
    assert.equal(g.gates.find(x => x.id === 'economical')!.pass, false); assert.equal(g.gates.find(x => x.id === 'economical')!.ack, true);
    assert.equal(g.ok, true); assert.ok(g.minOut < q.out && g.minOut > (q.out * 99n) / 100n);
    assert.equal(entryGates(WETH, q, 1040, { openPositions: 0, maxPositions: 2, exposureHeld: false, pausedNew: false, dataOk: true }).ok, false, 'quote expired');
    assert.equal(entryGates(WETH, { ...q, back: 0n }, 1010, { openPositions: 0, maxPositions: 2, exposureHeld: false, pausedNew: false, dataOk: true }).ok, false, 'no exit route');
    assert.equal(entryGates(WETH, q, 1010, { openPositions: 0, maxPositions: 2, exposureHeld: true, pausedNew: false, dataOk: true }).ok, false);
    assert.equal(entryGates(WETH, q, 1010, { openPositions: 0, maxPositions: 2, exposureHeld: false, pausedNew: true, dataOk: true }).ok, false);
    const o = { openPositions: 0, maxPositions: 2, exposureHeld: false, pausedNew: false, dataOk: true };
    // user max cost only tightens: 0.05% max refuses this 0.10% round trip; 5% is capped at rules v1's 1%
    assert.equal(entryGates(WETH, q, 1010, { ...o, maxCostPct: 0.05 }).gates.find(x => x.id === 'roundtrip')!.pass, false, 'tighter max cost');
    assert.equal(entryGates(WETH, { ...q, back: parseEther('0.985') }, 1010, { ...o, maxCostPct: 5 }).gates.find(x => x.id === 'roundtrip')!.pass, false, '1.5% > 1% ceiling');
    // per-asset minimum: WBTC refuses 1 MON
    const bq = { at: 1000, amountIn: parseEther('1'), out: 1_000n, back: parseEther('0.99'), midMonPerAsset: 0.001, refMonPerAsset: 0.001, gasRoundTripMon: 0.07 };
    const wb = entryGates(ASSETS[1], bq, 1010, o); assert.equal(wb.gates.find(x => x.id === 'minsize')!.pass, false); assert.equal(wb.ok, false);
    // preferred sibling: cbBTC refused when WBTC qualifies
    assert.equal(entryGates(ASSETS[2], bq, 1010, { ...o, preferredQualifies: 'WBTC' }).gates.find(x => x.id === 'preferred')!.pass, false);
    assert.deepEqual(preferredOver(ASSETS[2]).map(a => a.symbol), ['WBTC']); assert.deepEqual(preferredOver(ASSETS[1]), []);
    // SOL: no reference price -> refused
    assert.equal(entryGates(ASSETS[3], { ...q, refMonPerAsset: null }, 1010, o).gates.find(x => x.id === 'refdev')!.pass, false);
    assert.match(costStatus(ASSETS[3], 6.61).text, /^Enabled, but blocked by the cost check right now \(round trip 6\.61% at 0\.1 MON/);
    assert.equal(costStatus(ASSETS[1], 0.54).ok, true);
  });
});

describe('accounting', () => {
  const rid = (action: 1 | 2, step: number, amount: bigint) => encodeRid({ action, asset: 0, pos: 1, step, amount });
  const evs: LedgerEv[] = [
    { kind: 'deposit', block: 1, t: 1, tx: '0x01', mon: 5, gasMon: 0.3 },
    { kind: 'call', block: 2, t: 2, tx: '0x02', rid: rid(1, 0, parseEther('1')), valueWei: parseEther('1'), outAsset: WETH.address, received: 1000n, gasMon: 0.04 },
    { kind: 'call', block: 3, t: 3, tx: '0x03', rid: rid(2, 1, 250n), valueWei: 0n, outAsset: '0x0000000000000000000000000000000000000000', received: parseEther('0.3'), gasMon: 0.04 },
  ];
  it('partial exit removes basis proportionally and realizes the difference; fees are not counted twice', () => {
    const [p] = buildPositions(evs);
    assert.equal(p.status, 'PARTIALLY_EXITED'); assert.equal(p.remainingQty, 750n);
    assert.ok(Math.abs(p.remainingBasisMon - 0.75) < 1e-12); assert.ok(Math.abs(p.parts[0].basisOut - 0.25) < 1e-12);
    const r = result(p, { execMon: 0.8, exitGasMon: 0.04, usdPerMon: 0.02 });
    assert.ok(Math.abs(r.realizedMon - 0.05) < 1e-12);
    assert.ok(Math.abs(r.netMon - (0.05 + 0.05 - 0.08 - 0.04)) < 1e-12);
    assert.ok(Math.abs(r.netMon - (netByFlows(p, 0.8) - 0.04)) < 1e-12, 'net by basis == net by flows: pool fees inside quotes are never subtracted again');
    assert.ok(Math.abs(r.usd! - r.netMon * 0.02) < 1e-15);
  });
  it('two partials then close; vault deposit gas is not a position cost', () => {
    const more: LedgerEv[] = [...evs,
      { kind: 'call', block: 4, t: 4, tx: '0x04', rid: rid(2, 2, 375n), valueWei: 0n, outAsset: '0x0000000000000000000000000000000000000000', received: parseEther('0.36'), gasMon: 0.04 },
      { kind: 'call', block: 5, t: 5, tx: '0x05', rid: rid(2, 3, 375n), valueWei: 0n, outAsset: '0x0000000000000000000000000000000000000000', received: parseEther('0.37'), gasMon: 0.04 }];
    const [p] = buildPositions(more);
    assert.equal(p.status, 'CLOSED'); assert.equal(p.remainingQty, 0n); assert.equal(p.remainingBasisMon, 0);
    const basis = p.parts.reduce((a, x) => a + x.basisOut, 0); assert.ok(Math.abs(basis - 1) < 1e-12, 'all of the basis left, exactly once');
    const r = result(p); assert.ok(Math.abs(r.netMon - (0.3 + 0.36 + 0.37 - 1 - 0.16)) < 1e-12); assert.equal(r.unrealizedMon, 0);
    assert.ok(Math.abs(r.netMon - netByFlows(p)) < 1e-12);
  });
  it('a token withdrawn as tokens or a balance below the record needs manual action', () => {
    const tw: LedgerEv[] = [...evs, { kind: 'tokenWithdraw', block: 9, t: 9, tx: '0x09', token: WETH.address, qty: 750n, gasMon: 0.01 }];
    assert.equal(buildPositions(tw)[0].status, 'MANUAL_ACTION_REQUIRED');
    assert.equal(buildPositions(evs, { [WETH.address.toLowerCase()]: 100n })[0].status, 'MANUAL_ACTION_REQUIRED');
    assert.equal(buildPositions(evs, { [WETH.address.toLowerCase()]: 750n })[0].status, 'PARTIALLY_EXITED');
  });
});

describe('state machine', () => {
  it('happy path and partial path', () => {
    let s = step('IDLE', 'signal'); s = step(s, 'approve'); assert.equal(s, 'ENTRY_PENDING'); s = step(s, 'entry_confirmed'); assert.equal(s, 'OPEN');
    s = step(s, 'trigger'); s = step(s, 'exit_submit'); s = step(s, 'exit_partial'); assert.equal(s, 'PARTIALLY_EXITED');
    s = step(s, 'exit_submit'); s = step(s, 'exit_full'); assert.equal(s, 'CLOSED'); assert.equal(step(s, 'reset'), 'IDLE');
  });
  it('failures, retries, manual action; forbidden moves throw', () => {
    assert.equal(step(step('ENTRY_PENDING', 'entry_failed'), 'reset'), 'IDLE');
    assert.equal(step(step('EXIT_PENDING', 'exit_failed'), 'give_up'), 'MANUAL_ACTION_REQUIRED');
    assert.throws(() => step('ENTRY_PENDING', 'approve'), /not allowed/);
    assert.throws(() => step('OPEN', 'signal'));
    assert.throws(() => step('NEW_ENTRIES_PAUSED', 'approve'));
    assert.equal(STATES.length, 13);
  });
  it('pause and data loss only block entries; every exit state can still submit or finish an exit', () => {
    assert.equal(can('NEW_ENTRIES_PAUSED', 'signal'), false); assert.equal(can('DATA_UNAVAILABLE', 'approve'), false);
    for (const s of EXIT_STATES) assert.ok(can(s, 'exit_submit') || can(s, 'exit_full') || can(s, 'retry'), s);
  });
});

describe('backtest', () => {
  const cs = series(900, i => 100 * Math.exp(0.0006 * i + 0.03 * Math.sin(i / 40)));
  const costs = { roundTripPct: 0.1, gasRoundTripMon: 0.07, sizeMon: 10 };
  it('no lookahead: results up to hour k do not change when later candles change', () => {
    const a = backtest(cs, RULES_V1, EXITS_V1, costs, 0, 600);
    const mutated = cs.map((c, i) => (i >= 600 ? ([c[0], 1, 1, 1, 1, 0] as Candle) : c));
    const b = backtest(mutated, RULES_V1, EXITS_V1, costs, 0, 600);
    assert.deepEqual(a.equity, b.equity);
  });
  it('metrics and benchmarks are finite; walk-forward refuses short history', () => {
    const r = backtest(cs, RULES_V1, EXITS_V1, costs); const m = metrics(r, costs, 1);
    assert.ok(Number.isFinite(m.netMonPct) && m.maxDrawdownPct >= 0 && m.timeInMarketPct <= 100);
    const b = benchmarks(cs, costs, 200, 900); assert.equal(b.holdMonPct, 0); assert.ok(b.holdAssetPct > 0);
    assert.equal(walkForward(cs.slice(0, 300), EXITS_V1, costs).ok, false);
    assert.equal(walkForward(cs, EXITS_V1, costs).ok, true);
  });
});
