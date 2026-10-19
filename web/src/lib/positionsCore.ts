/**
 * Positions + "Close & withdraw all": pure reads, valuation, the close plan and the plan runner.
 * Imports only viem, so the browser (Positions tab) and the headless mainnet test (scripts/close-all-headless.mts)
 * run exactly the same code. Signing is injected through a Runner; nothing here holds a key.
 *
 * Honesty rules baked in:
 *  - a value is shown only when it comes from a live on-chain read (1:1 wrap, convertToAssets, pool assetsOf,
 *    aPriori request assets) or a live MON/USDC quote passed in by the caller; everything else is "unknown value";
 *  - sMON has no convertToAssets on its contract, so it is counted at par and flagged;
 *  - staked tokens are withdrawn AS TOKENS to the owner wallet; nothing claims they become MON instantly.
 */
import { encodeFunctionData, getAddress, keccak256, parseAbi, toHex, type Address, type Hex, type PublicClient } from 'viem';

export const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const ONE = 10n ** 18n;

/** Verified mainnet addresses (same sources as services.ts; positions.test.ts asserts they match). */
export const ADDR = {
  WMON: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A' as Address,
  USDC: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603' as Address,
  sMON: '0xA3227C5969757783154C60bF0bC1944180ed81B9' as Address,
  aprMON: '0x0c65A0BC65a5D819235B71F554D210D3F80E0852' as Address,
  gMON: '0x8498312A6B3CbD158bf0c93AbdCF29E6e4F55081' as Address,
  /** Uniswap v3 NonfungiblePositionManager on Monad (developers.uniswap.org v3-monad-deployments). */
  uniNpm: '0x7197e214c0b767cfb76fb734ab638e2c192f4e53' as Address,
  /** PancakeSwap v3 NonfungiblePositionManager on Monad (developer.pancakeswap.finance/contracts/v3/addresses). */
  pcsNpm: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364' as Address,
  /** Kuru MarginAccount (docs.kuru.io/contracts/Contract-addresses). */
  kuruMargin: '0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5' as Address,
} as const;

export type FactoryInfo = { id: 'v4' | 'v3' | 'v2' | 'v1' | 'showcase'; label: string; address: Address; unlimited: boolean; showcase?: boolean };
export const FACTORIES: FactoryInfo[] = [
  { id: 'v4', label: 'Unlimited (v4)', address: '0x41d6667aA35c3634D19068A39481d4c955f6557D', unlimited: true },
  { id: 'v3', label: 'v3 (1000 MON cap)', address: '0x52727226aF0efe2bfe3E5c97e46B704613344a92', unlimited: false },
  { id: 'v2', label: 'v2 (1 MON cap)', address: '0x0342d29055d77ba155c50233f550539E3029BA6a', unlimited: false },
  { id: 'v1', label: 'v1 (1 MON cap)', address: '0x8738B74778502ff3623A8319837A819d8dBdEeB7', unlimited: false },
  { id: 'showcase', label: 'v4 showcase (team)', address: '0x7611405605a9D630f3E7F4703897FcF1Dc17f945', unlimited: false, showcase: true },
];
export const SHOWCASE_LABEL = 'PolicyPilot showcase agents (operated by the team)';
/** Public Blockscout instance for Monad mainnet (keyless, CORS *). Used only to discover token addresses from Transfer logs. */
export const BLOCKSCOUT = 'https://monscout.cp0x.com';

export const KNOWN: { sym: string; address: Address; decimals: number; kind: TokenKind }[] = [
  { sym: 'WMON', address: ADDR.WMON, decimals: 18, kind: 'wrapped' },
  { sym: 'USDC', address: ADDR.USDC, decimals: 6, kind: 'stable' },
  { sym: 'sMON', address: ADDR.sMON, decimals: 18, kind: 'lst' },
  { sym: 'aprMON', address: ADDR.aprMON, decimals: 18, kind: 'lst' },
  { sym: 'gMON', address: ADDR.gMON, decimals: 18, kind: 'lst' },
];

// ---------- ABIs (subsets) ----------
export const factoryAbi = parseAbi([
  'function vaultsOf(address owner) view returns (address[])',
  'function vaultCount() view returns (uint256)',
  'function allVaults(uint256) view returns (address)',
]);
export const vaultAbi = parseAbi([
  'function owner() view returns (address)',
  'function executor() view returns (address)',
  'function paused() view returns (bool)',
  'function unlimited() view returns (bool)',
  'function callRule(address target, bytes4 selector) view returns (bool allowed, uint8 recipientWord)',
  'function emergencyWithdrawAll()',
  'function withdraw(address to, uint256 amount)',
  'function withdrawToken(address token, address to, uint256 amount)',
  'function setPaused(bool p)',
  'function executeCall(bytes32 requestId, address target, uint256 value, bytes data, (address approveToken, uint256 approveAmount, address outToken, uint256 minOut) o) returns (bytes)',
]);
export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);
const rateAbi = parseAbi(['function convertToAssets(uint256 shares) view returns (uint256)']);
const wmonAbi = parseAbi(['function withdraw(uint256)']);
export const aprAbi = parseAbi([
  'function getUserRequestDataCount(address user) view returns (uint256)',
  'function getUserRequestData(address user, uint256 startIndex, uint256 pageSize) view returns ((uint256 id, bool claimed, bool claimable, uint256 shares, uint256 assets, uint256 timestamp, uint64 unlockEpoch)[])',
  'function redeem(uint256[] requestIDs, address receiver)',
]);
const npmAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function transferFrom(address from, address to, uint256 tokenId)',
]);
const kuruAbi = parseAbi(['function getBalance(address user, address token) view returns (uint256)', 'function withdraw(uint256 amount, address token)']);
export const poolAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function assetsOf(address) view returns (uint256)',
  'function withdraw(uint256 shares) returns (uint256)',
]);
export const primeAbi = parseAbi([
  'function userShares(address, uint8) view returns (uint256)',
  'function assetsOf(address user, uint8 tranche) view returns (uint256)',
  'function withdraw(uint8 tranche, uint256 shares) returns (uint256)',
]);

// ---------- types ----------
export type TokenKind = 'wrapped' | 'stable' | 'lst' | 'erc20';
export type Priced = 'live' | 'par' | 'none';
export type TokenPos = { sym: string; name?: string; address: Address; decimals: number; amount: bigint; kind: TokenKind; monValue: bigint | null; priced: Priced; note: string; source: 'known' | 'transfer-logs' };
export type LpNft = { venue: 'Uniswap v3' | 'PancakeSwap v3'; manager: Address; tokenId: bigint };
export type PoolKind = 'clip' | 'spread' | 'prime';
export type PoolRef = { kind: PoolKind; address: Address };
export type PoolShare = { kind: PoolKind; pool: Address; tranche?: 0 | 1; shares: bigint; assets: bigint | null };
export type AprRequest = { id: bigint; claimed: boolean; claimable: boolean; shares: bigint; assets: bigint; timestamp: bigint; unlockEpoch: bigint };
export type KuruBal = { token: Address; sym: 'MON' | 'USDC'; amount: bigint };
export type Relation = 'owner' | 'agent' | 'browser-key' | 'showcase';
export type VaultPos = {
  vault: Address; factory: FactoryInfo; owner: Address; executor: Address; paused: boolean; unlimited: boolean; agentBal: bigint;
  relations: Relation[]; showcase: boolean;
  native: bigint; tokens: TokenPos[]; lpNfts: LpNft[]; pools: PoolShare[]; aprRequests: AprRequest[]; kuru: KuruBal[];
  discovery: 'ok' | 'unavailable' | 'skipped'; rules?: { wmonWithdraw: boolean; aprRedeem: boolean };
  navMon: bigint; unknown: number; errors: string[]; readAt: number;
};
export type WalletPos = { account: Address; aprMon: bigint; aprMonValue: bigint | null; aprRequests: AprRequest[]; pools: PoolShare[]; errors: string[]; /** sMON, gMON, WMON already in the wallet (as tokens). */ tokens?: TokenPos[] };
export type Rates = { aprMON: bigint | null; gMON: bigint | null; usdcPerMon: bigint | null; venue: string | null };

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address;
const mc3Abi = parseAbi(['function getEthBalance(address addr) view returns (uint256 balance)']);
/** Native balance as a Multicall3 read (a batching client folds it into the same eth_call); plain getBalance if that fails. */
export const ethBalance = (pub: PublicClient, a: Address) => pub.readContract({ address: MULTICALL3, abi: mc3Abi, functionName: 'getEthBalance', args: [a] }).catch(() => pub.getBalance({ address: a }));

