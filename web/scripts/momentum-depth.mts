// MonaDefi Momentum v2: measure real market depth on Monad mainnet. Free public RPC, read-only (eth_call quotes only).
// For each asset: discover every pool with liquidity on PancakeSwap v3 and Uniswap v3 (direct WMON/asset, and two hops
// through USDC or WETH on the same venue, i.e. what ONE router call can execute), then for each size quote every route at
// 10%..100% of the order, pick the best split (exact DP over 10 chunks), and quote selling exactly the bought amount back
// the same way. Round trip = 1 - MON back / MON in (pool fees included, gas excluded).
//   node --experimental-strip-types scripts/momentum-depth.mts [out.json]
import fs from 'node:fs';
import { createPublicClient, decodeFunctionResult, encodeFunctionData, http, parseAbi, type Address, type Hex } from 'viem';
import { ASSETS, USDC, WMON } from '../src/lib/momentumCore.ts';
import { FRACTIONS, VENUES, bestSplit, buyPath, maxSensible, minSensible, sellPath, type DepthAsset, type Route, type Venue } from '../src/lib/momentumDepth.ts';

const RPC = process.env.RPC || 'https://rpc.monad.xyz';
const OUT = process.argv[2] || new URL('../public/momentum/143/depth.json', import.meta.url).pathname;
export const SIZES = [1, 10, 50, 100, 250, 500, 1000];
const pub = createPublicClient({ transport: http(RPC, { retryCount: 4, retryDelay: 800 }) });
const MC: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
const mcAbi = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])']);
const facAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const poolAbi = parseAbi(['function liquidity() view returns (uint128)']);
const qAbi = parseAbi(['function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] a,uint32[] b,uint256 gasEstimate)']);
const ZERO = '0x0000000000000000000000000000000000000000';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let calls = 0;
async function agg(part: { target: Address; callData: Hex }[]): Promise<(Hex | null)[]> {
  for (let t = 0; t < 3; t++) {
    try {
      calls++; const r = await pub.call({ to: MC, data: encodeFunctionData({ abi: mcAbi, functionName: 'aggregate3', args: [part.map(c => ({ ...c, allowFailure: true }))] }), gas: 30_000_000n });
      return (decodeFunctionResult({ abi: mcAbi, functionName: 'aggregate3', data: r.data! }) as any).map((x: any) => (x.success ? x.returnData : null));
    } catch (e: any) {
      if (/out of gas/i.test(String(e?.details ?? e))) {
        if (part.length === 1) return [null];
        const h = Math.ceil(part.length / 2); return [...(await agg(part.slice(0, h))), ...(await agg(part.slice(h)))];
      }
      await sleep(1500 * (t + 1));
    }
  }
  throw new Error('RPC failed 3 times');
}
async function batch(cs: { target: Address; callData: Hex }[], size = 16): Promise<(Hex | null)[]> {
  const out: (Hex | null)[] = [];
  for (let i = 0; i < cs.length; i += size) { out.push(...(await agg(cs.slice(i, i + size)))); await sleep(120); }
  return out;
}
const dec = (d: Hex | null, abi: any, fn: string) => { if (!d || d === '0x') return null; try { return decodeFunctionResult({ abi, functionName: fn, data: d }) as any; } catch { return null; } };

