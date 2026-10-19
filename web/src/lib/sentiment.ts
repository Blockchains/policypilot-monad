/**
 * X sentiment for Momentum v2: transparent and rule-based, with no paid model. Method (also in docs/sentiment.md):
 *  - Attention: hourly post counts (X recent counts, 7 days). vol24 = last 24 full hours; baseline = mean of the earlier 24h windows;
 *    accel6h = mean of the last 6 hourly counts / mean of the earlier hours, minus 1.
 *  - Polarity: each post is scored with the public lexicon below (negation flips and halves, intensifiers ×1.5), then squashed
 *    to (-1, 1) as s / sqrt(s² + 15), the same normalisation VADER uses.
 *  - Weighting: engagement (log of likes + 2·reposts + replies + 2·quotes) × account quality (follower count on a log scale,
 *    verified ×1.2, accounts under 90 days ×0.5, curated influencers ×2).
 *  - Spam/bot filter: drops posts from accounts younger than 30 days or with < 50 followers, giveaway/airdrop/DM/presale bait,
 *    promo/airdrop/signal-style handles, posts with ≥ 5 cashtags/hashtags, near-duplicate text, and more than 2 posts from one author per sample.
 *  - Score = 0.7·crowd + 0.3·influencers (crowd only when < 2 influencer posts mention the asset); confidence = min(1, kept / 40).
 * Sentiment is a confirming factor only: it can raise or lower a v2 composite a little, never trigger a trade on its own, and is
 * ignored when the snapshot is older than STALE_AFTER_H.
 */
export const STALE_AFTER_H = 3;
export type SentAsset = 'ETH' | 'BTC' | 'SOL' | 'MON';
export const SENT_ASSETS: SentAsset[] = ['ETH', 'BTC', 'SOL', 'MON'];
/** Which Momentum registry symbols each sentiment bucket confirms. */
export const SENT_FOR: Record<string, SentAsset> = { WETH: 'ETH', WBTC: 'BTC', cbBTC: 'BTC', SOL: 'SOL' };
export const QUERIES: Record<SentAsset, string> = {
  ETH: '(ethereum OR ETH OR ether) -is:retweet -is:reply lang:en',
  BTC: '(bitcoin OR BTC) -is:retweet -is:reply lang:en',
  SOL: '(solana OR SOL) -is:retweet -is:reply lang:en -"sol de" -"el sol"',
  MON: '(monad OR "monad mainnet" OR MON) (crypto OR chain OR blockchain OR mainnet OR token OR defi OR testnet OR "@monad") -haskell -functor -is:retweet -is:reply lang:en',
};
export const MATCH: Record<SentAsset, RegExp> = {
  ETH: /\b(ethereum|eth|ether)\b/i, BTC: /\b(bitcoin|btc)\b/i, SOL: /\b(solana|sol)\b/i, MON: /\b(monad|mon)\b|@monad\b/i,
};
/** Curated list, checked to exist on X on 2026-10-19 (get_users_by_usernames). Mixed: builders, analysts, traders, news. */
export const INFLUENCERS = ['VitalikButerin', 'ethereum', 'sassal0x', 'TrustlessState', 'RyanSAdams', 'saylor', 'APompliano', 'DocumentingBTC',
  'BitcoinMagazine', 'solana', 'rajgokal', 'monad', 'keoneHD', 'lookonchain', 'WuBlockchain', 'CryptoHayes', 'cobie', 'Pentosh1', 'HsakaTrades',
  'CryptoKaleo', 'DegenSpartan', 'inversebrah'];

