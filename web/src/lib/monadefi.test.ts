import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseEther } from 'viem';
import {
  annualised, availableToDeploy, combineSteps, DEFAULT_RULES, deployGate, describeRules, feeOn, GAS_RESERVE, isDuplicate, minAfterSlippage,
  parseMon, performance, presetAmount, proposeActions, afterClaimBaseline, settleDeposit, sharesFor, validateRules, withdrawGate, withdrawPreview,
  type Rules, type TxRecord,
} from './monadefi.ts';

const E = (s: string) => parseEther(s);

describe('deploy math', () => {
  it('keeps the larger of the gas reserve and the rule reserve', () => {
    assert.equal(availableToDeploy(E('10')), E('10') - GAS_RESERVE);
    assert.equal(availableToDeploy(E('10'), E('2')), E('8'));
    assert.equal(availableToDeploy(E('0.01')), 0n);
  });
  it('25/50/75/Max are fractions of available, Max is exact', () => {
    const a = E('8');
    assert.equal(presetAmount(a, 25), E('2'));
    assert.equal(presetAmount(a, 50), E('4'));
    assert.equal(presetAmount(a, 75), E('6'));
    assert.equal(presetAmount(a, 100), a);
    assert.equal(presetAmount(0n, 50), 0n);
  });
  it('slippage guard rounds down', () => {
    assert.equal(minAfterSlippage(10_000n, 50), 9_950n);
    assert.equal(minAfterSlippage(0n), 0n);
  });
  it('parses MON amounts strictly', () => {
    assert.equal(parseMon('1.5'), E('1.5'));
    assert.equal(parseMon(''), null);
    assert.equal(parseMon('abc'), null);
    assert.equal(parseMon('-1'), null);
  });
  it('blocks stale previews, paused vaults and amounts above available or the cap', () => {
    const base = { mainnet: true, account: true, amount: E('1'), available: E('5'), paused: false, preview: { at: 1_000, block: 1n, amount: E('1'), shares: E('0.9') }, now: 2_000, capRoom: null, busy: false };
    assert.equal(deployGate(base).ok, true);
    assert.equal(deployGate({ ...base, now: 1_000 + 31_000 }).code, 'stale');
    assert.equal(deployGate({ ...base, paused: true }).code, 'paused');
    assert.equal(deployGate({ ...base, amount: E('6') }).code, 'available');
    assert.equal(deployGate({ ...base, capRoom: E('0.5') }).code, 'cap');
    assert.equal(deployGate({ ...base, busy: true }).code, 'busy');
    assert.equal(deployGate({ ...base, mainnet: false }).code, 'net');
    assert.equal(deployGate({ ...base, preview: { ...base.preview, amount: E('2') } }).code, 'preview');
  });
});

describe('withdraw math', () => {
  const pos = { shares: E('9'), value: E('10') };
  it('50% means half of the current position', () => {
    assert.equal(sharesFor({ kind: 'pct', pct: 50 }, pos), E('4.5'));
    assert.equal(sharesFor({ kind: 'pct', pct: 25 }, pos), E('2.25'));
    assert.equal(sharesFor({ kind: 'pct', pct: 75 }, pos), E('6.75'));
  });
  it('100% and "all" take every share, with no dust', () => {
    assert.equal(sharesFor({ kind: 'pct', pct: 100 }, pos), pos.shares);
    assert.equal(sharesFor({ kind: 'amount', mon: E('10') }, pos), pos.shares);
    assert.equal(sharesFor({ kind: 'amount', mon: E('50') }, pos), pos.shares);
  });
  it('an amount rounds shares up so the amount is covered', () => {
    const s = sharesFor({ kind: 'amount', mon: E('1') }, pos);
    assert.ok(s * pos.value / pos.shares >= E('1'));
    assert.equal(s, E('0.9'));
    const odd = sharesFor({ kind: 'amount', mon: 1n }, { shares: 3n, value: 7n });
    assert.equal(odd, 1n);
  });
  it('shares are clamped to the position', () => {
    assert.equal(sharesFor({ kind: 'shares', shares: E('100') }, pos), pos.shares);
    assert.equal(sharesFor({ kind: 'shares', shares: -1n }, pos), 0n);
  });
  it('previews fee and proceeds with a 10 bps withdrawal fee', () => {
    const p = withdrawPreview(E('9'), s => (s * 10n) / 9n, 10);
    assert.equal(p.gross, E('10'));
    assert.equal(p.fee, E('0.01'));
    assert.equal(p.net, E('9.99'));
    assert.equal(p.minNet, minAfterSlippage(E('9.99')));
    assert.equal(feeOn(E('1'), null), 0n);
  });
  it('gates withdrawals', () => {
    const g = { account: true, mainnet: true, shares: E('1'), position: E('2'), minimum: 100n, paused: false, busy: false, receiverOk: true, previewAt: 1_000, now: 2_000 };
    assert.equal(withdrawGate(g).ok, true);
    assert.equal(withdrawGate({ ...g, shares: E('3') }).code, 'over');
    assert.equal(withdrawGate({ ...g, shares: 10n }).code, 'min');
    assert.equal(withdrawGate({ ...g, receiverOk: false }).code, 'receiver');
    assert.equal(withdrawGate({ ...g, position: 0n }).code, 'empty');
    assert.equal(withdrawGate({ ...g, now: 60_000 }).code, 'stale');
  });
});