export async function measureDepth(sizes = SIZES) {
  const block = Number(await pub.getBlockNumber());
  // ---- pool discovery
  const WETH = ASSETS[0].address;
  const pairs: [Address, Address][] = [[WMON, USDC], [WMON, WETH], ...ASSETS.flatMap(a => [[WMON, a.address], [USDC, a.address], ...(a.address === WETH ? [] : [[WETH, a.address]])] as [Address, Address][])];
  const keys: { v: Venue; a: Address; b: Address; fee: number }[] = [];
  for (const v of Object.keys(VENUES) as Venue[]) for (const [a, b] of pairs) for (const fee of VENUES[v].fees) keys.push({ v, a, b, fee });
  const addrs = (await batch(keys.map(k => ({ target: VENUES[k.v].factory, callData: encodeFunctionData({ abi: facAbi, functionName: 'getPool', args: [k.a, k.b, k.fee] }) })))).map(d => dec(d, facAbi, 'getPool') as Address | null);
  const live = keys.map((k, i) => ({ ...k, pool: addrs[i] })).filter(k => k.pool && k.pool !== ZERO);
  const liq = await batch(live.map(k => ({ target: k.pool as Address, callData: encodeFunctionData({ abi: poolAbi, functionName: 'liquidity' }) })));
  const seen = new Set<string>(); const pools = live.filter((k, i) => ((dec(liq[i], poolAbi, 'liquidity') as bigint | null) ?? 0n) > 0n).filter(k => { const id = (k.pool as string).toLowerCase(); if (seen.has(id)) return false; seen.add(id); return true; });
  const find = (v: Venue, a: Address, b: Address) => pools.filter(p => p.v === v && ((p.a === a && p.b === b) || (p.a === b && p.b === a)));
  const sym = (t: Address) => t === WMON ? 'MON' : t === USDC ? 'USDC' : ASSETS.find(x => x.address === t)?.symbol ?? t.slice(0, 6);
  const assets: Record<string, DepthAsset> = {};
  for (const a of ASSETS) {
    const routes: (Route & { pools: string[] })[] = [];
    for (const v of Object.keys(VENUES) as Venue[]) {
      for (const p of find(v, WMON, a.address)) routes.push({ id: `${v}:${p.fee}`, venue: v, tokens: [WMON, a.address], fees: [p.fee], label: `${VENUES[v].name} MON→${a.symbol} ${p.fee / 1e4}%`, pools: [p.pool as string] });
      for (const hub of [USDC, ...(a.address === WETH ? [] : [WETH])]) for (const p1 of find(v, WMON, hub)) for (const p2 of find(v, hub, a.address))
        routes.push({ id: `${v}:${p1.fee}/${sym(hub)}/${p2.fee}`, venue: v, tokens: [WMON, hub, a.address], fees: [p1.fee, p2.fee], label: `${VENUES[v].name} MON→${sym(hub)}→${a.symbol} (${p1.fee / 1e4}% + ${p2.fee / 1e4}%)`, pools: [p1.pool as string, p2.pool as string] });
    }
    // prune dead/far-off routes: a route whose 1 MON quote is >3% worse than the best can never improve a split
    {
      const pr = await batch(routes.map(r => ({ target: VENUES[r.venue].quoter, callData: encodeFunctionData({ abi: qAbi, functionName: 'quoteExactInput', args: [buyPath(r), 10n ** 18n] }) })));
      const o = pr.map(d => (dec(d, qAbi, 'quoteExactInput')?.[0] as bigint | undefined) ?? 0n); const best = o.reduce((m, x) => (x > m ? x : m), 0n);
      const keep = routes.filter((_, i) => o[i] > 0n && o[i] * 100n >= best * 97n); routes.length = 0; routes.push(...keep);
    }
    const rows: DepthAsset['rows'] = [];
    for (const mon of sizes) {
      const amt = BigInt(Math.round(mon * 1e6)) * 10n ** 12n;
      const q = (r: Route, path: Hex, x: bigint) => ({ target: VENUES[r.venue].quoter, callData: encodeFunctionData({ abi: qAbi, functionName: 'quoteExactInput', args: [path, x] }) });
      const buyRes = await batch(routes.flatMap(r => FRACTIONS.map(f => q(r, buyPath(r), (amt * BigInt(Math.round(f * 100))) / 100n))));
      const buyCurves = routes.map((_, i) => FRACTIONS.map((_, j) => (dec(buyRes[i * FRACTIONS.length + j], qAbi, 'quoteExactInput')?.[0] as bigint | undefined) ?? 0n));
      // same-route round trip: sell exactly what route i bought at fraction j back through route i (no cross-route gaps)
      const backRes = await batch(routes.flatMap((r, i) => FRACTIONS.map((_, j) => q(r, sellPath(r), buyCurves[i][j] > 0n ? buyCurves[i][j] : 1n))));
      const backCurves = routes.map((_, i) => FRACTIONS.map((_, j) => (buyCurves[i][j] > 0n ? ((dec(backRes[i * FRACTIONS.length + j], qAbi, 'quoteExactInput')?.[0] as bigint | undefined) ?? 0n) : 0n)));
      const full = backCurves.map(c => c[9]); const bi = full.length ? full.indexOf(full.reduce((m, x) => (x > m ? x : m), 0n)) : -1;
      const sp = bestSplit(backCurves); // allocation that maximises MON back after buy + sell, per route
      const outQty = sp.alloc.reduce((t, k, i) => t + (k > 0 ? buyCurves[i][k - 1] : 0n), 0n);
      const rt = (back: bigint) => (back > 0n ? +((1 - Number(back) / Number(amt)) * 100).toFixed(4) : null);
      const pct = (alloc: number[]) => alloc.map((k, i) => ({ route: routes[i].id, pct: k * 10 })).filter(x => x.pct > 0);
      rows.push({ mon,
        single: { buy: bi >= 0 && full[bi] > 0n ? routes[bi].id : null, sell: bi >= 0 && full[bi] > 0n ? routes[bi].id : null, outQty: (bi >= 0 ? buyCurves[bi][9] : 0n).toString(), backMon: bi >= 0 ? Number(full[bi]) / 1e18 : 0, rtPct: bi >= 0 ? rt(full[bi]) : null },
        split: { buy: pct(sp.alloc), sell: pct(sp.alloc), outQty: outQty.toString(), backMon: Number(sp.out) / 1e18, rtPct: rt(sp.out) } });
      process.stderr.write(`${a.symbol} ${mon} MON: single ${rows.at(-1)!.single.rtPct}% split ${rows.at(-1)!.split.rtPct}% (${routes.length} routes)\n`);
    }
    const ms: Record<string, number> = {}; const mn: Record<string, number | null> = {};
    for (const c of [0.25, 0.5, 1]) { const rr = rows.map(r => ({ mon: r.mon, rtPct: r.split.rtPct })); ms[String(c)] = maxSensible(rr, c); mn[String(c)] = minSensible(rr, c); }
    const firstHelp = rows.find(r => r.split.rtPct != null && r.single.rtPct != null && r.single.rtPct - r.split.rtPct > 0.02);
    assets[a.symbol] = { symbol: a.symbol, routes, rows, maxSensible: ms, minSensible: mn, splitHelpsFrom: firstHelp?.mon ?? null };
  }
  return { v: 1 as const, generated: Math.floor(Date.now() / 1000), block, sizes,
    note: 'Executable quotes (QuoterV2) on every PancakeSwap v3 / Uniswap v3 route with liquidity: direct, or two hops on one venue. Round trip = buy, then sell exactly that amount back through the SAME route (conservative: no cross-route price gaps counted); pool fees included, gas excluded. Split = best allocation in 10% chunks across routes (same venue = one router call; across venues = one call per venue). maxSensible = largest size with round trip at or under the given cost, log-interpolated between measured sizes and never extrapolated past the largest one.',
    rpcCalls: calls, assets };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const d = await measureDepth();
  fs.writeFileSync(OUT, JSON.stringify(d, null, 1) + '\n');
  console.log(`wrote ${OUT} (${d.rpcCalls} RPC calls)`);
  for (const a of Object.values(d.assets)) console.log(a.symbol, 'routes', a.routes.map(r => r.id).join(','), 'size range @1%', a.minSensible['1'], '-', a.maxSensible['1'], '@0.5%', a.minSensible['0.5'], '-', a.maxSensible['0.5'], 'split helps from', a.splitHelpsFrom);
}