export const LEXICON: Record<string, number> = {
  // positive
  bullish: 2, bull: 1, moon: 1, mooning: 2, pump: 1, pumping: 1, breakout: 2, 'all-time high': 2, ath: 2, rally: 2, rallying: 2, surge: 2, surging: 2,
  soar: 2, soaring: 2, rip: 1, ripping: 2, accumulate: 1, accumulating: 1, 'buy the dip': 1, undervalued: 1, higher: 1, green: 1, inflows: 1,
  inflow: 1, adoption: 1, approved: 1, approval: 1, upgrade: 1, strong: 1, strength: 1, gains: 1, recovery: 1, recovering: 1, reclaim: 1,
  reclaimed: 2, uptrend: 2, outperform: 1, outperforming: 1, launch: 1, growth: 1, record: 1, wagmi: 1, lfg: 1, love: 1, great: 1, win: 1,
  // negative
  bearish: -2, bear: -1, dump: -2, dumping: -2, crash: -3, crashing: -3, rekt: -2, scam: -3, rug: -3, rugged: -3, hack: -3, hacked: -3,
  exploit: -3, exploited: -3, selloff: -2, 'sell-off': -2, liquidated: -1, liquidations: -1, outflows: -1, outflow: -1, lower: -1, plunge: -2,
  plunging: -2, tank: -2, tanking: -2, fud: -1, fear: -1, capitulation: -2, breakdown: -2, overvalued: -1, dead: -2, bleeding: -2,
  lawsuit: -1, sued: -1, ban: -2, banned: -2, downtrend: -2, weak: -1, weakness: -1, drop: -1, dropping: -1, collapse: -3, panic: -2,
  losses: -1, down: -1, ngmi: -1, worst: -2, fraud: -3, delay: -1, delayed: -1, outage: -2, halted: -2,
};
const EMOJI: [string, number][] = [['🚀', 1], ['📈', 1], ['🟢', 0.5], ['🔥', 0.5], ['📉', -1], ['🔴', -0.5], ['💀', -1], ['🩸', -1], ['😱', -1]];
const NEGATORS = new Set(['not', 'no', 'never', "isn't", "isnt", "don't", "dont", "won't", "wont", "aint", "ain't", "without", "hardly"]);
const INTENS = new Set(['very', 'super', 'extremely', 'massively', 'hugely', 'insanely', 'really']);

