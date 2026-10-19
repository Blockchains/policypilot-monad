/**
 * Wallet faults the page can tell apart.
 *
 * A prompt that never returns must release the send lane.
 * A fee rejection is not a cancellation.
 * A dropped provider is one reconnect, then one retry.
 * A submitted hash that is slow to land is not a failed send.
 * A contract revert, a cancellation, and an empty wallet are not retried.
 */

export class WalletSilentError extends Error {
  readonly code = 'WALLET_SILENT';
  constructor(message: string) {
    super(message);
    this.name = 'WalletSilentError';
  }
}

export function withDeadline<T>(work: Promise<T>, ms: number, fail: () => Error): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(fail()), ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export function errorText(e: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let x: unknown = e;
  while (x && typeof x === 'object' && !seen.has(x)) {
    seen.add(x);
    const rec = x as { shortMessage?: string; details?: string; message?: string; cause?: unknown; data?: unknown };
    parts.push(rec.shortMessage ?? '', rec.details ?? '', rec.message ?? '');
    const data = rec.data;
    if (typeof data === 'string') parts.push(data);
    else if (data && typeof data === 'object') {
      const inner = data as { message?: string };
      if (inner.message) parts.push(inner.message);
    }
    x = rec.cause;
  }
  return parts.join(' ').toLowerCase();
}

export function errorCode(e: unknown): number | undefined {
  let x: unknown = e;
  const seen = new Set<unknown>();
  while (x && typeof x === 'object' && !seen.has(x)) {
    seen.add(x);
    const rec = x as { code?: number; cause?: unknown };
    if (typeof rec.code === 'number') return rec.code;
    x = rec.cause;
  }
  return undefined;
}

export function isPromptTimeout(e: unknown): boolean {
  return e instanceof WalletSilentError || (e as { code?: unknown })?.code === 'WALLET_SILENT';
}

/** A person closed the wallet prompt. Fee and gas failures are not cancellations, even when a wallet uses code 4001. */
export function isUserReject(e: unknown): boolean {
  if (isPromptTimeout(e)) return false;
  // viem appends the request ("Request Arguments: … maxFeePerGas: …") to its messages; that dump says nothing about why
  // the wallet refused, so it must not turn a plain rejection into a fee problem (which would prompt a second time).
  const text = errorText(e).replace(/request arguments:[\s\S]*?(?=version:|docs:|details:|$)/g, ' ');
  if (/fee|underpriced|intrinsic gas|maxfee|max fee|priority fee|base fee/.test(text)) return false;
  if (errorCode(e) === 4001 || errorCode(e) === 5000) return true;
  return /user rejected the request|user denied transaction signature|user (?:cancelled|canceled)|rejected the request|denied transaction signature/.test(text);
}

/** The injected provider is gone. One silent reconnect is worth trying. A cancellation is not this. */
export function isConnectorDead(e: unknown): boolean {
  if (isUserReject(e) || isPromptTimeout(e)) return false;
  const code = errorCode(e);
  if (code === 4900 || code === 4901 || code === 4100) return true;
  return /disconnected|provider is disconnected|connection lost|wallet is locked/.test(errorText(e));
}

/** A read failed before it reached a contract. Reverts and fee errors are not transport failures. */
export function isTransportError(e: unknown): boolean {
  if (isUserReject(e) || isConnectorDead(e) || isPromptTimeout(e)) return false;
  const text = errorText(e);
  if (/revert|execution reverted|insufficient funds|exceeds the balance|nonce too low|already known|fee|underpriced|intrinsic gas/.test(text)) return false;
  return /timeout|timed out|network|failed to fetch|fetch failed|http request|socket|econnreset|econnrefused|503|502|429|rate limit|header not found|aborted/.test(text);
}

/**
 * One more wallet prompt, same gas limit, no fee fields, so the wallet can price it.
 * A contract revert, a cancellation, a dead provider, and a silent prompt are not retried.
 */
export function shouldRetryWithoutFees(e: unknown): boolean {
  if (isUserReject(e) || isConnectorDead(e) || isPromptTimeout(e)) return false;
  if (e && typeof e === 'object' && (e as { pending?: boolean }).pending) return false;
  const text = errorText(e);
  if (/insufficient funds|exceeds the balance|nonce too low|already known/.test(text)) return false;
  if (/revert|execution reverted/.test(text) && !/fee|underpriced|gas price/.test(text)) return false;
  return true;
}

export function chainIdNumber(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s = String(raw ?? '');
  return Number.parseInt(s, s.startsWith('0x') || s.startsWith('0X') ? 16 : 10);
}

export type ChainTarget = { id: number; hex: string; name: string; publicRpc: string; exp: string };
export type WalletProvider = { request: (a: { method: string; params?: unknown[] | object }) => Promise<unknown> };

/**
 * Read the chain, switch, and if the wallet does not know Monad, add it and switch again.
 * eth_chainId is a short call. Switch and add wait long enough for a person to tap.
 */
export async function ensureWalletChain(p: WalletProvider, net: ChainTarget, timeouts?: { readMs?: number; promptMs?: number }): Promise<void> {
  const readMs = timeouts?.readMs ?? 8_000;
  const promptMs = timeouts?.promptMs ?? 45_000;
  const read = async () => chainIdNumber(await withDeadline(
    p.request({ method: 'eth_chainId' }),
    readMs,
    () => new WalletSilentError("Your wallet didn't answer the network check. Try the action again."),
  ));
  if (await read() === net.id) return;
  const params = [{ chainId: net.hex }];
  const add = [{
    chainId: net.hex,
    chainName: `Monad${net.id === 143 ? '' : ' Testnet'}`,
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: [net.publicRpc],
    blockExplorerUrls: [net.exp],
  }];
  const ask = (method: string, methodParams: unknown[]) => withDeadline(
    p.request({ method, params: methodParams }),
    promptMs,
    () => new WalletSilentError("Your wallet didn't answer the network switch. Try the action again."),
  );
  try {
    await ask('wallet_switchEthereumChain', params);
  } catch (e) {
    if (isUserReject(e) || isPromptTimeout(e)) throw e;
    await ask('wallet_addEthereumChain', add);
    await ask('wallet_switchEthereumChain', params);
  }
  if (await read() !== net.id) throw new Error(`Switch your wallet to Monad ${net.name}.`);
}

/** Calls land in a few blocks. Deploys wait longer because the page needs the contract address. */
export function receiptWaitMs(deploy: boolean): number {
  return deploy ? 45_000 : 20_000;
}

export function pendingReceiptError(hash: `0x${string}`): Error & { hash: `0x${string}`; pending: true } {
  return Object.assign(
    new Error(`Your wallet submitted this transaction. It is not in a block yet. Wait for it before sending again. ${hash}`),
    { hash, pending: true as const },
  );
}

export function revertedReceiptError(hash: `0x${string}`): Error & { hash: `0x${string}` } {
  return Object.assign(new Error(`The transaction was included and reverted. Gas was still charged. ${hash}`), { hash });
}

/** Reload only when no prompt is open. A change during a send waits until that send finishes. */
export function planWalletReload(inFlight: number, changed: boolean): 'reload' | 'defer' | 'ignore' {
  if (!changed) return 'ignore';
  return inFlight > 0 ? 'defer' : 'reload';
}
