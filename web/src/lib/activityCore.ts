/**
 * Platform activity feed: dependency-free decoding, per-transaction aggregation, merge, sort and dedupe.
 * Shared by the browser (web/src/lib/activity.ts) and the GitHub Actions indexer (runner/activity-index.mjs,
 * run with `node --experimental-strip-types`). No imports on purpose, so both can load it as-is.
 */

export type Kind =
  | 'create' | 'deposit' | 'withdraw' | 'pay' | 'call' | 'token-out' | 'sweep' | 'pause' | 'unpause' | 'executor' | 'config'
  | 'refill' | 'refill-failed' | 'refill-fund' | 'refill-out' | 'md-deposit' | 'md-request' | 'md-redeem' | 'showcase';

/** One row = one executed transaction (deduped by tx hash). `i` is the log index of the row's main event. */
export type Row = {
  h: string;          // tx hash (lowercase)
  b: number;          // block number
  i: number;          // log index of the main event (-1 for ledger-only rows)
  t: number;          // block timestamp (unix seconds)
  k: Kind;
  s: 'ok' | 'reverted';
  v?: string;         // vault / contract the row is about (lowercase)
  a?: string;         // counterparty: recipient, target, depositor, owner, refilled address (lowercase)
  m?: string;         // amount in wei (MON) as a decimal string
  sel?: string;       // 4-byte selector for agent contract calls
  out?: string;       // token received by a call (lowercase), when any
  n?: number;         // platform events in this tx
  l?: string;         // label (from the showcase ledger)
  p?: string;         // showcase persona id (team rows)
  r?: string;         // revert reason (from the showcase ledger)
};

export const TOPIC = {
  VaultCreated: '0x897c133dfbfe1f6239e98b4ffd7e4f6c86a62350a131a7a37790419f58af02f9',
  Deposited: '0x73a19dd210f1a7f902193214c0ee91dd35ee5b4d920cba8d519eca65a7b488ca',
  Withdrawn: '0x92ccf450a286a957af52509bc1c9939d1a6a481783e142e41e2499f0bb66ebc6',
  Executed: '0x0d5c355dbbc9704bf64ba59d2aa11f1dfe9bd9c4522f48f1e560aff37957d658',
  DappCalled: '0xf67ce6de04b908359e88dd42b653b0a29b7cd02c0858f035a304a8324160e093',
  TokenWithdrawn: '0x8210728e7c071f615b840ee026032693858fbcd5e5359e67e438c890f59e5620', // gitleaks:allow (public event topic hash)
  PausedSet: '0x40db37ff5c0bdc2c427fbb2078c8f24afea940abac0e3c23bb4ea3bf2da2b212',
  Unpaused: '0x5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa',
  SweptToOwner: '0xed2eea449b807119f631f461fa1b887c897470253b998e7545b6bc72341a0d43',
  ExecutorSet: '0x3e3c5e6d5b512eaa5d5a80669846cfbaf8bde70fc6f7a3be9828cffc9ba5f1db',
  RecipientSet: '0xd5ffcccec9ca17d38e6c980f3e9207dd9e3b4dce832168f35ef094eeda3043df',
  PerPaymentCapSet: '0x36f88edda0ba8a9d807038b859422591991018c2363d1ceac0360156d1e09dba',
  BudgetSet: '0xaa2e070b2836a61656bb052c00da7076d0992fd90d7d0da7a8256bc4c6481cd8',
  CallRuleSet: '0x080eb15149c06fbbfdb5aec7a1d20e55763b9a5018cde4404f74922557f90a98',
  TokenCapSet: '0xb0e16f6fdfcb69f870c8b5f9b69b27f1ef92761f46c166dd55b4e1d9ad87e182', // gitleaks:allow (public event topic hash)
  Funded: '0x5af8184bef8e4b45eb9f6ed7734d04da38ced226495548f46e0c8ff8d7d9a524',
  Refilled: '0x19aee2c21e4d63823896cb2a77a3e61197dda70b1043a55fca38aa8d75c0edd3',
  RefillFailed: '0xdecc56715c14c4db26a710b9bc3d97d9ee88582fac2d752db4420f2207d3c4d7',
  RefillCall: '0x7f1ba8e2f1755b2a65acf3aca6381189493edabb41ca3f9e537785644c1fb9a5',
  RefillerWithdrawn: '0x430648de173157e069201c943adb2d4e340e7cf5b27b1b09c9cb852f03d63b56',
  AprDeposit: '0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7',
  AprRedeemRequest: '0x110990b6c317a85848c161e269666a01fea23eb9e16150c2c46cae8c0faf4a9d',
  AprRedeem: '0x8caf04742286d017f9ac3924388e188c73e6e5094311c5e59a61a7ef86dda8bf',
} as const;

