// BOX-ONLY (deployer key). Claims the deployer's unlocked aPriori (aprMON) withdrawal requests to the deployer itself.
// aPriori's redeem(requestIds, receiver) must be sent by the request's controller (the deployer), so it cannot run on GitHub;
// the meta-watchdog only reads the requests and opens "ops: box action needed" when MON has been claimable for 48 h.
//   node runner/apriori-claim.mjs          (DRY_RUN=1 default: lists and simulates)   DRY_RUN=0 to send once
import fs from 'node:fs'; import os from 'node:os';
import { createPublicClient, createWalletClient, parseAbi, formatEther, encodeFunctionData } from 'viem'; import { privateKeyToAccount } from 'viem/accounts';
import { rpcTransport, rpcList } from './chain-util.mjs';
const A = '0x0c65A0BC65a5D819235B71F554D210D3F80E0852', DEPLOYER = '0xc0c4E411e41bECAD6DA860F67063C2D6363a6113';
const abi = parseAbi(['function getUserRequestDataCount(address) view returns (uint256)', 'function getUserRequestData(address,uint256,uint256) view returns ((uint256 id, bool claimed, bool claimable, uint256 shares, uint256 assets, uint256 timestamp, uint64 unlockEpoch)[])', 'function redeem(uint256[] requestIDs, address receiver)']);
const E = process.env; const DRY = E.DRY_RUN !== '0';
const chain = { id: 143, name: 'Monad', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: rpcList(E) } } };
const pc = createPublicClient({ chain, transport: rpcTransport(rpcList(E)) });
const n = await pc.readContract({ address: A, abi, functionName: 'getUserRequestDataCount', args: [DEPLOYER] });
const rows = n ? await pc.readContract({ address: A, abi, functionName: 'getUserRequestData', args: [DEPLOYER, 0n, n] }) : [];
const ready = rows.filter(r => !r.claimed && r.claimable);
for (const r of rows.filter(x => !x.claimed)) console.log(`request ${r.id}: ${formatEther(r.assets)} MON, ${r.claimable ? 'claimable' : 'locked'}`);
if (!ready.length) { console.log('nothing claimable'); process.exit(0); }
const data = encodeFunctionData({ abi, functionName: 'redeem', args: [ready.map(r => r.id), DEPLOYER] });
const gas = await pc.estimateGas({ account: DEPLOYER, to: A, data });
console.log(`simulated redeem of ${ready.length} request(s) to the deployer OK (gas ${gas})`);
if (DRY) { console.log('DRY_RUN (default): nothing sent. Re-run with DRY_RUN=0 to send.'); process.exit(0); }
const key = fs.readFileSync((E.OWNER_ENV || '~/.policypilot/mainnet-wallet.env').replace(/^~/, os.homedir()), 'utf8').match(/^MONAD_MAINNET_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/m)?.[1];
const account = privateKeyToAccount(key); if (account.address !== DEPLOYER) throw new Error('key is not the deployer');
const wc = createWalletClient({ chain, transport: rpcTransport(rpcList(E)), account });
const before = await pc.getBalance({ address: DEPLOYER });
const hash = await wc.sendTransaction({ to: A, data, gas: (gas * 12n) / 10n }); const r = await pc.waitForTransactionReceipt({ hash });
console.log(JSON.stringify({ hash, status: r.status, block: Number(r.blockNumber), deployerDeltaMon: formatEther((await pc.getBalance({ address: DEPLOYER })) - before) }));
