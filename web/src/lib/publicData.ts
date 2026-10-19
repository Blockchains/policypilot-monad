/**
 * Public data published by the GitHub jobs (web/public/...). Three mirrors, tried in order, so the UI keeps working if one
 * is down or rate-limited:
 *   1. raw.githubusercontent.com: fresh within a minute of each [skip ci] commit
 *   2. this site (GitHub Pages): fresh after the next Pages deploy
 *   3. cdn.jsdelivr.net/gh: an independent CDN (branch files can be cached for up to ~12 h, so consumers keep their own
 *      staleness checks)
 */
export const REPO = 'Blockchains/policypilot-monad';
export function publicUrls(rel: string, base = (typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_BASE_PATH : '') ?? ''): string[] {
  const p = rel.replace(/^\/+/, '');
  return [`https://raw.githubusercontent.com/${REPO}/main/web/public/${p}`, `${base}/${p}`, `https://cdn.jsdelivr.net/gh/${REPO}@main/web/public/${p}`];
}
const cache = new Map<string, { t: number; v: Promise<any> }>();
export function loadPublic<T = any>(rel: string, ttl = 60_000, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<T | null> {
  const hit = cache.get(rel); if (hit && Date.now() - hit.t < ttl) return hit.v;
  const v = (async () => {
    for (const u of publicUrls(rel)) {
      try { const r = await fetchFn(u, { cache: 'no-store' }); if (r.ok) return await r.json() as T; } catch { /* next mirror */ }
    }
    return null;
  })();
  cache.set(rel, { t: Date.now(), v }); return v;
}