export type RawLog = { address: string; topics: string[]; data: string; transactionHash: string; blockNumber: string | number | bigint; logIndex: string | number | bigint; blockTimestamp?: string | number | bigint; removed?: boolean };

/** What the decoder needs to know about the platform's contracts and wallets (all lowercase). */
export type Ctx = { factories: Set<string>; vaults: Set<string>; refillers: Set<string>; aprmon: string; wallets: Set<string> };
export type Created = { vault: string; owner: string; executor: string; factory: string; block: number; t: number; h: string };

const num = (x: string | number | bigint | undefined): number => (x === undefined ? 0 : typeof x === 'string' ? Number(BigInt(x)) : Number(x));
const word = (data: string, k: number) => '0x' + data.slice(2 + 64 * k, 2 + 64 * (k + 1));
const addrOf = (w: string | undefined) => (w ? ('0x' + w.slice(-40)).toLowerCase() : undefined);
const uintOf = (w: string) => BigInt(w.length > 2 ? w : '0x0').toString();

type Part = { k: Kind; prio: number; v?: string; a?: string; m?: bigint; sel?: string; out?: string; i: number };
/** Priority decides which event names a multi-event tx (e.g. create + deposit, sweep + withdraw). */
const PRIO: Record<Kind, number> = { create: 100, sweep: 90, pay: 85, call: 84, 'token-out': 80, withdraw: 75, deposit: 70, refill: 60, 'refill-failed': 59, 'refill-fund': 58, 'refill-out': 57, 'md-deposit': 50, 'md-request': 49, 'md-redeem': 48, pause: 40, unpause: 39, executor: 30, config: 10, showcase: 0 };

