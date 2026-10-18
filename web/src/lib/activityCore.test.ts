import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aggregate, bucketOf, cmpRows, combine, fromLedger, mergeRows, TOPIC, type Ctx, type RawLog, type Row } from './activityCore.ts';

const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const W = (x: bigint | number | string) => (typeof x === 'string' ? x.replace(/^0x/, '').padStart(64, '0') : BigInt(x).toString(16).padStart(64, '0'));
const T = (a: string) => '0x' + W(a);
const H = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const FACT = A(0xf1), V1 = A(0xa1), V2 = A(0xa2), OWNER = A(0x0e), AGENT = A(0xae), REF = A(0xbb), APR = A(0xcc), STRANGER = A(0x99), WMON = A(0x77);
const ctx = (): Ctx => ({ factories: new Set([FACT]), vaults: new Set([V1]), refillers: new Set([REF]), aprmon: APR, wallets: new Set([OWNER, AGENT]) });
const log = (address: string, topics: string[], data: string, tx: number, block: number, li: number): RawLog => ({ address, topics, data: '0x' + data, transactionHash: H(tx), blockNumber: '0x' + block.toString(16), logIndex: '0x' + li.toString(16), blockTimestamp: '0x' + (1_800_000_000 + block).toString(16) });
const row = (h: number, b: number, i: number, extra: Partial<Row> = {}): Row => ({ h: H(h), b, i, t: b, k: 'pay', s: 'ok', ...extra });

describe('sort / merge / dedupe', () => {
  it('newest first: block desc, then log index desc, ledger-only rows last within a block', () => {
    const rs = [row(1, 10, 5), row(2, 12, 0), row(3, 10, 9), row(4, 10, -1), row(5, 11, 3)].sort(cmpRows);
    assert.deepEqual(rs.map(r => r.h), [H(2), H(5), H(3), H(1), H(4)]);
  });
  it('dedupes by tx hash across lists (case-insensitive) and keeps one row per tx', () => {
    const a = [row(1, 10, 1), row(2, 11, 0)]; const b = [{ ...row(1, 10, 1), h: H(1).toUpperCase().replace('0X', '0x') }, row(3, 12, 4)];
    const m = mergeRows(a, b, a);
    assert.equal(m.length, 3); assert.deepEqual(m.map(r => r.h), [H(3), H(2), H(1)]);
  });
  it('merge is idempotent and order-independent', () => {
    const a = [row(1, 10, 1), row(2, 11, 0)], b = [row(3, 9, 2), row(2, 11, 0)];
    assert.deepEqual(mergeRows(a, b), mergeRows(b, a)); assert.deepEqual(mergeRows(mergeRows(a, b), b), mergeRows(a, b));
  });
  it('chain row wins kind/amount/status; ledger adds label and persona', () => {
    const chain = row(7, 20, 3, { k: 'call', m: '5', a: WMON }); const led: Row = { h: H(7), b: 20, i: -1, t: 19, k: 'showcase', s: 'reverted', l: 'Tester wraps', p: 'tester', r: 'x' };
    for (const c of [combine(chain, led), combine(led, chain)]) { assert.equal(c.k, 'call'); assert.equal(c.s, 'ok'); assert.equal(c.l, 'Tester wraps'); assert.equal(c.p, 'tester'); assert.equal(c.i, 3); assert.equal(c.r, undefined); assert.equal(c.t, 20); }
  });
  it('a reverted ledger row stays reverted when no logs exist for it', () => {
    const m = mergeRows([{ h: H(8), b: 30, i: -1, t: 1, k: 'showcase', s: 'reverted', r: 'NotOwner()' }], [row(9, 31, 0)]);
    assert.equal(m[1].s, 'reverted'); assert.equal(m[1].r, 'NotOwner()');
  });
  it('a live row prepends on top of the index rows', () => {
    const idx = [row(1, 100, 2), row(2, 90, 1)]; const live = [row(3, 101, 0)];
    assert.equal(mergeRows(idx, live)[0].h, H(3));
  });
  it('buckets never split a block', () => { assert.equal(bucketOf(199_999), 0); assert.equal(bucketOf(200_000), 1); });
});

