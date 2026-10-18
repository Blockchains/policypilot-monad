import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeFunctionData, parseEther, type Address } from 'viem';
import { ADDR, buildClosePlan, closeBlocker, FACTORIES, isEmpty, runPlan, totals, valueToken, vaultAbi, type Rates, type Step, type VaultPos } from './positionsCore.ts';
import { TOKENS } from './services.ts';

const ME = '0x00000000000000000000000000000000000000A1' as Address;
const OTHER = '0x00000000000000000000000000000000000000B2' as Address;
const AGENT = '0x00000000000000000000000000000000000000C3' as Address;
const V = '0x00000000000000000000000000000000000000D4' as Address;
const rates: Rates = { aprMON: parseEther('1.1'), gMON: parseEther('1.2'), usdcPerMon: 25_000n, venue: 'Uniswap' }; // 0.025 USDC per MON
const tok = (sym: keyof typeof TOKENS, amount: bigint) => valueToken({ sym, address: TOKENS[sym].address, decimals: TOKENS[sym].decimals, amount, kind: sym === 'WMON' ? 'wrapped' : sym === 'USDC' ? 'stable' : 'lst', source: 'known' }, rates);
const vault = (o: Partial<VaultPos> = {}): VaultPos => ({
  vault: V, factory: FACTORIES[0], owner: ME, executor: AGENT, paused: false, unlimited: true, agentBal: parseEther('1'), relations: ['owner'], showcase: false,
  native: parseEther('0.5'), tokens: [tok('WMON', parseEther('0.1')), tok('aprMON', parseEther('0.05'))], lpNfts: [], pools: [], aprRequests: [], kuru: [],
  discovery: 'ok', navMon: 0n, unknown: 0, errors: [], readAt: 0, ...o,
});
const fnOf = (s: Step) => { const d = decodeFunctionData({ abi: vaultAbi, data: s.data }); return d.functionName; };

describe('addresses', () => {
  it('match services.ts', () => { for (const k of Object.keys(TOKENS) as (keyof typeof TOKENS)[]) assert.equal(ADDR[k].toLowerCase(), TOKENS[k].address.toLowerCase()); });
  it('lists every factory incl. Unlimited 0x41d6…', () => {
    assert.deepEqual(FACTORIES.map(f => f.id), ['v4', 'v3', 'v2', 'v1', 'showcase']);
    assert.equal(FACTORIES[0].address, '0x41d6667aA35c3634D19068A39481d4c955f6557D');
  });
});

describe('valuation', () => {
  it('sMON at par with a note, aprMON via rate, unknown ERC-20 has no value', () => {
    const s = tok('sMON', parseEther('2')); assert.equal(s.priced, 'par'); assert.equal(s.monValue, parseEther('2')); assert.match(s.note, /par/);
    const a = tok('aprMON', parseEther('2')); assert.equal(a.monValue, parseEther('2.2')); assert.match(a.note, /not instant/);
    const u = valueToken({ sym: 'FOO', address: OTHER, decimals: 18, amount: 5n, kind: 'erc20', source: 'transfer-logs' }, rates); assert.equal(u.monValue, null); assert.match(u.note, /Unknown value/);
  });
  it('USDC without a quote is unknown, not zero', () => {
    const u = valueToken({ sym: 'USDC', address: ADDR.USDC, decimals: 6, amount: 1_000_000n, kind: 'stable', source: 'known' }, { ...rates, usdcPerMon: null });
    assert.equal(u.monValue, null); assert.equal(u.priced, 'none');
  });
  it('totals skip unknowns and count them', () => {
    const p = vault({ tokens: [tok('WMON', parseEther('1')), valueToken({ sym: 'FOO', address: OTHER, decimals: 18, amount: 5n, kind: 'erc20', source: 'transfer-logs' }, rates)], lpNfts: [{ venue: 'Uniswap v3', manager: ADDR.uniNpm, tokenId: 7n }] });
    const t = totals([p], rates); assert.equal(t.navMon, parseEther('1.5')); assert.equal(t.unknown, 2); assert.equal(t.usdc, (parseEther('1.5') * 25_000n) / 10n ** 18n);
  });
});

