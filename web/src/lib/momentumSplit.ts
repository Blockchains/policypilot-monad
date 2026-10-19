// Momentum v2 split router: one vault call into the PancakeSwap v3 router whose multicall runs one exactInput per leg (direct
// pool or a one-venue two-hop route). The vault checks ONE aggregate minimum on what it receives, so a split is all-or-nothing.
// Cross-venue splits would need one vault call (and one minimum) per venue; they are not used. TWAP slices go one per keeper run.
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { PCS, WMON, encodeRid, routerAbi, vaultCallAbi, type Asset, type Rid } from './momentumCore.ts';
import { FRACTIONS, bestSplit, buyPath, sellPath, type Route } from './momentumDepth.ts';

export const splitAbi = parseAbi([
  'function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum)) payable returns (uint256)',
  'function multicall(uint256 deadline,bytes[] data) payable returns (bytes[])',
]);
export const quoterV2Abi = parseAbi(['function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] a,uint32[] b,uint256 gasEstimate)']);
const ZERO: Address = '0x0000000000000000000000000000000000000000';
const ADDRESS_THIS: Address = '0x0000000000000000000000000000000000000002';
export type Leg = { route: Route; amountIn: bigint };

/** PancakeSwap routes for an asset from depth.json (the only venue the split call uses). */
export const pcsRoutes = (routes: Route[] | undefined) => (routes ?? []).filter(r => r.venue === 'pcs');

/** Entry split: legs pay from the MON the vault sends (the router wraps per leg); the asset goes straight to the vault. */
export function splitEntryCall(a: Asset, vault: Address, rid: Rid, legs: Leg[], minOut: bigint, deadline: bigint): { to: Address; data: Hex } {
  const total = legs.reduce((s, l) => s + l.amountIn, 0n); if (total !== rid.amount) throw new Error('legs must add up to the rid amount');
  const calls = legs.map(l => encodeFunctionData({ abi: splitAbi, functionName: 'exactInput', args: [{ path: buyPath(l.route), recipient: vault, amountIn: l.amountIn, amountOutMinimum: 0n }] }));
  const mc = encodeFunctionData({ abi: splitAbi, functionName: 'multicall', args: [deadline, calls] });
  return { to: vault, data: encodeFunctionData({ abi: vaultCallAbi, functionName: 'executeCall', args: [encodeRid(rid), PCS.router, total, mc, { approveToken: ZERO, approveAmount: 0n, outToken: a.address, minOut }] }) };
}
/** Exit split: exact approval of the total, each leg swaps to WMON held by the router, one unwrap pays MON to the vault. */
export function splitExitCall(a: Asset, vault: Address, rid: Rid, legs: Leg[], minOut: bigint, deadline: bigint): { to: Address; data: Hex } {
  const total = legs.reduce((s, l) => s + l.amountIn, 0n); if (total !== rid.amount) throw new Error('legs must add up to the rid amount');
  const calls = legs.map(l => encodeFunctionData({ abi: splitAbi, functionName: 'exactInput', args: [{ path: sellPath(l.route), recipient: ADDRESS_THIS, amountIn: l.amountIn, amountOutMinimum: 0n }] }));
  calls.push(encodeFunctionData({ abi: routerAbi, functionName: 'unwrapWETH9', args: [minOut, vault] }));
  const mc = encodeFunctionData({ abi: splitAbi, functionName: 'multicall', args: [deadline, calls] });
  return { to: vault, data: encodeFunctionData({ abi: vaultCallAbi, functionName: 'executeCall', args: [encodeRid(rid), PCS.router, 0n, mc, { approveToken: a.address, approveAmount: total, outToken: ZERO, minOut }] }) };
}
/** Pick legs from quote curves (curves[i][j] = output of route i for FRACTIONS[j] of `total`). Splits only when that beats the
 *  best single route by ≥ minGainBps; otherwise uses the best single route (which may itself be a two-hop). */
export function chooseLegs(routes: Route[], curves: bigint[][], total: bigint, minGainBps = 5): { legs: Leg[]; out: bigint; single: bigint; split: boolean } {
  const last = FRACTIONS.length - 1; let bi = -1, single = 0n;
  curves.forEach((c, i) => { if ((c[last] ?? 0n) > single) { single = c[last]; bi = i; } });
  if (bi < 0) return { legs: [], out: 0n, single: 0n, split: false };
  const sp = bestSplit(curves, FRACTIONS.length);
  if (sp.alloc.filter(k => k > 0).length > 1 && sp.out * 10_000n >= single * BigInt(10_000 + minGainBps)) {
    const legs: Leg[] = []; let used = 0n; const idx = sp.alloc.map((k, i) => [k, i]).filter(([k]) => k > 0);
    idx.forEach(([k, i], n) => { const amt = n === idx.length - 1 ? total - used : (total * BigInt(k)) / BigInt(FRACTIONS.length); used += amt; legs.push({ route: routes[i], amountIn: amt }); });
    return { legs, out: sp.out, single, split: true };
  }
  return { legs: [{ route: routes[bi], amountIn: total }], out: single, single, split: false };
}
/** Forced 50/50 split across the two best single routes (deployer-owned test vaults only, to exercise the split path on mainnet). */
export function forcedHalves(routes: Route[], curves: bigint[][], total: bigint): Leg[] | null {
  const last = FRACTIONS.length - 1; const ord = curves.map((c, i) => [c[last] ?? 0n, i] as [bigint, number]).filter(([o]) => o > 0n).sort((a, b) => (b[0] > a[0] ? 1 : -1));
  if (ord.length < 2) return null; const h = total / 2n;
  return [{ route: routes[ord[0][1]], amountIn: h }, { route: routes[ord[1][1]], amountIn: total - h }];
}
export { WMON };