describe('decode + aggregate', () => {
  it('create + deposit in one tx is one create row carrying the deposit; the vault is reported', () => {
    const logs = [log(FACT, [TOPIC.VaultCreated, T(OWNER), T(V2), T(AGENT)], '', 1, 50, 0), log(V2, [TOPIC.Deposited, T(OWNER)], W(10n ** 18n) + W(10n ** 18n), 1, 50, 1)];
    const c = ctx(); c.vaults.add(V2);
    const { rows, created } = aggregate(logs, c);
    assert.equal(rows.length, 1); assert.equal(rows[0].k, 'create'); assert.equal(rows[0].m, (10n ** 18n).toString()); assert.equal(rows[0].v, V2); assert.equal(rows[0].n, 2);
    assert.deepEqual(created.map(x => [x.vault, x.owner, x.executor, x.block]), [[V2, OWNER, AGENT, 50]]);
  });
  it('agent pay, contract call, sweep (+Withdrawn), pause, token withdraw', () => {
    const logs = [
      log(V1, [TOPIC.Executed, H(1), T(STRANGER)], W(5) + W(5), 2, 60, 0),
      log(V1, [TOPIC.DappCalled, H(2), T(WMON), '0xd0e30db0' + '0'.repeat(56)], W(7) + W(WMON) + W(7) + W(12), 3, 61, 4),
      log(V1, [TOPIC.Withdrawn, T(OWNER)], W(9) + W(1), 4, 62, 0), log(V1, [TOPIC.SweptToOwner, T(AGENT)], W(9) + W(1), 4, 62, 1),
      log(V1, [TOPIC.PausedSet], W(1), 5, 63, 0),
      log(V1, [TOPIC.TokenWithdrawn, T(WMON), T(OWNER)], W(3), 6, 64, 0),
    ];
    const { rows } = aggregate(logs, ctx());
    const by = Object.fromEntries(rows.map(r => [r.b, r]));
    assert.equal(by[60].k, 'pay'); assert.equal(by[60].a, STRANGER); assert.equal(by[60].m, '5');
    assert.equal(by[61].k, 'call'); assert.equal(by[61].sel, '0xd0e30db0'); assert.equal(by[61].out, WMON); assert.equal(by[61].m, '7');
    assert.equal(by[62].k, 'sweep'); assert.equal(by[62].m, '9'); assert.equal(by[62].n, 2);
    assert.equal(by[63].k, 'pause'); assert.equal(by[64].k, 'token-out'); assert.equal(by[64].out, WMON);
    assert.deepEqual(rows.map(r => r.b), [64, 63, 62, 61, 60]);
  });
  it('refiller tx paying several agents sums the amounts', () => {
    const logs = [log(REF, [TOPIC.RefillCall, T(OWNER)], W(0) + W(3) + W(3), 9, 70, 0), log(REF, [TOPIC.Refilled, T(A(1))], W(1) + W(0), 9, 70, 1), log(REF, [TOPIC.Refilled, T(A(2))], W(2) + W(0), 9, 70, 2)];
    const [r] = aggregate(logs, ctx()).rows; assert.equal(r.k, 'refill'); assert.equal(r.m, '3'); assert.equal(r.n, 3);
  });
  it('aPriori events count only for platform wallets', () => {
    const logs = [log(APR, [TOPIC.AprDeposit, T(OWNER), T(OWNER)], W(4) + W(4), 10, 80, 0), log(APR, [TOPIC.AprDeposit, T(STRANGER), T(STRANGER)], W(4) + W(4), 11, 80, 1)];
    const { rows } = aggregate(logs, ctx()); assert.equal(rows.length, 1); assert.equal(rows[0].k, 'md-deposit'); assert.equal(rows[0].a, OWNER);
  });
  it('ignores unknown contracts, unknown topics and removed logs', () => {
    const logs = [log(A(0x55), [TOPIC.Executed, H(1), T(STRANGER)], W(5) + W(5), 12, 90, 0), log(V1, [H(123)], '', 13, 90, 1), { ...log(V1, [TOPIC.Executed, H(1), T(STRANGER)], W(5) + W(5), 14, 90, 2), removed: true }];
    assert.equal(aggregate(logs, ctx()).rows.length, 0);
  });
});

describe('showcase ledger', () => {
  it('keeps txs with a block, marks blocked/error as reverted, maps persona to vault', () => {
    const rs = fromLedger([
      { ts: '2026-10-18T19:43:03.624Z', persona: 'rogue', label: 'Rogue tries', status: 'blocked', reason: 'NotOwner()', tx: H(1), block: '100' },
      { persona: 'dca', label: 'DCA buys', status: 'allowed', tx: H(2), block: 101 },
      { persona: 'dca', status: 'precheck-blocked' }, { tx: H(3), status: 'allowed' },
    ], { rogue: V1 });
    assert.equal(rs.length, 2); assert.equal(rs[0].s, 'reverted'); assert.equal(rs[0].v, V1); assert.equal(rs[0].r, 'NotOwner()'); assert.equal(rs[0].t, 1792352583); assert.equal(rs[1].s, 'ok'); assert.equal(rs[1].i, -1);
  });
});