describe('rules engine', () => {
  const r = (o: Partial<Rules>): Rules => ({ ...DEFAULT_RULES, ...o });
  it('reads as plain sentences and says B applies to new deposits only', () => {
    const lines = describeRules(r({ autoDeployOn: true, autoDeployPct: 40 }));
    assert.equal(lines.length, 5);
    assert.match(lines[1], /new deposits only/);
    assert.match(lines[4], /approve/);
  });
  it('refuses automatic mode while it cannot be enforced on-chain', () => {
    assert.deepEqual(validateRules(DEFAULT_RULES), []);
    assert.ok(validateRules(r({ mode: 'auto' })).length > 0);
    assert.ok(validateRules(r({ reserve: 'x' })).length > 0);
  });
  it('B proposes a % of new deposits only, after the reserve', () => {
    const rules = r({ autoDeployOn: true, autoDeployPct: 50, baseline: E('5').toString(), reserve: '1' });
    const p = proposeActions({ rules, wallet: E('9'), invested: 0n, pending: false });
    assert.equal(p.length, 1);
    assert.equal(p[0].kind, 'deploy');
    assert.equal(p[0].amount, E('2'));
    assert.deepEqual(proposeActions({ rules, wallet: E('5'), invested: 0n, pending: false }), []);
  });
  it('never redeploys claimed withdrawals', () => {
    const rules = r({ autoDeployOn: true, autoDeployPct: 100, baseline: E('5').toString(), reserveOn: false });
    const after = afterClaimBaseline(rules, E('3'));
    assert.deepEqual(proposeActions({ rules: after, wallet: E('8'), invested: 0n, pending: false }), []);
  });
  it('D caps every proposal and C only proposes', () => {
    const rules = r({ targetOn: true, targetPct: 50, capOn: true, cap: '2', reserveOn: false });
    const p = proposeActions({ rules, wallet: E('10'), invested: 0n, pending: false });
    assert.equal(p[0].amount, E('2'));
    const over = proposeActions({ rules: r({ targetOn: true, targetPct: 10, reserveOn: false }), wallet: E('1'), invested: E('9'), pending: false });
    assert.equal(over[0].kind, 'withdraw');
    assert.equal(over[0].amount, E('8'));
  });
  it('makes no proposal while a transaction is pending', () => {
    assert.deepEqual(proposeActions({ rules: r({ targetOn: true }), wallet: E('10'), invested: 0n, pending: true }), []);
  });
});

describe('transactions and accounting', () => {
  const rec: TxRecord = { id: '1', kind: 'deploy', state: 'Submitted', vault: 'v', amount: E('1').toString(), minShares: E('0.9').toString(), at: 0, updated: 0 };
  it('a failed deposit never becomes a position', () => {
    assert.equal(settleDeposit(rec, { status: 'reverted' }, null).state, 'Failed');
    assert.equal(settleDeposit(rec, { status: 'success' }, null).state, 'Action required');
    assert.equal(settleDeposit(rec, null, null).state, 'Confirming');
  });
  it('completes only with enough minted shares', () => {
    assert.equal(settleDeposit(rec, { status: 'success' }, E('0.95')).state, 'Completed');
    assert.equal(settleDeposit(rec, { status: 'success' }, E('0.5')).state, 'Action required');
  });
  it('blocks duplicate actions', () => {
    const now = 100_000;
    assert.equal(isDuplicate([{ ...rec, at: now - 1_000 }], { kind: 'deploy', vault: 'v', amount: rec.amount }, now), true);
    assert.equal(isDuplicate([{ ...rec, state: 'Failed', at: now - 1_000 }], { kind: 'deploy', vault: 'v', amount: rec.amount }, now), false);
    assert.equal(isDuplicate([{ ...rec, state: 'Completed', at: now - 300_000 }], { kind: 'deploy', vault: 'v', amount: rec.amount }, now), false);
  });
  it('withdraw-all reports partial completion', () => {
    assert.equal(combineSteps(['Withdrawal requested', 'Failed']), 'Partially completed');
    assert.equal(combineSteps(['Withdrawal requested', 'Completed']), 'Withdrawal requested');
    assert.equal(combineSteps(['Completed']), 'Completed');
    assert.equal(combineSteps(['Failed']), 'Failed');
  });
  it('keeps gain separate from deposits and excludes untracked shares', () => {
    const value = (s: bigint) => (s * 11n) / 10n;
    const p = performance({ depositedMon: E('10'), depositedShares: E('10'), requestedShares: E('5'), requestedMon: E('5.2'), heldShares: E('6'), value });
    assert.equal(p.netDeposits, E('4.8'));
    assert.equal(p.tracked, E('5'));
    assert.equal(p.untracked, E('1'));
    assert.equal(p.costLeft, E('5'));
    assert.equal(p.gain, E('0.5'));
    assert.equal(performance({ depositedMon: 0n, depositedShares: 0n, requestedShares: 0n, requestedMon: 0n, heldShares: E('1'), value }).gain, null);
  });
  it('needs at least a day of data for a return figure', () => {
    assert.equal(annualised(E('1.1'), E('1.0'), 3_600), null);
    const apr = annualised(E('1.001'), E('1'), 365 * 86_400 / 100)!;
    assert.ok(Math.abs(apr - 0.1) < 1e-6);
  });
});
