import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseEther } from 'viem';
import { costsOf, UNITS, GOALS, maxAmount, NOT_OFFERED, pnl, review, risksFor, sharesForPct, shouldTrade, STRATEGIES, strategyFor, thirds } from './journey.ts';
import { addJournal, currentRun, ensurePos, positions, saveRun, useStore } from './journeyStore.ts';

const mem = new Map<string, string>();
useStore({ getItem: k => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v), removeItem: k => void mem.delete(k) });
const P = 102_000_000_000n;

describe('journey catalog', () => {
  it('every goal has at least one real strategy; every grid cell is offered or explains why not', () => {
    for (const g of GOALS) {
      if (g.id === 'pay') { assert.ok(strategyFor('pay', null)); continue; }
      const rs = risksFor(g.id);
      assert.ok(rs.some(r => r.strategy), g.id);
      for (const r of rs) assert.ok(!!r.strategy !== !!r.notOffered, `${g.id}/${r.id} must be exactly one of offered / not offered`);
    }
    assert.equal(NOT_OFFERED.length, 3);
  });
  it('copy is honest: no guarantees, every strategy says what can go wrong and how to withdraw', () => {
    const all = JSON.stringify(STRATEGIES, (_k, v) => typeof v === "bigint" ? String(v) : v) + JSON.stringify(NOT_OFFERED);
    assert.ok(!/guarantee|risk-free|safe return|always profit/i.test(all));
    for (const s of STRATEGIES) { assert.ok(s.wrong.length && s.withdraw.length && s.permissions.length && s.fees.length, s.id); assert.ok(s.frequency.length > 10); }
    for (const s of STRATEGIES.filter(x => x.kind === 'stake3' || x.kind === 'pay')) assert.ok(s.permissions.some(p => /No spending limits/.test(p)), s.id);
    for (const s of STRATEGIES.filter(x => x.kind === 'clip' || x.kind === 'spread')) assert.ok(/while a page/i.test(s.frequency) && s.cap === parseEther('10'));
  });
});

describe('amounts and gas', () => {
  it('Max leaves the wallet gas and the agent gas line, and respects the pool cap', () => {
    const s = strategyFor('arb', 'low')!; const c = costsOf(s, P);
    assert.ok(c.walletGas > parseEther('0.3') && c.walletGas < parseEther('0.5'));
    assert.equal(maxAmount(s, parseEther('2'), P), parseEther('2') - c.walletGas - c.agentGas - c.headroom);
    assert.ok(review(s, (Number(maxAmount(s, parseEther('2'), P)) / 1e18).toString(), parseEther('2'), P).ok);
    assert.equal(maxAmount(s, parseEther('100'), P), parseEther('10'));
    assert.equal(maxAmount(s, parseEther('0.1'), P), 0n);
    const r = review(s, '1', parseEther('2'), P); assert.ok(r.ok); assert.equal(r.total, parseEther('1') + c.walletGas + c.agentGas);
  });
  it('blocks before review: not enough MON, below min, over cap, bad payees', () => {
    const s = strategyFor('fast', 'balanced')!;
    assert.match(review(s, '1', parseEther('1'), P).blocker!, /You need .* and have 1 MON/);
    // Vault paths: the create carries the amount with a 2.3M gas limit, so the wallet needs head-room at the fee cap.
    const eb = strategyFor('earn', 'balanced')!; const ce = costsOf(eb, P); assert.ok(ce.headroom > 0n);
    assert.ok(parseEther('1') + ce.agentGas + ce.walletGas + ce.headroom >= parseEther('1') + (UNITS.vaultCreate * 202_000_000_000n));
    assert.match(review(s, '0.01', parseEther('5'), P).blocker!, /smallest amount/);
    assert.match(review(s, '11', parseEther('50'), P).blocker!, /at most 10 MON/);
    assert.match(review(s, 'abc', parseEther('5'), P).blocker!, /Enter an amount/);
    const pay = strategyFor('pay', null)!;
    assert.match(review(pay, '1', parseEther('5'), P, { payees: [] }).blocker!, /at least one address/);
    assert.match(review(pay, '1', parseEther('5'), P, { payees: [{ to: '0x12', amount: 1n }] }).blocker!, /not a valid/);
    assert.match(review(pay, '0.5', parseEther('5'), P, { payees: [{ to: '0x000000000000000000000000000000000000dEaD', amount: parseEther('1') }] }).blocker!, /add up to/);
    assert.ok(review(pay, '0.5', parseEther('5'), P, { payees: [{ to: '0x000000000000000000000000000000000000dEaD', amount: parseEther('0.1') }] }).ok);
  });
  it('earn-low has no agent gas; agent strategies show it as its own line', () => {
    assert.equal(costsOf(strategyFor('earn', 'low')!, P).agentGas, 0n);
    const r = review(strategyFor('earn', 'balanced')!, '1', parseEther('5'), P);
    assert.ok(r.lines.some(l => /Agent gas/.test(l.label)));
  });
});

describe('maths', () => {
  it('thirds add up exactly; pct shares; P&L', () => {
    const t = thirds(10n ** 18n + 2n); assert.equal(t[0] + t[1] + t[2], 10n ** 18n + 2n);
    assert.equal(sharesForPct(1000n, 100), 1000n); assert.equal(sharesForPct(1000n, 25), 250n); assert.equal(sharesForPct(1000n, 0), 0n);
    assert.deepEqual(pnl({ value: parseEther('1.1'), deposited: parseEther('1'), withdrawn: 0n }), { abs: parseEther('0.1'), pct: 10 });
    assert.equal(pnl({ value: null, deposited: 1n, withdrawn: 0n }), null);
    assert.equal(pnl({ value: 1n, deposited: null, withdrawn: 0n }), null);
  });
  it('the agent trades only when the gain beats gas (and clears the floor)', () => {
    const fast = strategyFor('fast', 'balanced')!; const low = strategyFor('arb', 'low')!;
    const one = parseEther('1');
    assert.equal(shouldTrade(fast, { amount: one, gain: parseEther('0.009'), gas: parseEther('0.043') }), false);
    assert.equal(shouldTrade(fast, { amount: one, gain: parseEther('0.05'), gas: parseEther('0.043') }), true);
    assert.equal(shouldTrade(low, { amount: one, gain: parseEther('0.0009'), gas: 0n }), false); // under the 0.10% floor
    assert.equal(shouldTrade(low, { amount: parseEther('100'), gain: parseEther('0.2'), gas: parseEther('0.05') }), true);
    assert.equal(shouldTrade(fast, { amount: one, gain: -1n, gas: 0n }), false);
  });
});

describe('journey store', () => {
  it('keeps the journal when a position is added again; saves and reads runs', () => {
    const p = { id: '0xabc', net: 143, account: '0xme', strategy: 'arb-low' as const, address: '0x0000000000000000000000000000000000000abc' as const, createdAt: 1, journal: [] };
    ensurePos(p); addJournal(143, '0xme', '0xabc', { h: '0x01', dir: 'in' }); ensurePos({ ...p, journal: [] });
    assert.equal(positions(143, '0xme')[0].journal.length, 1);
    addJournal(143, '0xme', '0xabc', { h: '0x01', dir: 'in' }); assert.equal(positions(143, '0xme')[0].journal.length, 1);
    saveRun({ id: 'r', net: 143, account: '0xme', strategy: 'arb-low', amount: '1', agentGas: '1', steps: [], startedAt: 1 });
    assert.equal(currentRun(143, '0xme')!.id, 'r');
  });
});
