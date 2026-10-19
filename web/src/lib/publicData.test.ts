import test from 'node:test'; import assert from 'node:assert/strict';
import { publicUrls, loadPublic } from './publicData.ts';
test('three mirrors in order, dot segments kept for the URL parser', () => {
  const u = publicUrls('/momentum/143/../sentiment-143/latest.json', '/policypilot-monad');
  assert.equal(u.length, 3); assert.match(u[0], /^https:\/\/raw\.githubusercontent\.com\/Blockchains\/policypilot-monad\/main\/web\/public\/momentum/);
  assert.equal(u[1], '/policypilot-monad/momentum/143/../sentiment-143/latest.json'); assert.match(u[2], /^https:\/\/cdn\.jsdelivr\.net\/gh\/Blockchains\/policypilot-monad@main\/web\/public\//);
  assert.equal(new URL(u[0]).pathname, '/Blockchains/policypilot-monad/main/web/public/momentum/sentiment-143/latest.json');
});
test('falls through to the next mirror', async () => {
  const seen: string[] = [];
  const f = (async (u: string) => { seen.push(u); if (u.includes('raw.')) throw new Error('down'); if (!u.includes('jsdelivr')) return { ok: false } as any; return { ok: true, json: async () => ({ ok: 1 }) } as any; }) as any;
  assert.deepEqual(await loadPublic('x/test-fallthrough.json', 0, f), { ok: 1 }); assert.equal(seen.length, 3);
});
test('null when every mirror fails', async () => assert.equal(await loadPublic('x/none.json', 0, (async () => ({ ok: false })) as any), null));
