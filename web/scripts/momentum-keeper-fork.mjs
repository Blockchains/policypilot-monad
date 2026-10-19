// Fork rehearsal of the keeper (anvil --fork-url https://rpc2.monad.xyz --port 8547). Impersonates the deployer address
// (no key needed on a fork), opts a fresh vault in, then runs the real keeper script: entry → hold → time-stop exit →
// sweep → revoke. The keeper key is read from ~/.policypilot/momentum-keeper.env and passed by env (never printed).
import fs from 'node:fs'; import os from 'node:os'; import { spawnSync } from 'node:child_process';
import { createPublicClient, http, encodeFunctionData, parseAbi, parseEther, formatEther } from 'viem';
import { optInCall, revokeCall, cleanSettings, KEEPER } from '../src/lib/momentumKeeper.ts';
const R = 'http://127.0.0.1:8547'; const O = '0xc0c4E411e41bECAD6DA860F67063C2D6363a6113'; const F = '0x41d6667aA35c3634D19068A39481d4c955f6557D';
const pc = createPublicClient({ transport: http(R) }); const rpc = (method, params) => pc.request({ method, params });
const send = async (tx) => { const h = await rpc('eth_sendTransaction', [{ from: O, ...tx }]); const r = await pc.waitForTransactionReceipt({ hash: h }); if (r.status !== 'success') throw new Error('fork tx failed ' + h); return r; };
await rpc('anvil_impersonateAccount', [O]); await rpc('anvil_setBalance', [O, '0x56BC75E2D63100000']); await rpc('anvil_setBalance', [KEEPER, '0x4563918244F40000']);
const fa = parseAbi(['function createVault(address) payable returns (address)', 'function vaultsOf(address) view returns (address[])']);
await send({ to: F, data: encodeFunctionData({ abi: fa, functionName: 'createVault', args: [O] }), value: '0x' + parseEther('1.2').toString(16) });
const vs = await pc.readContract({ address: F, abi: fa, functionName: 'vaultsOf', args: [O] }); const V = vs[vs.length - 1];
const start = Number(await pc.getBlockNumber()) - 2;
const s = cleanSettings({ pos: 0.5, max: 1, share: 100, hold: 0.25, sweep: true, keep: 0, ackCost: true, entries: true, exits: true, slip: 1 });
const opt = await send(optInCall(V, s)); console.log('vault', V, 'opt-in gasUsed', opt.gasUsed, 'executor now', await pc.readContract({ address: V, abi: parseAbi(['function executor() view returns (address)']), functionName: 'executor' }));
const key = fs.readFileSync(os.homedir() + '/.policypilot/momentum-keeper.env', 'utf8').match(/^MOMENTUM_KEEPER_KEY=(0x[0-9a-fA-F]{64})/m)[1];
const dir = '/tmp/keeper-fork'; fs.rmSync(dir, { recursive: true, force: true });
const run = (label, extra = {}) => { const r = spawnSync('npx', ['-y', 'node@22', '--no-warnings', '--experimental-strip-types', 'scripts/momentum-keeper.mts'], { env: { ...process.env, MOMENTUM_KEEPER_KEY: key, RPC: R, KEEPER_DIR: dir, KEEPER_START_BLOCK: String(start), KEEPER_OUT: dir + '/alert.json', ...extra }, encoding: 'utf8' });
  const out = (r.stdout + r.stderr).replaceAll(key, '<redacted>').split('\n').filter(l => /ACTION|done:|failed|Error|error/.test(l)).map(l => l.slice(0, 400)).join('\n'); console.log(`--- ${label} (exit ${r.status})\n${out}`); };
const bal = async () => `vault ${formatEther(await pc.getBalance({ address: V }))} MON, owner ${formatEther(await pc.getBalance({ address: O }))} MON`;
run('run 1: forced test entry', { TEST_FORCE_ENTRY: '1' }); console.log(await bal());
run('run 2: holding (no trigger yet)');
await rpc('evm_increaseTime', [1000]); await rpc('evm_mine', []);
run('run 3: time stop → exit'); console.log(await bal());
run('run 4: sweep'); console.log(await bal());
await send(revokeCall(V, O)); run('run 5: after revoke');
console.log(JSON.stringify(JSON.parse(fs.readFileSync(dir + '/alert.json', 'utf8')).alert));
