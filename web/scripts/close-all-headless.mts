// Headless "Close & withdraw all" on Monad mainnet, using the SAME positionsCore code the Positions tab runs
// (findVaults → readVaultPositions → buildClosePlan → runPlan). Only the signer adapter differs: viem local accounts
// instead of the browser wallet / browser agent key.
//
//   OWNER_ENV=~/.policypilot/mainnet-wallet.env  (MONAD_MAINNET_PRIVATE_KEY=..., never printed)
//   AGENT_ENV=/path/agent.env                     (optional AGENT_PRIVATE_KEY=..., the "agent key in this browser")
//   VAULTS=0xA,0xB                                (required: only these owner vaults are touched)
//   UNWRAP=1                                      (default 1)
//   OUT=close-all-result.json
// node --experimental-transform-types scripts/close-all-headless.mts   (Node 22.7+; rpcLimit.ts needs transform, not strip)
import fs from 'node:fs';
import os from 'node:os';
import { createPublicClient, createWalletClient, fallback, http, formatEther, getAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Gate, limitedTransport } from '../src/lib/rpcLimit.ts';
import { buildClosePlan, findVaults, isEmpty, readRates, readVaultPositions, runPlan, type Step, type VaultPos } from '../src/lib/positionsCore.ts';

const E = process.env;
const RPCS = ['https://rpc.monad.xyz', 'https://rpc1.monad.xyz', 'https://rpc3.monad.xyz', 'https://rpc-mainnet.monadinfra.com', 'https://rpc2.monad.xyz'];
const chain = { id: 143, name: 'Monad', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [RPCS[0]] } } } as const;
const transport = limitedTransport(fallback(RPCS.map(u => http(u, { batch: false, retryCount: 1, retryDelay: 300, timeout: 12_000 })), { rank: false, retryCount: 2 }), new Gate(4));
const pub = createPublicClient({ chain, transport }) as any;
const keyFrom = (file: string | undefined, name: string): Hex | null => {
  if (!file) return null;
  const txt = fs.readFileSync(file.replace(/^~/, os.homedir()), 'utf8');
  const m = new RegExp(`^${name}=\\s*(0x)?([0-9a-fA-F]{64})\\s*$`, 'm').exec(txt);
  return m ? (`0x${m[2]}` as Hex) : null;
};
const ownerKey = keyFrom(E.OWNER_ENV, 'MONAD_MAINNET_PRIVATE_KEY'); if (!ownerKey) throw new Error('OWNER_ENV has no MONAD_MAINNET_PRIVATE_KEY');
const agentKey = keyFrom(E.AGENT_ENV, 'AGENT_PRIVATE_KEY');
const owner = privateKeyToAccount(ownerKey); const agent = agentKey ? privateKeyToAccount(agentKey) : null;
const only = new Set((E.VAULTS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
if (!only.size) throw new Error('VAULTS is required (comma list): the headless run never touches other vaults.');
const wcOwner = createWalletClient({ account: owner, chain, transport });
const wcAgent = agent ? createWalletClient({ account: agent, chain, transport }) : null;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const snap = (p: VaultPos) => ({ vault: p.vault, paused: p.paused, owner: p.owner, executor: p.executor, native: formatEther(p.native), tokens: p.tokens.map(t => `${t.amount} ${t.sym}`), pools: p.pools.length, aprRequests: p.aprRequests.length, lpNfts: p.lpNfts.length, kuru: p.kuru.length, empty: isEmpty(p) });

const read = async () => {
  const found = (await findVaults(pub, { account: owner.address, scanAgents: false, includeShowcase: false })).filter(f => only.has(f.vault.toLowerCase()));
  const rates = await readRates(pub, null);
  return { found, rates, vs: await Promise.all(found.map(f => readVaultPositions(pub, f, { rates }))) };
};
const before = await read();
if (before.found.length !== only.size) throw new Error(`only ${before.found.length}/${only.size} of VAULTS are owned by ${owner.address}`);
const walletBefore = await pub.getBalance({ address: owner.address });
log('owner', owner.address, 'MON', formatEther(walletBefore), 'agent', agent?.address ?? '(none)');
for (const p of before.vs) log('before', JSON.stringify(snap(p)));
const access = (p: VaultPos) => (agent && p.executor.toLowerCase() === agent.address.toLowerCase() ? 'key' as const : p.executor.toLowerCase() === owner.address.toLowerCase() ? 'wallet' as const : null);
const plan = buildClosePlan({ account: owner.address, vaults: before.vs, access, unwrap: E.UNWRAP !== '0' });
log('plan', plan.steps.length, 'steps,', plan.walletSigs, 'owner signatures'); for (const s of plan.steps) log('  -', s.signer, s.label);
for (const m of plan.manual) log('  manual:', m.what, '-', m.why);
if (E.DRY_RUN === '1') process.exit(0);
const sendStep = async (s: Step): Promise<Hex> => {
  const wc = s.signer === 'agent-key' ? wcAgent : wcOwner; if (!wc) throw new Error('no agent key');
  const est = await pub.estimateGas({ account: wc.account.address, to: s.to, data: s.data });
  const hash = await wc.sendTransaction({ to: s.to, data: s.data, gas: est + est / 10n, chain } as any);
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 120_000, pollingInterval: 500 });
  if (rc.status !== 'success') throw Object.assign(new Error(`reverted ${hash}`), { hash });
  log('  ok', s.signer, s.label, hash); return hash;
};
const st = await runPlan(plan, { send: sendStep }, () => {});
const after = await read();
for (const p of after.vs) log('after', JSON.stringify(snap(p)));
const walletAfter = await pub.getBalance({ address: owner.address });
const res = { owner: owner.address, agent: agent?.address ?? null, walletBefore: formatEther(walletBefore), walletAfter: formatEther(walletAfter), plan: plan.steps.map((s, i) => ({ signer: s.signer, label: s.label, vault: s.vault, status: st[i].status, hash: st[i].hash, error: st[i].error })), manual: plan.manual, before: before.vs.map(snap), after: after.vs.map(snap), allEmpty: after.vs.every(isEmpty) };
fs.writeFileSync(E.OUT || 'close-all-result.json', JSON.stringify(res, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
log('allEmpty', res.allEmpty, 'wallet', res.walletBefore, '→', res.walletAfter);
if (!res.allEmpty || st.some(x => x.status !== 'done')) process.exit(1);