// ---------- discovery ----------
export type FoundVault = { vault: Address; factory: FactoryInfo; relations: Relation[] };
type IdxCache = { get(k: string): Address | undefined; set(k: string, v: Address): void };

/** Every vault `account` owns (vaultsOf on each user factory) or is the agent of (allVaults scan, executor == account or a
 *  key held in this browser), plus the 13 team showcase vaults (read-only). allVaults(i) never changes, so `cache` keeps it. */
export async function findVaults(pub: PublicClient, o: { account: Address | null; agentAddrs?: Address[]; scanAgents: boolean; cache?: IdxCache; factories?: FactoryInfo[]; includeShowcase?: boolean; indexed?: Map<string, Address[]> }): Promise<FoundVault[]> {
  const facs = o.factories ?? FACTORIES;
  const map = new Map<string, FoundVault>();
  const add = (v: Address, f: FactoryInfo, r: Relation) => {
    const k = v.toLowerCase(); const x = map.get(k) ?? { vault: getAddress(v), factory: f, relations: [] };
    if (!x.relations.includes(r)) x.relations.push(r); map.set(k, x);
  };
  const me = o.account?.toLowerCase();
  const agents = new Map<string, Relation>();
  if (o.account) agents.set(o.account.toLowerCase(), 'agent');
  for (const a of o.agentAddrs ?? []) if (!agents.has(a.toLowerCase())) agents.set(a.toLowerCase(), 'browser-key');
  if (o.account) {
    await Promise.all(facs.filter(f => !f.showcase).map(async f => {
      const list = await pub.readContract({ address: f.address, abi: factoryAbi, functionName: 'vaultsOf', args: [o.account!] }).catch(() => [] as readonly Address[]);
      for (const v of list) add(v, f, 'owner');
    }));
  }
  const scanFacs = facs.filter(f => (o.scanAgents && agents.size) || (f.showcase && o.includeShowcase !== false));
  await Promise.all(scanFacs.map(async f => {
    const n = Number(await pub.readContract({ address: f.address, abi: factoryAbi, functionName: 'vaultCount' }).catch(() => 0n));
    // `indexed`: this factory's vaults from the activity index (creation order), so only vaults created after it cost a read.
    const known = o.indexed?.get(f.address.toLowerCase()) ?? [];
    const idx = [...Array(Math.max(0, Math.min(n, 500) - known.length)).keys()].map(k => k + known.length);
    const addrs = [...known, ...await Promise.all(idx.map(async i => {
      const k = `${f.address.toLowerCase()}:${i}`; const hit = o.cache?.get(k); if (hit) return hit;
      const a = await pub.readContract({ address: f.address, abi: factoryAbi, functionName: 'allVaults', args: [BigInt(i)] }).catch(() => null);
      if (a) o.cache?.set(k, a); return a;
    }))];
    for (const v of addrs) {
      if (!v) continue;
      if (f.showcase && o.includeShowcase !== false) add(v, f, 'showcase');
    }
    if (!(o.scanAgents && agents.size)) return;
    await Promise.all(addrs.map(async v => {
      if (!v) return;
      const ex = await pub.readContract({ address: v, abi: vaultAbi, functionName: 'executor' }).catch(() => null);
      const r = ex ? agents.get(ex.toLowerCase()) : undefined;
      if (r) add(v, f, r);
    }));
  }));
  const out = [...map.values()];
  // owner relation overrides the generic factory guess for duplicates; showcase factory stays showcase
  return out.sort((a, b) => Number(!!a.factory.showcase) - Number(!!b.factory.showcase) || FACTORIES.indexOf(a.factory) - FACTORIES.indexOf(b.factory) || (me ? Number(!a.relations.includes('owner')) - Number(!b.relations.includes('owner')) : 0));
}

/** The public Blockscout instance rate-limits bursts (HTTP 429, which the browser logs as an error), so every request from
 *  this app goes through one queue: one at a time, 250 ms apart, and nothing for a minute after a 429. */
let scoutChain: Promise<unknown> = Promise.resolve();
let scoutPauseUntil = 0;
export const scoutPaused = () => Date.now() < scoutPauseUntil;
export const scoutFetch = ((u: string, init?: RequestInit) => {
  const run = scoutChain.then(async () => {
    if (scoutPaused()) throw new Error('blockscout busy');
    const r = await fetch(u, init);
    if (r.status === 429) scoutPauseUntil = Date.now() + 60_000;
    await new Promise(res => setTimeout(res, 250));
    return r;
  });
  scoutChain = run.catch(() => undefined);
  return run;
}) as typeof fetch;

