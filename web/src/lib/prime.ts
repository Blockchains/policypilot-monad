import { decodeErrorResult, encodeDeployData, encodeFunctionData, formatEther, parseEther, type Abi, type Address, type Hex } from 'viem';
import artifact from './primeArtifact.json';

export const primeAbi = artifact.abi as Abi;
export const PRIME_BYTECODE = artifact.bytecode as Hex;

/** Matches PolicyPilotPrimeVault's constants and the caps this app deploys with. */
export const PRIME_CAP = parseEther('10');
export const PRIME_HOP = parseEther('10');
/** A hop on a vault opened here may lose 0.05 MON and still settle. A larger loss reverts. */
export const PRIME_LOSS = parseEther('0.05');
export const SENIOR_PROFIT_BPS = 3000;
export const FEE_BPS = 1000;
export const HOP_BPS = 10_000;
export const BREAKER_BPS = 150;

export type TrancheId = 0 | 1;

export type PrimeGate = { ok: boolean; code: string; label: string; detail: string };

const show = (v: bigint) => `${Number(formatEther(v)).toLocaleString(undefined, { maximumFractionDigits: 4 })} MON`;

/** Instant check. The chain is asked only when the user deposits. */
export function primeGate(o: {
  account: boolean; vault: boolean; halted: boolean; amount: string;
  nav: bigint; cap: bigint; walletBal: bigint | null;
}): PrimeGate {
  let wei: bigint;
  try { wei = parseEther(o.amount || '0'); } catch {
    return { ok: false, code: 'amount', label: 'ENTER AN AMOUNT', detail: 'Use a MON amount such as 0.05.' };
  }
  if (wei <= 0n) return { ok: false, code: 'amount', label: 'ENTER AN AMOUNT', detail: 'The deposit needs more than 0 MON.' };
  if (wei > o.cap || o.nav + wei > o.cap) {
    const room = o.cap > o.nav ? o.cap - o.nav : 0n;
    return { ok: false, code: 'cap', label: 'EXCEEDS CAP', detail: `This pool can still take ${show(room)}. The cap is ${show(o.cap)}.` };
  }
  if (!o.account) return { ok: false, code: 'connect', label: 'CONNECT WALLET', detail: 'One wallet connection, then this button deposits.' };
  if (o.walletBal != null && wei > o.walletBal) return { ok: false, code: 'bal', label: 'NOT ENOUGH MON', detail: `Your wallet holds ${show(o.walletBal)}.` };
  if (o.walletBal != null && wei + primeGasKeep(!o.vault) > o.walletBal) return { ok: false, code: 'bal', label: 'LEAVE MON FOR GAS', detail: `Keep about ${show(primeGasKeep(!o.vault))} for gas${o.vault ? '' : ' (opening the vault uses about 3M gas)'}. Your wallet holds ${show(o.walletBal)}; Max fills the right amount.` };
  if (o.halted) return { ok: false, code: 'halt', label: 'TRADING HALTED', detail: 'The pool is under its high watermark. Withdrawals stay open.' };
  if (!o.vault) return { ok: true, code: 'open', label: 'READY TO OPEN', detail: 'Two signatures: one opens your vault, one deposits into this tranche. Each is simulated before you sign.' };
  return { ok: true, code: 'go', label: 'PASSED — READY', detail: 'Inside the cap. Deposit sends one transaction.' };
}

/** MON kept back for gas: opening (factory create, ~2.9M gas used, limit ~3.2M at ~102 gwei) plus the deposit, or a deposit alone (~160k). */
export function primeGasKeep(opening: boolean): bigint { return parseEther(opening ? '0.35' : '0.02'); }

export function primeDeployData(guardian: Address, treasury: Address, executor: Address, tranche: TrancheId): Hex {
  return encodeDeployData({
    abi: primeAbi,
    bytecode: PRIME_BYTECODE,
    args: [guardian, treasury, executor, PRIME_CAP, PRIME_HOP, PRIME_LOSS, tranche],
  });
}

export function primeDepositData(tranche: TrancheId): Hex {
  return encodeFunctionData({ abi: primeAbi, functionName: 'deposit', args: [tranche] });
}

export function primeWithdrawData(tranche: TrancheId, shares: bigint): Hex {
  return encodeFunctionData({ abi: primeAbi, functionName: 'withdraw', args: [tranche, shares] });
}

const PRIME_PLAIN: Record<string, string> = {
  VaultCapExceeded: 'That deposit would pass the pool cap.',
  CircuitBreakerTripped: 'Trading is halted. You can still withdraw.',
  InsufficientShares: 'Those shares are not in this wallet.',
  ZeroDeposit: 'The deposit needs more than 0 MON.',
  ZeroAssets: 'This tranche has nothing to withdraw.',
  TransferFailed: 'The MON transfer failed.',
  NotAdmin: 'Only the vault admin can do that.',
  NotExecutor: 'Only the vault executor can run a hop.',
};

export function explainPrime(e: unknown, fallback: string): string {
  let x: any = e;
  while (x) {
    const d = x.data?.data ?? x.data;
    if (typeof d === 'string' && d.startsWith('0x') && d.length >= 10) {
      try {
        const name = decodeErrorResult({ abi: primeAbi, data: d as Hex }).errorName;
        return PRIME_PLAIN[name] ?? name;
      } catch { /* next */ }
    }
    x = x.cause;
  }
  return fallback;
}

export function trancheAssets(v: unknown): bigint {
  if (Array.isArray(v)) return BigInt(v[0]);
  if (v && typeof v === 'object' && 'totalAssets' in v) return BigInt((v as { totalAssets: bigint }).totalAssets);
  return 0n;
}
