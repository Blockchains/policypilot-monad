/**
 * Activity feed for the live site: loads the committed history index (every factory, vault, refiller, showcase ledger,
 * MonaDefi of platform wallets), then live-tails the chain from its lastBlock with ONE eth_getLogs per tick over every
 * known factory + vault + refiller + aprMON address. New vaults found in VaultCreated are added on the fly.
 */
import { http, createPublicClient, type PublicClient } from 'viem';
import { aggregate, mergeRows, type Ctx, type RawLog, type Row } from './activityCore';
import { limitedTransport } from './rpcLimit';
import { chainOf, gateOf, type Net } from './vault';

export type VaultMeta = { a: string; f: string; o: string; e: string; b: number; t: number; team?: boolean; p?: string };
export type Index = { v: number; lastBlock: number; updatedAt: string; total: number; reverted: number; counts: Record<string, number>; factories: Record<string, string>; refillers: string[]; aprmon: string; teamOwner: string; vaults: VaultMeta[]; pages: { id: number; n: number; from: number; to: number }[]; latest: Row[] };

const RAW = 'https://raw.githubusercontent.com/Blockchains/policypilot-monad/main/web/public/activity/143';
const getJSON = (u: string) => fetch(u, { cache: 'no-store' }).then(r => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${u}`))));

/** Freshest of raw GitHub (pushed by the indexer every minute it has news) and the copy deployed with Pages. */
export async function loadIndex(base: string): Promise<Index | null> {
  const rs = await Promise.allSettled([getJSON(`${RAW}/index.json`), getJSON(`${base}/activity/143/index.json`)]);
  const xs = rs.filter(x => x.status === 'fulfilled').map(x => (x as PromiseFulfilledResult<Index>).value).filter(x => x && x.lastBlock);
  return xs.sort((a, b) => b.lastBlock - a.lastBlock)[0] ?? null;
}
export async function loadPage(base: string, id: number): Promise<Row[]> {
  for (const u of [`${RAW}/p${id}.json`, `${base}/activity/143/p${id}.json`]) { try { return (await getJSON(u)).rows ?? []; } catch { /* next */ } }
  return [];
}

/** getLogs endpoints, widest range first (public Monad RPCs cap the range: rpc2 10k, rpc3 1k, the rest 100 blocks). */
const ENDPOINTS: [string, number][] = [['https://rpc2.monad.xyz', 10_000], ['https://rpc3.monad.xyz', 1_000], ['https://rpc.monad.xyz', 100]];
const clients = new Map<string, PublicClient>();
const logsClient = (n: Net, url: string) => { let c = clients.get(url); if (!c) clients.set(url, (c = createPublicClient({ chain: chainOf(n), transport: limitedTransport(http(url, { batch: false, retryCount: 0, timeout: 10_000 }), gateOf(n)) }) as PublicClient)); return c; };

export type Tail = { cursor: number; ctx: Ctx; vaults: Map<string, VaultMeta>; ep: number; epSince: number; calls: number; okAt: number; err?: string };

export function tailFrom(idx: Index): Tail {
  const vaults = new Map(idx.vaults.map(v => [v.a, v]));
  const wallets = new Set([idx.teamOwner, ...idx.vaults.flatMap(v => [v.o, v.e])]);
  return { cursor: idx.lastBlock, vaults, ep: 0, epSince: 0, calls: 0, okAt: 0, ctx: { factories: new Set(Object.keys(idx.factories)), vaults: new Set(vaults.keys()), refillers: new Set(idx.refillers), aprmon: idx.aprmon, wallets } };
}
const hex = (n: number) => `0x${n.toString(16)}`;
const addrsOf = (t: Tail) => [...t.ctx.factories, ...t.ctx.vaults, ...t.ctx.refillers, t.ctx.aprmon];

async function getLogs(n: Net, t: Tail, address: string[], from: number, to: number): Promise<RawLog[]> {
  if (t.ep && Date.now() - t.epSince > 60_000) t.ep = 0; // retry the wide endpoint after a minute
  for (;;) {
    const [url] = ENDPOINTS[t.ep];
    try { t.calls++; return (await logsClient(n, url).request({ method: 'eth_getLogs', params: [{ address, fromBlock: hex(from), toBlock: hex(to) }] } as any)) as RawLog[]; }
    catch (e) { if (/not yet|not available|block not found/i.test(String((e as any)?.details ?? (e as any)?.message ?? e))) throw e; /* node is behind: retry next tick, same endpoint */ if (t.ep >= ENDPOINTS.length - 1) throw e; t.ep++; t.epSince = Date.now(); if (to - from + 1 > ENDPOINTS[t.ep][1]) return []; }
  }
}

/**
 * One live-tail step: logs for (cursor, head] (clipped to the endpoint's max range), decoded into rows. Usually exactly one
 * eth_getLogs; one more only when this range created a vault (to pick up that vault's own events in the same range).
 * `account` widens the MonaDefi filter to the connected wallet. Returns the new rows (empty when nothing happened).
 */
export async function tick(n: Net, t: Tail, head: number, account?: string | null): Promise<Row[]> {
  if (account) t.ctx.wallets.add(account.toLowerCase());
  const from = t.cursor + 1; if (head < from) return [];
  // rpc2 rejects a toBlock it has not seen yet (safe); the narrower fallbacks silently return [] for it, so they stay further back.
  const safe = head - (t.ep ? 8 : 2); if (safe < from) return [];
  const to = Math.min(safe, from + ENDPOINTS[t.ep][1] - 1);
  try {
    let logs = await getLogs(n, t, addrsOf(t), from, to);
    if (!logs.length && to - from + 1 > ENDPOINTS[t.ep][1]) return []; // endpoint changed to a narrower one: retry next tick
    let agg = aggregate(logs, t.ctx);
    const born = agg.created.filter(c => !t.vaults.has(c.vault));
    if (born.length) {
      for (const c of born) { t.vaults.set(c.vault, { a: c.vault, f: n.id === 143 ? 'live' : 'testnet', o: c.owner, e: c.executor, b: c.block, t: c.t }); t.ctx.vaults.add(c.vault); t.ctx.wallets.add(c.owner); t.ctx.wallets.add(c.executor); }
      logs = logs.concat(await getLogs(n, t, born.map(c => c.vault), from, to));
      agg = aggregate(logs, t.ctx);
    }
    for (const x of agg.executors) { const v = t.vaults.get(x.vault); if (v) v.e = x.executor; }
    t.cursor = to; t.okAt = Date.now(); t.err = undefined;
    return agg.rows;
  } catch (e) { t.err = String((e as Error)?.message ?? e).slice(0, 120); return []; }
}

export { mergeRows };
export type { Row };