/** Token addresses seen in ERC-20 Transfer logs *to* this address, from the public Blockscout index (up to 3 pages). */
const tokenCache = new Map<string, { at: number; v: { ok: boolean; tokens: { address: Address; sym: string; name: string; decimals: number }[] } }>();
/** Last good Blockscout token list for this address (any age), or null. */
export const cachedTokens = (addr: Address) => tokenCache.get(addr.toLowerCase())?.v ?? null;
/** Cached (5 minutes) per address when the default throttled fetch is used. */
export async function discoverTokens(addr: Address, f?: typeof fetch): Promise<{ ok: boolean; tokens: { address: Address; sym: string; name: string; decimals: number }[] }> {
  if (f) return discoverTokensRaw(addr, f);
  const k = addr.toLowerCase(); const hit = tokenCache.get(k);
  if (hit && Date.now() - hit.at < 300_000) return hit.v;
  const v = await discoverTokensRaw(addr, scoutFetch);
  if (v.ok) tokenCache.set(k, { at: Date.now(), v });
  return v;
}
async function discoverTokensRaw(addr: Address, f: typeof fetch): Promise<{ ok: boolean; tokens: { address: Address; sym: string; name: string; decimals: number }[] }> {
  const seen = new Map<string, { address: Address; sym: string; name: string; decimals: number }>();
  let q = `${BLOCKSCOUT}/api/v2/addresses/${addr}/token-transfers?type=ERC-20&filter=to`;
  try {
    for (let page = 0; page < 3 && q; page++) {
      const r = await f(q, { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(`blockscout ${r.status}`);
      const j: any = await r.json();
      for (const it of j.items ?? []) {
        const t = it.token ?? {}; const a = t.address_hash ?? t.address;
        if (!a || !/^0x[0-9a-fA-F]{40}$/.test(a)) continue;
        const k = a.toLowerCase(); if (seen.has(k)) continue;
        const d = Number(t.decimals); seen.set(k, { address: getAddress(a), sym: String(t.symbol ?? '?').slice(0, 16), name: String(t.name ?? '').slice(0, 48), decimals: Number.isFinite(d) && d >= 0 && d <= 36 ? d : 18 });
      }
      const nx = j.next_page_params;
      q = nx ? `${BLOCKSCOUT}/api/v2/addresses/${addr}/token-transfers?type=ERC-20&filter=to&${new URLSearchParams(Object.entries(nx).map(([k, v]) => [k, String(v)])).toString()}` : '';
    }
    return { ok: true, tokens: [...seen.values()] };
  } catch { return { ok: false, tokens: [...seen.values()] }; }
}

// ---------- valuation ----------
export async function readRates(pub: PublicClient, price: { usdcPerMon: bigint; venue: string } | null): Promise<Rates> {
  const [apr, g] = await Promise.all([
    pub.readContract({ address: ADDR.aprMON, abi: rateAbi, functionName: 'convertToAssets', args: [ONE] }).catch(() => null),
    pub.readContract({ address: ADDR.gMON, abi: rateAbi, functionName: 'convertToAssets', args: [ONE] }).catch(() => null),
  ]);
  return { aprMON: apr && apr > 0n ? apr : null, gMON: g && g > 0n ? g : null, usdcPerMon: price && price.usdcPerMon > 0n ? price.usdcPerMon : null, venue: price?.venue || null };
}

export function valueToken(t: Omit<TokenPos, 'monValue' | 'priced' | 'note'>, r: Rates): TokenPos {
  const per = (x: bigint) => (Number(x) / 1e18).toLocaleString('en-GB', { maximumFractionDigits: 4 });
  if (t.address.toLowerCase() === ADDR.WMON.toLowerCase()) return { ...t, monValue: t.amount, priced: 'live', note: 'Wrapped MON, 1:1 with MON.' };
  if (t.address.toLowerCase() === ADDR.USDC.toLowerCase()) {
    if (!r.usdcPerMon) return { ...t, monValue: null, priced: 'none', note: 'Unknown value: no live MON/USDC quote right now, so it is left out of the MON total.' };
    return { ...t, monValue: (t.amount * ONE) / r.usdcPerMon, priced: 'live', note: `Valued at the live ${r.venue ?? 'venue'} MON/USDC quote.` };
  }
  if (t.address.toLowerCase() === ADDR.sMON.toLowerCase()) return { ...t, monValue: t.amount, priced: 'par', note: 'Kintsu sMON has no convertToAssets on its contract, so it is shown 1:1 with MON (par, not a live rate). It is withdrawn as sMON; unstaking in Kintsu has a delay.' };
  for (const [sym, addr, rate, who] of [['aprMON', ADDR.aprMON, r.aprMON, 'aPriori'], ['gMON', ADDR.gMON, r.gMON, 'Magma']] as const) {
    if (t.address.toLowerCase() !== addr.toLowerCase()) continue;
    if (!rate) return { ...t, monValue: null, priced: 'none', note: `Unknown value: ${who}'s convertToAssets was unreadable. Withdrawn as ${sym}.` };
    return { ...t, monValue: (t.amount * rate) / ONE, priced: 'live', note: `1 ${sym} = ${per(rate)} MON via convertToAssets. Withdrawn as ${sym}; unstaking in ${who} is queued, not instant.` };
  }
  return { ...t, monValue: null, priced: 'none', note: 'Unknown value: no price source in this app. Withdrawn as the token itself.' };
}

// ---------- reads ----------
const tryRead = async <T,>(p: Promise<T>, errs: string[], what: string): Promise<T | null> => { try { return await p; } catch (e: any) { errs.push(`${what}: ${String(e?.shortMessage ?? e?.message ?? e).split('\n')[0].slice(0, 120)}`); return null; } };

export async function readAprRequests(pub: PublicClient, who: Address): Promise<AprRequest[]> {
  const n = await pub.readContract({ address: ADDR.aprMON, abi: aprAbi, functionName: 'getUserRequestDataCount', args: [who] });
  if (n === 0n) return [];
  const rows = await pub.readContract({ address: ADDR.aprMON, abi: aprAbi, functionName: 'getUserRequestData', args: [who, 0n, n > 100n ? 100n : n] });
  return rows.map(x => ({ id: x.id, claimed: x.claimed, claimable: x.claimable, shares: x.shares, assets: x.assets, timestamp: x.timestamp, unlockEpoch: BigInt(x.unlockEpoch) })).filter(x => !x.claimed);
}

export async function readPoolShares(pub: PublicClient, who: Address, pools: PoolRef[]): Promise<PoolShare[]> {
  const out: PoolShare[] = [];
  await Promise.all(pools.map(async p => {
    if (p.kind === 'prime') {
      for (const tr of [0, 1] as const) {
        const sh = await pub.readContract({ address: p.address, abi: primeAbi, functionName: 'userShares', args: [who, tr] }).catch(() => 0n);
        if (sh > 0n) out.push({ kind: 'prime', pool: p.address, tranche: tr, shares: sh, assets: await pub.readContract({ address: p.address, abi: primeAbi, functionName: 'assetsOf', args: [who, tr] }).catch(() => null) });
      }
      return;
    }
    const sh = await pub.readContract({ address: p.address, abi: poolAbi, functionName: 'balanceOf', args: [who] }).catch(() => 0n);
    if (sh > 0n) out.push({ kind: p.kind, pool: p.address, shares: sh, assets: await pub.readContract({ address: p.address, abi: poolAbi, functionName: 'assetsOf', args: [who] }).catch(() => null) });
  }));
  return out;
}

export async function readVaultPositions(pub: PublicClient, fv: FoundVault, o: { rates: Rates; pools?: PoolRef[]; discover?: boolean; discovered?: { ok: boolean; tokens: { address: Address; sym: string; name: string; decimals: number }[] } | null; fetchImpl?: typeof fetch }): Promise<VaultPos> {
  const v = fv.vault; const errors: string[] = [];
  const rd = <T,>(fn: string, args: unknown[] = []) => pub.readContract({ address: v, abi: vaultAbi, functionName: fn as any, args: args as any }) as Promise<T>;
  const [owner, executor, paused, unl, native] = await Promise.all([rd<Address>('owner'), rd<Address>('executor'), rd<boolean>('paused'), rd<boolean>('unlimited').catch(() => false), ethBalance(pub, v)]);
  const agentBal = await ethBalance(pub, executor).catch(() => 0n);
  const unlimited = !!unl || fv.factory.unlimited;
  const disc = o.discovered !== undefined ? o.discovered : o.discover === false ? null : await discoverTokens(v, o.fetchImpl);
  const extra = (disc?.tokens ?? []).filter(t => !KNOWN.some(k => k.address.toLowerCase() === t.address.toLowerCase()));
  const tokList = [...KNOWN.map(k => ({ ...k, name: undefined as string | undefined, source: 'known' as const })), ...extra.map(t => ({ sym: t.sym, name: t.name, address: t.address, decimals: t.decimals, kind: 'erc20' as TokenKind, source: 'transfer-logs' as const }))];
  const [bals, npm, apr, kuru, pools, rules] = await Promise.all([
    Promise.all(tokList.map(t => pub.readContract({ address: t.address, abi: erc20Abi, functionName: 'balanceOf', args: [v] }).catch(() => { errors.push(`${t.sym} balance unreadable`); return 0n; }))),
    Promise.all(([['Uniswap v3', ADDR.uniNpm], ['PancakeSwap v3', ADDR.pcsNpm]] as const).map(async ([venue, m]) => {
      const n = await tryRead(pub.readContract({ address: m, abi: npmAbi, functionName: 'balanceOf', args: [v] }), errors, `${venue} LP`) ?? 0n;
      const ids = await Promise.all([...Array(Number(n > 20n ? 20n : n)).keys()].map(i => pub.readContract({ address: m, abi: npmAbi, functionName: 'tokenOfOwnerByIndex', args: [v, BigInt(i)] }).catch(() => null)));
      return ids.filter((x): x is bigint => x != null).map(tokenId => ({ venue, manager: m, tokenId }) as LpNft);
    })),
    tryRead(readAprRequests(pub, v), errors, 'aPriori requests'),
    Promise.all(([[ZERO, 'MON'], [ADDR.USDC, 'USDC']] as const).map(async ([token, sym]) => ({ token, sym, amount: await pub.readContract({ address: ADDR.kuruMargin, abi: kuruAbi, functionName: 'getBalance', args: [v, token] }).catch(() => 0n) }) as KuruBal)),
    readPoolShares(pub, v, o.pools ?? []),
    unlimited ? Promise.resolve(undefined) : Promise.all([
      rd<readonly [boolean, number]>('callRule', [ADDR.WMON, '0x2e1a7d4d']).then(r => !!r[0]).catch(() => false),
      rd<readonly [boolean, number]>('callRule', [ADDR.aprMON, '0x492e47d2']).then(r => !!r[0]).catch(() => false),
    ]).then(([wmonWithdraw, aprRedeem]) => ({ wmonWithdraw, aprRedeem })),
  ]);
  const tokens = tokList.map((t, i) => valueToken({ sym: t.sym, name: t.name, address: t.address, decimals: t.decimals, amount: bals[i], kind: t.kind, source: t.source }, o.rates)).filter(t => t.amount > 0n);
  const p: VaultPos = {
    vault: v, factory: fv.factory, owner: getAddress(owner), executor: getAddress(executor), paused, unlimited, agentBal, relations: fv.relations, showcase: !!fv.factory.showcase,
    native, tokens, lpNfts: npm.flat(), pools, aprRequests: apr ?? [], kuru: kuru.filter(k => k.amount > 0n),
    discovery: disc == null ? 'skipped' : disc.ok ? 'ok' : 'unavailable', rules, navMon: 0n, unknown: 0, errors, readAt: Date.now(),
  };
  const t = totals([p], o.rates); p.navMon = t.navMon; p.unknown = t.unknown;
  return p;
}

export async function readWalletPositions(pub: PublicClient, account: Address, o: { rates: Rates; pools?: PoolRef[] }): Promise<WalletPos> {
  const errors: string[] = [];
  const lsts = KNOWN.filter(k => k.sym === 'sMON' || k.sym === 'gMON' || k.sym === 'WMON');
  const [aprMon, reqs, pools, bals] = await Promise.all([
    pub.readContract({ address: ADDR.aprMON, abi: erc20Abi, functionName: 'balanceOf', args: [account] }).catch(() => { errors.push('aprMON balance unreadable'); return 0n; }),
    tryRead(readAprRequests(pub, account), errors, 'aPriori requests'),
    readPoolShares(pub, account, o.pools ?? []),
    Promise.all(lsts.map(k => pub.readContract({ address: k.address, abi: erc20Abi, functionName: 'balanceOf', args: [account] }).catch(() => 0n))),
  ]);
  const tokens = lsts.map((k, i) => valueToken({ sym: k.sym, address: k.address, decimals: k.decimals, amount: bals[i], kind: k.kind, source: 'known' }, o.rates)).filter(t => t.amount > 0n);
  return { account, aprMon, aprMonValue: o.rates.aprMON ? (aprMon * o.rates.aprMON) / ONE : null, aprRequests: reqs ?? [], pools, errors, tokens };
}

/** MON total of everything with a live value (pending aPriori requests count at their recorded MON assets). */
export function totals(vs: VaultPos[], r: Rates, w?: WalletPos | null): { navMon: bigint; usdc: bigint | null; unknown: number; par: number } {
  let nav = 0n; let unknown = 0; let par = 0;
  for (const p of vs) {
    nav += p.native;
    for (const t of p.tokens) { if (t.monValue == null) unknown++; else nav += t.monValue; if (t.priced === 'par') par++; }
    for (const s of p.pools) { if (s.assets == null) unknown++; else nav += s.assets; }
    for (const q of p.aprRequests) nav += q.assets;
    for (const k of p.kuru) { if (k.sym === 'MON') nav += k.amount; else if (r.usdcPerMon) nav += (k.amount * ONE) / r.usdcPerMon; else unknown++; }
    unknown += p.lpNfts.length;
  }
  if (w) {
    if (w.aprMon > 0n) { if (w.aprMonValue == null) unknown++; else nav += w.aprMonValue; }
    for (const q of w.aprRequests) nav += q.assets;
    for (const s of w.pools) { if (s.assets == null) unknown++; else nav += s.assets; }
    for (const t of w.tokens ?? []) { if (t.monValue == null) unknown++; else nav += t.monValue; if (t.priced === 'par') par++; }
  }
  return { navMon: nav, usdc: r.usdcPerMon ? (nav * r.usdcPerMon) / ONE : null, unknown, par };
}

// ---------- close plan ----------
export type Signer = 'owner' | 'agent-key' | 'agent-wallet' | 'wallet';
export type Step = {
  id: string; vault: Address | null; signer: Signer; label: string; to: Address; data: Hex;
  /** What this step moves, for the confirm modal. */
  moves: { what: string; to: Address | 'vault' }[];
};
export type Manual = { vault: Address | null; what: string; why: string };
export type Plan = { steps: Step[]; manual: Manual[]; notes: string[]; walletSigs: number; disabled: { vault: Address; why: string }[] };
export type AgentAccess = 'key' | 'wallet' | null;

/** Rough gas an agent-key executeCall needs (about 250k gas at ~120 gwei). Below this the owner path is used. */
export const AGENT_GAS_PER_STEP = 30_000_000_000_000_000n;
const NONE = { approveToken: ZERO, approveAmount: 0n, outToken: ZERO, minOut: 0n };
const rid = (t: string) => keccak256(toHex(`${t}:${Date.now()}:${Math.random()}`));
const xcall = (v: Address, tag: string, target: Address, data: Hex, out: Partial<typeof NONE> = {}) => encodeFunctionData({ abi: vaultAbi, functionName: 'executeCall', args: [rid(tag), target, 0n, data, { ...NONE, ...out }] });
const fmt18 = (x: bigint, d = 6) => (Number(x) / 1e18).toLocaleString('en-GB', { maximumFractionDigits: d });
export const fmtUnits = (x: bigint, dec: number, d = 6) => (Number(x) / 10 ** dec).toLocaleString('en-GB', { maximumFractionDigits: d });

/** Why the connected wallet cannot close this vault, or null when it can. */
export function closeBlocker(p: VaultPos, account: Address | null): string | null {
  if (p.showcase) return 'Read-only: a team showcase vault, operated by the team.';
  if (!account) return 'Connect the owner wallet to close this vault.';
  if (p.owner.toLowerCase() !== account.toLowerCase()) return `Only the owner ${p.owner.slice(0, 6)}…${p.owner.slice(-4)} can withdraw. You are ${p.relations.includes('agent') ? 'its agent' : p.relations.includes('browser-key') ? 'holding its agent key in this browser' : 'not the owner'}; agents can never withdraw to themselves.`;
  return null;
}

function hasAnything(p: VaultPos) {
  return p.native > 0n || p.tokens.length > 0 || p.lpNfts.length > 0 || p.pools.length > 0 || p.aprRequests.length > 0 || p.kuru.length > 0;
}

/**
 * The fewest-signature plan that empties each vault into its owner wallet.
 * Per vault: (unpause, only if agent steps are needed on a paused vault) → agent steps (claim aPriori, exit pools,
 * withdraw Kuru margin, unwrap WMON, and on unlimited vaults with the agent key in this browser also hand every
 * token/LP NFT straight to the owner, which needs no wallet signature) → owner withdrawToken for whatever is left →
 * owner emergencyWithdrawAll (pauses the agent and sends all native MON to the owner).
 * Then wallet-level: claim claimable aPriori requests and exit Prime/Spread/Clip pool shares held by the wallet.
 */
export function buildClosePlan(o: { account: Address; vaults: VaultPos[]; wallet?: WalletPos | null; access: (p: VaultPos) => AgentAccess; unwrap: boolean }): Plan {
  const steps: Step[] = []; const manual: Manual[] = []; const notes: string[] = []; const disabled: Plan['disabled'] = [];
  const me = getAddress(o.account);
  let walletUnwrap = 0n;
  const planVault = (p: VaultPos, acc: AgentAccess) => {
    const manual: Manual[] = []; let walletUnwrap = 0n;
    const agentSigner: Signer | null = acc === 'key' ? 'agent-key' : acc === 'wallet' ? 'agent-wallet' : null;
    const agent: Step[] = []; const owner: Step[] = [];
    const sv = p.vault;
    const wmon = p.tokens.find(t => t.address.toLowerCase() === ADDR.WMON.toLowerCase());
    const claimable = p.aprRequests.filter(q => q.claimable);
    const locked = p.aprRequests.filter(q => !q.claimable);
    for (const q of locked) manual.push({ vault: sv, what: `aPriori request #${q.id} (${fmt18(q.assets, 4)} MON)`, why: 'Not unlocked yet. aPriori releases queued withdrawals after a few staking epochs; claim it then (run Close again).' });
    const canAgent = (rule?: boolean) => !!agentSigner && (p.unlimited || !!rule);
    // aPriori claims (controller is the vault, so only the vault's agent can claim)
    if (claimable.length) {
      if (canAgent(p.rules?.aprRedeem)) agent.push({ id: `${sv}:apr`, vault: sv, signer: agentSigner!, label: `Agent claims ${claimable.length} aPriori withdrawal(s) into the vault`, to: sv, data: xcall(sv, 'apr', ADDR.aprMON, encodeFunctionData({ abi: aprAbi, functionName: 'redeem', args: [claimable.map(q => q.id), sv] })), moves: [{ what: `${fmt18(claimable.reduce((a, q) => a + q.assets, 0n), 4)} MON (before aPriori's withdrawal fee)`, to: 'vault' }] });
      else manual.push({ vault: sv, what: `${claimable.length} claimable aPriori withdrawal(s)`, why: agentSigner ? 'This older vault does not allow aPriori redeem calls.' : 'The vault requested them, so only its agent can claim. The agent key is not in this browser and is not this wallet.' });
    }
    for (const s of p.pools) {
      const data = s.kind === 'prime' ? encodeFunctionData({ abi: primeAbi, functionName: 'withdraw', args: [s.tranche ?? 0, s.shares] }) : encodeFunctionData({ abi: poolAbi, functionName: 'withdraw', args: [s.shares] });
      if (canAgent(false)) agent.push({ id: `${sv}:pool:${s.pool}:${s.tranche ?? ''}`, vault: sv, signer: agentSigner!, label: `Agent exits ${s.kind} pool shares`, to: sv, data: xcall(sv, 'pool', s.pool, data), moves: [{ what: s.assets != null ? `${fmt18(s.assets, 4)} MON` : 'pool MON (unknown amount)', to: 'vault' }] });
      else manual.push({ vault: sv, what: `${s.kind} pool shares held by the vault`, why: agentSigner ? 'Older vaults only let the agent call allowlisted services.' : 'Only the vault (through its agent) can exit these shares; the agent key is not here.' });
    }
    for (const k of p.kuru) {
      if (canAgent(false)) agent.push({ id: `${sv}:kuru:${k.sym}`, vault: sv, signer: agentSigner!, label: `Agent withdraws ${k.sym} from Kuru margin account`, to: sv, data: xcall(sv, 'kuru', ADDR.kuruMargin, encodeFunctionData({ abi: kuruAbi, functionName: 'withdraw', args: [k.amount, k.token] })), moves: [{ what: `${fmtUnits(k.amount, k.sym === 'USDC' ? 6 : 18)} ${k.sym}`, to: 'vault' }] });
      else manual.push({ vault: sv, what: `Kuru margin ${k.sym}`, why: 'Only the vault (through its agent) can withdraw from Kuru.' });
    }
    // Kuru USDC lands in the vault as USDC: make sure it is withdrawn too
    const kuruUsdc = p.kuru.find(k => k.sym === 'USDC' && canAgent(false))?.amount ?? 0n;
    let unwrapInVault = false;
    if (o.unwrap && wmon && wmon.amount > 0n && canAgent(p.rules?.wmonWithdraw)) {
      unwrapInVault = true;
      agent.push({ id: `${sv}:unwrap`, vault: sv, signer: agentSigner!, label: `Agent unwraps ${fmt18(wmon.amount)} WMON → MON inside the vault`, to: sv, data: xcall(sv, 'unwrap', ADDR.WMON, encodeFunctionData({ abi: wmonAbi, functionName: 'withdraw', args: [wmon.amount] }), { outToken: ZERO, minOut: wmon.amount }), moves: [{ what: `${fmt18(wmon.amount)} WMON → MON`, to: 'vault' }] });
    }
    const keyDirect = agentSigner === 'agent-key' && p.unlimited; // agent hands tokens to the owner with no wallet signature
    for (const t of p.tokens) {
      if (unwrapInVault && t === wmon) continue;
      let amt = t.amount; if (t.address.toLowerCase() === ADDR.USDC.toLowerCase()) amt += kuruUsdc;
      const label = `${fmtUnits(amt, t.decimals)} ${t.sym}`;
      const lst = t.kind === 'lst' ? ' (as tokens: unstaking has a delay, so this is not instant MON)' : '';
      if (keyDirect) agent.push({ id: `${sv}:tok:${t.address}`, vault: sv, signer: 'agent-key', label: `Agent sends ${label} to the owner${lst}`, to: sv, data: xcall(sv, 'tok', t.address, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [p.owner, amt] })), moves: [{ what: label + lst, to: p.owner }] });
      else owner.push({ id: `${sv}:tok:${t.address}`, vault: sv, signer: 'owner', label: `Withdraw ${label} to the owner${lst}`, to: sv, data: encodeFunctionData({ abi: vaultAbi, functionName: 'withdrawToken', args: [t.address, p.owner, amt] }), moves: [{ what: label + lst, to: p.owner }] });
      if (t === wmon && o.unwrap) walletUnwrap += amt;
    }
    if (kuruUsdc > 0n && !p.tokens.some(t => t.address.toLowerCase() === ADDR.USDC.toLowerCase())) {
      const label = `${fmtUnits(kuruUsdc, 6)} USDC`;
      if (keyDirect) agent.push({ id: `${sv}:tok:${ADDR.USDC}`, vault: sv, signer: 'agent-key', label: `Agent sends ${label} to the owner`, to: sv, data: xcall(sv, 'tok', ADDR.USDC, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [p.owner, kuruUsdc] })), moves: [{ what: label, to: p.owner }] });
      else owner.push({ id: `${sv}:tok:${ADDR.USDC}`, vault: sv, signer: 'owner', label: `Withdraw ${label} to the owner`, to: sv, data: encodeFunctionData({ abi: vaultAbi, functionName: 'withdrawToken', args: [ADDR.USDC, p.owner, kuruUsdc] }), moves: [{ what: label, to: p.owner }] });
    }
    for (const n of p.lpNfts) {
      if (canAgent(false) && p.unlimited) agent.push({ id: `${sv}:nft:${n.manager}:${n.tokenId}`, vault: sv, signer: agentSigner!, label: `Agent sends ${n.venue} LP NFT #${n.tokenId} to the owner (not unwound)`, to: sv, data: xcall(sv, 'nft', n.manager, encodeFunctionData({ abi: npmAbi, functionName: 'transferFrom', args: [sv, p.owner, n.tokenId] })), moves: [{ what: `${n.venue} LP NFT #${n.tokenId} (unknown value; remove liquidity in ${n.venue})`, to: p.owner }] });
      else manual.push({ vault: sv, what: `${n.venue} LP NFT #${n.tokenId}`, why: 'withdrawToken only moves ERC-20s; an LP NFT needs the agent of an unlimited vault to transfer it.' });
    }
    const needsAgent = agent.length > 0;
    const pre: Step[] = [];
    if (needsAgent && p.paused) pre.push({ id: `${sv}:unpause`, vault: sv, signer: 'owner', label: 'Unpause so the agent steps can run (Close pauses it again at the end)', to: sv, data: encodeFunctionData({ abi: vaultAbi, functionName: 'setPaused', args: [false] }), moves: [] });
    const nativeNote = `all native MON in the vault (now ${fmt18(p.native, 6)} MON${needsAgent ? ', plus whatever the steps above bring in' : ''})`;
    if (!p.paused || p.native > 0n || needsAgent) owner.push({ id: `${sv}:emergency`, vault: sv, signer: 'owner', label: 'emergencyWithdrawAll: pause the agent and send all MON to the owner', to: sv, data: encodeFunctionData({ abi: vaultAbi, functionName: 'emergencyWithdrawAll' }), moves: [{ what: nativeNote, to: p.owner }] });
    return { steps: [...pre, ...agent, ...owner], agentSteps: agent.filter(x => x.signer === 'agent-key').length, manual, walletUnwrap };
  };
  for (const p of o.vaults) {
    const why = closeBlocker(p, me);
    if (why) { if (!p.showcase) disabled.push({ vault: p.vault, why }); continue; }
    if (!hasAnything(p)) continue; // nothing to move: an empty vault is left as it is
    let r = planVault(p, o.access(p));
    if (r.agentSteps > 0 && p.agentBal < AGENT_GAS_PER_STEP * BigInt(r.agentSteps)) {
      notes.push(`Vault ${p.vault.slice(0, 6)}…${p.vault.slice(-4)}: its agent key is in this browser but holds only ${fmt18(p.agentBal, 4)} MON, too little gas for ${r.agentSteps} agent step(s), so the owner wallet does the work instead.`);
      r = planVault(p, p.executor.toLowerCase() === me.toLowerCase() ? 'wallet' : null);
    }
    steps.push(...r.steps); manual.push(...r.manual); walletUnwrap += r.walletUnwrap;
  }
  if (o.wallet) {
    const w = o.wallet;
    const claimable = w.aprRequests.filter(q => q.claimable);
    if (claimable.length) steps.push({ id: 'wallet:apr', vault: null, signer: 'wallet', label: `Claim ${claimable.length} unlocked MonaDefi (aPriori) withdrawal(s)`, to: ADDR.aprMON, data: encodeFunctionData({ abi: aprAbi, functionName: 'redeem', args: [claimable.map(q => q.id), me] }), moves: [{ what: `${fmt18(claimable.reduce((a, q) => a + q.assets, 0n), 4)} MON (before aPriori's withdrawal fee)`, to: me }] });
    for (const q of w.aprRequests.filter(x => !x.claimable)) manual.push({ vault: null, what: `MonaDefi aPriori request #${q.id} (${fmt18(q.assets, 4)} MON)`, why: 'Queued, not unlocked yet. Claim it when aPriori releases it.' });
    if (w.aprMon > 0n) notes.push(`Your wallet already holds ${fmt18(w.aprMon, 4)} aprMON (MonaDefi position). It stays as aprMON: turning it into MON is a queued aPriori withdrawal (Home → Withdraw), not instant.`);
    for (const s of w.pools) steps.push({ id: `wallet:pool:${s.pool}:${s.tranche ?? ''}`, vault: null, signer: 'wallet', label: `Exit ${s.kind} pool${s.kind === 'prime' ? (s.tranche === 0 ? ' (senior)' : ' (junior)') : ''}`, to: s.pool, data: s.kind === 'prime' ? encodeFunctionData({ abi: primeAbi, functionName: 'withdraw', args: [s.tranche ?? 0, s.shares] }) : encodeFunctionData({ abi: poolAbi, functionName: 'withdraw', args: [s.shares] }), moves: [{ what: s.assets != null ? `${fmt18(s.assets, 4)} MON` : 'pool MON', to: me }] });
  }
  if (walletUnwrap > 0n) steps.push({ id: 'wallet:unwrap', vault: null, signer: 'wallet', label: `Unwrap ${fmt18(walletUnwrap)} WMON → MON in your wallet`, to: ADDR.WMON, data: encodeFunctionData({ abi: wmonAbi, functionName: 'withdraw', args: [walletUnwrap] }), moves: [{ what: `${fmt18(walletUnwrap)} WMON → MON`, to: me }] });
  const walletSigs = steps.filter(s => s.signer !== 'agent-key').length;
  return { steps, manual, notes, walletSigs, disabled };
}

