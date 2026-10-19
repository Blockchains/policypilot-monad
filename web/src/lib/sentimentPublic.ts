/**
 * GitHub-run sentiment from free, keyless public sources (no paid API, no login, no scraping behind a login).
 * Runs every ~30 min in .github/workflows/sentiment-public.yml, so sentiment never depends on the bot box or Grok Bot.
 * Sources (each is weak on its own; the merge is a confidence-weighted mean, and sentiment is only ever a 10% confirming
 * factor in signal v2, never a trigger):
 *   mastodon  mastodon.social public tag timelines (open API, no auth): posts in the last 24 h, lexicon-scored, bots/spam dropped
 *   gdelt     GDELT DOC 2.0 news tone over the last 24 h (free; 1 request / 5 s)
 *   coingecko CoinGecko public coin page: community sentiment votes (up %), scored against its own recent baseline
 *   fng       alternative.me Crypto Fear & Greed index (market-wide, mostly BTC-driven)
 *   x         OPTIONAL enrichment: the box/Grok Bot X snapshot (x-latest.json), merged only while it is fresh (≤ 3 h)
 * CoinGecko trending is recorded as attention only (no polarity).
 */
import { polarity, STALE_AFTER_H, type SentAsset, SENT_ASSETS } from './sentiment.ts';

export const PUBLIC_TAGS: Record<SentAsset, string[]> = { ETH: ['ethereum', 'eth'], BTC: ['bitcoin', 'btc'], SOL: ['solana'], MON: ['monad'] };
export const PUBLIC_MATCH: Record<SentAsset, RegExp> = {
  ETH: /\b(ethereum|eth|ether)\b/i, BTC: /\b(bitcoin|btc)\b/i, SOL: /\bsolana\b|\$sol\b/i, MON: /\bmonad\b|\$mon\b|@monad\b/i,
};
export const CG_ID: Record<SentAsset, string> = { ETH: 'ethereum', BTC: 'bitcoin', SOL: 'solana', MON: 'monad' };
export const GDELT_Q: Record<SentAsset, string> = {
  ETH: '(ethereum OR "ether price") sourcelang:english', BTC: '(bitcoin OR btc) sourcelang:english',
  SOL: 'solana crypto sourcelang:english', MON: 'monad blockchain sourcelang:english',
};
/** Source weights in the merge (before each source's own confidence). */
export const W = { x: 1.5, mastodon: 1.0, gdelt: 1.0, coingecko: 0.6, fng: 0.6 } as const;
export type SourceId = keyof typeof W;
export type Component = { score: number; confidence: number; n?: number; note?: string };

