/**
 * Momentum signal engine v2: one explained composite score. Every factor is scaled to [-1, 1] and multiplied by a fixed weight
 * chosen up front (not fitted to the history below), so each factor's contribution is readable on its own.
 *  - rs (0.45): MON-relative strength over 1 h / 4 h / 24 h / 7 d, each return divided by the volatility expected over that
 *    horizon (hourly σ·√h), squashed with tanh, weighted 0.1 / 0.2 / 0.3 / 0.4.
 *  - regime (0.25): trend vs chop. Kaufman efficiency ratio over 48 h (net move / path length) gives the strength; the sign is
 *    EMA 24 h vs EMA 72 h. Below ER 0.15 the market is "chop": the factor is 0 and the entry bar rises to 0.5.
 *  - activity (0.10): pool swap count, last 24 h vs the 7-day mean (an activity proxy; Swap logs carry no reliable USD volume
 *    here), signed by the 24 h direction: busier trading confirms a move, quieter trading weakens it.
 *  - sentiment (0.10): X score × confidence when the snapshot is fresh (≤ 3 h); otherwise 0 and marked ignored.
 *  - extension (0.10, penalty only): price far above EMA 24 h in daily-volatility units (> 1.5σ) pulls the score down.
 * Entry needs composite ≥ 0.35 (0.5 in chop), rs > 0, regime not trending down, plus every v1 hard gate (data, volatility,
 * liquidity, wrapper, cost). Sentiment can add at most 0.10, so it can never open a position on its own.
 * Risk: ATR(24 h) sets the loss-exit trigger (1.5 × daily ATR, clamped 2–8%) and the trailing exit (1.2 × daily ATR, 2–6%);
 * the position size follows from the loss-exit trigger (allocation × risk per trade / loss-exit %).
 */
import { HOUR, RULES_V1, completed, dailyVolPct, ema, evaluate, evaluateExits, type BtCosts, type Candle, type ExitParams, type Live, type Trade } from './momentumCore.ts';

export const V2 = {
  version: 'v2', weights: { rs: 0.45, regime: 0.25, activity: 0.10, sentiment: 0.10, extension: 0.10 },
  rsHorizons: [[1, 0.1], [4, 0.2], [24, 0.3], [168, 0.4]] as [number, number][],
  erHours: 48, chopEr: 0.15, entry: 0.35, entryChop: 0.5, exitBelow: -0.2,
  atrHours: 24, lossAtr: 1.5, lossMin: 2, lossMax: 8, trailAtr: 1.2, trailMin: 2, trailMax: 6, minCandles: 200,
} as const;
export type Factor = { id: keyof typeof V2.weights; label: string; value: number; weight: number; contribution: number; detail: string };
export type SignalV2 = {
  version: 'v2'; at: number; composite: number; pass: boolean; regime: 'trend-up' | 'trend-down' | 'chop' | 'unknown'; factors: Factor[];
  gates: { id: string; pass: boolean | null; detail: string }[]; atrDailyPct: number | null; lossExitPct: number | null; trailingPct: number | null; why: string;
};
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const r4 = (x: number) => +x.toFixed(4);

/** Average true range over `n` hourly candles as a % of price, scaled to a day (× √24). */
export function atrDailyPct(c: Candle[], n: number = V2.atrHours): number | null {
  if (c.length < n + 1) return null; let s = 0;
  for (let i = c.length - n; i < c.length; i++) { const pc = c[i - 1][4]; s += Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - pc), Math.abs(c[i][3] - pc)); }
  return (s / n / c[c.length - 1][4]) * 100 * Math.sqrt(24);
}
export const atrExits = (atrD: number | null) => atrD == null ? null : {
  lossExitPct: +clamp(V2.lossAtr * atrD, V2.lossMin, V2.lossMax).toFixed(2), trailingPct: +clamp(V2.trailAtr * atrD, V2.trailMin, V2.trailMax).toFixed(2),
};
export function efficiency(closes: number[], n: number): number {
  if (closes.length < n + 1) return 0; const xs = closes.slice(-n - 1); let path = 0;
  for (let i = 1; i < xs.length; i++) path += Math.abs(xs[i] - xs[i - 1]);
  return path > 0 ? Math.abs(xs[xs.length - 1] - xs[0]) / path : 0;
}

