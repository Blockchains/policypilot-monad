import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeFunctionData, getAddress, parseEther, type Address } from 'viem';
import { ADDR, aprWithdrawSteps, classify, DESK_FACTORY, FACTORIES, findPools, poolAbi, poolWithdrawStep, summarize, txTargets, valueToken, vaultAbi, vaultWithdrawSteps, type Rates, type VaultPos, type WalletPos } from './positionsCore.ts';

const ME = getAddress('0x00000000000000000000000000000000000000a1');
const OTHER = '0x00000000000000000000000000000000000000B2' as Address;
const AGENT = '0x00000000000000000000000000000000000000C3' as Address;
const CLIP = '0x00000000000000000000000000000000000000E1' as Address;
const SPREAD = '0x5E6fB4ca02F1044ca1c896ba0e18dc0E74B67901' as Address;
const NOTPOOL = '0x00000000000000000000000000000000000000F9' as Address;
const rates: Rates = { aprMON: parseEther('1.1'), gMON: parseEther('1.2'), usdcPerMon: null, venue: null };
let n = 0;
const vault = (o: Partial<VaultPos> = {}): VaultPos => ({
  vault: `0x${(++n).toString(16).padStart(40, '0')}` as Address, factory: FACTORIES[2], owner: ME, executor: AGENT, paused: false, unlimited: false, agentBal: 0n, relations: ['owner'], showcase: false,
  native: parseEther('1'), tokens: [], lpNfts: [], pools: [], aprRequests: [], kuru: [], discovery: 'ok', navMon: parseEther('1'), unknown: 0, errors: [], readAt: 0, ...o,
});
const wallet = (o: Partial<WalletPos> = {}): WalletPos => ({ account: ME, aprMon: 0n, aprMonValue: 0n, aprRequests: [], pools: [], errors: [], tokens: [], ...o });

/** A fake client: Clip answers UNI_THIN_POOL, Spread answers minProfitBps, the desk factory lists the Spread pool. */
const pub: any = {
  readContract: async ({ address, functionName }: any) => {
    const a = address.toLowerCase();
    if (functionName === 'vaultsOf' && a === DESK_FACTORY[143]!.toLowerCase()) return [SPREAD];
    if (functionName === 'UNI_THIN_POOL' && a === CLIP.toLowerCase()) return OTHER;
    if (functionName === 'minProfitBps' && a === SPREAD.toLowerCase()) return 10n;
    throw new Error('revert');
  },
};
/** Blockscout pages: a failed creation, a successful one (CLIP), a call to a non-pool contract and a factory call. */
const pages = [
  { items: [{ block_number: 300, status: 'error', created_contract: { hash: '0x00000000000000000000000000000000000000AA' } }, { block_number: 290, status: 'ok', created_contract: { hash: CLIP } }, { block_number: 280, status: 'ok', to: { hash: NOTPOOL, is_contract: true } }], next_page_params: { p: 2 } },
  { items: [{ block_number: 200, status: 'ok', to: { hash: FACTORIES[2].address, is_contract: true } }], next_page_params: null },
];
const fakeFetch = (log: string[]) => (async (u: string) => { log.push(u); const pg = /p=2/.test(u) ? pages[1] : pages[0]; return { ok: true, json: async () => pg }; }) as unknown as typeof fetch;

describe('discovery on a device that never started a position', () => {
  it('finds desk and directly-created pools from chain + the public index, skips failed creations and non-pools', async () => {
    const log: string[] = []; const mem = new Map<string, string>(); const kv = { get: (k: string) => mem.get(k) ?? null, set: (k: string, v: string) => void mem.set(k, v) };
    const r = await findPools(pub, ME, { netId: 143, kv, fetchImpl: fakeFetch(log) });
    assert.equal(r.ok, true);
    assert.deepEqual(r.pools.map(p => `${p.kind}:${p.address.toLowerCase()}`).sort(), [`clip:${CLIP.toLowerCase()}`, `spread:${SPREAD.toLowerCase()}`]);
    assert.equal(log.length, 2);
    // Second scan is incremental: stops at the newest block already seen, and classification is cached.
    const log2: string[] = [];
    const r2 = await findPools(pub, ME, { netId: 143, kv, fetchImpl: fakeFetch(log2) });
    assert.equal(r2.pools.length, 2); assert.equal(log2.length, 1);
  });
  it('reports a Blockscout outage instead of claiming there are no pools', async () => {
    const r = await findPools(pub, ME, { netId: 143, fetchImpl: (async () => ({ ok: false, status: 503 })) as any });
    assert.equal(r.ok, false); assert.deepEqual(r.pools.map(p => p.kind), ['spread']); // desk pools still found on-chain
  });
  it('classify: kinds from immutable views', async () => {
    const k = await classify(pub, [CLIP.toLowerCase(), SPREAD.toLowerCase(), NOTPOOL.toLowerCase()]);
    assert.deepEqual(Object.values(k), ['clip', 'spread', 'none']);
  });
  it('txTargets ignores failed transactions', async () => {
    const t = await txTargets(ME, 0, fakeFetch([]));
    assert.ok(!t.addrs.includes('0x00000000000000000000000000000000000000aa')); assert.equal(t.top, 300);
  });
});

