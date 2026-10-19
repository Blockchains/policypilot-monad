// Prints the exact X tool calls for one sentiment run (9 calls: 4 hourly counts, 4 relevancy samples, 1 influencer sample) as JSON.
// The windows end on the last full UTC hour so the hourly bins are complete. Usage: node --experimental-strip-types scripts/sentiment-plan.mts
import { INFLUENCERS, QUERIES, SENT_ASSETS } from '../src/lib/sentiment.ts';
const end = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const ago = (h: number) => iso(new Date(end.getTime() - h * 3_600_000));
const POST = { 'post.fields': 'created_at,public_metrics,author_id,lang', expansions: 'author_id', 'user.fields': 'created_at,public_metrics,verified', max_results: 25 };
const calls: { key: string; tool: string; arguments: Record<string, unknown> }[] = [];
for (const a of SENT_ASSETS) calls.push({ key: `${a}.counts`, tool: 'get_posts_counts_recent', arguments: { query: QUERIES[a], granularity: 'hour', start_time: ago(167), end_time: iso(end) } });
for (const a of SENT_ASSETS) calls.push({ key: `${a}.posts`, tool: 'search_posts_all', arguments: { query: QUERIES[a], sort_order: 'relevancy', start_time: ago(24), end_time: iso(end), ...POST } });
calls.push({ key: 'influencers', tool: 'search_posts_all', arguments: { query: `(${INFLUENCERS.map(u => 'from:' + u).join(' OR ')}) -is:retweet`, sort_order: 'recency', start_time: ago(24), end_time: iso(end), ...POST } });
console.log(JSON.stringify({ namespace: 'x', windowEnd: iso(end), calls }, null, 1));
