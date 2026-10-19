/**
 * One round-trip quote for the journey agent: all forward legs in one Multicall3 eth_call, then all back legs in a second.
 * Two RPC requests per check (the desks use up to ten separate eth_calls), so the agent stays inside the RPC budget.
 */
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { TOKENS } from './services';
import { roundTripBacks, SETTLEMENT_VENUES, VENUES, venueIndex, type VenueId } from './spread';

const quoterAbi = parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);
const mc3 = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address;

const q = (venue: VenueId, tokenIn: Address, tokenOut: Address, amountIn: bigint) => ({
  target: VENUES[venue].quoter, allowFailure: true,
  callData: encodeFunctionData({ abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ tokenIn, tokenOut, amountIn, fee: VENUES[venue].fee, sqrtPriceLimitX96: 0n }] }),
});
const out = (r: { success: boolean; returnData: Hex }) => { if (!r.success || r.returnData === '0x') return 0n; try { return decodeFunctionResult({ abi: quoterAbi, functionName: 'quoteExactInputSingle', data: r.returnData })[0]; } catch { return 0n; } };

async function batch(pub: Pick<PublicClient, 'call'>, calls: ReturnType<typeof q>[]) {
  const data = encodeFunctionData({ abi: mc3, functionName: 'aggregate3', args: [calls] });
  const res = await pub.call({ to: MULTICALL3, data });
  if (!res.data) throw new Error('No quote');
  return decodeFunctionResult({ abi: mc3, functionName: 'aggregate3', data: res.data }) as readonly { success: boolean; returnData: Hex }[];
}

export type RoundTrip = { amount: bigint; sell: VenueId; buy: VenueId; usdc: bigint; back: bigint; gain: bigint; gapBps: number };

/** Best ordered pair (sell on one venue, buy back on another) for `amount` MON. Null when fewer than two venues quote. */
export async function quoteRoundTrip(pub: Pick<PublicClient, 'call'>, amount: bigint): Promise<RoundTrip | null> {
  const wmon = TOKENS.WMON.address, usdc = TOKENS.USDC.address;
  const fw = await batch(pub, SETTLEMENT_VENUES.map(v => q(v, wmon, usdc, amount)));
  const legs = SETTLEMENT_VENUES.map((id, i) => ({ id, usdc: out(fw[i]) }));
  if (legs.filter(l => l.usdc > 0n).length < 2) return null;
  const backs = roundTripBacks(legs);
  const bk = await batch(pub, backs.map(b => q(b.buy, usdc, wmon, b.usdc)));
  let best: RoundTrip | null = null;
  backs.forEach((b, i) => {
    const back = out(bk[i]);
    if (back <= 0n) return;
    const gain = back - amount;
    if (!best || back > best.back) best = { amount, sell: b.sell, buy: b.buy, usdc: b.usdc, back, gain, gapBps: Number((gain * 1_000_000n) / amount) / 100 };
  });
  return best;
}

/** minOuts for the agent's own trades: never accept less MON back than it sold (plus the pool floor, if any). */
export function agentMinOuts(t: Pick<RoundTrip, 'amount' | 'usdc'>, floorBps = 0, acceptShortBps = 0): { minUsdc: bigint; minWmon: bigint } {
  const minUsdc = (t.usdc * 995n) / 1000n;
  const short = floorBps > 0 ? 0n : (t.amount * BigInt(Math.min(acceptShortBps, 50))) / 10_000n;
  return { minUsdc: minUsdc > 0n ? minUsdc : 1n, minWmon: t.amount + (t.amount * BigInt(floorBps)) / 10_000n - short };
}

export const tripArgs = (t: RoundTrip, floorBps = 0, acceptShortBps = 0) => { const m = agentMinOuts(t, floorBps, acceptShortBps); return [venueIndex(t.sell), venueIndex(t.buy), t.amount, m.minUsdc, m.minWmon] as const; };

/** Best gain across several sizes, still two requests: every size's forward legs in one batch, every back leg in another. */
export async function bestRoundTrip(pub: Pick<PublicClient, 'call'>, sizes: bigint[]): Promise<RoundTrip | null> {
  const wmon = TOKENS.WMON.address, usdc = TOKENS.USDC.address;
  const xs = sizes.filter(x => x > 0n); if (!xs.length) return null;
  const fw = await batch(pub, xs.flatMap(a => SETTLEMENT_VENUES.map(v => q(v, wmon, usdc, a))));
  const plans = xs.map((amount, k) => ({ amount, backs: roundTripBacks(SETTLEMENT_VENUES.map((id, i) => ({ id, usdc: out(fw[k * SETTLEMENT_VENUES.length + i]) }))) }));
  const flat = plans.flatMap(p => p.backs.map(b => ({ amount: p.amount, b })));
  if (!flat.length) return null;
  const bk = await batch(pub, flat.map(x => q(x.b.buy, usdc, wmon, x.b.usdc)));
  let best: RoundTrip | null = null;
  flat.forEach((x, i) => {
    const back = out(bk[i]); if (back <= 0n) return;
    const gain = back - x.amount;
    if (!best || gain > best.gain) best = { amount: x.amount, sell: x.b.sell, buy: x.b.buy, usdc: x.b.usdc, back, gain, gapBps: Number((gain * 1_000_000n) / x.amount) / 100 };
  });
  return best;
}

/** Sizes the agent checks for a pool holding `bal` (largest first), capped at the balance. */
export function tripSizes(bal: bigint): bigint[] {
  const one = 10n ** 18n;
  const fixed = [one / 10n, (3n * one) / 10n, one, 2n * one, 5n * one, 10n * one].filter(x => x < bal);
  return [...fixed, bal].filter(x => x >= one / 100n);
}