describe('My money summary', () => {
  it('counts owned vaults + wallet (aprMON, queued requests, pools, staked tokens), never agent-only vaults', () => {
    const own = [vault(), vault({ native: 0n, navMon: 0n })]; const theirs = vault({ owner: OTHER, relations: ['agent'], native: parseEther('5'), navMon: parseEther('5') });
    const sMON = valueToken({ sym: 'sMON', address: ADDR.sMON, decimals: 18, amount: parseEther('2'), kind: 'lst', source: 'known' }, rates);
    const w = wallet({ aprMon: parseEther('10'), aprMonValue: parseEther('11'), aprRequests: [{ id: 1n, claimed: false, claimable: false, shares: 1n, assets: parseEther('3'), timestamp: 0n, unlockEpoch: 0n }], pools: [{ kind: 'spread', pool: SPREAD, shares: 10n, assets: parseEther('10') }], tokens: [sMON] });
    const s = summarize({ vaults: [...own, theirs], wallet: w, poolsOk: true }, ME, rates);
    assert.equal(s.total, parseEther('27')); // 1 + 11 + 3 + 10 + 2
    assert.equal(s.nonEmpty.length, 1); assert.equal(s.empty.length, 1); assert.equal(s.agentOnly.length, 1); assert.equal(s.nothing, false);
  });
  it('empty state only when there is truly nothing', () => {
    assert.equal(summarize({ vaults: [], wallet: wallet(), poolsOk: true }, ME, rates).nothing, true);
    assert.equal(summarize({ vaults: [vault({ native: 0n, navMon: 0n })], wallet: wallet(), poolsOk: true }, ME, rates).nothing, false);
  });
});

describe('per-position withdraw', () => {
  const lst = valueToken({ sym: 'gMON', address: ADDR.gMON, decimals: 18, amount: parseEther('4'), kind: 'lst', source: 'known' }, rates);
  it('vault 25%: owner withdraw of a quarter of the MON and tokens', () => {
    const v = vault({ native: parseEther('2'), tokens: [lst] });
    const { steps, note } = vaultWithdrawSteps(v, ME, 25, null);
    assert.equal(steps.length, 2);
    const a = decodeFunctionData({ abi: vaultAbi, data: steps[0].data }); assert.equal(a.functionName, 'withdraw'); assert.deepEqual(a.args, [ME, parseEther('0.5')]);
    const b = decodeFunctionData({ abi: vaultAbi, data: steps[1].data }); assert.equal(b.functionName, 'withdrawToken'); assert.equal(b.args![2], parseEther('1'));
    assert.ok(steps.every(s => s.signer === 'owner')); assert.match(note, /25%/);
  });
  it('vault 100%: the close plan (ends with emergencyWithdrawAll)', () => {
    const { steps } = vaultWithdrawSteps(vault({ native: parseEther('2'), tokens: [lst] }), ME, 100, null);
    assert.equal(decodeFunctionData({ abi: vaultAbi, data: steps.at(-1)!.data }).functionName, 'emergencyWithdrawAll');
  });
  it('a vault owned by someone else gives no steps', () => {
    assert.equal(vaultWithdrawSteps(vault({ owner: OTHER }), ME, 50, null).steps.length, 0);
    assert.equal(vaultWithdrawSteps(vault({ owner: OTHER }), ME, 100, null).steps.length, 0);
  });
  it('pool 50%: withdraw half the shares, wallet signs', () => {
    const s = poolWithdrawStep({ kind: 'spread', pool: SPREAD, shares: 10n, assets: parseEther('10') }, ME, 50);
    assert.equal(s.signer, 'wallet'); assert.deepEqual(decodeFunctionData({ abi: poolAbi, data: s.data }).args, [5n]);
  });
  it('aprMON: claim unlocked first, then queue pct%', () => {
    const w = wallet({ aprMon: parseEther('8'), aprRequests: [{ id: 7n, claimed: false, claimable: true, shares: 1n, assets: parseEther('1'), timestamp: 0n, unlockEpoch: 0n }] });
    const { steps, note } = aprWithdrawSteps(w, ME, 25);
    assert.equal(steps.length, 2); assert.equal(steps[0].id, 'wallet:apr:claim'); assert.match(note, /12–18 hours/);
  });
});