/** Factors + composite on completed candles. `sentiment` = usableSentiment(...) (null when missing or stale). */
export function factorsV2(c: Candle[], sentiment: { score: number; confidence: number; ageH?: number } | null): { factors: Factor[]; composite: number; regime: SignalV2['regime']; rsRaw: number } | null {
  const closes = c.map(x => x[4]); const n = closes.length - 1;
  if (n < 168 + 1) return null;
  const rets = closes.slice(-169).slice(1).map((x, i) => Math.log(x / closes[n - 168 + i]));
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1)) || 1e-9;
  const parts = V2.rsHorizons.map(([h, w]) => { const r = Math.log(closes[n] / closes[n - h]); return { h, w, r, z: r / (sd * Math.sqrt(h)) }; });
  const rs = parts.reduce((a, p) => a + p.w * Math.tanh(p.z / 1.5), 0);
  const er = efficiency(closes, V2.erHours); const f = ema(closes, 24)[n], s = ema(closes, 72)[n];
  const regime: SignalV2['regime'] = er < V2.chopEr ? 'chop' : f >= s ? 'trend-up' : 'trend-down';
  const reg = regime === 'chop' ? 0 : Math.sign(f - s) * clamp((er - V2.chopEr) / 0.25, 0, 1);
  const cnt = c.map(x => x[5]); const m24 = cnt.slice(-24).reduce((a, b) => a + b, 0) / 24, m168 = cnt.slice(-168).reduce((a, b) => a + b, 0) / 168;
  const ratio = m168 > 0 ? m24 / m168 : 1; const dir = Math.sign(Math.log(closes[n] / closes[n - 24]));
  const act = clamp(Math.tanh(Math.log(Math.max(ratio, 1e-6))), -1, 1) * (dir || 0);
  const sen = sentiment ? clamp(sentiment.score * sentiment.confidence, -1, 1) : 0;
  const vol = dailyVolPct(closes); const extSig = Number.isFinite(vol) && vol > 0 ? ((closes[n] / f - 1) * 100) / vol : 0;
  const ext = -clamp((extSig - 1.5) / 1.5, 0, 1);
  const pc = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;
  const W = V2.weights; const mk = (id: Factor['id'], label: string, value: number, detail: string): Factor => ({ id, label, value: r4(value), weight: W[id], contribution: r4(value * W[id]), detail });
  const factors = [
    mk('rs', 'Strength vs MON (1 h / 4 h / 24 h / 7 d)', rs, parts.map(p => `${p.h < 24 ? p.h + ' h' : p.h / 24 + ' d'} ${pc(p.r)}`).join(', ')),
    mk('regime', 'Trend vs chop', reg, `efficiency ${er.toFixed(2)} over ${V2.erHours} h (chop below ${V2.chopEr}), EMA 24 h ${f >= s ? 'above' : 'below'} EMA 72 h: ${regime}`),
    mk('activity', 'Swap activity trend', act, `${m24.toFixed(1)} swaps/h in the last 24 h vs ${m168.toFixed(1)} over 7 d (×${ratio.toFixed(2)}), price ${dir > 0 ? 'up' : dir < 0 ? 'down' : 'flat'} over 24 h`),
    mk('sentiment', 'X sentiment (confirming only)', sen, sentiment ? `score ${sentiment.score.toFixed(2)} × confidence ${sentiment.confidence.toFixed(2)}${sentiment.ageH != null ? `, ${sentiment.ageH.toFixed(1)} h old` : ''}` : 'ignored: no fresh snapshot (older than 3 h or missing)'),
    mk('extension', 'Not overextended (penalty)', ext, Number.isFinite(vol) ? `${extSig.toFixed(2)} daily σ above EMA 24 h (penalty starts at 1.5)` : 'volatility unknown'),
  ];
  return { factors, composite: r4(factors.reduce((a, x) => a + x.contribution, 0)), regime, rsRaw: rs };
}

/** Full v2 decision: factors + v1 hard gates. */
export function evaluateV2(cs: Candle[], nowSec: number, live: Live | null, sentiment: { score: number; confidence: number; ageH?: number } | null): SignalV2 {
  const c = completed(cs, nowSec);
  const v1 = evaluate(cs, nowSec, live, { ...RULES_V1, minCandles: V2.minCandles });
  const hard = v1.checks.filter(x => ['data', 'volatility', 'liquidity', 'wrapper', 'cost'].includes(x.id)).map(x => ({ id: x.id, pass: x.pass, detail: `${x.label}: ${x.value}` }));
  const fx = factorsV2(c, sentiment); const atrD = atrDailyPct(c); const ex = atrExits(atrD);
  if (!fx) return { version: 'v2', at: nowSec, composite: 0, pass: false, regime: 'unknown', factors: [], gates: hard, atrDailyPct: atrD, lossExitPct: ex?.lossExitPct ?? null, trailingPct: ex?.trailingPct ?? null, why: 'Not enough history for v2 (needs 7 days of hourly candles).' };
  const bar = fx.regime === 'chop' ? V2.entryChop : V2.entry;
  const gates = [...hard,
    { id: 'composite', pass: fx.composite >= bar, detail: `composite ${fx.composite.toFixed(3)} vs entry bar ${bar}${fx.regime === 'chop' ? ' (chop: higher bar)' : ''}` },
    { id: 'rs', pass: fx.rsRaw > 0, detail: 'relative strength must be positive on its own (sentiment can never carry an entry)' },
    { id: 'regime', pass: fx.regime !== 'trend-down', detail: `regime ${fx.regime}` }];
  const pass = gates.every(g => g.pass === true);
  const top = [...fx.factors].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))[0];
  return { version: 'v2', at: nowSec, composite: fx.composite, pass, regime: fx.regime, factors: fx.factors, gates, atrDailyPct: atrD == null ? null : +atrD.toFixed(3), lossExitPct: ex?.lossExitPct ?? null, trailingPct: ex?.trailingPct ?? null,
    why: pass ? `Entry: composite ${fx.composite.toFixed(2)} ≥ ${bar}, led by ${top.label.toLowerCase()}.` : `No entry: ${gates.filter(g => g.pass !== true).map(g => g.id).join(', ')} not met.` };
}

