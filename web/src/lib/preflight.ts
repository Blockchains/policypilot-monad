import type { Address, Hex, PublicClient } from 'viem';

/** Gas limit = estimate + max(2%, 3000). Monad charges the full limit, so the buffer stays small. */
export function cushion(estimate: bigint): bigint {
  const extra = estimate / 50n > 3000n ? estimate / 50n : 3000n;
  return estimate + extra;
}

/** Creations and heavy calls (> 500k) get +10%, light calls the cushion. A caller's measured limit is a floor. */
export function bufferedGas(estimate: bigint, creation: boolean, floor?: bigint): bigint {
  const want = creation || estimate > 500_000n ? estimate + estimate / 10n : cushion(estimate);
  return floor != null && floor > want ? floor : want;
}

/** Thrown when the pre-send simulation reverts: nothing was sent and no gas was spent. Keeps the revert data for decoding. */
export class SimulationRevert extends Error {
  simulated = true as const; data?: Hex; cause: unknown;
  constructor(cause: unknown) {
    const c = cause as { details?: string; shortMessage?: string; message?: string } | null;
    super(String(c?.details || c?.shortMessage || c?.message || 'the contract would revert').split('\n')[0].slice(0, 200));
    this.cause = cause;
    let x: any = cause;
    for (let i = 0; x && i < 8; i++, x = x.cause) { const d = x.data?.data ?? x.data; if (typeof d === 'string' && d.startsWith('0x')) { this.data = d as Hex; break; } }
  }
}
export const isSimulationRevert = (e: unknown): e is SimulationRevert => !!e && typeof e === 'object' && (e as { simulated?: boolean }).simulated === true;

/**
 * eth_estimateGas from the sender before anything is signed. A revert throws SimulationRevert. If the RPC itself failed,
 * the caller's own limit is kept (or the error is rethrown when there is none).
 */
export async function simulateGas(pub: Pick<PublicClient, 'estimateGas'>, from: Address, req: { to?: Address; data?: Hex; value?: bigint; gas?: bigint }, isTransport: (e: unknown) => boolean): Promise<bigint> {
  try {
    const est = await pub.estimateGas({ account: from, to: req.to, data: req.data, value: req.value ?? 0n });
    return bufferedGas(est, !req.to, req.gas);
  } catch (e) {
    if (isTransport(e)) { if (req.gas) return req.gas; throw e; }
    throw new SimulationRevert(e);
  }
}

/** Wording for a pre-send simulation revert: say plainly that nothing went out. */
export function notSent(e: unknown, reason: string): string {
  if (!isSimulationRevert(e)) return reason;
  const r = (reason || 'the contract would revert').replace(/\.$/, '');
  return `Not sent: the simulation reverted (${r}). Nothing was signed and no gas was spent.`;
}