// ---------- runner ----------
export type StepState = { id: string; status: 'todo' | 'sending' | 'done' | 'failed'; hash?: Hex; error?: string };
export type Runner = {
  /** Send one transaction for this signer and resolve after a successful receipt. */
  send(step: Step): Promise<Hex>;
  /** Optional atomic batch (EIP-5792) for consecutive wallet-signed steps. Returns one hash per call or throws. */
  sendBatch?(steps: Step[]): Promise<Hex[]>;
};

/** Runs the plan in order. Consecutive wallet-signed steps go out as one EIP-5792 batch when the runner offers it;
 *  otherwise one by one. Stops at the first failure so the caller can re-read and resume (done steps are skipped
 *  by id, and a fresh plan only contains what is still there). */
export async function runPlan(plan: Plan, r: Runner, onUpdate: (s: StepState[]) => void, done: Set<string> = new Set()): Promise<StepState[]> {
  const st: StepState[] = plan.steps.map(s => ({ id: s.id, status: done.has(s.id) ? 'done' : 'todo' }));
  const upd = () => onUpdate(st.map(x => ({ ...x })));
  upd();
  for (let i = 0; i < plan.steps.length; i++) {
    if (st[i].status === 'done') continue;
    const s = plan.steps[i];
    if (r.sendBatch && s.signer !== 'agent-key') {
      let j = i; while (j < plan.steps.length && plan.steps[j].signer !== 'agent-key' && st[j].status !== 'done') j++;
      if (j - i > 1) {
        for (let k = i; k < j; k++) st[k].status = 'sending'; upd();
        try {
          const hs = await r.sendBatch(plan.steps.slice(i, j));
          for (let k = i; k < j; k++) { st[k].status = 'done'; st[k].hash = hs[k - i] ?? hs[hs.length - 1]; }
          upd(); i = j - 1; continue;
        } catch (e: any) {
          if (!e?.batchUnsupported) { for (let k = i; k < j; k++) { st[k].status = k === i ? 'failed' : 'todo'; } st[i].error = errText(e); upd(); return st; }
          for (let k = i; k < j; k++) st[k].status = 'todo'; upd(); // fall back to one by one
        }
      }
    }
    st[i].status = 'sending'; upd();
    try { st[i].hash = await r.send(s); st[i].status = 'done'; upd(); }
    catch (e: any) { st[i].status = 'failed'; st[i].error = errText(e); if (e?.hash) st[i].hash = e.hash; upd(); return st; }
  }
  return st;
}
export const errText = (e: any) => (e?.simulated ? 'Not sent: the simulation reverted (' : '') + String(e?.shortMessage ?? e?.details ?? e?.message ?? e).split('\n')[0].slice(0, 200) + (e?.simulated ? '). No gas was spent.' : '');

