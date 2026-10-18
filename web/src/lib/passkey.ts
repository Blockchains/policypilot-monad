/**
 * MonaDefi passkey accounts (Mera, @category-labs/mera). FEATURE-FLAGGED, OFF BY DEFAULT.
 *
 * Why a flag: Mera derives an ordinary EVM private key IN THE BROWSER from the passkey's WebAuthn PRF output.
 * That goes against this project's usual "no keys in the frontend" stance, so it only runs when the site owner
 * builds with NEXT_PUBLIC_MONADEFI_PASSKEY=1 or a visitor opts in on their own device with ?passkey=1.
 *
 * What this module guarantees:
 * - No key or PRF output is ever stored, logged or sent anywhere. Only the credential id and transports
 *   (public metadata, no key material) and the derived address go to localStorage.
 * - The derived key lives only inside a Mera signing session in memory. The intermediate PRF output, seed and
 *   key bytes are zeroed right after the session is created. Locking or reloading the page ends the session.
 * - Every transaction or signature asks the user first, in plain language. Creating an account grants nothing.
 */
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { createWalletClient, formatEther, hashMessage, hashTypedData, hexToBytes, http, keccak256, serializeSignature, serializeTransaction, toHex, type Address, type Chain, type Hex } from 'viem';
import { publicKeyToAddress, toAccount } from 'viem/accounts';

export const PASSKEY_RDNS = 'com.monadefi.passkey';
export const DERIVATION_PATH = "m/44'/60'/0'/0/0";
const CRED_KEY = (host: string) => `md.passkey.cred.${host}`;

/**
 * BIP-39 mnemonic from the 32-byte PRF output, then BIP-44 m/44'/60'/0'/0/0, as Mera's Monad guide recommends,
 * so the same passkey reproduces the same address and the account stays a standard EOA. Returns fresh key bytes
 * the caller must zero. Pure and deterministic (unit-tested with a fixed, non-secret test vector).
 */
export function deriveEvmKey(prfOutput: Uint8Array, index = 0): Uint8Array {
  if (prfOutput.length !== 32) throw new Error('PRF output must be 32 bytes');
  const seed = mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist));
  try {
    const node = HDKey.fromMasterSeed(seed).derive(`m/44'/60'/0'/0/${index}`);
    if (!node.privateKey) throw new Error('derivation produced no key');
    return new Uint8Array(node.privateKey);
  } finally { seed.fill(0); }
}

export type StoredCredential = { credentialId: string; transports?: string[]; address: Address; createdAt: number; host: string };
export function loadCredential(host = location.hostname): StoredCredential | null {
  try { const s = localStorage.getItem(CRED_KEY(host)); return s ? JSON.parse(s) : null; } catch { return null; }
}
function saveCredential(c: StoredCredential) { localStorage.setItem(CRED_KEY(c.host), JSON.stringify(c)); }
export function forgetCredential(host = location.hostname) { localStorage.removeItem(CRED_KEY(host)); }

export type Approval = { title: string; lines: string[] };
export type Approver = (a: Approval) => Promise<boolean>;

type Session = { publicKey: Uint8Array; signDigest: (d: Uint8Array) => Promise<{ compact: Uint8Array; recovery: number }>; end: () => void };

/** viem LocalAccount over a Mera signing session (viem 2.21 compatible; Mera's own adapter needs viem >= 2.28). */
export function sessionAccount(session: Session) {
  const address = publicKeyToAddress(toHex(session.publicKey));
  const signHash = async (hash: Hex) => {
    const { compact, recovery } = await session.signDigest(hexToBytes(hash));
    return { r: toHex(compact.slice(0, 32)), s: toHex(compact.slice(32, 64)), v: BigInt(27 + recovery), yParity: recovery };
  };
  return toAccount({
    address,
    async signMessage({ message }) { return serializeSignature(await signHash(hashMessage(message))); },
    async signTransaction(tx, opts) { const ser = opts?.serializer ?? serializeTransaction; return ser(tx, await signHash(keccak256(await ser(tx)))); },
    async signTypedData(td) { return serializeSignature(await signHash(hashTypedData(td as any))); },
  });
}

