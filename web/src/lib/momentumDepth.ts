// MonaDefi Momentum v2: market depth, multi-route split and depth-derived size caps. Pure logic (no I/O).
// Routes are executable paths through ONE router call (direct pool, or two hops on the same venue).
import { encodePacked, type Address, type Hex } from 'viem';

export type Venue = 'pcs' | 'uni';
export const VENUES: Record<Venue, { name: string; factory: Address; quoter: Address; router: Address; fees: number[] }> = {
  pcs: { name: 'PancakeSwap v3', factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997', router: '0x21114915Ac6d5A2e156931e20B20b038dEd0Be7C', fees: [100, 500, 2500, 10000] },
  uni: { name: 'Uniswap v3', factory: '0x204FAca1764B154221e35c0d20aBb3c525710498', quoter: '0x661e93cca42afacb172121ef892830ca3b70f08d', router: '0xfE31F71C1b106EAc32F1A19239c9a9A72ddfb900', fees: [100, 500, 3000, 10000] },
};
/** tokens[i] → tokens[i+1] through fees[i]; tokens[0] = WMON for a buy route. */
export type Route = { id: string; venue: Venue; tokens: Address[]; fees: number[]; label: string };
export const buyPath = (r: Route): Hex => encodePacked(r.tokens.flatMap((t, i) => (i < r.fees.length ? ['address', 'uint24'] : ['address'])) as any, r.tokens.flatMap((t, i) => (i < r.fees.length ? [t, r.fees[i]] : [t])) as any);
export const sellPath = (r: Route): Hex => { const t = [...r.tokens].reverse(), f = [...r.fees].reverse(); return buyPath({ ...r, tokens: t, fees: f }); };

export const FRACTIONS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
/** Best allocation of 10 equal chunks over routes, given each route's cumulative output at k/10 of the order (curve[r][k-1]).
 *  Exact DP (routes × chunks). Returns chunks per route and the total output. */
export function bestSplit(curves: bigint[][], chunks = 10): { alloc: number[]; out: bigint } {
  const R = curves.length;
  // dp[r][u] = best output using routes 0..r-1 with u chunks; pick[r][u] = chunks given to route r-1
  const dp: bigint[][] = [Array(chunks + 1).fill(-1n)]; dp[0][0] = 0n; const pick: number[][] = [Array(chunks + 1).fill(0)];
  for (let r = 0; r < R; r++) {
    const row: bigint[] = Array(chunks + 1).fill(-1n), pk: number[] = Array(chunks + 1).fill(0);
    for (let u = 0; u <= chunks; u++) {
      if (dp[r][u] < 0n) continue;
      for (let k = 0; u + k <= chunks; k++) {
        const add = k === 0 ? 0n : (curves[r][k - 1] ?? 0n);
        if (k > 0 && add <= 0n) break; // the route can't fill k chunks
        if (dp[r][u] + add > row[u + k]) { row[u + k] = dp[r][u] + add; pk[u + k] = k; }
      }
    }
    dp.push(row); pick.push(pk);
  }
  if (dp[R][chunks] <= 0n) return { alloc: Array(R).fill(0), out: 0n };
  const alloc = Array(R).fill(0); let u = chunks;
  for (let r = R; r >= 1; r--) { const k = pick[r][u]; alloc[r - 1] = k; u -= k; }
  return { alloc, out: dp[R][chunks] };
}

export type SizeRow = {
  mon: number;
  single: { buy: string | null; sell: string | null; outQty: string; backMon: number; rtPct: number | null };
  split: { buy: { route: string; pct: number }[]; sell: { route: string; pct: number }[]; outQty: string; backMon: number; rtPct: number | null };
};
const lerpLog = (a: { mon: number; rtPct: number }, b: { mon: number; rtPct: number }, c: number) => {
  const t = (c - a.rtPct) / (b.rtPct - a.rtPct); return +Math.exp(Math.log(a.mon) + t * (Math.log(b.mon) - Math.log(a.mon))).toFixed(1);
};
type RtRow = { mon: number; rtPct: number | null };
const clean = (rows: RtRow[]) => rows.filter(x => x.rtPct != null).sort((a, b) => a.mon - b.mon) as { mon: number; rtPct: number }[];
/** Largest size whose round trip stays ≤ maxCostPct. Handles the U-shape of 8-decimal assets (expensive when tiny because of
 *  rounding, cheap in the middle, expensive when huge): small failing sizes are skipped until the first passing size, then the
 *  size grows until the first failure, log-interpolated between measured sizes. Never extrapolated past the largest one. */
export function maxSensible(rows: RtRow[], maxCostPct: number, minMon = 0): number {
  let ok: { mon: number; rtPct: number } | null = null;
  for (const x of clean(rows)) {
    if (x.mon < minMon) continue;
    if (x.rtPct <= maxCostPct) { ok = x; continue; }
    if (ok) return Math.max(ok.mon, lerpLog(ok, x, maxCostPct));
  }
  return ok ? ok.mon : 0;
}
/** Smallest size whose round trip is ≤ maxCostPct (log-interpolated down from the first passing size); null = none passes. */
export function minSensible(rows: RtRow[], maxCostPct: number): number | null {
  const r = clean(rows); const i = r.findIndex(x => x.rtPct <= maxCostPct);
  if (i < 0) return null; if (i === 0) return r[0].mon;
  return Math.min(r[i].mon, lerpLog(r[i - 1], r[i], maxCostPct));
}
/** Rounding guard for partial exits: selling `qty` base units loses up to one unit to rounding. Partial sells are only allowed when
 *  that is ≤ maxRoundPct of the sold part; otherwise the exit sells everything (fixes the BTC split-sell loss at small sizes). */
export const partialAllowed = (qty: bigint, maxRoundPct = 0.04) => qty > 0n && 100 / Number(qty) <= maxRoundPct;

export type DepthAsset = { symbol: string; routes: (Route & { pools: string[] })[]; rows: SizeRow[]; maxSensible: Record<string, number>; minSensible: Record<string, number | null>; splitHelpsFrom: number | null };
export type Depth = { v: 1; generated: number; block: number; sizes: number[]; note: string; rpcCalls?: number; assets: Record<string, DepthAsset> };
/** Depth-derived cap for an asset at the owner's max cost; null if depth data is missing/stale (callers fall back to fixed caps). */
export function depthCap(d: Depth | null, symbol: string, maxCostPct: number, nowSec: number, maxAgeH = 26): number | null {
  if (!d || nowSec - d.generated > maxAgeH * 3600) return null;
  const a = d.assets[symbol]; if (!a) return null;
  return maxSensible(a.rows.map(r => ({ mon: r.mon, rtPct: r.split.rtPct })), maxCostPct);
}
