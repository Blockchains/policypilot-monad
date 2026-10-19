import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attention, combine, polarity, scoreSample, usableSentiment, weightedPolarity, type SentSnapshot } from './sentiment.ts';
const NOW = Date.parse('2026-10-19T08:00:00Z') / 1000;
const user = (id: string, o: Partial<{ f: number; age: number; v: boolean; u: string }> = {}) => ({ id, username: o.u ?? 'u' + id, verified: o.v, created_at: new Date((NOW - (o.age ?? 900) * 86400) * 1000).toISOString(), public_metrics: { followers_count: o.f ?? 5000 } });
describe('sentiment: lexicon', () => {
  it('scores direction, phrases, negation and intensifiers', () => {
    assert.ok(polarity('ETH breakout, very bullish').score > 0.4); assert.ok(polarity('bitcoin crash, rekt').score < -0.5);
    assert.ok(polarity('not bullish on sol').score < 0); assert.equal(polarity('ETH is trading at 2400').hits, 0);
    assert.ok(polarity('new all-time high 🚀').score > 0); assert.ok(Math.abs(polarity('moon moon moon moon moon moon moon').score) < 1);
  });
});
describe('sentiment: filter + weights', () => {
  const posts = [
    { id: '1', author_id: 'a', text: 'ETH looks bullish', public_metrics: { like_count: 100 } },
    { id: '2', author_id: 'b', text: 'ETH airdrop giveaway, dm me', public_metrics: {} },
    { id: '3', author_id: 'c', text: 'ETH dump incoming', public_metrics: {} },
    { id: '4', author_id: 'd', text: 'ETH looks bullish', public_metrics: {} },
    { id: '5', author_id: 'e', text: 'nice weather today', public_metrics: {} },
  ];
  it('drops bait, new accounts, duplicates and off-topic posts', () => {
    const r = scoreSample(posts, [user('a'), user('b'), user('c', { age: 5 }), user('d'), user('e')], NOW, { match: /\beth\b/i });
    assert.deepEqual(r.kept.map(k => k.id), ['1']); assert.deepEqual(r.dropped, { bait: 1, 'new-account': 1, duplicate: 1, 'off-topic': 1 });
  });
  it('curated influencers bypass account filters and weigh double', () => {
    const r = scoreSample([{ id: '9', author_id: 'z', text: 'ETH bearish', public_metrics: {} }], [user('z', { f: 10, u: 'Guru' })], NOW, { influencers: new Set(['guru']) });
    assert.equal(r.kept.length, 1);
  });
  it('weighted polarity ignores posts with no lexicon hits; combine blends 70/30 only with ≥ 2 influencer posts', () => {
    assert.deepEqual(weightedPolarity([{ id: '1', user: 'a', w: 2, pol: 0.5, hits: 1 }, { id: '2', user: 'b', w: 9, pol: 0, hits: 0 }]), { value: 0.5, n: 1 });
    assert.equal(combine({ value: 0.5, n: 5 }, { value: -0.5, n: 1 }, 20).score, 0.5); assert.equal(combine({ value: 0.5, n: 5 }, { value: -0.5, n: 2 }, 20).score, 0.2);
    assert.equal(combine({ value: 0, n: 0 }, { value: 0, n: 0 }, 80).confidence, 1);
  });
});
describe('sentiment: attention + staleness', () => {
  it('volume ratio vs earlier 24h windows and 6h acceleration', () => {
    const h = [...Array(144).fill(10), ...Array(18).fill(10), ...Array(6).fill(30)]; const a = attention(h);
    assert.equal(a.vol24, 360); assert.equal(a.baseline24, 240); assert.equal(a.volRatio, 1.5); assert.equal(a.accel6h, 2);
  });
  it('stale or missing snapshots are ignored, never blocking', () => {
    const s = { generated: NOW, assets: { ETH: { score: 0.3, confidence: 0.5 }, BTC: { score: -0.1, confidence: 0.2 } } } as unknown as SentSnapshot;
    assert.deepEqual(usableSentiment(s, 'WETH', NOW + 3600), { score: 0.3, confidence: 0.5, ageH: 1 }); assert.equal(usableSentiment(s, 'cbBTC', NOW)!.score, -0.1);
    assert.equal(usableSentiment(s, 'WETH', NOW + 4 * 3600), null); assert.equal(usableSentiment(null, 'WETH', NOW), null); assert.equal(usableSentiment(s, 'SOL', NOW), null);
  });
});