async function startSession(prfOutput: Uint8Array): Promise<Session> {
  const { createSecp256k1SigningSession } = await import('@category-labs/mera');
  const key = deriveEvmKey(prfOutput);
  try { return createSecp256k1SigningSession({ privateKey: key }) as unknown as Session; }
  finally { key.fill(0); prfOutput.fill(0); }
}

export function meraError(e: unknown): string {
  const code = (e as { code?: string })?.code;
  if (code === 'PRF_UNAVAILABLE') return 'This passkey provider does not support the WebAuthn PRF extension that passkey accounts need. iCloud Keychain, Google Password Manager and 1Password work. On desktop Chrome, save the passkey to Google Password Manager, not the local profile.';
  if (code === 'PASSKEY_OPERATION_FAILED') return 'The passkey prompt was cancelled or is not available in this browser.';
  if (code === 'CRYPTO_UNAVAILABLE') return 'This browser lacks the Web Crypto features passkeys need.';
  return (e as Error)?.message ?? 'Passkey error';
}

/** Create a NEW passkey and account. Every call makes a different passkey and a different address. */
export async function createPasskeyAccount(appName = 'MonaDefi'): Promise<{ session: Session; address: Address }> {
  const { createPasskeyWithPrfOutput } = await import('@category-labs/mera');
  const host = location.hostname;
  const created = await createPasskeyWithPrfOutput({ rp: { id: host, name: appName }, user: { name: `MonaDefi account ${new Date().toISOString().slice(0, 10)}`, displayName: 'MonaDefi account' } });
  const session = await startSession(created.prfOutput);
  const address = sessionAccount(session).address;
  saveCredential({ credentialId: created.credentialId, transports: created.transports ? [...created.transports] : undefined, address, createdAt: Date.now(), host });
  return { session, address };
}

/** Sign in with the passkey saved for this host (or let the browser pick any MonaDefi passkey for it). */
export async function signInWithPasskey(): Promise<{ session: Session; address: Address }> {
  const { getPasskeyPrfOutput } = await import('@category-labs/mera');
  const host = location.hostname;
  const stored = loadCredential(host);
  const got = await getPasskeyPrfOutput({ rpId: host, credential: stored ? { credentialId: stored.credentialId, transports: stored.transports } : undefined });
  const session = await startSession(got.prfOutput);
  const address = sessionAccount(session).address;
  saveCredential({ credentialId: got.credentialId, transports: stored?.credentialId === got.credentialId ? stored.transports : undefined, address, createdAt: stored?.createdAt ?? Date.now(), host });
  return { session, address };
}

const rpcErr = (code: number, message: string) => Object.assign(new Error(message), { code });

/**
 * EIP-1193 provider for a passkey session, so the existing wallet code (connect, chain check, sends, receipts)
 * works unchanged. Reads go to the public RPC. eth_sendTransaction and signatures ask `approve` first;
 * a "no" is a standard 4001 user rejection.
 */