const clamp = (x: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
const r4 = (x: number) => +x.toFixed(4);
export const stripHtml = (s: string) => s.replace(/<br\s*\/?>/gi, ' ').replace(/<\/p>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

export type MastoStatus = { id: string; url?: string; created_at: string; content: string; language?: string | null; reblogs_count?: number; favourites_count?: number; replies_count?: number; tags?: { name: string }[];
  account: { id: string; acct: string; bot?: boolean; created_at?: string; followers_count?: number } };
export function mastoSpam(s: MastoStatus, nowSec: number): string | null {
  const a = s.account; if (a.bot) return 'bot';
  if (a.created_at && nowSec - Date.parse(a.created_at) / 1000 < 30 * 86400) return 'new-account';
  if ((a.followers_count ?? 0) < 5) return 'low-followers';
  if ((s.tags?.length ?? 0) > 6) return 'tag-spam';
  if (/\b(giveaway|airdrop|free\s+crypto|dm me|signals? group|100x)\b/i.test(stripHtml(s.content))) return 'bait';
  return null;
}
/** Score mastodon posts for one asset: 24 h window, english or unset, dedupe by id and by text, one post per author per 6 h. */
export function scoreMastodon(posts: MastoStatus[], asset: SentAsset, nowSec: number): Component & { kept: number; fetched: number; dropped: Record<string, number>; vol24: number; sources: { url: string; user: string; pol: number }[] } {
  const seen = new Set<string>(), texts = new Set<string>(), lastBy = new Map<string, number>(); const dropped: Record<string, number> = {};
  const drop = (k: string) => { dropped[k] = (dropped[k] ?? 0) + 1; };
  const kept: { w: number; pol: number; hits: number; url: string; user: string }[] = []; let fetched = 0, vol24 = 0;
  for (const s of [...posts].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))) {
    if (seen.has(s.id)) continue; seen.add(s.id); fetched++;
    const t = Date.parse(s.created_at) / 1000; if (!(nowSec - t <= 86400 && t <= nowSec + 300)) { drop('old'); continue; }
    vol24++;
    if (s.language && s.language !== 'en') { drop('lang'); continue; }
    const text = stripHtml(s.content); if (!PUBLIC_MATCH[asset].test(text) && !(s.tags ?? []).some(g => PUBLIC_TAGS[asset].includes(g.name.toLowerCase()))) { drop('off-topic'); continue; }
    const sp = mastoSpam(s, nowSec); if (sp) { drop(sp); continue; }
    const key = text.toLowerCase().replace(/https?:\/\/\S+/g, '').slice(0, 120); if (texts.has(key)) { drop('duplicate'); continue; } texts.add(key);
    const prev = lastBy.get(s.account.id); if (prev != null && prev - t < 6 * 3600) { drop('author-flood'); continue; } lastBy.set(s.account.id, t);
    const p = polarity(text); const w = 1 + Math.log10(1 + (s.favourites_count ?? 0) + 2 * (s.reblogs_count ?? 0) + (s.replies_count ?? 0));
    kept.push({ w, pol: p.score, hits: p.hits, url: s.url ?? '', user: s.account.acct });
  }
  const h = kept.filter(k => k.hits > 0); const Wt = h.reduce((a, k) => a + k.w, 0);
  const score = Wt ? h.reduce((a, k) => a + k.w * k.pol, 0) / Wt : 0;
  return { score: r4(score), confidence: r4(Math.min(1, h.length / 30) * 0.6), n: h.length, kept: kept.length, fetched, dropped, vol24,
    sources: h.sort((a, b) => b.w * Math.abs(b.pol) - a.w * Math.abs(a.pol)).slice(0, 5).map(k => ({ url: k.url, user: k.user, pol: r4(k.pol) })) };
}
/** GDELT timelinetone JSON -> mean tone of the last 24 h. Typical news tone is about -3..+2, so ±5 maps to ±1. */
export function scoreGdelt(j: any): Component | null {
  const pts: { value: number }[] = j?.timeline?.[0]?.data ?? []; const v = pts.map(p => Number(p.value)).filter(Number.isFinite);
  if (!v.length) return null; const m = v.reduce((a, x) => a + x, 0) / v.length;
  return { score: r4(clamp(m / 5)), confidence: 0.3, n: v.length, note: `mean tone ${m.toFixed(2)} over ${v.length} points` };
}
/** CoinGecko up-vote %: these polls lean bullish, so score against the asset's own recent mean once 24 samples exist. */
export function scoreCoingecko(upPct: number | null | undefined, hist: number[]): Component | null {
  if (upPct == null || !Number.isFinite(upPct)) return null;
  if (hist.length >= 24) { const m = hist.reduce((a, x) => a + x, 0) / hist.length; return { score: r4(clamp((upPct - m) / 15)), confidence: 0.25, note: `up ${upPct}% vs ${m.toFixed(1)}% mean of ${hist.length}` }; }
  return { score: r4(clamp((upPct - 50) / 50) * 0.5), confidence: 0.1, note: `up ${upPct}% (no baseline yet, damped)` };
}
/** Fear & Greed 0..100 -> -1..1. Market-wide context: full confidence weight only for BTC. */
export function scoreFng(v: number | null | undefined, asset: SentAsset): Component | null {
  if (v == null || !Number.isFinite(v)) return null;
  return { score: r4(clamp((v - 50) / 50)), confidence: asset === 'BTC' ? 0.3 : 0.15, note: `index ${v}` };
}
/** X enrichment: the box snapshot's value for this asset, only while it is fresh. */
export function xComponent(x: any, asset: SentAsset, nowSec: number, maxAgeH = STALE_AFTER_H): Component | null {
  const a = x?.assets?.[asset]; if (!a || !x?.generated) return null; const age = (nowSec - x.generated) / 3600;
  if (age > maxAgeH || age < -0.25) return null;
  return { score: a.score, confidence: a.confidence, n: a.sample?.kept, note: `X snapshot ${age.toFixed(1)} h old` };
}
/** Confidence-weighted merge. Confidence: half the summed weighted confidence, capped at 0.8 (keyword methods stay humble). */
export function mergeComponents(cs: Partial<Record<SourceId, Component | null>>): { score: number; confidence: number; used: SourceId[] } {
  let num = 0, den = 0; const used: SourceId[] = [];
  for (const k of Object.keys(W) as SourceId[]) { const c = cs[k]; if (!c || !(c.confidence > 0)) continue; const w = W[k] * c.confidence; num += w * c.score; den += w; used.push(k); }
  return { score: den ? r4(num / den) : 0, confidence: r4(Math.min(0.8, den / 2)), used };
}
export { SENT_ASSETS };