/** True when nothing closable is left in these vaults (native 0, no ERC-20s, no pool shares, no claimable requests). */
export function isEmpty(p: VaultPos): boolean {
  return p.native === 0n && p.tokens.length === 0 && p.pools.length === 0 && p.kuru.length === 0 && p.lpNfts.length === 0 && !p.aprRequests.some(q => q.claimable);
}

// ================= My money discovery (pools, wallet holdings) =================
/** Same as desk.ts (kept inline so this file only depends on positionsCore and viem, for node tests). */
export const DESK_FACTORY: Partial<Record<number, Address>> = { 143: '0x223482EC33Eee63de621B3A3Fa56e1Fc96Cd420B' };
const deskFactoryAbi = parseAbi(['function vaultsOf(address creator) view returns (address[])']);
const aprMonAbi = parseAbi(['function requestRedeem(uint256 shares, address controller, address owner) returns (uint256 requestId)']);
const probeAbi = parseAbi([
  'function UNI_THIN_POOL() view returns (address)',
  'function minProfitBps() view returns (uint256)',
  'function seniorTranche() view returns (address)',
]);

export type KV = { get(k: string): string | null; set(k: string, v: string): void };
type Scan = { top: number; cands: string[]; kinds: Record<string, PoolKind | 'none'> };
/** Addresses that are never pools: factories, tokens, aprMON. */
const NOT_POOLS = new Set([...FACTORIES.map(f => f.address), ...Object.values(ADDR), DESK_FACTORY[143] ?? ''].map(a => a.toLowerCase()));

