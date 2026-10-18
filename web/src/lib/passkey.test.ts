import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { toHex } from 'viem';
import { deriveEvmKey, DERIVATION_PATH } from './passkey.ts';
import { passkeyEnabled } from './passkeyFlag.ts';

// Fixed, public, non-secret test vector (never a real account). Nothing here is printed.
const PRF = new Uint8Array(32).fill(7);

test('derivation matches the standard BIP-39/BIP-44 wallet path', () => {
  const key = deriveEvmKey(PRF.slice());
  const ours = privateKeyToAccount(toHex(key)).address;
  key.fill(0);
  const ref = mnemonicToAccount(entropyToMnemonic(PRF, wordlist), { path: DERIVATION_PATH as `m/44'/60'/${string}` }).address;
  assert.equal(ours, ref);
});

test('derivation is deterministic and passkey-specific', () => {
  const a = deriveEvmKey(PRF.slice()), b = deriveEvmKey(PRF.slice()), c = deriveEvmKey(new Uint8Array(32).fill(8));
  assert.deepEqual(a, b); assert.notDeepEqual(a, c);
  assert.throws(() => deriveEvmKey(new Uint8Array(16)));
});

test('flag is off unless explicitly enabled', () => {
  assert.equal(passkeyEnabled(undefined), false);
  assert.equal(passkeyEnabled(''), false);
  assert.equal(passkeyEnabled('0'), false);
  assert.equal(passkeyEnabled('1'), true);
  assert.equal(passkeyEnabled('true'), true);
});

test('Mera session account signs transactions and messages that recover to its address', async () => {
  const { createSecp256k1SigningSession } = await import('@category-labs/mera');
  const { sessionAccount } = await import('./passkey.ts');
  const { recoverMessageAddress, recoverTransactionAddress, parseEther } = await import('viem');
  const key = deriveEvmKey(PRF.slice());
  const expected = privateKeyToAccount(toHex(key)).address;
  const session = createSecp256k1SigningSession({ privateKey: key });
  key.fill(0);
  const acct = sessionAccount(session as any);
  assert.equal(acct.address, expected);
  const sig = await acct.signMessage({ message: 'MonaDefi test' });
  assert.equal(await recoverMessageAddress({ message: 'MonaDefi test', signature: sig }), expected);
  const raw = await acct.signTransaction({ chainId: 143, type: 'eip1559', to: expected, value: parseEther('0.001'), nonce: 0, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
  assert.equal(await recoverTransactionAddress({ serializedTransaction: raw as any }), expected);
  session.end();
});

test('passkey provider: rejecting the approval sends nothing; accounts empty after lock', async () => {
  const { createSecp256k1SigningSession } = await import('@category-labs/mera');
  const { passkeyProvider } = await import('./passkey.ts');
  const key = deriveEvmKey(PRF.slice());
  const session = createSecp256k1SigningSession({ privateKey: key });
  key.fill(0);
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => { calls.push(JSON.parse(init?.body ?? '{}').method); return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x0' })); }) as typeof fetch;
  try {
    const asked: string[] = [];
    const chain = { id: 143, name: 'Monad Mainnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.invalid'] } } } as const;
    const pk = passkeyProvider({ session: session as any, chain: chain as any, rpc: 'https://rpc.invalid', explorer: '', approve: async a => { asked.push(a.title); return false; } });
    assert.equal(await pk.provider.request({ method: 'eth_chainId' }), '0x8f');
    assert.deepEqual(await pk.provider.request({ method: 'eth_accounts' }), [pk.address]);
    await assert.rejects(pk.provider.request({ method: 'eth_sendTransaction', params: [{ from: pk.address, to: pk.address, value: '0x1' }] }), (e: any) => e.code === 4001);
    await assert.rejects(pk.provider.request({ method: 'personal_sign', params: ['0x00', pk.address] }), (e: any) => e.code === 4001);
    await assert.rejects(pk.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] }), (e: any) => e.code === 4902);
    assert.equal(asked.length, 2);
    assert.ok(!calls.includes('eth_sendRawTransaction'));
    pk.lock();
    assert.deepEqual(await pk.provider.request({ method: 'eth_accounts' }), []);
    await assert.rejects(pk.provider.request({ method: 'eth_sendTransaction', params: [{}] }), (e: any) => e.code === 4100);
  } finally { globalThis.fetch = realFetch; }
});
