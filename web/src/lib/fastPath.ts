'use client';
import { createPublicClient, http, keccak256, parseGwei, toFunctionSelector, webSocket, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { SERVICES, TOKENS } from './services';
import { chainOf, type Net, type VaultState } from './vault';
import { bufferedGas, cushion, isSimulationRevert, SimulationRevert, simulateGas } from './preflight';
export { cushion };
import { errorText, isTransportError, shouldRetryWithoutFees, WalletSilentError, withDeadline } from './walletFault';

export { isUserReject, isConnectorDead, isPromptTimeout, shouldRetryWithoutFees, ensureWalletChain, planWalletReload, receiptWaitMs, pendingReceiptError, revertedReceiptError, withDeadline, chainIdNumber } from './walletFault';

/**
 * Transaction gas limits. Monad charges the gas limit, not gas used
 * (https://docs.monad.xyz/developer-essentials/gas-pricing).
 *
 * Call-gas ceilings are locked by test/GasProfile.t.sol (gasleft around the call).
 * That measurement shares a transaction with setup, so factory slots stay warm and it
 * understates a standalone send. eth_estimateGas on a Monad mainnet fork (cold accounts,
 * 2026-10-15) is the number a wallet transaction actually needs:
 *   first execute to a new address 177464 (creating the account), to self 150652,
 *   later execute to self 135827, withdraw 85821, deposit 67321, setPaused 50938.
 * Paying a contract can use more gas than this, because the vault forwards the rest of
 * the call. Limits below are the new-address estimate plus the cushion() rule (2% or 3000).
 * A short limit reverts and still spends the whole limit on Monad. If GasProfileTest fails,
 * remeasure and raise these in the same change.
 */
export const GAS = {
  pay: 182_000n,
  vaultDeposit: 75_000n,
  vaultWithdraw: 90_000n,
  pause: 80_000n,
  primeDeposit: 160_000n,
  primeWithdraw: 100_000n,
  /**
   * Fallback only. v4 UnlimitedAgentVaultFactory.createVault estimates 2.09M-2.13M gas on Monad mainnet
   * (2026-10-18; eth_call fails at 99% of the estimate, so the estimate is the true minimum). Creation now uses
   * createGas(): eth_estimateGas + 10%. This fixed value is used only if the RPC cannot estimate.
   */
  createVault: 2_600_000n,
} as const;

/**
 * Gas limit for a vault creation: eth_estimateGas + 10% (about 2.3M, ~0.23 MON at 100 gwei, instead of the old fixed
 * 8,000,000 that Monad billed in full at ~0.8 MON). Safe on Monad: estimates are exact for this call and the 10% covers
 * the first-vault storage slot and state drift between estimate and inclusion. A reverting create still fails the
 * estimate (or the eth_call callers run first), so it is not sent.
 */
export async function createGas(pub: Pick<PublicClient, 'estimateGas'>, account: Address, req: { to: Address; data: Hex; value?: bigint }): Promise<bigint> {
  try {
    const est = await pub.estimateGas({ account, to: req.to, data: req.data, value: req.value ?? 0n });
    return est + est / 10n;
  } catch (e) {
    if (!isTransportError(e)) throw e;
    return GAS.createVault;
  }
}

const DEPOSIT = toFunctionSelector('function deposit()');
const WITHDRAW = toFunctionSelector('function withdraw(address,uint256)');
const PAUSE = toFunctionSelector('function setPaused(bool)');

/** Fixed limit for owner calls whose cost was measured. Anything else returns undefined. */
export function fixedOwnerGas(data?: Hex): bigint | undefined {
  if (!data || data.length < 10) return undefined;
  const sel = data.slice(0, 10).toLowerCase();
  if (sel === DEPOSIT) return GAS.vaultDeposit;
  if (sel === WITHDRAW) return GAS.vaultWithdraw;
  if (sel === PAUSE) return GAS.pause;
  return undefined;
}

/** 2% or 3000 gas, whichever is larger. Replaces the old 30% buffer, which Monad bills in full. */

/** Simulate-first guard used before every wallet or agent-key send (see preflight.ts). */
export function preflightGas(pub: Pick<PublicClient, 'estimateGas'>, from: Address, req: { to?: Address; data?: Hex; value?: bigint; gas?: bigint }): Promise<bigint> {
  return simulateGas(pub, from, req, isTransportError);
}
export { bufferedGas, isSimulationRevert, SimulationRevert };

export async function pricedGas(pub: Pick<PublicClient, 'estimateGas'>, account: Address, req: { to?: Address; data?: Hex; value?: bigint }): Promise<bigint> {
  const once = () => pub.estimateGas({ account, to: req.to, data: req.data, value: req.value ?? 0n });
  try {
    return cushion(await once());
  } catch (e) {
    if (!isTransportError(e)) throw e;
    return cushion(await once());
  }
}

type PolicyView = Pick<VaultState, 'executor' | 'owner' | 'paused' | 'cap' | 'budget' | 'spent' | 'bal' | 'rules'>;
export type LocalVerdict = { ok: true } | { ok: false; name: string; args?: readonly unknown[] };

function attachedOf(kind: string, amount: bigint, cap: bigint): bigint {
  if (kind === 'unwrap' || kind === 'x-drain' || kind === 'x-withdraw' || kind === 'usdctowmon') return 0n;
  if (kind === 'x-cap') return cap >= 2n ** 255n ? 0n : cap * 2n;
  if (kind === 'x-stranger') return 1n;
  if (kind === 'x-self') return 1000n;
  return amount;
}

/**
 * Certain rejects only, from the vault snapshot already in memory.
 * Unsure cases return ok so the chain (one estimateGas, or eth_call when nothing will be sent) decides.
 */
export function evaluateVault(s: PolicyView, signer: Address, kind: string, amount: bigint, to?: Address): LocalVerdict {
  const attached = attachedOf(kind, amount, s.cap);
  if (signer.toLowerCase() !== s.executor.toLowerCase()) return { ok: false, name: 'NotExecutor' };
  if (kind === 'x-withdraw') {
    if (s.executor.toLowerCase() !== s.owner.toLowerCase()) return { ok: false, name: 'NotOwner' };
    return { ok: true };
  }
  if (s.paused) return { ok: false, name: 'Paused' };
  // v4 vaults have no caps or allowlists: these probes would succeed and move funds, so the app never sends them.
  if (s.cap >= 2n ** 255n && (kind === 'x-cap' || kind === 'x-stranger' || kind === 'x-drain' || kind === 'x-self')) return { ok: false, name: 'NoLimitToProbe' };
  if (kind === 'x-stranger') return { ok: false, name: 'RecipientNotAllowed', args: ['0x000000000000000000000000000000000000dEaD'] };
  if (kind === 'x-drain') return { ok: false, name: 'CallNotAllowed', args: [TOKENS.USDC.address, '0xa9059cbb'] };
  if (kind === 'x-self') {
    const uni = SERVICES.find(x => x.id === 'uniswap')?.address ?? '0x0000000000000000000000000000000000000000';
    return { ok: false, name: 'CallNotAllowed', args: [uni, '0x04e45aaf'] };
  }
  if ((kind === 'pay' || kind === 'payto' || kind === 'x-cap') && attached === 0n) return { ok: false, name: 'ZeroAmount' };
  if (attached > s.cap) return { ok: false, name: 'PerPaymentCapExceeded', args: [attached, s.cap] };
  const remaining = s.budget > s.spent ? s.budget - s.spent : 0n;
  if (attached > remaining) return { ok: false, name: 'BudgetExceeded', args: [attached, remaining] };
  if (attached > s.bal) return { ok: false, name: 'InsufficientBalance', args: [attached, s.bal] };
  // `rules` includes 'pay' only when the owner is an allowlisted recipient. A pay-to-address
  // target is not in that snapshot, so it is left for one eth_call instead of a false reject.
  if (kind === 'pay' && !s.rules.includes('pay')) return { ok: false, name: 'RecipientNotAllowed', args: [s.owner] };
  if (kind === 'payto' && to && to.toLowerCase() === s.owner.toLowerCase() && !s.rules.includes('pay')) return { ok: false, name: 'RecipientNotAllowed', args: [to] };
  return { ok: true };
}

/** Public WebSocket endpoints. Empty when `?rpc=` replaced the public list, so fork tests stay on that RPC. */
export function socketUrls(net: Net): string[] {
  if (!net.rpcs?.length) return [];
  if (net.id === 143) return ['wss://rpc.monad.xyz', 'wss://rpc3.monad.xyz'];
  if (net.id === 10143) return ['wss://testnet-rpc.monad.xyz', 'wss://rpc-testnet.monadinfra.com'];
  return [];
}

let lastBaseFee = parseGwei('100');
function noteBaseFee(fee: bigint) { if (fee > 0n) lastBaseFee = fee; }

/** What the user can be charged up to. They pay base + priority, and the cost lever on Monad is the gas limit. */
export function feeCaps() {
  const floor = parseGwei('100');
  const base = lastBaseFee > floor ? lastBaseFee : floor;
  const priority = parseGwei('2');
  return { maxFeePerGas: base * 2n + priority, maxPriorityFeePerGas: priority };
}

/** Read the latest base fee, then build caps. A stale or silent read must not block the wallet prompt. */
export async function freshFeeCaps(readBaseFee: () => Promise<bigint | null | undefined>) {
  try {
    const fee = await withDeadline(readBaseFee(), 4_000, () => new Error('base fee unread'));
    if (fee && fee > 0n) noteBaseFee(fee);
  } catch { /* the cached base fee still produces a usable cap */ }
  return feeCaps();
}

const clients = new Map<string, PublicClient>();
function wsOf(net: Net, url: string): PublicClient {
  const key = `w:${net.id}:${url}`;
  let c = clients.get(key);
  if (!c) {
    c = createPublicClient({ chain: chainOf(net), transport: webSocket(url, { keepAlive: true, reconnect: true, timeout: 12_000 }) });
    clients.set(key, c);
  }
  return c;
}
function httpOf(net: Net, url: string): PublicClient {
  const key = `h:${net.id}:${url}`;
  let c = clients.get(key);
  if (!c) {
    c = createPublicClient({ chain: chainOf(net), transport: http(url, { batch: false, retryCount: 0, timeout: 12_000 }) });
    clients.set(key, c);
  }
  return c;
}

/** Two warm sockets. The HTTP poll in the page stays until the first head arrives. */
export function watchHeads(net: Net, onHead: (block: bigint) => void): () => void {
  const urls = socketUrls(net).slice(0, 2);
  if (!urls.length) return () => {};
  let seen = -1n;
  const stops: (() => void)[] = [];
  for (const url of urls) {
    const stop = wsOf(net, url).watchBlocks({
      onBlock(block) {
        const n = block.number;
        if (n == null || n <= seen) return;
        seen = n;
        if (block.baseFeePerGas) noteBaseFee(block.baseFeePerGas);
        onHead(n);
      },
      onError() { /* the HTTP poll covers a dead socket */ },
    });
    stops.push(stop);
  }
  return () => { for (const s of stops) { try { s(); } catch { /* already closed */ } } };
}

function isKnown(e: unknown): boolean {
  const m = errorText(e);
  return m.includes('already known') || m.includes('nonce too low') || m.includes('already imported') || m.includes('known transaction');
}

async function broadcastRaw(net: Net, serialized: Hex): Promise<Hex> {
  const httpUrls = (net.rpcs?.length ? net.rpcs : [net.rpc]).slice(0, 2);
  const targets = [...socketUrls(net).slice(0, 2).map(u => wsOf(net, u)), ...httpUrls.map(u => httpOf(net, u))];
  try {
    return await Promise.any(targets.map(async c => {
      try { return await c.sendRawTransaction({ serializedTransaction: serialized }); }
      catch (e) { if (isKnown(e)) return keccak256(serialized); throw e; }
    }));
  } catch (e) {
    const inner = (e as AggregateError).errors ?? [e];
    if (inner.some(isKnown)) return keccak256(serialized);
    throw inner[0] ?? e;
  }
}

export type WalletSendRequest = { to?: Address; data?: Hex; value?: bigint; gas?: bigint };

let walletLane: Promise<unknown> = Promise.resolve();

/** How long a wallet prompt may sit before the next click is allowed to start. */
export const WALLET_PROMPT_MS = 90_000;

/**
 * One wallet prompt at a time. A second click waits instead of stacking nonces.
 * If the provider never answers, this job ends and the lane opens. The original
 * request can still complete in the wallet; close that prompt before sending again.
 */
export function queueWallet<T>(fn: () => Promise<T>, ms = WALLET_PROMPT_MS): Promise<T> {
  const run = walletLane.catch(() => undefined).then(() => withDeadline(
    Promise.resolve().then(fn),
    ms,
    () => new WalletSilentError("Your wallet didn't answer. If that prompt is still open, close it before you try again."),
  ));
  walletLane = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Ask the wallet once with a fresh fee cap and the known gas limit.
 * If the wallet rejects the cap, ask once more with the same gas and no fee fields.
 * The connector must be created with retryCount 0, or viem will re-prompt on its own.
 */
export async function sendViaWallet(w: WalletClient, readBaseFee: () => Promise<bigint | null | undefined>, req: WalletSendRequest): Promise<Hex> {
  if (!w.account) throw new Error('Connect your wallet first.');
  const gas = req.gas;
  const body: Record<string, unknown> = { account: w.account, chain: w.chain };
  if (req.to) body.to = req.to;
  if (req.data) body.data = req.data;
  if (req.value != null) body.value = req.value;
  if (gas) body.gas = gas;
  const once = async (fees: boolean) => w.sendTransaction((fees && gas ? { ...body, ...(await freshFeeCaps(readBaseFee)) } : { ...body }) as Parameters<WalletClient['sendTransaction']>[0]);
  try {
    return await once(!!gas);
  } catch (e) {
    if (!gas || !shouldRetryWithoutFees(e)) throw e;
    return await once(false);
  }
}

const nonceNext = new Map<string, number>();
const lane = new Map<string, Promise<unknown>>();

/**
 * Sign once with the agent key held in this browser, then race the same raw transaction
 * to the WebSocket pool and two HTTP endpoints. Wallet-popup transactions cannot do this.
 */
export function sendWithKey(net: Net, key: Hex, req: { to: Address; data?: Hex; value?: bigint; gas: bigint }, nonceSource: PublicClient): Promise<Hex> {
  const account = privateKeyToAccount(key);
  const id = account.address.toLowerCase();
  const prev = lane.get(id) ?? Promise.resolve();
  // Simulate first, in parallel with the lane wait, nonce and fee reads; a revert means nothing is signed.
  const sim = preflightGas(nonceSource, account.address, req);
  sim.catch(() => undefined);
  const job = prev.catch(() => undefined).then(async () => {
    const gas = await sim;
    let nonce = nonceNext.get(id);
    if (nonce == null) {
      nonce = await withDeadline(
        nonceSource.getTransactionCount({ address: account.address, blockTag: 'pending' }),
        12_000,
        () => new Error('The network did not answer. Nothing was sent.'),
      );
      nonceNext.set(id, nonce);
    }
    const fees = await freshFeeCaps(() => nonceSource.getBlock().then(b => b.baseFeePerGas));
    const serialized = await account.signTransaction({
      chainId: net.id, to: req.to, data: req.data, value: req.value ?? 0n, gas, nonce,
      maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, type: 'eip1559',
    });
    try {
      const hash = await withDeadline(broadcastRaw(net, serialized), 20_000, () => new Error('The network did not accept the transaction. Nothing was confirmed.'));
      nonceNext.set(id, nonce + 1);
      return hash;
    } catch (e) {
      nonceNext.delete(id);
      throw e;
    }
  });
  lane.set(id, job.then(() => undefined, () => undefined));
  return job;
}