/** Contracts this wallet created (successful creations only) and contracts it called, newest first, newer than `stopAt`. */
export async function txTargets(account: Address, stopAt: number, f: typeof fetch = scoutFetch, maxPages = 20): Promise<{ ok: boolean; top: number; addrs: string[] }> {
  const out = new Set<string>(); let top = stopAt; let q = `${BLOCKSCOUT}/api/v2/addresses/${account}/transactions?filter=from`;
  try {
    for (let page = 0; page < maxPages && q; page++) {
      const r = await f(q, { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(`blockscout ${r.status}`);
      const j: any = await r.json(); let older = false;
      for (const t of j.items ?? []) {
        const b = Number(t.block_number ?? t.block ?? 0);
        if (b && b <= stopAt) { older = true; break; }
        if (b > top) top = b;
        if (t.status !== 'ok') continue;
        const c = t.created_contract?.hash; if (c) out.add(String(c).toLowerCase());
        const to = t.to?.hash; if (to && t.to?.is_contract !== false) out.add(String(to).toLowerCase());
      }
      const nx = j.next_page_params;
      q = !older && nx ? `${BLOCKSCOUT}/api/v2/addresses/${account}/transactions?filter=from&${new URLSearchParams(Object.entries(nx).map(([k, v]) => [k, String(v)])).toString()}` : '';
    }
    return { ok: true, top, addrs: [...out] };
  } catch { return { ok: false, top: stopAt, addrs: [...out] }; }
}

/** Pool kind from an immutable view (Clip: UNI_THIN_POOL, Spread: minProfitBps, Prime: seniorTranche), or 'none'. */
export async function classify(pub: PublicClient, addrs: string[]): Promise<Record<string, PoolKind | 'none'>> {
  const out: Record<string, PoolKind | 'none'> = {};
  await Promise.all(addrs.map(async a => {
    const at = getAddress(a);
    const ok = (fn: 'UNI_THIN_POOL' | 'minProfitBps' | 'seniorTranche') => pub.readContract({ address: at, abi: probeAbi, functionName: fn }).then(() => true, () => false);
    const [c, s, p] = await Promise.all([ok('UNI_THIN_POOL'), ok('minProfitBps'), ok('seniorTranche')]);
    out[a] = c ? 'clip' : s ? 'spread' : p ? 'prime' : 'none';
  }));
  return out;
}

/**
 * Every Prime/Clip/Spread pool linked to `account`: desk factory vaultsOf, plus contracts it created or called (Blockscout,
 * incremental: only transactions newer than the last scan are fetched). Kinds never change, so they are cached in `kv`.
 * `ok` is false when the Blockscout index could not be read (desk pools are still returned).
 */
export async function findPools(pub: PublicClient, account: Address, o: { netId: number; kv?: KV; fetchImpl?: typeof fetch; extra?: PoolRef[] }): Promise<{ pools: PoolRef[]; ok: boolean }> {
  const key = `pp.scan.${o.netId}.${account.toLowerCase()}`;
  let scan: Scan = { top: 0, cands: [], kinds: {} };
  try { const raw = o.kv?.get(key); if (raw) scan = { ...scan, ...JSON.parse(raw) }; } catch { /* fresh scan */ }
  const desk = DESK_FACTORY[o.netId];
  const [deskList, tx] = await Promise.all([
    desk ? pub.readContract({ address: desk, abi: deskFactoryAbi, functionName: 'vaultsOf', args: [account] }).catch(() => [] as readonly Address[]) : Promise.resolve([] as readonly Address[]),
    o.netId === 143 ? txTargets(account, scan.top, o.fetchImpl) : Promise.resolve({ ok: true, top: scan.top, addrs: [] as string[] }),
  ]);
  const cands = new Set(scan.cands);
  for (const a of [...deskList.map(x => x.toLowerCase()), ...tx.addrs, ...(o.extra ?? []).map(p => p.address.toLowerCase())]) if (!NOT_POOLS.has(a)) cands.add(a);
  const unknown = [...cands].filter(a => !scan.kinds[a]);
  if (unknown.length) Object.assign(scan.kinds, await classify(pub, unknown));
  const deskKinds = new Set(deskList.map(x => x.toLowerCase()));
  // Desk-created contracts are always pools even if a probe failed transiently: keep them as candidates, re-probe next time.
  for (const a of deskKinds) if (scan.kinds[a] === 'none') delete scan.kinds[a];
  scan = { top: tx.ok ? tx.top : scan.top, cands: [...cands], kinds: scan.kinds };
  try { o.kv?.set(key, JSON.stringify(scan)); } catch { /* full */ }
  const pools = Object.entries(scan.kinds).filter((e): e is [string, PoolKind] => e[1] !== 'none').map(([a, kind]) => ({ kind, address: getAddress(a) }));
  for (const p of o.extra ?? []) if (!pools.some(x => x.address.toLowerCase() === p.address.toLowerCase())) pools.push(p);
  return { pools, ok: tx.ok };
}

// ---------- what My money shows and withdraws ----------
export type Discovered = { vaults: VaultPos[]; wallet: WalletPos | null; poolsOk: boolean };
const lc = (a: string) => a.toLowerCase();
const part = (x: bigint, pct: number) => (pct >= 100 ? x : (x * BigInt(Math.round(pct))) / 100n);
const f18 = (x: bigint) => fmtUnits(x, 18, 4);

/** Totals for My money: vaults this wallet OWNS (agent-only vaults belong to someone else) plus the wallet's own holdings. */
export function summarize(d: Discovered, account: Address, r: Rates) {
  const owned = d.vaults.filter(v => lc(v.owner) === lc(account) && !v.showcase);
  const agentOnly = d.vaults.filter(v => lc(v.owner) !== lc(account) && !v.showcase);
  const full = (v: VaultPos) => v.native > 0n || v.tokens.length > 0 || v.pools.length > 0 || v.aprRequests.length > 0 || v.kuru.length > 0 || v.lpNfts.length > 0;
  const w = d.wallet;
  const walletItems = w ? (w.aprMon > 0n ? 1 : 0) + w.aprRequests.length + w.pools.length + (w.tokens?.length ?? 0) : 0;
  const t = totals(owned, r, w);
  return { owned, nonEmpty: owned.filter(full), empty: owned.filter(v => !full(v)), agentOnly, walletItems, total: t.navMon, unknown: t.unknown, nothing: !owned.length && !agentOnly.length && walletItems === 0 };
}

/** Withdraw pct% of one vault the wallet owns. 100% reuses the close plan (everything, fewest signatures); a part moves
 *  that share of its MON and ERC-20s with owner calls (pool shares, Kuru and aPriori requests inside it move at 100%). */
export function vaultWithdrawSteps(v: VaultPos, account: Address, pct: number, access: AgentAccess): { steps: Step[]; note: string } {
  if (pct >= 100) {
    const plan = buildClosePlan({ account, vaults: [v], wallet: null, access: () => access, unwrap: true });
    const m = plan.manual.map(x => `${x.what}: ${x.why}`).join(' ');
    return { steps: plan.steps, note: `Everything comes back to your wallet${v.tokens.some(t => t.kind === 'lst') ? '; staked tokens come back as tokens (unstaking has a delay)' : ''}.${m ? ` Not covered: ${m}` : ''}${plan.disabled[0] ? ` ${plan.disabled[0].why}` : ''}` };
  }
  const me = getAddress(account); const steps: Step[] = [];
  if (lc(v.owner) !== lc(account)) return { steps, note: `Only the owner ${v.owner.slice(0, 6)}…${v.owner.slice(-4)} can withdraw from this vault.` };
  const nat = part(v.native, pct);
  if (nat > 0n) steps.push({ id: `${v.vault}:mon:${pct}`, vault: v.vault, signer: 'owner', label: `Withdraw ${f18(nat)} MON`, to: v.vault, data: encodeFunctionData({ abi: vaultAbi, functionName: 'withdraw', args: [me, nat] }), moves: [{ what: `${f18(nat)} MON`, to: me }] });
  for (const t of v.tokens) {
    const a = part(t.amount, pct); if (a <= 0n) continue;
    steps.push({ id: `${v.vault}:tok:${t.address}:${pct}`, vault: v.vault, signer: 'owner', label: `Withdraw ${fmtUnits(a, t.decimals)} ${t.sym}${t.kind === 'lst' ? ' (as tokens)' : ''}`, to: v.vault, data: encodeFunctionData({ abi: vaultAbi, functionName: 'withdrawToken', args: [t.address, me, a] }), moves: [{ what: `${fmtUnits(a, t.decimals)} ${t.sym}`, to: me }] });
  }
  const inside = v.pools.length + v.kuru.length + v.aprRequests.length + v.lpNfts.length;
  return { steps, note: `${pct}% of the vault's MON${v.tokens.length ? ' and tokens' : ''} comes back to your wallet, ${steps.length} signature(s).${inside ? ' Pool shares, Kuru margin and aPriori requests inside the vault move only at 100%.' : ''}` };
}

/** Withdraw pct% of a pool position held by the wallet (one signature, comes back as MON). */
export function poolWithdrawStep(s: PoolShare, account: Address, pct: number): Step {
  const sh = part(s.shares, pct);
  return { id: `wallet:pool:${s.pool}:${s.tranche ?? ''}:${pct}`, vault: null, signer: 'wallet', label: `Withdraw ${pct}% from the ${s.kind} pool`, to: s.pool,
    data: s.kind === 'prime' ? encodeFunctionData({ abi: primeAbi, functionName: 'withdraw', args: [s.tranche ?? 0, sh] }) : encodeFunctionData({ abi: poolAbi, functionName: 'withdraw', args: [sh] }),
    moves: [{ what: s.assets != null ? `${f18(part(s.assets, pct))} MON` : 'pool MON', to: getAddress(account) }] };
}

/** aprMON in the wallet: claim whatever aPriori has unlocked, then queue pct% of the aprMON (about 12–18 hours). */
export function aprWithdrawSteps(w: WalletPos, account: Address, pct: number): { steps: Step[]; note: string } {
  const me = getAddress(account); const steps: Step[] = [];
  const claimable = w.aprRequests.filter(q => q.claimable);
  if (claimable.length) steps.push({ id: 'wallet:apr:claim', vault: null, signer: 'wallet', label: `Claim ${claimable.length} unlocked aPriori withdrawal(s)`, to: ADDR.aprMON, data: encodeFunctionData({ abi: aprAbi, functionName: 'redeem', args: [claimable.map(q => q.id), me] }), moves: [{ what: `${f18(claimable.reduce((a, q) => a + q.assets, 0n))} MON`, to: me }] });
  const sh = part(w.aprMon, pct);
  if (sh > 0n) steps.push({ id: `wallet:apr:req:${pct}`, vault: null, signer: 'wallet', label: `Request ${pct}% of your aprMON back from aPriori`, to: ADDR.aprMON, data: encodeFunctionData({ abi: aprMonAbi, functionName: 'requestRedeem', args: [sh, me, me] }), moves: [{ what: `${f18(sh)} aprMON → MON, queued`, to: me }] });
  return { steps, note: `${claimable.length ? 'Unlocked withdrawals come back as MON now. ' : ''}The request is queued at aPriori and comes back as MON after about 12–18 hours (press Claim then).` };
}
