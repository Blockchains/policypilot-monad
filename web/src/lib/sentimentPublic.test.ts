import test from 'node:test'; import assert from 'node:assert/strict';
import { scoreMastodon, scoreGdelt, scoreCoingecko, scoreFng, xComponent, mergeComponents, stripHtml, mastoSpam, type MastoStatus } from './sentimentPublic.ts';
const NOW = 1_800_000_000;
const acct = (id: string, o: any = {}) => ({ id, acct: `u${id}`, bot: false, created_at: '2024-01-01T00:00:00Z', followers_count: 50, ...o });
const post = (id: string, text: string, ageS = 600, o: any = {}): MastoStatus => ({ id, url: `https://m/${id}`, created_at: new Date((NOW - ageS) * 1000).toISOString(), content: `<p>${text}</p>`, language: 'en', favourites_count: 1, reblogs_count: 0, replies_count: 0, tags: [], account: acct(o.a ?? id, o.acc), ...o.s });
test('stripHtml', () => assert.equal(stripHtml('<p>Bitcoin &amp; <b>ETH</b><br>up</p>'), 'Bitcoin & ETH up'));
test('mastodon: scores on-topic posts, drops old/bots/new/off-topic/dupes/floods', () => {
  const ps = [post('1', 'Bitcoin is bullish, breakout'), post('2', 'bitcoin crash, very bearish'), post('3', 'Bitcoin rally', 90000),
    post('4', 'bitcoin moon', 600, { acc: { bot: true } }), post('5', 'bitcoin pump', 600, { acc: { created_at: new Date((NOW - 86400) * 1000).toISOString() } }),
    post('6', 'cats are great'), post('7', 'Bitcoin is bullish, breakout'), post('8', 'bitcoin surge', 700, { a: '1' })];
  const r = scoreMastodon(ps, 'BTC', NOW);
  assert.equal(r.fetched, 8); assert.equal(r.kept, 2); assert.equal(r.vol24, 7);
  assert.deepEqual(r.dropped, { old: 1, bot: 1, 'new-account': 1, 'off-topic': 1, duplicate: 1, 'author-flood': 1 });
  assert.ok(r.confidence > 0 && r.confidence <= 0.6);
});
test('mastodon: nothing usable -> n 0', () => { const r = scoreMastodon([], 'MON', NOW); assert.equal(r.n, 0); assert.equal(r.score, 0); });
test('spam bait', () => assert.equal(mastoSpam(post('1', 'Free crypto giveaway DM me'), NOW), 'bait'));
test('gdelt tone', () => { assert.equal(scoreGdelt({ timeline: [{ data: [{ value: -2 }, { value: -3 }] }] })!.score, -0.5); assert.equal(scoreGdelt({}), null); assert.equal(scoreGdelt({ timeline: [{ data: [{ value: -20 }] }] })!.score, -1); });
test('coingecko: damped without baseline, relative with one', () => {
  assert.deepEqual([scoreCoingecko(80, [])!.score, scoreCoingecko(80, [])!.confidence], [0.3, 0.1]);
  const c = scoreCoingecko(70, Array(24).fill(85))!; assert.equal(c.score, -1); assert.equal(c.confidence, 0.25);
  assert.equal(scoreCoingecko(null, []), null);
});
test('fng', () => { assert.equal(scoreFng(75, 'BTC')!.score, 0.5); assert.equal(scoreFng(75, 'ETH')!.confidence, 0.15); assert.equal(scoreFng(null, 'BTC'), null); });
test('x enrichment only while fresh', () => {
  const x = { generated: NOW - 3600, assets: { ETH: { score: -0.4, confidence: 0.35, sample: { kept: 13 } } } };
  assert.equal(xComponent(x, 'ETH', NOW)!.score, -0.4); assert.equal(xComponent(x, 'ETH', NOW + 3 * 3600), null); assert.equal(xComponent(x, 'BTC', NOW), null); assert.equal(xComponent(null, 'ETH', NOW), null);
});
test('merge: confidence-weighted, capped, skips missing', () => {
  const m = mergeComponents({ mastodon: { score: 0.5, confidence: 0.6 }, fng: { score: -0.5, confidence: 0.3 }, gdelt: null });
  assert.deepEqual(m.used, ['mastodon', 'fng']); assert.equal(m.score, +((0.6 * 0.5 - 0.18 * 0.5) / 0.78).toFixed(4)); assert.equal(m.confidence, 0.39);
  assert.deepEqual(mergeComponents({}), { score: 0, confidence: 0, used: [] });
  assert.equal(mergeComponents({ x: { score: 1, confidence: 1 }, mastodon: { score: 1, confidence: 1 }, gdelt: { score: 1, confidence: 1 } }).confidence, 0.8);
});