export function passkeyProvider(o: { session: Session; chain: Chain; rpc: string; approve: Approver; explorer: string }) {
  const account = sessionAccount(o.session);
  const wc = createWalletClient({ account, chain: o.chain, transport: http(o.rpc) });
  const hexId = toHex(o.chain.id);
  let ended = false;
  const read = async (method: string, params: unknown) => {
    const r = await fetch(o.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? [] }) });
    const j = await r.json(); if (j.error) throw Object.assign(new Error(j.error.message), j.error); return j.result;
  };
  const provider = {
    isMonaDefiPasskey: true,
    async request({ method, params }: { method: string; params?: any }) {
      if (ended && /^(eth_send|personal_sign|eth_sign)/.test(method)) throw rpcErr(4100, 'The passkey session is locked. Sign in with your passkey again.');
      switch (method) {
        case 'eth_accounts': case 'eth_requestAccounts': return ended ? [] : [account.address];
        case 'eth_chainId': return hexId;
        case 'net_version': return String(o.chain.id);
        case 'wallet_switchEthereumChain': if (String(params?.[0]?.chainId).toLowerCase() === hexId) return null; throw rpcErr(4902, `Passkey accounts here run on ${o.chain.name} only.`);
        case 'wallet_addEthereumChain': return null;
        case 'eth_sendTransaction': {
          const tx = params?.[0] ?? {};
          const value = tx.value ? BigInt(tx.value) : 0n;
          const ok = await o.approve({ title: 'Approve this transaction?', lines: [
            `From your passkey account ${account.address}`,
            tx.to ? `To ${tx.to}` : 'Creates a new contract',
            `Sends ${formatEther(value)} MON${tx.data && tx.data !== '0x' ? ' and calls a contract function' : ''}`,
            tx.gas ? `Gas limit ${BigInt(tx.gas).toString()} (Monad charges the full limit)` : 'Gas limit estimated by the network',
            'Nothing is sent unless you press Approve.',
          ] });
          if (!ok) throw rpcErr(4001, 'You rejected the transaction.');
          return wc.sendTransaction({
            account, chain: o.chain, to: tx.to, data: tx.data, value,
            gas: tx.gas ? BigInt(tx.gas) : undefined,
            ...(tx.maxFeePerGas ? { maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: tx.maxPriorityFeePerGas ? BigInt(tx.maxPriorityFeePerGas) : undefined } : {}),
          } as any);
        }
        case 'personal_sign': {
          const [msg] = params ?? [];
          const ok = await o.approve({ title: 'Sign this message?', lines: [`Account ${account.address}`, 'A signature can prove you own this account. It does not send funds by itself.', String(msg).slice(0, 200)] });
          if (!ok) throw rpcErr(4001, 'You rejected the signature.');
          return account.signMessage({ message: typeof msg === 'string' && msg.startsWith('0x') ? { raw: msg as Hex } : String(msg) });
        }
        case 'eth_signTypedData_v4': {
          const td = typeof params?.[1] === 'string' ? JSON.parse(params[1]) : params?.[1];
          const ok = await o.approve({ title: 'Sign this typed data?', lines: [`Account ${account.address}`, `Domain: ${td?.domain?.name ?? 'unknown'}`, 'Typed-data signatures can authorise token permits. Only approve if you expected this.'] });
          if (!ok) throw rpcErr(4001, 'You rejected the signature.');
          return account.signTypedData(td);
        }
        default:
          if (method.startsWith('eth_sign')) throw rpcErr(4200, `${method} is not supported for passkey accounts.`);
          return read(method, params);
      }
    },
    on() { /* no account/chain changes */ },
    removeListener() { /* noop */ },
  };
  return { provider, address: account.address, lock: () => { ended = true; o.session.end(); } };
}

/** Plain-DOM approval dialog (no wallet popup exists for passkey accounts). Text only, never innerHTML. */
export const domApprover: Approver = (a) => new Promise(resolve => {
  const wrap = document.createElement('div');
  wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true'); wrap.dataset.testid = 'passkey-approval';
  wrap.style.cssText = 'position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7);padding:16px';
  const box = document.createElement('div');
  box.style.cssText = 'max-width:440px;width:100%;background:#09090b;border:1px solid rgba(255,255,255,.15);border-radius:24px;padding:20px;color:#e4e4e7;font:14px system-ui';
  const h = document.createElement('h2'); h.textContent = a.title; h.style.cssText = 'font-size:18px;font-weight:600;margin:0 0 10px;color:#fafafa';
  box.appendChild(h);
  for (const l of a.lines) { const p = document.createElement('p'); p.textContent = l; p.style.cssText = 'margin:6px 0;word-break:break-all'; box.appendChild(p); }
  const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;margin-top:16px';
  const mk = (label: string, pri: boolean, v: boolean) => { const b = document.createElement('button'); b.textContent = label; b.dataset.testid = v ? 'passkey-approve' : 'passkey-reject'; b.style.cssText = `flex:1;min-height:44px;border-radius:16px;border:1px solid rgba(255,255,255,.15);background:${pri ? '#836EF9' : 'transparent'};color:#fff;font-weight:500`; b.onclick = () => { wrap.remove(); resolve(v); }; return b; };
  row.appendChild(mk('Reject', false, false)); row.appendChild(mk('Approve', true, true)); box.appendChild(row); wrap.appendChild(box);
  document.body.appendChild(wrap);
});
