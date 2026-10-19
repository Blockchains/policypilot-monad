/**
 * MonaDefi Momentum: the pure core. Asset registry, hourly candles, rule engine v1 (a research hypothesis, not a promise),
 * sizing, exits, position accounting, the state machine, request-id codec, swap calldata and the backtest.
 * No browser APIs and no relative imports, so the GitHub job (node --experimental-strip-types) and the site run the same code.
 */
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';

// ---------------------------------------------------------------- registry (mirrors web/public/momentum/143/assets.v1.json)
export const REGISTRY_VERSION = 1;
export const WMON: Address = '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A';
export const USDC: Address = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
export const PCS = { router: '0x21114915Ac6d5A2e156931e20B20b038dEd0Be7C' as Address, quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997' as Address, factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865' as Address };
export const UNI = { quoter: '0x661e93cca42afacb172121ef892830ca3b70f08d' as Address };
export const V4_FACTORY: Address = '0x41d6667aA35c3634D19068A39481d4c955f6557D';
export const MON_USDC_POOL: Address = '0x63e48B725540A3Db24ACF6682a29f877808C53F2'; // PancakeSwap v3 0.05%, token0 = WMON

export type Status = 'enabled' | 'watchlist';
export type Asset = {
  idx: number; symbol: 'WETH' | 'WBTC' | 'cbBTC' | 'SOL'; exposure: 'ETH' | 'BTC' | 'SOL'; address: Address; decimals: number;
  status: Status; pool: Address; fee: number; token0IsMon: boolean;
  /** asset/USDC pool used for the reference price (asset/USDC ÷ MON/USDC, both from pool mid prices). null = none. */
  refPool: Address | null;
  why: string;
};
export const ASSETS: Asset[] = [
  { idx: 0, symbol: 'WETH', exposure: 'ETH', address: '0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242', decimals: 18, status: 'enabled', pool: '0xB02793FE655C1169A8699B4ee462F8Ac9c75E402', fee: 500, token0IsMon: true, refPool: '0x25EF1a210fF55BcEe9F8fee979aAFf6bD1bE5Bf1', why: 'Buy and sell both quote on PancakeSwap v3 0.05% with a 0.10% round trip from 0.3 to 30 MON.' },
  { idx: 1, symbol: 'WBTC', exposure: 'BTC', address: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c', decimals: 8, status: 'watchlist', pool: '0x0944526D2727B532653E6Ca6c4D980461E170a09', fee: 500, token0IsMon: false, refPool: '0x9B60E561E3aB15782FbB23ea0a766DD8D91ff8Ac', why: 'Round trip 3.9% at 1 MON and 23% at 0.3 MON (8-decimal rounding). Meets the 0.5% bar only from about 10 MON.' },
  { idx: 2, symbol: 'cbBTC', exposure: 'BTC', address: '0xd18B7EC58Cdf4876f6AFebd3Ed1730e4Ce10414b', decimals: 8, status: 'watchlist', pool: '0x614B85502B89540Bb79bE98d5429EC032A78A284', fee: 500, token0IsMon: true, refPool: '0xebc92C45C652E9AaE8a886fA49Fb2135796d1be1', why: 'Worse than WBTC at every size (7.5% round trip at 1 MON). Counts as the same BTC exposure.' },
  { idx: 3, symbol: 'SOL', exposure: 'SOL', address: '0xea17E5a9efEBf1477dB45082d67010E2245217f1', decimals: 9, status: 'watchlist', pool: '0xbAB9AcC9D872C6cAdb6dCf4f44Bd0b54080a18eA', fee: 2500, token0IsMon: true, refPool: null, why: 'Watchlist by design: one thin 0.25% pool, 17% round trip at 0.3 MON, no USDC price to check against.' },
];
export const assetBy = (s: string) => ASSETS.find(a => a.symbol === s || a.address.toLowerCase() === s.toLowerCase());
export const ENABLED = () => ASSETS.filter(a => a.status === 'enabled');

// ---------------------------------------------------------------- copy (single source; tests pin the exact wording)
export const COPY = {
  name: 'MonaDefi Momentum',
  tagline: 'Follow strength. Set your limits. Return to MON.',
  what: 'A trading strategy, not yield. It buys an eligible wrapped asset with MON only while that asset is getting stronger against MON, and sells back to MON when one of your exit rules is reached. “No trade” is a normal outcome.',
  review: 'This strategy may invest up to your approved amount in eligible assets. It will attempt to sell when a profit target, loss threshold, trend failure, or time limit is reached. Exit prices are not guaranteed. It may remain inactive when no trade qualifies.',
  hypothesis: 'Research hypothesis: these rules are a published, versioned test of whether short-term strength against MON persists on Monad. They are not a prediction and carry no confidence score.',
  automatic: 'Automatic within limits: opt-in per vault, alpha, switched on ahead of the research gate (backtest under 60 days, anecdotal).',
  alpha: 'Alpha · unaudited contract · only deposit what you’re happy to lose',
} as const;

// ---------------------------------------------------------------- candles
/** [hour start (unix s), open, high, low, close, swaps]. Prices are MON per 1 whole asset. */
export type Candle = [number, number, number, number, number, number];
export const HOUR = 3600;

/** MON per whole asset from a v3 pool's sqrtPriceX96. */
export function monPerAsset(sqrtPriceX96: bigint, token0IsMon: boolean, assetDecimals: number): number {
  const s = Number(sqrtPriceX96) / 2 ** 96;
  const r = s * s; // raw token1 per raw token0
  if (r <= 0 || !Number.isFinite(r)) return NaN;
  return token0IsMon ? 1 / (r * 10 ** (18 - assetDecimals)) : r * 10 ** (assetDecimals - 18);
}
/** USDC per MON from the WMON/USDC pool (token0 = WMON, 18 dp; token1 = USDC, 6 dp). */
export const usdPerMon = (sqrtPriceX96: bigint) => { const s = Number(sqrtPriceX96) / 2 ** 96; return s * s * 1e12; };
/** USDC per whole asset from an asset/USDC pool (token order = address order). */
export function usdPerAsset(sqrtPriceX96: bigint, a: Pick<Asset, 'address' | 'decimals'>): number {
  const s = Number(sqrtPriceX96) / 2 ** 96; const r = s * s;
  const assetIs0 = a.address.toLowerCase() < USDC.toLowerCase();
  return assetIs0 ? r * 10 ** (a.decimals - 6) : 1 / (r * 10 ** (6 - a.decimals));
}
/** Reference MON per asset (USDC cross-rate) and the pool's deviation from it, in %. */
export const refDev = (poolMonPerAsset: number, usdAsset: number, usdMon: number) => { const ref = usdAsset / usdMon; return { ref, devPct: (poolMonPerAsset / ref - 1) * 100 }; };
export const slot0Abi = parseAbi(['function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint32,bool)']);

/** Fold price ticks (time-ordered or not) into hourly candles, merged into `into` (sorted, unique hours). */
export function addTicks(into: Candle[], ticks: { t: number; p: number }[]): Candle[] {
  const map = new Map<number, Candle>(into.map(c => [c[0], [...c] as Candle]));
  const sorted = [...ticks].filter(x => Number.isFinite(x.p) && x.p > 0).sort((a, b) => a.t - b.t);
  for (const { t, p } of sorted) {
    const h = Math.floor(t / HOUR) * HOUR;
    const c = map.get(h);
    if (!c) map.set(h, [h, p, p, p, p, 1]);
    else { c[2] = Math.max(c[2], p); c[3] = Math.min(c[3], p); c[4] = p; c[5] += 1; }
  }
  return [...map.values()].sort((a, b) => a[0] - b[0]);
}
/** Ticks added out of order (a backfill) must not overwrite the open/close of hours already built from later data. */
export function addBackfill(into: Candle[], ticks: { t: number; p: number }[]): Candle[] {
  const known = new Set(into.map(c => c[0]));
  const fresh = ticks.filter(x => !known.has(Math.floor(x.t / HOUR) * HOUR));
  return addTicks(into, fresh);
}
/** Only completed hours (the current hour is still forming). Gaps (hours with no swap) are filled flat from the last close. */
export function completed(cs: Candle[], nowSec: number): Candle[] {
  const cur = Math.floor(nowSec / HOUR) * HOUR;
  const done = cs.filter(c => c[0] < cur);
  const out: Candle[] = [];
  for (const c of done) {
    const last = out[out.length - 1];
    if (last) for (let h = last[0] + HOUR; h < c[0]; h += HOUR) out.push([h, last[4], last[4], last[4], last[4], 0]);
    out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------- indicators
export function ema(xs: number[], n: number): number[] {
  const k = 2 / (n + 1); const out: number[] = [];
  xs.forEach((x, i) => out.push(i === 0 ? x : x * k + out[i - 1] * (1 - k)));
  return out;
}
export function dailyVolPct(closes: number[], hours = 72): number {
  const xs = closes.slice(-hours - 1);
  if (xs.length < 3) return NaN;
  const r = xs.slice(1).map((x, i) => Math.log(x / xs[i]));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v) * Math.sqrt(24) * 100;
}

// ---------------------------------------------------------------- rule engine v1
export type RuleParams = {
  version: string; momentumHours: number; momentumMinPct: number; fastEma: number; slowEma: number;
  breakoutHours: number; breakoutTolPct: number; maxExtensionSigma: number; maxDailyVolPct: number;
  maxRoundTripPct: number; maxRefDevPct: number; maxTotalCostPct: number; minCandles: number; maxStaleHours: number;
};
export const RULES_V1: RuleParams = {
  version: 'v1', momentumHours: 168, momentumMinPct: 0, fastEma: 24, slowEma: 72, breakoutHours: 48, breakoutTolPct: 0.5,
  maxExtensionSigma: 2, maxDailyVolPct: 8, maxRoundTripPct: 1, maxRefDevPct: 1.5, maxTotalCostPct: 2, minCandles: 240, maxStaleHours: 2,
};
/** Predefined research variants (no tuning beyond these three). */
export const VARIANTS: RuleParams[] = [
  RULES_V1,
  { ...RULES_V1, version: 'v1-slow', momentumHours: 336, fastEma: 48, slowEma: 144, breakoutHours: 96 },
  { ...RULES_V1, version: 'v1-fast', momentumHours: 72, fastEma: 12, slowEma: 36, breakoutHours: 24 },
];
export type Check = { id: string; label: string; pass: boolean | null; value: string; need: string; why: string };
export type Live = { roundTripPct: number | null; refDevPct: number | null; gasRoundTripMon: number; sizeMon: number };
const pct = (x: number, d = 2) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`;

/** Every check with a plain explanation. pass = null when the input is missing (counts as not passing). */
export function evaluate(cs: Candle[], nowSec: number, live: Live | null, p: RuleParams = RULES_V1): { checks: Check[]; pass: boolean; ruleVersion: string } {
  const c = completed(cs, nowSec);
  const closes = c.map(x => x[4]);
  const last = c[c.length - 1];
  const checks: Check[] = [];
  const ageH = last ? (Math.floor(nowSec / HOUR) * HOUR - last[0]) / HOUR - 1 : Infinity;
  const enough = c.length >= p.minCandles && ageH <= p.maxStaleHours;
  checks.push({ id: 'data', label: 'Enough fresh data', pass: enough, value: `${c.length} hourly candles, last ${last ? Math.max(0, ageH).toFixed(0) : '–'} h old`, need: `≥ ${p.minCandles} candles, ≤ ${p.maxStaleHours} h old`, why: 'Signals only use completed hourly candles. Too little or stale data means no entry.' });
  if (closes.length < Math.max(p.momentumHours, p.slowEma, p.breakoutHours) + 1) {
    for (const id of ['momentum', 'trend', 'breakout', 'extension', 'volatility']) checks.push({ id, label: LABELS[id], pass: null, value: 'not enough history', need: NEEDS(p)[id], why: WHY[id] });
  } else {
    const n = closes.length - 1; const px = closes[n];
    const mom = (px / closes[n - p.momentumHours] - 1) * 100;
    const f = ema(closes, p.fastEma)[n], s = ema(closes, p.slowEma)[n];
    const prevHigh = Math.max(...closes.slice(n - p.breakoutHours, n));
    const vol = dailyVolPct(closes);
    const ext = (px / f - 1) * 100;
    checks.push({ id: 'momentum', label: LABELS.momentum, pass: mom > p.momentumMinPct, value: `${pct(mom)} vs MON over ${p.momentumHours / 24} days`, need: NEEDS(p).momentum, why: WHY.momentum });
    checks.push({ id: 'trend', label: LABELS.trend, pass: f > s, value: `fast ${fmtP(f)} vs slow ${fmtP(s)} MON`, need: NEEDS(p).trend, why: WHY.trend });
    checks.push({ id: 'breakout', label: LABELS.breakout, pass: px >= prevHigh * (1 - p.breakoutTolPct / 100), value: `${fmtP(px)} vs ${p.breakoutHours} h high ${fmtP(prevHigh)}`, need: NEEDS(p).breakout, why: WHY.breakout });
    checks.push({ id: 'extension', label: LABELS.extension, pass: Number.isFinite(vol) && ext <= p.maxExtensionSigma * vol, value: `${pct(ext)} above the fast average (limit ${pct(p.maxExtensionSigma * vol)})`, need: NEEDS(p).extension, why: WHY.extension });
    checks.push({ id: 'volatility', label: LABELS.volatility, pass: Number.isFinite(vol) && vol <= p.maxDailyVolPct, value: `${vol.toFixed(2)}% a day`, need: NEEDS(p).volatility, why: WHY.volatility });
  }
  const rt = live?.roundTripPct ?? null, dev = live?.refDevPct ?? null;
  checks.push({ id: 'liquidity', label: LABELS.liquidity, pass: rt == null ? null : rt <= p.maxRoundTripPct, value: rt == null ? 'no quote' : `${rt.toFixed(3)}% buy + sell at ${live!.sizeMon} MON`, need: NEEDS(p).liquidity, why: WHY.liquidity });
  checks.push({ id: 'wrapper', label: LABELS.wrapper, pass: dev == null ? null : Math.abs(dev) <= p.maxRefDevPct, value: dev == null ? 'no reference price' : `${pct(dev)} vs the USDC cross-rate`, need: NEEDS(p).wrapper, why: WHY.wrapper });
  const total = rt == null || !live ? null : rt + (live.gasRoundTripMon / live.sizeMon) * 100;
  checks.push({ id: 'cost', label: LABELS.cost, pass: total == null ? null : total <= p.maxTotalCostPct, value: total == null ? 'no quote' : `${total.toFixed(2)}% (swaps ${rt!.toFixed(2)}% + gas ${((live!.gasRoundTripMon / live!.sizeMon) * 100).toFixed(2)}%)`, need: NEEDS(p).cost, why: WHY.cost });
  return { checks, pass: checks.every(x => x.pass === true), ruleVersion: p.version };
}
const fmtP = (x: number) => (x >= 100 ? x.toFixed(1) : x >= 1 ? x.toFixed(3) : x.toPrecision(4));
const LABELS: Record<string, string> = { momentum: 'Stronger than MON (medium term)', trend: 'Fast trend above slow trend', breakout: 'Breaking out', extension: 'Not overextended', volatility: 'Volatility acceptable', liquidity: 'Liquidity at your size', wrapper: 'Wrapper price healthy', cost: 'Entry + estimated exit cost' };
const NEEDS = (p: RuleParams): Record<string, string> => ({ momentum: `> ${p.momentumMinPct}% over ${p.momentumHours / 24} days`, trend: `EMA ${p.fastEma} h > EMA ${p.slowEma} h`, breakout: `close within ${p.breakoutTolPct}% of the prior ${p.breakoutHours} h high, or above`, extension: `≤ ${p.maxExtensionSigma} × daily volatility above EMA ${p.fastEma} h`, volatility: `≤ ${p.maxDailyVolPct}% a day (72 h)`, liquidity: `round trip ≤ ${p.maxRoundTripPct}%`, wrapper: `within ±${p.maxRefDevPct}%`, cost: `≤ ${p.maxTotalCostPct}% of the position` });
const WHY: Record<string, string> = {
  momentum: 'The asset priced in MON must be higher than it was a week ago. Strength is measured against MON, not dollars.',
  trend: 'The 24-hour average price must be above the 72-hour average.',
  breakout: 'The latest close must be at, or near, the highest close of the last two days.',
  extension: 'Skip entries that already ran far above their average: they often snap back.',
  volatility: 'Skip assets that swing too much against MON for the loss-exit trigger to be meaningful.',
  liquidity: 'A fresh buy quote and the matching sell quote at your size must lose little to the pool.',
  wrapper: 'The pool price must match the price implied by USDC pools. A gap can mean a bridge or pool problem.',
  cost: 'Swap costs plus gas for buying and selling back, as a share of the position.',
};

// ---------------------------------------------------------------- exits
export type ExitParams = {
  profitTargetPct: number; profitMode: 'full' | 'partial'; partialSellPct: number; trailingPct: number;
  lossExitPct: number; maxHoldHours: number; trendInvalidation: boolean; incidentRefDevPct: number; incidentRoundTripPct: number;
  /** Portfolio loss over 24 h that stops new entries (risk exits continue). */
  dailyLossStopPct: number;
};
export const EXITS_V1: ExitParams = { profitTargetPct: 8, profitMode: 'partial', partialSellPct: 50, trailingPct: 4, lossExitPct: 5, maxHoldHours: 168, trendInvalidation: true, incidentRefDevPct: 3, incidentRoundTripPct: 2, dailyLossStopPct: 3 };
export type Trigger = { id: 'profit' | 'partial' | 'trailing' | 'loss' | 'trend' | 'time' | 'incident'; hit: boolean; sellPct: number; why: string };
export type ExitInput = {
  /** Executable MON from selling the remaining quantity now (a sell quote, not the mid price). null = no sell quote. */
  execMon: number | null; remainingBasisMon: number; peakRatio: number; partialDone: boolean; openedAt: number; now: number;
  trendBroken: boolean; refDevPct: number | null; roundTripPct: number | null;
};
export function evaluateExits(x: ExitInput, e: ExitParams = EXITS_V1): Trigger[] {
  const ratio = x.execMon == null || x.remainingBasisMon <= 0 ? null : x.execMon / x.remainingBasisMon;
  const r = ratio == null ? null : (ratio - 1) * 100;
  const peak = Math.max(x.peakRatio, ratio ?? 0);
  const trailOn = x.partialDone || (peak - 1) * 100 >= e.profitTargetPct;
  const fromPeak = ratio == null || peak <= 0 ? null : (1 - ratio / peak) * 100;
  const out: Trigger[] = [];
  if (e.profitMode === 'full') out.push({ id: 'profit', hit: r != null && r >= e.profitTargetPct, sellPct: 100, why: `Profit target: executable result ${r == null ? 'unknown' : pct(r)} vs +${e.profitTargetPct}%` });
  else {
    out.push({ id: 'partial', hit: !x.partialDone && r != null && r >= e.profitTargetPct, sellPct: e.partialSellPct, why: `Partial profit: sell ${e.partialSellPct}% at +${e.profitTargetPct}% (now ${r == null ? 'unknown' : pct(r)})` });
    out.push({ id: 'trailing', hit: trailOn && fromPeak != null && fromPeak >= e.trailingPct, sellPct: 100, why: `Trailing: ${fromPeak == null ? 'unknown' : fromPeak.toFixed(2) + '%'} below the best executable value (limit ${e.trailingPct}%, ${trailOn ? 'active' : 'not active yet'})` });
  }
  out.push({ id: 'loss', hit: r != null && r <= -e.lossExitPct, sellPct: 100, why: `Loss-exit trigger: executable result ${r == null ? 'unknown' : pct(r)} vs −${e.lossExitPct}%` });
  out.push({ id: 'trend', hit: e.trendInvalidation && x.trendBroken, sellPct: 100, why: 'Trend invalidation: fast average below slow average and the close below the slow average' });
  const heldH = (x.now - x.openedAt) / HOUR;
  out.push({ id: 'time', hit: heldH >= e.maxHoldHours, sellPct: 100, why: `Time limit: held ${heldH.toFixed(0)} h of ${e.maxHoldHours} h` });
  const incident = x.execMon == null || (x.refDevPct != null && Math.abs(x.refDevPct) > e.incidentRefDevPct) || (x.roundTripPct != null && x.roundTripPct > e.incidentRoundTripPct);
  out.push({ id: 'incident', hit: incident, sellPct: 100, why: x.execMon == null ? 'Wrapper/liquidity incident: no executable sell quote' : `Wrapper/liquidity incident check: price gap ${x.refDevPct == null ? 'unknown' : pct(x.refDevPct)} (limit ±${e.incidentRefDevPct}%), round trip ${x.roundTripPct == null ? 'unknown' : x.roundTripPct.toFixed(2) + '%'} (limit ${e.incidentRoundTripPct}%)` });
  return out;
}
export function trendBroken(cs: Candle[], nowSec: number, p: RuleParams = RULES_V1): boolean {
  const closes = completed(cs, nowSec).map(c => c[4]); if (closes.length < p.slowEma) return false;
  const n = closes.length - 1; const f = ema(closes, p.fastEma)[n], s = ema(closes, p.slowEma)[n];
  return f < s && closes[n] < s;
}

// ---------------------------------------------------------------- sizing
export type SizingIn = {
  allocationMon: number; availableMon: number; openExposureMon: number; riskPerTradePct: number; lossExitPct: number;
  maxPerPositionMon: number; maxTotalExposureMon: number; liquidityCapMon: number; gasRoundTripMon: number; roundTripPct: number;
  maxTotalCostPct: number; gasReserveMon: number; hasOpenSameExposure: boolean;
};
export type Sizing = { notionalMon: number; raw: number; caps: string[]; minEconomicalMon: number; belowEconomical: boolean; blocked: string | null };
/** Smallest size where swaps + gas stay within the cost limit. Infinity if the swap cost alone is above it. */
export const minEconomical = (gasRoundTripMon: number, roundTripPct: number, maxTotalCostPct: number) => maxTotalCostPct > roundTripPct ? gasRoundTripMon / ((maxTotalCostPct - roundTripPct) / 100) : Infinity;
export function size(x: SizingIn): Sizing {
  const minE = minEconomical(x.gasRoundTripMon, x.roundTripPct, x.maxTotalCostPct);
  const base: Omit<Sizing, 'notionalMon' | 'caps' | 'belowEconomical' | 'blocked'> = { raw: 0, minEconomicalMon: minE };
  if (x.hasOpenSameExposure) return { ...base, notionalMon: 0, caps: [], belowEconomical: false, blocked: 'You already hold this exposure. No averaging down and no adding: one position per underlying.' };
  if (x.lossExitPct <= 0) return { ...base, notionalMon: 0, caps: [], belowEconomical: false, blocked: 'Set a loss-exit trigger first: the size is worked out from it.' };
  const raw = (x.allocationMon * x.riskPerTradePct) / x.lossExitPct;
  const caps: [string, number][] = [
    ['max per position', x.maxPerPositionMon],
    ['max total exposure', Math.max(0, x.maxTotalExposureMon - x.openExposureMon)],
    ['liquidity', x.liquidityCapMon],
    ['available MON after the gas reserve (no leverage)', Math.max(0, x.availableMon - x.gasReserveMon)],
  ];
  let n = raw; const hit: string[] = [];
  for (const [k, v] of caps) if (v < n) { n = v; hit.push(k); }
  n = Math.floor(n * 1e4) / 1e4;
  const blocked = n <= 0 ? `Nothing left to place (capped by ${hit[hit.length - 1] ?? 'limits'}).` : null;
  return { notionalMon: Math.max(0, n), raw, caps: hit, minEconomicalMon: minE, belowEconomical: n > 0 && n < minE, blocked };
}

// ---------------------------------------------------------------- request ids: the durable, on-chain position record
/** bytes32 = "MOM1" | action(1) | asset(1) | position(2) | step(2) | reserved(6) | amount(16). Same intent → same id, and the vault refuses a used id: submit once. */
export const TAG = 0x4d4f4d31; // "MOM1"
export type Action = 1 | 2; // 1 entry, 2 exit
export type Rid = { action: Action; asset: number; pos: number; step: number; amount: bigint };
export function encodeRid(r: Rid): Hex {
  const h = (n: number | bigint, bytes: number) => BigInt(n).toString(16).padStart(bytes * 2, '0');
  if (r.amount < 0n || r.amount >= 1n << 128n) throw new Error('amount out of range');
  return `0x${h(TAG, 4)}${h(r.action, 1)}${h(r.asset, 1)}${h(r.pos, 2)}${h(r.step, 2)}${'0'.repeat(12)}${h(r.amount, 16)}` as Hex;
}
export function decodeRid(id: string): Rid | null {
  const x = id.toLowerCase().replace(/^0x/, ''); if (x.length !== 64 || parseInt(x.slice(0, 8), 16) !== TAG) return null;
  const action = parseInt(x.slice(8, 10), 16); if (action !== 1 && action !== 2) return null;
  return { action: action as Action, asset: parseInt(x.slice(10, 12), 16), pos: parseInt(x.slice(12, 16), 16), step: parseInt(x.slice(16, 20), 16), amount: BigInt('0x' + x.slice(32)) };
}

// ---------------------------------------------------------------- calldata (PancakeSwap v3 SmartRouter through the user's v4 vault)
export const routerAbi = parseAbi([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)',
  'function unwrapWETH9(uint256 amountMinimum,address recipient) payable',
  'function multicall(uint256 deadline,bytes[] data) payable returns (bytes[])',
]);
export const quoterAbi = parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);
export const vaultCallAbi = parseAbi([
  'function executeCall(bytes32 requestId,address target,uint256 value,bytes data,(address approveToken,uint256 approveAmount,address outToken,uint256 minOut) o) returns (bytes)',
  'function withdraw(address to,uint256 amount)', 'function withdrawToken(address token,address to,uint256 amount)', 'function setPaused(bool p)', 'function deposit() payable',
  'function executed(bytes32) view returns (bool)', 'function owner() view returns (address)', 'function executor() view returns (address)', 'function paused() view returns (bool)',
  'event DappCalled(bytes32 indexed requestId, address indexed target, bytes4 indexed selector, uint256 value, address outToken, uint256 received, uint256 totalSpent)',
  'event Deposited(address indexed from, uint256 amount, uint256 balance)', 'event Withdrawn(address indexed to, uint256 amount, uint256 balance)', 'event TokenWithdrawn(address indexed token, address indexed to, uint256 amount)',
]);
export const factoryAbi = parseAbi(['function createVault(address executor) payable returns (address)', 'function vaultsOf(address owner) view returns (address[])', 'event VaultCreated(address indexed owner, address indexed vault, address indexed executor)']);
const ZERO: Address = '0x0000000000000000000000000000000000000000';
const ADDRESS_THIS: Address = '0x0000000000000000000000000000000000000002';

/** Entry: the vault sends `amountIn` MON to the router, which wraps it and swaps to the asset, paid to the vault. The vault checks it received ≥ minOut. */
export function entryCall(a: Asset, vault: Address, rid: Rid, minOut: bigint): { to: Address; data: Hex } {
  const swap = encodeFunctionData({ abi: routerAbi, functionName: 'exactInputSingle', args: [{ tokenIn: WMON, tokenOut: a.address, fee: a.fee, recipient: vault, amountIn: rid.amount, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] });
  return { to: vault, data: encodeFunctionData({ abi: vaultCallAbi, functionName: 'executeCall', args: [encodeRid(rid), PCS.router, rid.amount, swap, { approveToken: ZERO, approveAmount: 0n, outToken: a.address, minOut }] }) };
}
/** Exit: exact approval of `qty` (reset to 0 after), swap to WMON held by the router, unwrap to MON paid to the vault, deadline. The vault checks MON received ≥ minOut. */
export function exitCall(a: Asset, vault: Address, rid: Rid, minOut: bigint, deadline: bigint): { to: Address; data: Hex } {
  const swap = encodeFunctionData({ abi: routerAbi, functionName: 'exactInputSingle', args: [{ tokenIn: a.address, tokenOut: WMON, fee: a.fee, recipient: ADDRESS_THIS, amountIn: rid.amount, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] });
  const unwrap = encodeFunctionData({ abi: routerAbi, functionName: 'unwrapWETH9', args: [minOut, vault] });
  const mc = encodeFunctionData({ abi: routerAbi, functionName: 'multicall', args: [deadline, [swap, unwrap]] });
  return { to: vault, data: encodeFunctionData({ abi: vaultCallAbi, functionName: 'executeCall', args: [encodeRid(rid), PCS.router, 0n, mc, { approveToken: a.address, approveAmount: rid.amount, outToken: ZERO, minOut }] }) };
}
export const quoteData = (tokenIn: Address, tokenOut: Address, amountIn: bigint, fee: number) => encodeFunctionData({ abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }] });
export const quoteOut = (data: Hex | undefined): bigint => { if (!data || data === '0x') return 0n; try { return decodeFunctionResult({ abi: quoterAbi, functionName: 'quoteExactInputSingle', data })[0]; } catch { return 0n; } };

// ---------------------------------------------------------------- entry pipeline gates (pure; the UI and the headless test both use them)
export type EntryQuote = { at: number; amountIn: bigint; out: bigint; back: bigint; midMonPerAsset: number; refMonPerAsset: number | null; gasRoundTripMon: number };
export type Gate = { id: string; label: string; pass: boolean; detail: string; ack?: boolean };
export const ENTRY_LIMITS = { quoteTtlSec: 30, maxImpactPct: 0.5, slippagePct: 0.5, maxRefDevPct: RULES_V1.maxRefDevPct, maxRoundTripPct: RULES_V1.maxRoundTripPct, maxTotalCostPct: RULES_V1.maxTotalCostPct, cooldownSec: 3600 };
export function entryGates(a: Asset, q: EntryQuote, nowSec: number, o: { lastExitAt?: number; openPositions: number; maxPositions: number; exposureHeld: boolean; pausedNew: boolean; dataOk: boolean }, L = ENTRY_LIMITS): { gates: Gate[]; minOut: bigint; ok: boolean; roundTripPct: number; totalCostPct: number } {
  const amt = Number(q.amountIn) / 1e18; const outA = Number(q.out) / 10 ** a.decimals; const back = Number(q.back) / 1e18;
  const exec = outA > 0 ? amt / outA : Infinity; // MON per asset paid
  const impact = (exec / q.midMonPerAsset - 1) * 100;
  const rt = (1 - back / amt) * 100; const total = rt + (q.gasRoundTripMon / amt) * 100;
  const dev = q.refMonPerAsset == null ? null : (q.midMonPerAsset / q.refMonPerAsset - 1) * 100;
  const minOut = (q.out * BigInt(Math.round((100 - L.slippagePct) * 100))) / 10_000n;
  const gates: Gate[] = [
    { id: 'paused', label: 'New entries are on', pass: !o.pausedNew, detail: o.pausedNew ? 'You paused new entries. Exits still work.' : 'Not paused.' },
    { id: 'data', label: 'Data available', pass: o.dataOk, detail: o.dataOk ? 'Candles and quotes are fresh.' : 'Price data is stale or missing: no entry.' },
    { id: 'enabled', label: 'Asset enabled', pass: a.status === 'enabled', detail: a.status === 'enabled' ? `${a.symbol} passed buy and sell testing.` : `${a.symbol} is watchlist only: ${a.why}` },
    { id: 'exposure', label: 'One position per underlying', pass: !o.exposureHeld, detail: o.exposureHeld ? `You already hold ${a.exposure} exposure. No averaging down.` : `No open ${a.exposure} position.` },
    { id: 'slots', label: 'Max simultaneous positions', pass: o.openPositions < o.maxPositions, detail: `${o.openPositions} of ${o.maxPositions} open.` },
    { id: 'cooldown', label: 'Cooldown after the last exit', pass: !o.lastExitAt || nowSec - o.lastExitAt >= L.cooldownSec, detail: o.lastExitAt ? `Last exit ${Math.round((nowSec - o.lastExitAt) / 60)} min ago (wait ${L.cooldownSec / 60} min).` : 'No recent exit.' },
    { id: 'fresh', label: 'Fresh quote for this exact size', pass: q.out > 0n && nowSec - q.at <= L.quoteTtlSec, detail: q.out > 0n ? `Quoted ${Math.max(0, nowSec - q.at)} s ago; it expires after ${L.quoteTtlSec} s.` : 'No buy quote.' },
    { id: 'exit-route', label: 'Exit route works', pass: q.back > 0n, detail: q.back > 0n ? `Selling it straight back would return ${back.toFixed(6)} MON.` : 'No sell quote: entry refused.' },
    { id: 'impact', label: 'Price impact', pass: Number.isFinite(impact) && impact <= L.maxImpactPct, detail: `${Number.isFinite(impact) ? impact.toFixed(3) : '–'}% vs the pool price (limit ${L.maxImpactPct}%).` },
    { id: 'refdev', label: 'Reference price deviation', pass: dev != null && Math.abs(dev) <= L.maxRefDevPct, detail: dev == null ? 'No reference price.' : `${pct(dev)} vs the USDC cross-rate (limit ±${L.maxRefDevPct}%).` },
    { id: 'roundtrip', label: 'Round-trip swap cost', pass: rt <= L.maxRoundTripPct, detail: `${rt.toFixed(3)}% (limit ${L.maxRoundTripPct}%). Pool fees are inside this figure.` },
    { id: 'economical', label: 'Economical size', pass: total <= L.maxTotalCostPct, ack: total > L.maxTotalCostPct && rt <= L.maxRoundTripPct, detail: `Swaps + gas = ${total.toFixed(2)}% of the position (target ≤ ${L.maxTotalCostPct}%). ${total > L.maxTotalCostPct ? `Gas is a large share at this size; you can still go ahead if you tick the box.` : ''}`.trim() },
    { id: 'minout', label: 'Minimum received', pass: minOut > 0n, detail: `The vault reverts unless it receives at least ${(Number(minOut) / 10 ** a.decimals).toPrecision(6)} ${a.symbol} (${L.slippagePct}% below the quote).` },
  ];
  return { gates, minOut, ok: gates.every(g => g.pass || g.ack), roundTripPct: rt, totalCostPct: total };
}

// ---------------------------------------------------------------- accounting
export type LedgerEv =
  | { kind: 'deposit' | 'withdraw'; block: number; t: number; tx: Hex; mon: number; gasMon: number }
  | { kind: 'tokenWithdraw'; block: number; t: number; tx: Hex; token: Address; qty: bigint; gasMon: number }
  | { kind: 'call'; block: number; t: number; tx: Hex; rid: Hex; valueWei: bigint; outAsset: Address; received: bigint; gasMon: number };
export type Part = { t: number; tx: Hex; qty: bigint; monOut: number; basisOut: number; gasMon: number };
export type Position = {
  id: string; asset: Asset; pos: number; openedAt: number; entryTx: Hex; committedMon: number; qty: bigint; entryGasMon: number;
  parts: Part[]; remainingQty: bigint; remainingBasisMon: number; receivedMon: number; gasMon: number; status: 'OPEN' | 'PARTIALLY_EXITED' | 'CLOSED' | 'MANUAL_ACTION_REQUIRED';
  ruleVersion: string; lastReconciledQty: bigint | null;
};
/** Positions from the vault's own on-chain events. Basis leaves proportionally to the quantity sold (one entry per position, so this is exact average cost). */
export function buildPositions(evs: LedgerEv[], balances?: Record<string, bigint>): Position[] {
  const out = new Map<string, Position>();
  for (const e of [...evs].sort((a, b) => a.block - b.block)) {
    if (e.kind === 'call') {
      const r = decodeRid(e.rid); if (!r) continue;
      const a = ASSETS.find(x => x.idx === r.asset); if (!a) continue;
      const id = `${a.symbol}-${r.pos}`;
      if (r.action === 1) {
        out.set(id, { id, asset: a, pos: r.pos, openedAt: e.t, entryTx: e.tx, committedMon: Number(e.valueWei) / 1e18, qty: e.received, entryGasMon: e.gasMon, parts: [], remainingQty: e.received, remainingBasisMon: Number(e.valueWei) / 1e18, receivedMon: 0, gasMon: e.gasMon, status: 'OPEN', ruleVersion: RULES_V1.version, lastReconciledQty: null });
      } else {
        const p = out.get(id); if (!p) continue;
        const q = r.amount > p.remainingQty ? p.remainingQty : r.amount;
        const basisOut = p.remainingQty > 0n ? p.remainingBasisMon * (Number(q) / Number(p.remainingQty)) : 0;
        const monOut = Number(e.received) / 1e18;
        p.parts.push({ t: e.t, tx: e.tx, qty: q, monOut, basisOut, gasMon: e.gasMon });
        p.remainingQty -= q; p.remainingBasisMon = p.remainingQty === 0n ? 0 : p.remainingBasisMon - basisOut;
        p.receivedMon += monOut; p.gasMon += e.gasMon;
        p.status = p.remainingQty === 0n ? 'CLOSED' : 'PARTIALLY_EXITED';
      }
    } else if (e.kind === 'tokenWithdraw') {
      for (const p of out.values()) if (p.asset.address.toLowerCase() === e.token.toLowerCase() && p.remainingQty > 0n) {
        const q = e.qty > p.remainingQty ? p.remainingQty : e.qty;
        const basisOut = p.remainingBasisMon * (Number(q) / Number(p.remainingQty));
        p.parts.push({ t: e.t, tx: e.tx, qty: q, monOut: 0, basisOut, gasMon: e.gasMon });
        p.remainingQty -= q; p.remainingBasisMon -= basisOut; p.gasMon += e.gasMon;
        p.status = 'MANUAL_ACTION_REQUIRED'; // tokens left the vault as tokens: the MON result can't be measured
      }
    }
  }
  if (balances) for (const p of out.values()) {
    const b = balances[p.asset.address.toLowerCase()];
    if (b != null && p.remainingQty > 0n) { p.lastReconciledQty = b; if (b < p.remainingQty) p.status = 'MANUAL_ACTION_REQUIRED'; }
  }
  return [...out.values()];
}
export type Result = { netMon: number; netPct: number; usd: number | null; vsHoldMonPct: number; realizedMon: number; unrealizedMon: number | null; costsMon: number };
/**
 * Net MON = MON received − MON committed − costs paid separately (gas). Pool fees are already inside "received" and are NOT
 * subtracted again. Open positions add the executable sell value of what is left (minus an estimated exit gas, if given).
 */
export function result(p: Position, o: { execMon?: number | null; exitGasMon?: number; usdPerMon?: number | null } = {}): Result {
  const realized = p.parts.reduce((a, x) => a + x.monOut - x.basisOut, 0);
  const open = p.remainingQty > 0n;
  const unreal = open ? (o.execMon == null ? null : o.execMon - p.remainingBasisMon) : 0;
  const exitGas = open ? o.exitGasMon ?? 0 : 0;
  const net = realized + (unreal ?? 0) - p.gasMon - exitGas;
  return { netMon: net, netPct: p.committedMon > 0 ? (net / p.committedMon) * 100 : 0, usd: o.usdPerMon == null ? null : net * o.usdPerMon, vsHoldMonPct: p.committedMon > 0 ? (net / p.committedMon) * 100 : 0, realizedMon: realized, unrealizedMon: unreal, costsMon: p.gasMon + exitGas };
}
/** Same net MON, the other way round: total received + value left − committed − gas. Used by the tests to prove there is no double count. */
export const netByFlows = (p: Position, execMon = 0) => p.receivedMon + (p.remainingQty > 0n ? execMon : 0) - p.committedMon - p.gasMon;

// ---------------------------------------------------------------- state machine
export type State = 'IDLE' | 'CANDIDATE' | 'ENTRY_PENDING' | 'OPEN' | 'EXIT_TRIGGERED' | 'EXIT_PENDING' | 'CLOSED' | 'ENTRY_FAILED' | 'EXIT_FAILED' | 'PARTIALLY_EXITED' | 'DATA_UNAVAILABLE' | 'NEW_ENTRIES_PAUSED' | 'MANUAL_ACTION_REQUIRED';
export type Ev = 'signal' | 'signal_lost' | 'approve' | 'entry_confirmed' | 'entry_failed' | 'trigger' | 'trigger_cleared' | 'exit_submit' | 'exit_partial' | 'exit_full' | 'exit_failed' | 'retry' | 'give_up' | 'data_lost' | 'data_back' | 'pause_new' | 'resume_new' | 'reset' | 'reconciled';
export const STATES: State[] = ['IDLE', 'CANDIDATE', 'ENTRY_PENDING', 'OPEN', 'EXIT_TRIGGERED', 'EXIT_PENDING', 'CLOSED', 'ENTRY_FAILED', 'EXIT_FAILED', 'PARTIALLY_EXITED', 'DATA_UNAVAILABLE', 'NEW_ENTRIES_PAUSED', 'MANUAL_ACTION_REQUIRED'];
const T: Partial<Record<State, Partial<Record<Ev, State>>>> = {
  IDLE: { signal: 'CANDIDATE', data_lost: 'DATA_UNAVAILABLE', pause_new: 'NEW_ENTRIES_PAUSED' },
  CANDIDATE: { approve: 'ENTRY_PENDING', signal_lost: 'IDLE', data_lost: 'DATA_UNAVAILABLE', pause_new: 'NEW_ENTRIES_PAUSED' },
  ENTRY_PENDING: { entry_confirmed: 'OPEN', entry_failed: 'ENTRY_FAILED' },
  ENTRY_FAILED: { reset: 'IDLE', retry: 'CANDIDATE' },
  OPEN: { trigger: 'EXIT_TRIGGERED', exit_submit: 'EXIT_PENDING', give_up: 'MANUAL_ACTION_REQUIRED' },
  PARTIALLY_EXITED: { trigger: 'EXIT_TRIGGERED', exit_submit: 'EXIT_PENDING', give_up: 'MANUAL_ACTION_REQUIRED' },
  EXIT_TRIGGERED: { exit_submit: 'EXIT_PENDING', trigger_cleared: 'OPEN' },
  EXIT_PENDING: { exit_full: 'CLOSED', exit_partial: 'PARTIALLY_EXITED', exit_failed: 'EXIT_FAILED' },
  EXIT_FAILED: { retry: 'EXIT_PENDING', give_up: 'MANUAL_ACTION_REQUIRED' },
  MANUAL_ACTION_REQUIRED: { exit_submit: 'EXIT_PENDING', reconciled: 'OPEN' },
  CLOSED: { reset: 'IDLE' },
  DATA_UNAVAILABLE: { data_back: 'IDLE' },
  NEW_ENTRIES_PAUSED: { resume_new: 'IDLE' },
};
/** Next state, or throws on a transition the strategy must never make (e.g. a second entry while one is pending). */
export function step(s: State, e: Ev): State { const n = T[s]?.[e]; if (!n) throw new Error(`Momentum: ${e} is not allowed in ${s}`); return n; }
export const can = (s: State, e: Ev) => !!T[s]?.[e];
/** Exits are never blocked by data loss or by the new-entry pause: those states only exist on the "no position" side. */
export const EXIT_STATES: State[] = ['OPEN', 'PARTIALLY_EXITED', 'EXIT_TRIGGERED', 'EXIT_PENDING', 'EXIT_FAILED', 'MANUAL_ACTION_REQUIRED'];

// ---------------------------------------------------------------- paper positions + backtest (no lookahead: decide on candle i, fill at its close)
export type Trade = { asset: string; inT: number; outT: number; inPx: number; outPx: number; netPct: number; reason: Trigger['id'] | 'end' };
export type Metrics = { netMonPct: number; usdPct: number | null; maxDrawdownPct: number; trades: number; avgGainPct: number | null; avgLossPct: number | null; turnover: number; costPerRoundTripPct: number; timeInMarketPct: number; failedExits: string; concentrationPct: number | null };
export type BtCosts = { roundTripPct: number; gasRoundTripMon: number; sizeMon: number };
/** One asset, one position at a time, size = whole allocation (the report is per unit of MON). */
export function backtest(cs: Candle[], p: RuleParams, e: ExitParams, costs: BtCosts, from = 0, to = cs.length): { trades: Trade[]; equity: number[]; inMarket: number } {
  const closes = cs.map(c => c[4]);
  const fe = ema(closes, p.fastEma), se = ema(closes, p.slowEma);
  const half = (costs.roundTripPct + (costs.gasRoundTripMon / costs.sizeMon) * 100) / 200;
  const warm = Math.max(p.momentumHours, p.slowEma, p.breakoutHours, 72) + 1;
  let eq = 1; const equity: number[] = []; const trades: Trade[] = []; let inMarket = 0;
  let open: { i: number; px: number; peak: number; partial: boolean; frac: number; banked: number } | null = null;
  for (let i = Math.max(from, warm); i < to; i++) {
    const px = closes[i];
    if (open) {
      inMarket++;
      const ratio = (px * (1 - half)) / (open.px * (1 + half));
      const broken = fe[i] < se[i] && px < se[i];
      const tr = evaluateExits({ execMon: ratio, remainingBasisMon: 1, peakRatio: open.peak, partialDone: open.partial, openedAt: cs[open.i][0], now: cs[i][0], trendBroken: broken, refDevPct: 0, roundTripPct: costs.roundTripPct }, e).filter(t => t.hit && t.id !== 'incident');
      open.peak = Math.max(open.peak, ratio);
      const t = tr[0];
      if (t && t.sellPct < 100 && !open.partial) { open.banked += open.frac * (t.sellPct / 100) * ratio; open.frac *= 1 - t.sellPct / 100; open.partial = true; }
      else if (t || i === to - 1) {
        const total = open.banked + open.frac * ratio; // per 1 MON committed
        eq *= total; trades.push({ asset: '', inT: cs[open.i][0], outT: cs[i][0], inPx: open.px, outPx: px, netPct: (total - 1) * 100, reason: t ? t.id : 'end' }); open = null;
      }
      equity.push(open ? eq * (open.banked + open.frac * ratio) : eq);
      continue;
    }
    const slice = cs.slice(0, i + 1);
    const ev = evaluate(slice, cs[i][0] + HOUR, { roundTripPct: costs.roundTripPct, refDevPct: 0, gasRoundTripMon: costs.gasRoundTripMon, sizeMon: costs.sizeMon }, { ...p, minCandles: warm });
    if (ev.pass) open = { i, px, peak: 1, partial: false, frac: 1, banked: 0 };
    equity.push(eq);
  }
  return { trades, equity, inMarket };
}
export function metrics(r: { trades: Trade[]; equity: number[]; inMarket: number }, costs: BtCosts, usdRatio: number | null): Metrics {
  let peak = 1, mdd = 0; for (const x of r.equity) { peak = Math.max(peak, x); mdd = Math.max(mdd, 1 - x / peak); }
  const end = r.equity.length ? r.equity[r.equity.length - 1] : 1;
  const g = r.trades.filter(t => t.netPct > 0), l = r.trades.filter(t => t.netPct <= 0);
  const sumAbs = r.trades.reduce((a, t) => a + Math.abs(t.netPct), 0);
  return {
    netMonPct: (end - 1) * 100, usdPct: usdRatio == null ? null : (end * usdRatio - 1) * 100, maxDrawdownPct: mdd * 100, trades: r.trades.length,
    avgGainPct: g.length ? g.reduce((a, t) => a + t.netPct, 0) / g.length : null, avgLossPct: l.length ? l.reduce((a, t) => a + t.netPct, 0) / l.length : null,
    turnover: r.trades.length * 2, costPerRoundTripPct: costs.roundTripPct + (costs.gasRoundTripMon / costs.sizeMon) * 100,
    timeInMarketPct: r.equity.length ? (r.inMarket / r.equity.length) * 100 : 0, failedExits: 'not modelled (needs live data)',
    concentrationPct: sumAbs > 0 ? (Math.max(...r.trades.map(t => Math.abs(t.netPct))) / sumAbs) * 100 : null,
  };
}
/** Benchmarks on the same window: hold MON (0), inactive (0), hold the asset (one round trip), slow trend (EMA 72 > EMA 168). */
export function benchmarks(cs: Candle[], costs: BtCosts, from: number, to: number) {
  const closes = cs.map(c => c[4]); const rt = (costs.roundTripPct + (costs.gasRoundTripMon / costs.sizeMon) * 100) / 100;
  const holdAsset = from < to - 1 ? ((closes[to - 1] / closes[from]) * (1 - rt) - 1) * 100 : 0;
  const f = ema(closes, 72), s = ema(closes, 168); let eq = 1, inPos = false, entry = 0, trades = 0;
  for (let i = from; i < to; i++) {
    const want = f[i] > s[i];
    if (want && !inPos) { inPos = true; entry = closes[i]; }
    else if ((!want || i === to - 1) && inPos) { inPos = false; eq *= (closes[i] / entry) * (1 - rt); trades++; }
  }
  return { holdMonPct: 0, inactivePct: 0, holdAssetPct: holdAsset, slowTrendPct: (eq - 1) * 100, slowTrendTrades: trades };
}
/** Walk-forward: on each fold pick the variant that did best on the previous fold, then score it on this fold only. */
export function walkForward(cs: Candle[], e: ExitParams, costs: BtCosts, folds = 4) {
  const warm = Math.max(...VARIANTS.map(v => Math.max(v.momentumHours, v.slowEma, v.breakoutHours))) + 1;
  const len = cs.length - warm; if (len < folds * 48) return { ok: false as const, reason: `Only ${cs.length} hourly candles (${(cs.length / 24).toFixed(1)} days). Walk-forward needs at least ${warm + folds * 48}.` };
  const size = Math.floor(len / folds); const rows: { fold: number; from: number; to: number; picked: string; oosNetPct: number; trades: number }[] = [];
  for (let k = 1; k < folds; k++) {
    const trS = warm + (k - 1) * size, trE = warm + k * size, teE = k === folds - 1 ? cs.length : warm + (k + 1) * size;
    const scored = VARIANTS.map(v => ({ v, net: metrics(backtest(cs, v, e, costs, trS, trE), costs, null).netMonPct }));
    const best = scored.sort((a, b) => b.net - a.net)[0].v;
    const r = backtest(cs, best, e, costs, trE, teE);
    rows.push({ fold: k, from: cs[trE][0], to: cs[teE - 1][0], picked: best.version, oosNetPct: metrics(r, costs, null).netMonPct, trades: r.trades.length });
  }
  return { ok: true as const, rows, oosNetPct: (rows.reduce((a, r) => a * (1 + r.oosNetPct / 100), 1) - 1) * 100 };
}
