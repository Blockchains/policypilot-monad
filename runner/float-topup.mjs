// BOX-ONLY (deployer key, never on GitHub). Tops up one of the two GitHub-run floats with a plain transfer:
//   node runner/float-topup.mjs showcase <MON>   -> ShowcaseRefiller v4 0x6B4E…573c (team agents + vaults)
//   node runner/float-topup.mjs keeper <MON>     -> KeeperRefiller     0xf7d3…A94C (Momentum keeper gas)
// DRY_RUN=1 is the default (simulates, sends nothing); DRY_RUN=0 sends once. Keeps the deployer >= RESERVE (5) + 0.5 MON.
// The key is read from ~/.policypilot/mainnet-wallet.env (OWNER_ENV) and never printed. The meta-watchdog opens the
// "ops: box action needed" issue at least 30 days before either float would run dry.
import fs from 'node:fs'; import os from 'node:os';
import { createPublicClient, createWalletClient, parseEther, formatEther } from 'viem'; import { privateKeyToAccount } from 'viem/accounts';
import { rpcTransport, rpcList } from './chain-util.mjs';
const TARGETS = { showcase: '0x6B4EA80c7207E25116eCDFB3E0C6F3DCC359573c', keeper: '0xf7d3841d68988a074e309e033484ce532018A94C' };
const DEPLOYER = '0xc0c4E411e41bECAD6DA860F67063C2D6363a6113';
const [which, amt] = process.argv.slice(2); const to = TARGETS[which];
if (!to || !(Number(amt) > 0)) { console.log('usage: node runner/float-topup.mjs showcase|keeper <MON>'); process.exit(2); }
const E = process.env; const DRY = E.DRY_RUN !== '0'; const RESERVE = parseEther(E.RESERVE || '5') + parseEther('0.5');
const chain = { id: 143, name: 'Monad', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: rpcList(E) } } };
const pc = createPublicClient({ chain, transport: rpcTransport(rpcList(E)) });
const value = parseEther(String(amt));
const [d, f] = await Promise.all([pc.getBalance({ address: DEPLOYER }), pc.getBalance({ address: to })]);
console.log(`${which} float ${formatEther(f)} MON, deployer ${formatEther(d)} MON, top-up ${amt} MON`);
if (d - value < RESERVE) { console.log(`STOP: the deployer would drop below ${formatEther(RESERVE)} MON`); process.exit(1); }
const gas = await pc.estimateGas({ account: DEPLOYER, to, value });
console.log(`simulated OK (gas ${gas}); deployer after ≈ ${formatEther(d - value)} MON`);
if (DRY) { console.log('DRY_RUN (default): nothing sent. Re-run with DRY_RUN=0 to send.'); process.exit(0); }
const key = fs.readFileSync((E.OWNER_ENV || '~/.policypilot/mainnet-wallet.env').replace(/^~/, os.homedir()), 'utf8').match(/^MONAD_MAINNET_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/m)?.[1];
if (!key) throw new Error('deployer key not found (value never printed)');
const account = privateKeyToAccount(key); if (account.address !== DEPLOYER) throw new Error('key is not the deployer');
const wc = createWalletClient({ chain, transport: rpcTransport(rpcList(E)), account });
const hash = await wc.sendTransaction({ to, value, gas }); const r = await pc.waitForTransactionReceipt({ hash });
console.log(JSON.stringify({ hash, status: r.status, block: Number(r.blockNumber), floatAfter: formatEther(await pc.getBalance({ address: to })) }));