/** Decode one log into a part of a row, or null when it is not a platform event. */
export function decodeLog(l: RawLog, ctx: Ctx): (Part & { created?: Omit<Created, 'block' | 't' | 'h'> }) | null {
  const at = l.address.toLowerCase(); const t0 = (l.topics[0] ?? '').toLowerCase(); const i = num(l.logIndex);
  const T = l.topics; const p = (k: Kind, x: Omit<Part, 'k' | 'prio' | 'i'> = {}): Part => ({ k, prio: PRIO[k], i, ...x });
  if (ctx.factories.has(at)) {
    if (t0 !== TOPIC.VaultCreated) return null;
    const owner = addrOf(T[1])!, vault = addrOf(T[2])!, executor = addrOf(T[3])!;
    return { ...p('create', { v: vault, a: owner }), created: { vault, owner, executor, factory: at } };
  }
  if (ctx.refillers.has(at)) {
    if (t0 === TOPIC.Refilled) return p('refill', { v: at, a: addrOf(T[1]), m: BigInt(word(l.data, 0)) });
    if (t0 === TOPIC.RefillFailed) return p('refill-failed', { v: at, a: addrOf(T[1]), m: BigInt(word(l.data, 0)) });
    if (t0 === TOPIC.Funded) return p('refill-fund', { v: at, a: addrOf(T[1]), m: BigInt(word(l.data, 0)) });
    if (t0 === TOPIC.RefillerWithdrawn) return p('refill-out', { v: at, m: BigInt(word(l.data, 0)) });
    if (t0 === TOPIC.RefillCall) return p('refill', { v: at, a: addrOf(T[1]), m: 0n });
    return null;
  }
  if (at === ctx.aprmon) {
    // aPriori aprMON: only platform wallets (vault owners, agents, the team) count as MonaDefi activity.
    const who = addrOf(T[2]);
    if (!who || !ctx.wallets.has(who)) return null;
    if (t0 === TOPIC.AprDeposit) return p('md-deposit', { v: at, a: who, m: BigInt(word(l.data, 0)) });
    if (t0 === TOPIC.AprRedeemRequest) return p('md-request', { v: at, a: who, m: BigInt(word(l.data, 2)) });
    if (t0 === TOPIC.AprRedeem) return p('md-redeem', { v: at, a: who, m: BigInt(word(l.data, 1)) });
    return null;
  }
  if (!ctx.vaults.has(at)) return null;
  switch (t0) {
    case TOPIC.Deposited: return p('deposit', { v: at, a: addrOf(T[1]), m: BigInt(word(l.data, 0)) });
    case TOPIC.Withdrawn: return p('withdraw', { v: at, a: addrOf(T[1]), m: BigInt(word(l.data, 0)) });
    case TOPIC.Executed: return p('pay', { v: at, a: addrOf(T[2]), m: BigInt(word(l.data, 0)) });
    case TOPIC.DappCalled: { const out = addrOf(word(l.data, 1)); return p('call', { v: at, a: addrOf(T[2]), sel: '0x' + (T[3] ?? '').slice(2, 10), m: BigInt(word(l.data, 0)), out: out && /^0x0{40}$/.test(out) ? undefined : out }); }
    case TOPIC.TokenWithdrawn: return p('token-out', { v: at, a: addrOf(T[2]), out: addrOf(T[1]), m: 0n });
    case TOPIC.SweptToOwner: return p('sweep', { v: at, a: addrOf(T[1]), m: BigInt(word(l.data, 0)) });
    case TOPIC.PausedSet: return p(BigInt(word(l.data, 0)) ? 'pause' : 'unpause', { v: at });
    case TOPIC.Unpaused: return p('unpause', { v: at, a: addrOf(T[1]) });
    case TOPIC.ExecutorSet: return p('executor', { v: at, a: addrOf(T[1]) });
    case TOPIC.RecipientSet: case TOPIC.PerPaymentCapSet: case TOPIC.BudgetSet: case TOPIC.CallRuleSet: case TOPIC.TokenCapSet: return p('config', { v: at });
    default: return null;
  }
}

/**
 * Turn raw logs into one row per transaction, plus the vaults these logs created.
 * Amounts of the winning kind are summed (e.g. a refill tx paying 5 agents); a create row carries the deposit made in the same tx.
 */
export function aggregate(logs: RawLog[], ctx: Ctx): { rows: Row[]; created: Created[]; executors: { vault: string; executor: string; b: number; i: number }[] } {
  const byTx = new Map<string, { b: number; t: number; parts: Part[] }>(); const created: Created[] = []; const executors: { vault: string; executor: string; b: number; i: number }[] = [];
  for (const l of logs) {
    if (l.removed) continue;
    const d = decodeLog(l, ctx); if (!d) continue;
    const h = l.transactionHash.toLowerCase(); const b = num(l.blockNumber); const t = num(l.blockTimestamp);
    if (d.created) created.push({ ...d.created, block: b, t, h });
    if (d.k === 'executor' && d.v && d.a) executors.push({ vault: d.v, executor: d.a, b, i: d.i });
    const e = byTx.get(h) ?? { b, t, parts: [] }; e.parts.push(d); byTx.set(h, e);
  }
  const rows: Row[] = [];
  for (const [h, e] of byTx) {
    const top = e.parts.reduce((x, y) => (y.prio > x.prio ? y : x));
    const same = e.parts.filter(x => x.k === top.k);
    let m = same.reduce((s, x) => s + (x.m ?? 0n), 0n);
    if (top.k === 'create') m += e.parts.filter(x => x.k === 'deposit' && x.v === top.v).reduce((s, x) => s + (x.m ?? 0n), 0n);
    const r: Row = { h, b: e.b, i: top.i, t: e.t, k: top.k, s: 'ok', n: e.parts.length };
    if (top.v) r.v = top.v; if (top.a) r.a = top.a; if (m > 0n) r.m = m.toString(); if (top.sel) r.sel = top.sel; if (top.out) r.out = top.out;
    rows.push(r);
  }
  return { rows: sortRows(rows), created, executors };
}

