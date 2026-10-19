// GitHub-run sentiment snapshot from free public sources (see src/lib/sentimentPublic.ts). No keys, no paid APIs.
// Writes web/public/momentum/sentiment-143/{latest,history,public-raw}.json; merges x-latest.json (box X routine) only while fresh.
//   node --experimental-strip-types web/scripts/sentiment-public.mts [--commit]   (DRY=1: print, write nothing)
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
import { SENT_ASSETS, type SentAsset, STALE_AFTER_H } from '../src/lib/sentiment.ts';
import { PUBLIC_TAGS, CG_ID, GDELT_Q, scoreMastodon, scoreGdelt, scoreCoingecko, scoreFng, xComponent, mergeComponents, type MastoStatus, type Component, type SourceId } from '../src/lib/sentimentPublic.ts';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = process.env.SENT_OUT ?? path.join(HERE, '../public/momentum/sentiment-143');
const UA = 'policypilot-sentiment/1.0 (+https://github.com/Blockchains/policypilot-monad; public data only)';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const now = Math.floor(Date.now() / 1000); const calls: Record<string, { ok: number; fail: number }> = {}; const errors: string[] = [];
async function get(src: string, url: string, tries = 2, wait = 6000): Promise<any | null> {
  calls[src] ??= { ok: 0, fail: 0 };
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      const t = await r.text();
      if (r.ok) { try { const j = JSON.parse(t); calls[src].ok++; return j; } catch { /* not json */ } }
      if (i === tries - 1) errors.push(`${src}: HTTP ${r.status} ${t.slice(0, 80).replace(/\s+/g, ' ')}`);
    } catch (e: any) { if (i === tries - 1) errors.push(`${src}: ${String(e?.message ?? e).slice(0, 80)}`); }
    await sleep(wait);
  }
  calls[src].fail++; return null;
}
const rd = (f: string, d: any) => { try { return JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')); } catch { return d; } };
const hist: any[] = rd('history.json', []);
// ---- fetch (sequential, polite: ≤ 17 requests a run, GDELT spaced 6 s)
const fngJ = await get('fng', 'https://api.alternative.me/fng/?limit=1'); const fng = fngJ?.data?.[0] ? Number(fngJ.data[0].value) : null;
const trendJ = await get('coingecko', 'https://api.coingecko.com/api/v3/search/trending');
const trending: string[] = (trendJ?.coins ?? []).map((c: any) => String(c.item?.id ?? ''));
const comp: Record<SentAsset, Partial<Record<SourceId, Component | null>>> = {} as any; const extra: Record<string, any> = {};
const x = rd('x-latest.json', null); let gdeltOff = false;
for (const a of SENT_ASSETS) {
  const posts: MastoStatus[] = [];
  for (const tag of PUBLIC_TAGS[a]) { const j = await get('mastodon', `https://mastodon.social/api/v1/timelines/tag/${tag}?limit=40`); if (Array.isArray(j)) posts.push(...j); await sleep(400); }
  const m = scoreMastodon(posts, a, now);
  const cg = await get('coingecko', `https://api.coingecko.com/api/v3/coins/${CG_ID[a]}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`);
  const up = cg?.sentiment_votes_up_percentage ?? null;
  const cgHist = hist.map(h => h.a?.[a]?.cgUp).filter((v: any) => Number.isFinite(v)).slice(-96);
  // GDELT is best-effort: shared CI IPs often get 429, so after the first refusal this run skips it (absent = no weight)
  let gd: any = null;
  if (!gdeltOff) { await sleep(6000); gd = await get('gdelt', `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(GDELT_Q[a])}&mode=timelinetone&timespan=24h&format=json`, 1); if (!gd) gdeltOff = true; }
  comp[a] = { x: xComponent(x, a, now), mastodon: m.n ? m : null, gdelt: scoreGdelt(gd), coingecko: scoreCoingecko(up, cgHist), fng: scoreFng(fng, a) };
  extra[a] = { m, up, trendingRank: trending.indexOf(CG_ID[a]) >= 0 ? trending.indexOf(CG_ID[a]) + 1 : null };
}
// ---- snapshot (same shape as the X snapshot, so the signal engine and UI read it unchanged)
const assets: any = {}; const hrow: any = { t: now, a: {} };
for (const a of SENT_ASSETS) {
  const mg = mergeComponents(comp[a]); const m = extra[a].m; const xa = comp[a].x ? x.assets[a] : null;
  assets[a] = {
    score: mg.score, confidence: mg.confidence, used: mg.used,
    components: Object.fromEntries(Object.entries(comp[a]).filter(([, v]) => v).map(([k, v]: any) => [k, { score: v.score, confidence: v.confidence, n: v.n, note: v.note }])),
    crowd: { value: m.score, n: m.n ?? 0 }, influencers: xa ? xa.influencers : { value: 0, n: 0 },
    attention: xa ? xa.attention : { vol24: m.vol24, baseline24: null, volRatio: null, accel6h: null },
    trendingRank: extra[a].trendingRank,
    sample: { fetched: m.fetched, kept: m.kept, dropped: m.dropped },
    sources: [...(xa?.sources ?? []).slice(0, 3), ...m.sources.slice(0, 3)],
    window: { from: new Date((now - 86400) * 1000).toISOString(), to: new Date(now * 1000).toISOString() },
  };
  hrow.a[a] = { s: mg.score, c: mg.confidence, u: mg.used.join(','), cgUp: extra[a].up ?? undefined, mv: m.vol24 };
}
const total = Object.values(calls).reduce((s, c) => s + c.ok + c.fail, 0);
const snap = { v: 1, generated: now, staleAfterH: STALE_AFTER_H,
  source: `GitHub Actions: mastodon.social tags, GDELT news tone, CoinGecko votes, Fear & Greed${x && comp.ETH.x ? ' + X snapshot (box, fresh)' : ''}`,
  method: 'docs/sentiment.md#public-sources', callsThisRun: total, calls, errors, fearGreed: fng, xSnapshot: x?.generated ?? null, assets };
const ok = Object.values(assets).some((v: any) => v.used.length);
console.log(JSON.stringify({ generated: snap.generated, calls, errors, assets: Object.fromEntries(Object.entries(assets).map(([k, v]: any) => [k, `${v.score} c${v.confidence} [${v.used}]`])) }, null, 1));
if (process.env.DRY === '1') process.exit(0);
if (!ok) { console.log('no source answered: keeping the previous snapshot (consumers treat it as stale after 3 h)'); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'latest.json'), JSON.stringify(snap, null, 1) + '\n');
hist.push(hrow); while (hist.length && hist[0].t < now - 30 * 86400) hist.shift();
fs.writeFileSync(path.join(OUT, 'history.json'), JSON.stringify(hist) + '\n');
if (process.argv.includes('--commit')) execFileSync('bash', [path.join(HERE, 'momentum-commit.sh')], { stdio: 'inherit', env: { ...process.env, DIR: 'web/public/momentum/sentiment-143', MSG: `sentiment: public snapshot ${new Date(now * 1000).toISOString().slice(0, 16)}Z [skip ci]` } });