/** Lexicon polarity in (-1, 1); hits = number of scored terms. */
export function polarity(text: string): { score: number; hits: number } {
  const t = text.toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/[@#$]\w+/g, m => m.startsWith('#') || m.startsWith('$') ? m.slice(1) : ' ');
  const toks = t.split(/[^a-z0-9'\-]+/).filter(Boolean);
  let s = 0, hits = 0;
  for (let i = 0; i < toks.length; i++) {
    let v = LEXICON[toks[i]] ?? 0; let span = 1;
    for (const n of [3, 2]) { const ph = toks.slice(i, i + n).join(' '); if (LEXICON[ph] != null) { v = LEXICON[ph]; span = n; break; } }
    if (!v) continue;
    hits++;
    const prev = toks.slice(Math.max(0, i - 3), i);
    if (prev.some(p => NEGATORS.has(p))) v *= -0.5;
    if (INTENS.has(toks[i - 1])) v *= 1.5;
    s += v; i += span - 1;
  }
  for (const [e, v] of EMOJI) { const k = text.split(e).length - 1; if (k) { s += v * Math.min(k, 3); hits++; } }
  return { score: s / Math.sqrt(s * s + 15), hits };
}

export type Author = { id: string; username: string; created_at?: string; verified?: boolean; public_metrics?: { followers_count?: number } };
export type Post = { id: string; text: string; author_id: string; created_at?: string; public_metrics?: { like_count?: number; retweet_count?: number; reply_count?: number; quote_count?: number } };
const BAIT = /\b(giveaway|airdrop|dm me|dm for|claim (now|your)|whitelist|presale|pre-sale|join (my|our) (telegram|discord|group)|signals? group|100x|1000x|free (crypto|tokens?|btc|eth|sol)|send me|referral|promo code|follow (me|and|&) (rt|retweet))\b/i;

export function spamReason(p: Post, a: Author | undefined, nowSec: number): string | null {
  if (!a) return 'unknown-author';
  const ageD = a.created_at ? (nowSec - Date.parse(a.created_at) / 1000) / 86400 : 9999;
  if (ageD < 30) return 'new-account';
  if ((a.public_metrics?.followers_count ?? 0) < 50) return 'low-followers';
  if (/promo|airdrop|giveaway|signals?_?|pump|shill|1000x|100x/i.test(a.username)) return 'spammy-handle';
  if (BAIT.test(p.text)) return 'bait';
  if ((p.text.match(/[#$][A-Za-z]\w*/g) ?? []).length >= 5) return 'tag-spam';
  return null;
}
export const engagement = (p: Post) => { const m = p.public_metrics ?? {}; return 1 + Math.log10(1 + (m.like_count ?? 0) + 2 * (m.retweet_count ?? 0) + (m.reply_count ?? 0) + 2 * (m.quote_count ?? 0)); };
export function quality(a: Author, nowSec: number, influencer = false): number {
  const f = a.public_metrics?.followers_count ?? 0; let q = Math.min(1, Math.max(0.1, Math.log10(f + 1) / 6));
  if (a.verified) q *= 1.2;
  if (a.created_at && (nowSec - Date.parse(a.created_at) / 1000) / 86400 < 90) q *= 0.5;
  return influencer ? q * 2 : q;
}

export type Scored = { id: string; user: string; w: number; pol: number; hits: number; t?: string };
export type SampleResult = { kept: Scored[]; dropped: Record<string, number> };
/** Filter + score one search sample (posts + expanded authors). */
export function scoreSample(posts: Post[], users: Author[], nowSec: number, opts: { match?: RegExp; influencers?: Set<string> } = {}): SampleResult {
  const byId = new Map(users.map(u => [u.id, u])); const seen = new Set<string>(); const perAuthor = new Map<string, number>();
  const kept: Scored[] = []; const dropped: Record<string, number> = {};
  const drop = (r: string) => { dropped[r] = (dropped[r] ?? 0) + 1; };
  for (const p of posts) {
    if (opts.match && !opts.match.test(p.text)) { drop('off-topic'); continue; }
    const a = byId.get(p.author_id); const infl = !!a && !!opts.influencers?.has(a.username.toLowerCase());
    const r = infl ? null : spamReason(p, a, nowSec); if (r) { drop(r); continue; }
    const key = p.text.toLowerCase().replace(/https?:\/\/\S+|@\w+|\d+/g, '').replace(/\W+/g, ' ').trim().slice(0, 80);
    if (key && seen.has(key)) { drop('duplicate'); continue; } seen.add(key);
    const n = (perAuthor.get(p.author_id) ?? 0) + 1; perAuthor.set(p.author_id, n); if (n > 2) { drop('author-flood'); continue; }
    const pol = polarity(p.text);
    kept.push({ id: p.id, user: a!.username, w: engagement(p) * quality(a!, nowSec, infl), pol: pol.score, hits: pol.hits, t: p.created_at });
  }
  return { kept, dropped };
}
/** Weighted mean polarity over posts that hit the lexicon (posts with no scored words carry no polarity information). */
export function weightedPolarity(xs: Scored[]): { value: number; n: number } {
  const h = xs.filter(x => x.hits > 0); const W = h.reduce((s, x) => s + x.w, 0);
  return { value: W ? +(h.reduce((s, x) => s + x.w * x.pol, 0) / W).toFixed(4) : 0, n: h.length };
}
/** Attention from hourly counts (oldest first, complete hours only). */
export function attention(hourly: number[]): { vol24: number; baseline24: number | null; volRatio: number | null; accel6h: number | null } {
  const vol24 = hourly.slice(-24).reduce((s, x) => s + x, 0); const prior = hourly.slice(0, -24);
  const baseline24 = prior.length >= 24 ? prior.reduce((s, x) => s + x, 0) / prior.length * 24 : null;
  const last6 = hourly.slice(-6), before = hourly.slice(0, -6);
  const m6 = last6.reduce((s, x) => s + x, 0) / Math.max(1, last6.length), mb = before.length ? before.reduce((s, x) => s + x, 0) / before.length : 0;
  return { vol24, baseline24: baseline24 == null ? null : Math.round(baseline24), volRatio: baseline24 ? +(vol24 / baseline24).toFixed(3) : null, accel6h: mb ? +(m6 / mb - 1).toFixed(3) : null };
}
export function combine(crowd: { value: number; n: number }, infl: { value: number; n: number }, kept: number) {
  const score = infl.n >= 2 ? 0.7 * crowd.value + 0.3 * infl.value : crowd.value;
  return { score: +score.toFixed(4), confidence: +Math.min(1, kept / 40).toFixed(3) };
}

export type SentSnapshot = {
  v: 1; generated: number; staleAfterH: number; source: string; method: string; callsThisRun: number;
  assets: Record<SentAsset, {
    score: number; confidence: number; crowd: { value: number; n: number }; influencers: { value: number; n: number };
    attention: ReturnType<typeof attention>; sample: { fetched: number; kept: number; dropped: Record<string, number> };
    sources: { url: string; user: string; pol: number }[]; window: { from: string; to: string };
  }>;
};
/** The value consumers use: null when missing or stale, so sentiment can never block anything. */
export function usableSentiment(s: SentSnapshot | null | undefined, sym: string, nowSec: number, maxAgeH = STALE_AFTER_H): { score: number; confidence: number; ageH: number } | null {
  const k = SENT_FOR[sym] ?? (sym === 'MON' ? 'MON' : undefined); if (!s || !k || !s.assets?.[k]) return null;
  const ageH = (nowSec - s.generated) / 3600; if (ageH > maxAgeH || ageH < -0.25) return null;
  const a = s.assets[k]; return { score: a.score, confidence: a.confidence, ageH: +ageH.toFixed(2) };
}