/** v2 backtest: same mechanics and costs as v1's backtest (decide on candle i, fill at its close), v2 entries, ATR exits, and an
 *  extra exit when the composite falls below V2.exitBelow. No sentiment history exists, so sentiment contributes 0 here. */
export function backtestV2(cs: Candle[], e: ExitParams, costs: BtCosts, from = 0, to = cs.length): { trades: Trade[]; equity: number[]; inMarket: number } {
  const closes = cs.map(c => c[4]); const fe = ema(closes, 24), se = ema(closes, 72);
  const half = (costs.roundTripPct + (costs.gasRoundTripMon / costs.sizeMon) * 100) / 200;
  const warm = 169 + 1; let eq = 1; const equity: number[] = []; const trades: Trade[] = []; let inMarket = 0;
  let open: { i: number; px: number; peak: number; partial: boolean; frac: number; banked: number; ex: ExitParams } | null = null;
  for (let i = Math.max(from, warm); i < to; i++) {
    const px = closes[i]; const slice = cs.slice(Math.max(0, i - 400), i + 1);
    if (open) {
      inMarket++;
      const ratio = (px * (1 - half)) / (open.px * (1 + half));
      const broken = fe[i] < se[i] && px < se[i];
      let tr = evaluateExits({ execMon: ratio, remainingBasisMon: 1, peakRatio: open.peak, partialDone: open.partial, openedAt: cs[open.i][0], now: cs[i][0], trendBroken: broken, refDevPct: 0, roundTripPct: costs.roundTripPct }, open.ex).filter(t => t.hit && t.id !== 'incident');
      if (!tr.length) { const fx = factorsV2(slice, null); if (fx && fx.composite < V2.exitBelow) tr = [{ id: 'trend', hit: true, sellPct: 100, why: 'composite below exit level' }]; }
      open.peak = Math.max(open.peak, ratio);
      const t = tr[0];
      if (t && t.sellPct < 100 && !open.partial) { open.banked += open.frac * (t.sellPct / 100) * ratio; open.frac *= 1 - t.sellPct / 100; open.partial = true; }
      else if (t || i === to - 1) {
        const total = open.banked + open.frac * ratio;
        eq *= total; trades.push({ asset: '', inT: cs[open.i][0], outT: cs[i][0], inPx: open.px, outPx: px, netPct: (total - 1) * 100, reason: t ? t.id : 'end' }); open = null;
      }
      equity.push(open ? eq * (open.banked + open.frac * ratio) : eq);
      continue;
    }
    const sig = evaluateV2(slice, cs[i][0] + HOUR, { roundTripPct: costs.roundTripPct, refDevPct: 0, gasRoundTripMon: costs.gasRoundTripMon, sizeMon: costs.sizeMon }, null);
    if (sig.pass && sig.lossExitPct != null && sig.trailingPct != null) open = { i, px, peak: 1, partial: false, frac: 1, banked: 0, ex: { ...e, lossExitPct: sig.lossExitPct, trailingPct: sig.trailingPct } };
    equity.push(eq);
  }
  return { trades, equity, inMarket };
}

/** v1 vs v2 on identical candles, costs and segments (60 % train / 20 % validation / 20 % out-of-sample). v2's weights were set
 *  before this comparison and are not tuned on any segment, so "train" is just the first 60 %. */
export function compareV1V2(cs: Candle[], e: ExitParams, costs: BtCosts, backtestV1: (from: number, to: number) => { trades: Trade[]; equity: number[]; inMarket: number },
  metrics: (r: { trades: Trade[]; equity: number[]; inMarket: number }) => { netMonPct: number; maxDrawdownPct: number; trades: number; timeInMarketPct: number }) {
  const n = cs.length; const iTr = Math.floor(n * 0.6), iVa = Math.floor(n * 0.8);
  const segs: [string, number, number][] = [['full', 0, n], ['train', 0, iTr], ['validation', iTr, iVa], ['outOfSample', iVa, n]];
  const pick = (m: ReturnType<typeof metrics>) => ({ netMonPct: +m.netMonPct.toFixed(2), maxDrawdownPct: +m.maxDrawdownPct.toFixed(2), trades: m.trades, timeInMarketPct: +m.timeInMarketPct.toFixed(1) });
  return Object.fromEntries(segs.map(([k, a, b]) => [k, { from: cs[a]?.[0], to: cs[b - 1]?.[0], v1: pick(metrics(backtestV1(a, b))), v2: pick(metrics(backtestV2(cs, e, costs, a, b))) }]));
}
