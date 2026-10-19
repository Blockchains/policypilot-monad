// Builds web/public/momentum/sentiment-143/{latest,history}.json from one run's raw X tool outputs.
// Usage: node --experimental-strip-types scripts/sentiment-snapshot.mts <rawDir>   (rawDir holds <key>.txt for every key in sentiment-plan)
// Only aggregates and up to 5 post links per asset are written; no post text is stored.
import fs from 'node:fs'; import path from 'node:path';
import { INFLUENCERS, MATCH, SENT_ASSETS, STALE_AFTER_H, attention, combine, scoreSample, weightedPolarity, type SentSnapshot } from '../src/lib/sentiment.ts';
const raw = process.argv[2]; if (!raw) { console.error('usage: sentiment-snapshot.mts <rawDir>'); process.exit(2); }
const OUT = process.env.SENT_OUT ?? path.join(path.dirname(new URL(import.meta.url).pathname), '../public/momentum/sentiment-143');
/** Tool outputs may be wrapped in fence lines; the JSON payload is the first line that starts with '{'. */
function load(key: string): any {
  const f = path.join(raw, key + '.txt'); const txt = fs.readFileSync(f, 'utf8');
  const line = txt.split('\n').find(l => l.trimStart().startsWith('{')); if (!line) throw new Error(`${key}: no JSON payload in ${f}`);
  const j = JSON.parse(line); if (!j.data && j.errors) throw new Error(`${key}: X error ${JSON.stringify(j.errors).slice(0, 200)}`); return j;
}
const now = Math.floor(Date.now() / 1000); const infl = new Set(INFLUENCERS.map(u => u.toLowerCase()));
const I = load('influencers'); const iPosts = I.data ?? [], iUsers = I.includes?.users ?? [];
const assets = {} as SentSnapshot['assets']; let calls = 1;
for (const a of SENT_ASSETS) {
  const C = load(`${a}.counts`); const P = load(`${a}.posts`); calls += 2;
  const bins = (C.data ?? []).filter((b: any) => Date.parse(b.end) - Date.parse(b.start) >= 3_600_000 - 1000).map((b: any) => b.tweet_count as number);
  const posts = P.data ?? [], users = P.includes?.users ?? [];
  const crowdS = scoreSample(posts, users, now, { match: MATCH[a], influencers: infl });
  const inflS = scoreSample(iPosts, iUsers, now, { match: MATCH[a], influencers: infl });
  const crowd = weightedPolarity(crowdS.kept), inf = weightedPolarity(inflS.kept);
  const all = [...crowdS.kept, ...inflS.kept.filter(x => !crowdS.kept.some(y => y.id === x.id))];
  const sources = [...all].filter(x => x.hits > 0).sort((x, y) => y.w - x.w).slice(0, 5).map(x => ({ url: `https://x.com/${x.user}/status/${x.id}`, user: x.user, pol: +x.pol.toFixed(3) }));
  const times = posts.map((p: any) => p.created_at).filter(Boolean).sort();
  assets[a] = { ...combine(crowd, inf, crowdS.kept.length), crowd, influencers: inf, attention: attention(bins),
    sample: { fetched: posts.length, kept: crowdS.kept.length, dropped: crowdS.dropped }, sources, window: { from: times[0] ?? '', to: times.at(-1) ?? '' } };
}
const snap: SentSnapshot = { v: 1, generated: now, staleAfterH: STALE_AFTER_H, source: 'X API v2 (recent counts + search), collected on the bot box', method: 'docs/sentiment.md', callsThisRun: calls, assets };
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'latest.json'), JSON.stringify(snap, null, 1) + '\n');
const hf = path.join(OUT, 'history.json'); let hist: any[] = []; try { hist = JSON.parse(fs.readFileSync(hf, 'utf8')); } catch { /* first run */ }
hist.push({ t: now, a: Object.fromEntries(SENT_ASSETS.map(k => [k, { s: assets[k].score, c: assets[k].confidence, vr: assets[k].attention.volRatio, ac: assets[k].attention.accel6h, v24: assets[k].attention.vol24 }])) });
hist = hist.filter(h => h.t > now - 14 * 86400).slice(-400);
fs.writeFileSync(hf, JSON.stringify(hist) + '\n');
for (const k of SENT_ASSETS) { const x = assets[k]; console.log(k, 'score', x.score, 'conf', x.confidence, 'crowd', x.crowd, 'infl', x.influencers, 'vol24', x.attention.vol24, 'volRatio', x.attention.volRatio, 'accel6h', x.attention.accel6h, 'kept', x.sample.kept, '/', x.sample.fetched, JSON.stringify(x.sample.dropped)); }
