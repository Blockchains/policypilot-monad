// Box-only: top the Momentum keeper's gas wallet up from the deployer (the deployer key never leaves
// ~/.policypilot/mainnet-wallet.env and is never printed). Sends only when the keeper is below FLOOR, only up to TARGET,
// and never leaves the deployer below RESERVE + 0.5 MON. Simulated first.
//   node scripts/momentum-keeper-refill.mjs            (FLOOR=2 TARGET=4 RESERVE=5, DRY_RUN=1 to only print the plan)
import fs from 'node:fs'; import os from 'node:os';
import { createPublicClient, createWalletClient, http, fallback, parseEther, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
const E = process.env; const KEEPER = '0xDC079c2c18e5AA4844fB4a62b522962205ac7ad7';
const FLOOR = parseEther(E.FLOOR || '2'), TARGET = parseEther(E.TARGET || '4'), RESERVE = parseEther(E.RESERVE || '5'), MARGIN = parseEther('0.5');
const chain = { id: 143, name: 'Monad', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.monad.xyz'] } } };
const transport = fallback(['https://rpc.monad.xyz', 'https://rpc2.monad.xyz', 'https://rpc3.monad.xyz'].map(u => http(u, { retryCount: 2 })));
const key = fs.readFileSync(os.homedir() + '/.policypilot/mainnet-wallet.env', 'utf8').match(/^MONAD_MAINNET_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/m)?.[1];
if (!key) throw new Error('deployer key not found (value not printed)');
const account = privateKeyToAccount(key); const pc = createPublicClient({ chain, transport }); const wc = createWalletClient({ chain, transport, account });
const [k, d] = await Promise.all([pc.getBalance({ address: KEEPER }), pc.getBalance({ address: account.address })]);
console.log(`keeper ${formatEther(k)} MON, deployer ${formatEther(d)} MON`);
if (k >= FLOOR) { console.log(`keeper at or above the ${formatEther(FLOOR)} MON floor: nothing to do`); process.exit(0); }
let amt = TARGET - k; const room = d - RESERVE - MARGIN;
if (room <= 0n) { console.log('deployer at its reserve: not sending'); process.exit(2); }
if (amt > room) amt = room;
const tx = { to: KEEPER, value: amt };
const gas = await pc.estimateGas({ account, ...tx }); // simulate
console.log(`plan: send ${formatEther(amt)} MON to the keeper (gas ${gas}); deployer after ≈ ${formatEther(d - amt)} MON`);
if (E.DRY_RUN === '1') process.exit(0);
const hash = await wc.sendTransaction({ ...tx, gas });
const r = await pc.waitForTransactionReceipt({ hash });
console.log(JSON.stringify({ hash, status: r.status, block: Number(r.blockNumber), sentMon: formatEther(amt) }));