describe('close plan', () => {
  it('owner only (no agent here): withdrawToken per token, then emergencyWithdrawAll, then unwrap in wallet', () => {
    const pl = buildClosePlan({ account: ME, vaults: [vault()], access: () => null, unwrap: true });
    assert.deepEqual(pl.steps.map(s => s.vault ? fnOf(s) : s.id), ['withdrawToken', 'withdrawToken', 'emergencyWithdrawAll', 'wallet:unwrap']);
    for (const s of pl.steps.filter(s => s.vault)) { const d = decodeFunctionData({ abi: vaultAbi, data: s.data }); if (d.functionName === 'withdrawToken') assert.equal((d.args as any)[1], ME); }
    assert.equal(pl.walletSigs, 4);
    assert.ok(pl.steps.some(s => /aprMON.*not instant MON/.test(s.label)));
  });
  it('unwrap off: no unwrap step, WMON withdrawn as WMON', () => {
    const pl = buildClosePlan({ account: ME, vaults: [vault()], access: () => null, unwrap: false });
    assert.ok(!pl.steps.some(s => s.id.includes('unwrap')));
  });
  it('agent key in this browser on an unlimited vault: agent unwraps + hands tokens to the owner, 1 wallet signature', () => {
    const pl = buildClosePlan({ account: ME, vaults: [vault()], access: () => 'key', unwrap: true });
    assert.deepEqual(pl.steps.map(s => s.signer), ['agent-key', 'agent-key', 'owner']);
    assert.equal(fnOf(pl.steps[2]), 'emergencyWithdrawAll');
    assert.equal(pl.walletSigs, 1);
  });
  it('paused vault that needs agent steps is unpaused first and re-paused by emergencyWithdrawAll', () => {
    const pl = buildClosePlan({ account: ME, vaults: [vault({ paused: true })], access: () => 'key', unwrap: true });
    assert.equal(fnOf(pl.steps[0]), 'setPaused'); assert.equal(fnOf(pl.steps[pl.steps.length - 1]), 'emergencyWithdrawAll');
  });
  it('agent key without gas falls back to the owner path with a note', () => {
    const pl = buildClosePlan({ account: ME, vaults: [vault({ agentBal: 0n })], access: () => 'key', unwrap: true });
    assert.ok(pl.steps.every(s => s.signer !== 'agent-key')); assert.match(pl.notes.join(' '), /too little gas/);
  });
  it('not the owner: disabled with the reason; showcase never included', () => {
    const notMine = vault({ owner: OTHER, relations: ['agent'] });
    const show = vault({ showcase: true, factory: FACTORIES[4], relations: ['showcase'], owner: ME });
    const pl = buildClosePlan({ account: ME, vaults: [notMine, show], access: () => 'wallet', unwrap: true });
    assert.equal(pl.steps.length, 0); assert.equal(pl.disabled.length, 1); assert.match(pl.disabled[0].why, /Only the owner/);
    assert.match(closeBlocker(show, ME)!, /Read-only/);
  });
  it('queued aPriori: locked is manual; claimable is claimed by the agent before the sweep', () => {
    const reqs = [{ id: 1n, claimed: false, claimable: false, shares: 1n, assets: parseEther('0.01'), timestamp: 0n, unlockEpoch: 9n }, { id: 2n, claimed: false, claimable: true, shares: 1n, assets: parseEther('0.02'), timestamp: 0n, unlockEpoch: 8n }];
    const a = buildClosePlan({ account: ME, vaults: [vault({ tokens: [], aprRequests: reqs })], access: () => 'wallet', unwrap: true });
    assert.equal(a.steps[0].id.endsWith(':apr'), true); assert.equal(a.manual.length, 1);
    const b = buildClosePlan({ account: ME, vaults: [vault({ tokens: [], aprRequests: reqs })], access: () => null, unwrap: true });
    assert.equal(b.manual.length, 2);
  });
  it('LP NFTs: manual without an agent, transferred by the agent on unlimited vaults', () => {
    const n = [{ venue: 'Uniswap v3' as const, manager: ADDR.uniNpm, tokenId: 3n }];
    assert.equal(buildClosePlan({ account: ME, vaults: [vault({ lpNfts: n })], access: () => null, unwrap: true }).manual.length, 1);
    assert.ok(buildClosePlan({ account: ME, vaults: [vault({ lpNfts: n })], access: () => 'key', unwrap: true }).steps.some(s => s.id.includes(':nft:')));
  });
  it('empty vaults are skipped', () => {
    const e = vault({ native: 0n, tokens: [] }); assert.ok(isEmpty(e));
    assert.equal(buildClosePlan({ account: ME, vaults: [e], access: () => null, unwrap: true }).steps.length, 0);
  });
  it('wallet-level: claimable MonaDefi requests and pool shares', () => {
    const pl = buildClosePlan({ account: ME, vaults: [], access: () => null, unwrap: true, wallet: { account: ME, aprMon: parseEther('1'), aprMonValue: parseEther('1.1'), aprRequests: [{ id: 5n, claimed: false, claimable: true, shares: 1n, assets: 1n, timestamp: 0n, unlockEpoch: 0n }], pools: [{ kind: 'clip', pool: OTHER, shares: 10n, assets: 9n }], errors: [] } });
    assert.deepEqual(pl.steps.map(s => s.id.split(':').slice(0, 2).join(':')), ['wallet:apr', 'wallet:pool']);
    assert.match(pl.notes[0], /not instant/);
  });
});

describe('runner', () => {
  const plan = () => buildClosePlan({ account: ME, vaults: [vault()], access: () => null, unwrap: true });
  it('stops at the first failure and resumes without repeating finished steps', async () => {
    const pl = plan(); const sent: string[] = []; let fail = true;
    const r = { send: async (s: Step) => { if (s.id.endsWith(':emergency') && fail) throw new Error('boom'); sent.push(s.id); return '0x01' as `0x${string}`; } };
    const st = await runPlan(pl, r, () => {});
    assert.deepEqual(st.map(x => x.status), ['done', 'done', 'failed', 'todo']);
    fail = false;
    const st2 = await runPlan(pl, r, () => {}, new Set(st.filter(x => x.status === 'done').map(x => x.id)));
    assert.ok(st2.every(x => x.status === 'done')); assert.equal(sent.length, 4);
  });
  it('batches consecutive wallet steps when the wallet supports it, falls back when it does not', async () => {
    const pl = plan(); let batches = 0; let singles = 0;
    await runPlan(pl, { send: async () => { singles++; return '0x02'; }, sendBatch: async ss => { batches++; return ss.map(() => '0x03' as const); } }, () => {});
    assert.equal(batches, 1); assert.equal(singles, 0);
    singles = 0;
    await runPlan(pl, { send: async () => { singles++; return '0x02'; }, sendBatch: async () => { throw Object.assign(new Error('x'), { batchUnsupported: true }); } }, () => {});
    assert.equal(singles, 4);
  });
});