/** Showcase ledger lines (runner/ledger/showcase-143.jsonl) → rows. Reverted txs emit no logs, so this is where they come from. */
export function fromLedger(lines: { ts?: string; persona?: string; label?: string; status?: string; reason?: string; tx?: string; block?: string | number; vault?: string }[], personaVault: Record<string, string> = {}): Row[] {
  const out: Row[] = [];
  for (const x of lines) {
    if (!x?.tx || !/^0x[0-9a-fA-F]{64}$/.test(x.tx) || x.block === undefined || x.block === null || x.block === '') continue;
    const failed = x.status === 'blocked' || x.status === 'error' || x.status === 'reverted' || x.status === 'failed';
    const r: Row = { h: x.tx.toLowerCase(), b: Number(x.block), i: -1, t: x.ts ? Math.floor(Date.parse(x.ts) / 1000) : 0, k: 'showcase', s: failed ? 'reverted' : 'ok' };
    if (x.label) r.l = x.label; if (x.persona) r.p = x.persona; if (failed && x.reason) r.r = String(x.reason).slice(0, 160);
    const v = x.vault ?? (x.persona ? personaVault[x.persona] : undefined); if (v) r.v = v.toLowerCase();
    out.push(r);
  }
  return out;
}

/** Newest first: block desc, then log index desc (ledger-only rows, i = -1, sort after logged rows of the same block). */
export const cmpRows = (x: Row, y: Row) => y.b - x.b || y.i - x.i || (x.h < y.h ? -1 : x.h > y.h ? 1 : 0);
export const sortRows = (rows: Row[]) => rows.sort(cmpRows);

/** Combine two rows for the same tx: on-chain logs decide kind/amount/status (a tx with logs succeeded); the ledger adds label/persona. */
export function combine(x: Row, y: Row): Row {
  const [chain, other] = x.i >= 0 ? [x, y] : y.i >= 0 ? [y, x] : [x, y];
  const r: Row = { ...other, ...chain };
  if (chain.i >= 0) r.s = 'ok';
  else r.s = x.s === 'reverted' || y.s === 'reverted' ? 'reverted' : 'ok';
  r.l = chain.l ?? other.l; r.p = chain.p ?? other.p; r.r = r.s === 'reverted' ? (chain.r ?? other.r) : undefined;
  r.v = chain.v ?? other.v; r.t = chain.t || other.t;
  for (const k of Object.keys(r) as (keyof Row)[]) if (r[k] === undefined) delete r[k];
  return r;
}

/** Merge any number of row lists: dedupe by tx hash (one row per executed tx), newest first. */
export function mergeRows(...lists: Row[][]): Row[] {
  const m = new Map<string, Row>();
  for (const list of lists) for (const r of list) { const h = r.h.toLowerCase(); const o = m.get(h); m.set(h, o ? combine(o, { ...r, h }) : { ...r, h }); }
  return sortRows([...m.values()]);
}

/** Bucket id for paged history files: one file per BUCKET blocks (~0.9 day on Monad). Rows never move between files. */
export const BUCKET = 200_000;
export const bucketOf = (b: number) => Math.floor(b / BUCKET);

export const KIND_GROUP: Record<Kind, string> = {
  create: 'create', deposit: 'deposit', withdraw: 'withdraw', 'token-out': 'withdraw', pay: 'agent', call: 'agent', sweep: 'sweep',
  pause: 'pause', unpause: 'pause', executor: 'config', config: 'config', refill: 'refill', 'refill-failed': 'refill', 'refill-fund': 'refill', 'refill-out': 'refill',
  'md-deposit': 'monadefi', 'md-request': 'monadefi', 'md-redeem': 'monadefi', showcase: 'agent',
};
