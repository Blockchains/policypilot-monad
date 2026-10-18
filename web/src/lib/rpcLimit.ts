import { custom, type Transport } from 'viem';

/** Shared request gate: caps concurrent RPC calls and pauses everyone after a 429. */
export class Gate {
  active = 0; pauseUntil = 0; private q: (() => void)[] = [];
  constructor(public max = 4) {}
  async acquire() {
    for (;;) {
      const wait = this.pauseUntil - Date.now();
      if (wait > 0) { await new Promise(r => setTimeout(r, wait)); continue; }
      if (this.active < this.max) { this.active++; return; }
      await new Promise<void>(r => this.q.push(r));
    }
  }
  release() { this.active--; this.q.shift()?.(); }
}

const IMMUTABLE = new Set(['eth_chainId', 'eth_getTransactionByHash', 'eth_getTransactionReceipt']);
const TTL_OK = new Set(['eth_call', 'eth_getBalance', 'eth_getTransactionCount', 'eth_getCode']);

export function is429(e: unknown): boolean {
  for (let x: any = e, i = 0; x && i < 8; x = x.cause, i++) {
    if (x.status === 429 || x.code === 429) return true;
    if (/\b429\b|rate.?limit|too many requests/i.test(String(x.message ?? x.details ?? ''))) return true;
  }
  return false;
}

/**
 * Wraps a transport (e.g. the fallback list) with: a concurrency gate, in-flight dedupe of identical
 * calls, a permanent cache for immutable results (mined tx/receipts), an optional short TTL cache for
 * state reads, and exponential back-off on 429. Never caches null (e.g. a receipt that is still pending).
 */
export function limitedTransport(inner: Transport, gate: Gate, ttlMs = 0): Transport {
  const cache = new Map<string, { t: number; v: unknown }>();
  const inflight = new Map<string, Promise<unknown>>();
  return cfg => {
    const t = inner(cfg);
    return custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        const key = `${method}:${JSON.stringify(params ?? [])}`;
        const hit = cache.get(key);
        if (hit && (IMMUTABLE.has(method) || Date.now() - hit.t < ttlMs)) return hit.v;
        const f = inflight.get(key); if (f) return f;
        const p = (async () => {
          for (let i = 0; ; i++) {
            await gate.acquire();
            try {
              const v = await t.request({ method, params } as any);
              if (v != null && (IMMUTABLE.has(method) || (ttlMs > 0 && TTL_OK.has(method)))) cache.set(key, { t: Date.now(), v });
              return v;
            } catch (e) {
              if (is429(e) && i < 3) { gate.pauseUntil = Math.max(gate.pauseUntil, Date.now() + 1000 * 2 ** i + Math.random() * 500); continue; }
              throw e;
            } finally { gate.release(); }
          }
        })().finally(() => inflight.delete(key));
        inflight.set(key, p);
        return p;
      },
    }, { retryCount: 0 })(cfg);
  };
}

/** setInterval that skips ticks while the tab is hidden and catches up once when it becomes visible. */
export function everyVisible(fn: () => void, ms: number): () => void {
  let last = Date.now();
  const run = () => { last = Date.now(); fn(); };
  const t = setInterval(() => { if (!document.hidden) run(); }, ms);
  const onVis = () => { if (!document.hidden && Date.now() - last >= ms) run(); };
  document.addEventListener('visibilitychange', onVis);
  return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
}
