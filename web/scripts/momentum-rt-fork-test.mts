// Latency harness on a LOCAL anvil fork of Monad (no mainnet tx): opens a small WETH position in a forked opted-in vault with the
// keeper, sets a 1% take-profit, starts nothing itself. Then `pump` moves the WETH price up with a large buy from an anvil account
// and records the block where the price crossed. Usage: setup | pump <MON>
import fs from 'node:fs';
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseEther, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ASSETS, PCS, WMON, entryCall, quoteData, quoteOut, routerAbi, vaultCallAbi } from '../src/lib/momentumCore.ts';
import { KEEPER } from '../src/lib/momentumKeeper.ts';
const RPC = process.env.RPC!; if (!/127\.0\.0\.1|localhost/.test(RPC)) throw new Error('fork only');
const chain = { id: 143, name: 'fork', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const pc = createPublicClient({ chain, transport: http(RPC, { timeout: 120_000 }) });
const VAULT = process.env.VAULT as Address; const W = ASSETS[0];
const rpc = (method: string, params: unknown[]) => pc.request({ method: method as any, params: params as any });
const [cmd, arg] = process.argv.slice(2);
if (cmd === 'setup') {
  const owner = await pc.readContract({ address: VAULT, abi: vaultCallAbi, functionName: 'owner' }) as Address;
  await rpc('anvil_impersonateAccount', [owner]); await rpc('anvil_setBalance', [owner, '0x56BC75E2D63100000']);
  const ow = createWalletClient({ chain, transport: http(RPC, { timeout: 120_000 }), account: owner });
  await pc.waitForTransactionReceipt({ hash: await ow.writeContract({ address: VAULT, abi: vaultCallAbi, functionName: 'setPaused', args: [false], chain } as any) });
  await rpc('anvil_setBalance', [VAULT, '0x' + parseEther('5').toString(16)]);
  const kw = createWalletClient({ chain, transport: http(RPC, { timeout: 120_000 }), account: privateKeyToAccount(process.env.MOMENTUM_KEEPER_KEY as Hex) });
  if (kw.account.address.toLowerCase() !== KEEPER.toLowerCase()) throw new Error('keeper mismatch');
  const amt = parseEther('2'); const out = quoteOut((await pc.call({ to: PCS.quoter, data: quoteData(WMON, W.address, amt, W.fee) })).data);
  const rid = { action: 1 as const, asset: W.idx, pos: 900, step: 1, amount: amt };
  const c = entryCall(W, VAULT, rid, (out * 99n) / 100n);
  const r = await pc.waitForTransactionReceipt({ hash: await kw.sendTransaction({ to: c.to, data: c.data, chain } as any) });
  console.log('entry on fork', r.status, 'block', r.blockNumber);
} else if (cmd === 'pump') {
  const k = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex; // anvil's public test account 0
  const a = privateKeyToAccount(k); await rpc('anvil_setBalance', [a.address, '0x' + parseEther('10000000').toString(16)]);
  const w = createWalletClient({ chain, transport: http(RPC, { timeout: 120_000 }), account: a });
  const amt = parseEther(arg || '20000');
  const data = encodeFunctionData({ abi: routerAbi, functionName: 'exactInputSingle', args: [{ tokenIn: WMON, tokenOut: W.address, fee: W.fee, recipient: a.address, amountIn: amt, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] });
  const h = await w.sendTransaction({ to: PCS.router, data, value: amt, chain } as any);
  const r = await pc.waitForTransactionReceipt({ hash: h, pollingInterval: 50 });
  fs.writeFileSync('/tmp/rt-fork/pump.json', JSON.stringify({ block: Number(r.blockNumber), at: Date.now() }));
  console.log('pump block', r.blockNumber);
}
