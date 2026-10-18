'use client';
import { decodeErrorResult, encodeDeployData, encodeFunctionData, parseEther, type Abi, type Address, type Hex } from 'viem';
import artifact from './clipArtifact.json';
import { minOuts, type VenueId, venueIndex } from './spread';

export const clipAbi = artifact.abi as Abi;
export const CLIP_BYTECODE = artifact.bytecode as Hex;
/** Deployed runtime from this compile. Immutable words are zero here and filled in at construction. */
export const CLIP_RUNTIME = (artifact.runtime as string).toLowerCase();
const CLIP_IMMUTABLES = artifact.immutables as unknown as readonly (readonly [number, number])[];

export const CLIP_CAP = parseEther('10');
/**
 * Direct-pool clip on a Monad fork, 2026-10-15: 396,776 gas inside the call.
 * 420,000 is that measurement plus room for a cold transaction. Monad charges this limit.
 */
export const CLIP_GAS = 420_000n;
/** Priority tip used with the spread desk. The paid price is base fee plus this tip. */
export const CLIP_TIP = 2_000_000_000n;
export const MIN_BASE_FEE = 100_000_000_000n;

export function maskClipRuntime(code: string): string {
  const hex = code.toLowerCase();
  if (!hex.startsWith('0x')) return hex;
  const chars = hex.split('');
  for (const [start, length] of CLIP_IMMUTABLES) {
    const from = 2 + start * 2;
    const to = from + length * 2;
    for (let i = from; i < to && i < chars.length; i++) chars[i] = '0';
  }
  return chars.join('');
}

/** True only for a pool deployed from the current clip contract. */
export function isCurrentClipCode(code: string | null | undefined): boolean {
  if (!code || code === '0x') return false;
  const live = code.toLowerCase();
  return live.length === CLIP_RUNTIME.length && maskClipRuntime(live) === maskClipRuntime(CLIP_RUNTIME);
}

/** MON the caller pays if the transaction is included at this base fee. A revert costs the same. */
export function clipCharge(baseFee?: bigint | null, gas: bigint = CLIP_GAS): bigint {
  const base = baseFee && baseFee > MIN_BASE_FEE ? baseFee : MIN_BASE_FEE;
  return gas * (base + CLIP_TIP);
}

export function clipDeployData(treasury: Address): Hex {
  return encodeDeployData({ abi: clipAbi, bytecode: CLIP_BYTECODE, args: [treasury, CLIP_CAP] });
}

export function clipCallData(sell: VenueId, buy: VenueId, amount: bigint, usdc: bigint, back: bigint): Hex {
  const mins = minOuts(amount, usdc, back);
  return encodeFunctionData({ abi: clipAbi, functionName: 'clip', args: [venueIndex(sell), venueIndex(buy), amount, mins.minUsdc, mins.minWmon] });
}

export function clipDepositData(): Hex {
  return encodeFunctionData({ abi: clipAbi, functionName: 'deposit' });
}

export function clipWithdrawData(shares: bigint): Hex {
  return encodeFunctionData({ abi: clipAbi, functionName: 'withdraw', args: [shares] });
}

export type ClipGate = { ok: boolean; code: string; label: string; detail: string };

export function clipGate(o: {
  mainnet: boolean; account: boolean; vault: boolean; amount: string; pool: bigint;
  walletBal: bigint | null; quoting: boolean; quoteOk: boolean | null; netPositive: boolean; smallLoss?: boolean;
}): ClipGate {
  let wei: bigint;
  try { wei = parseEther(o.amount || '0'); } catch {
    return { ok: false, code: 'amount', label: 'ENTER AN AMOUNT', detail: 'Use a MON amount such as 0.05.' };
  }
  if (wei <= 0n) return { ok: false, code: 'amount', label: 'ENTER AN AMOUNT', detail: 'The amount needs to be more than 0 MON.' };
  if (!o.mainnet) return { ok: false, code: 'net', label: 'MAINNET ONLY', detail: 'These pools are Uniswap v3 and PancakeSwap v3 on Monad mainnet.' };
  if (!o.vault && wei > CLIP_CAP) return { ok: false, code: 'cap', label: 'EXCEEDS CAP', detail: 'A new clip pool holds at most 10 MON.' };
  if (o.vault && wei > o.pool) return { ok: false, code: 'bal', label: 'LARGER THAN THE POOL', detail: 'A clip cannot sell more MON than the pool holds. The whole balance is allowed.' };
  if (!o.account) return { ok: false, code: 'connect', label: 'CONNECT WALLET', detail: 'One wallet connection opens the pool or submits a clip.' };
  if (!o.vault) {
    if (o.walletBal != null && wei > o.walletBal) return { ok: false, code: 'wallet', label: 'NOT ENOUGH MON', detail: 'Your wallet does not hold this deposit.' };
    return { ok: true, code: 'open', label: 'READY TO OPEN', detail: 'Two signatures: one opens your pool, one deposits this MON. Each is simulated before you sign. There is no promised rate.' };
  }
  if (o.quoting || o.quoteOk == null) return { ok: false, code: 'quote', label: 'QUOTING', detail: 'Asking the pools for this size.' };
  if (!o.quoteOk) return { ok: false, code: 'flat', label: 'LOSS TOO LARGE', detail: 'This size comes back more than 0.50% under the MON sold. Nothing is sent.' };
  if (o.smallLoss) return { ok: true, code: 'loss', label: 'SMALL LOSS', detail: 'This size is flat or inside a 0.50% shortfall. The clip still sends. You pay the gas on top.' };
  if (!o.netPositive) return { ok: true, code: 'gain', label: 'QUOTED GAIN', detail: 'The pool gains MON on this quote. The gas limit costs more than that gain, and you pay it.' };
  return { ok: true, code: 'net', label: 'CLEARS GAS', detail: 'This size returns more MON than the gas limit charges. One signature sends it.' };
}

const CLIP_PLAIN: Record<string, string> = {
  Unprofitable: 'The shortfall was more than 0.50%, so nothing was sent.',
  Floor: 'The minimum back has to stay inside 0.50% of the MON sold.',
  SameVenue: 'The two legs have to be different pools.',
  TradeTooLarge: 'That size is larger than the MON in the pool.',
  VaultCapExceeded: 'That deposit would pass the pool cap.',
  WrongNetwork: 'Clip pools open on Monad mainnet.',
  NotPool: 'Only the Uniswap and PancakeSwap pools can pull tokens.',
  TransferFailed: 'The MON or token transfer failed.',
  ZeroAmount: 'The amount has to be more than 0.',
  InsufficientShares: 'Those shares are not yours.',
};

export function explainClip(e: unknown, fallback: string): string {
  let x: unknown = e;
  while (x && typeof x === 'object') {
    const rec = x as { data?: unknown; cause?: unknown };
    const inner = rec.data && typeof rec.data === 'object' ? (rec.data as { data?: unknown }).data : rec.data;
    const data = typeof inner === 'string' ? inner : typeof rec.data === 'string' ? rec.data : undefined;
    if (data && data.startsWith('0x') && data.length >= 10) {
      try { return CLIP_PLAIN[decodeErrorResult({ abi: clipAbi, data: data as Hex }).errorName] ?? fallback; } catch { /* next */ }
    }
    x = rec.cause;
  }
  return fallback;
}
