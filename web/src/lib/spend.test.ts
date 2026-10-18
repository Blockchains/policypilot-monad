import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseEther, type Address } from 'viem';
import { fundedMax, limitsFor, planSpend, SIGNER_RESERVE } from './spend.ts';

const E = (s: string) => parseEther(s);
const funder = '0x9A4300000000000000000000000000000000Ac1F' as Address;

const base = {
  mainnet: true, account: true, mode: 'run' as const, amount: '3',
  cap: E('0.5'), budget: E('5'), spent: 0n, bal: E('3'), vaultCap: E('1000'),
  paused: false, canSign: true, isOwner: true,
  source: 'vault' as const, funder: null, funderConnected: false, funderBal: 0n,
};

describe('planSpend', () => {
  it('raises the 0.5 cap so a 3 MON stake can use the vault balance', () => {
    const p = planSpend(base);
    assert.equal(p.ok, true);
    assert.equal(p.code, 'go');
    assert.equal(p.lift, true);
    assert.equal(p.pull, 0n);
    assert.equal(p.maxWei, E('3'));
    assert.deepEqual(limitsFor(base, E('3')), { cap: E('1000'), budget: null });
  });

  it('does not raise when the amount already fits', () => {
    const p = planSpend({ ...base, amount: '0.5' });
    assert.equal(p.lift, false);
    assert.equal(p.ok, true);
  });

  it('asks for a funder when the vault is short', () => {
    const p = planSpend({ ...base, amount: '4' });
    assert.equal(p.ok, false);
    assert.equal(p.code, 'bal');
  });

  it('pulls the shortfall from a connected owner funder and keeps a gas reserve', () => {
    const p = planSpend({
      ...base, amount: '4', source: 'deployer', funder, funderConnected: true, funderBal: E('10'),
    });
    assert.equal(p.ok, true);
    assert.equal(p.pull, E('1'));
    assert.equal(p.lift, true);
    assert.equal(p.maxWei, E('3') + E('10') - SIGNER_RESERVE);
  });

  it('refuses a funder that cannot cover the shortfall after the reserve', () => {
    const p = planSpend({
      ...base, amount: '4', source: 'balancer', funder, funderConnected: true, funderBal: E('1.02'),
    });
    assert.equal(p.ok, false);
    assert.equal(p.code, 'fund-bal');
  });

  it('keeps the cap when the connected wallet is not the owner', () => {
    const p = planSpend({ ...base, isOwner: false });
    assert.equal(p.ok, false);
    assert.equal(p.code, 'cap');
    assert.equal(fundedMax({ ...base, isOwner: false }), E('0.5'));
  });

  it('stops at the immutable vault cap', () => {
    const p = planSpend({ ...base, amount: '1001', bal: E('1001') });
    assert.equal(p.code, 'vaultcap');
  });

  it('opens a legacy 1 MON vault only up to that cap', () => {
    const s = { cap: E('0.1'), budget: E('1'), spent: 0n, vaultCap: E('1'), bal: E('1') };
    assert.deepEqual(limitsFor(s, E('1')), { cap: E('1'), budget: null });
    const p = planSpend({ ...base, ...s, amount: '2' });
    assert.equal(p.code, 'vaultcap');
  });

  it('raises the budget once the remaining budget is short', () => {
    const s = { cap: E('1000'), budget: E('5'), spent: E('5'), bal: E('3'), vaultCap: E('1000') };
    assert.deepEqual(limitsFor(s, E('1')), { cap: null, budget: E('1005') });
  });

  it('simulates inside the current cap when this browser cannot sign', () => {
    assert.equal(planSpend({ ...base, amount: '0.4', canSign: false }).code, 'sim');
    assert.equal(planSpend({ ...base, canSign: false }).code, 'signer');
  });

  it('rejects a paused vault and a bad amount', () => {
    assert.equal(planSpend({ ...base, paused: true }).code, 'paused');
    assert.equal(planSpend({ ...base, amount: 'nope' }).code, 'amount');
    assert.equal(planSpend({ ...base, account: false }).code, 'connect');
  });

  it('v4 unlimited vault: no cap, no budget, no lift, only the balance bounds an action', () => {
    const MAX = 2n ** 256n - 1n;
    const u = { ...base, cap: MAX, budget: MAX, vaultCap: MAX, bal: E('2500'), amount: '2000' };
    const p = planSpend(u);
    assert.equal(p.ok, true);
    assert.equal(p.code, 'go');
    assert.equal(p.lift, false);
    assert.match(p.detail, /no spending limits/i);
    assert.deepEqual(limitsFor(u, E('2000')), { cap: null, budget: null });
    assert.equal(planSpend({ ...u, isOwner: false, amount: '2400' }).ok, true);
    assert.equal(planSpend({ ...u, amount: '3000' }).code, 'bal');
  });

  it('creating a v4 vault accepts any deposit amount', () => {
    const MAX = 2n ** 256n - 1n;
    for (const amount of ['0.0001', '0.37', '1500']) {
      const p = planSpend({ ...base, mode: 'create', cap: MAX, budget: MAX, vaultCap: MAX, amount });
      assert.equal(p.ok, true, amount);
      assert.equal(p.code, 'create');
    }
  });
});
