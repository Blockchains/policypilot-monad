'use client';
/**
 * Momentum: browser-side reads. Public data comes from the GitHub job's files (raw.githubusercontent.com, Pages as the
 * fallback; no RPC). Chain reads go through the app's rate-limited client. Positions are rebuilt from the vault's own
 * on-chain events (the public ledger plus a live tail of the newest blocks), never from this browser alone.
 */
import { createPublicClient, decodeEventLog, decodeFunctionResult, encodeFunctionData, getAddress, http, keccak256, parseAbi, toHex, type Address, type Hex, type PublicClient } from 'viem';
import { limitedTransport } from './rpcLimit';
import { gateOf, type Net } from './vault';
import {
  ASSETS, MON_USDC_POOL, PCS, V4_FACTORY, WMON, buildPositions, completed, factoryAbi, monPerAsset, quoteData, quoteOut, refDev, slot0Abi, usdPerAsset, usdPerMon, vaultCallAbi,
  EXITS_V1, RULES_V1, type Asset, type Candle, type EntryQuote, type ExitParams, type LedgerEv, type Position,
} from './momentumCore';
import { KEEPER } from './momentumKeeper';

const RAW = 'https://raw.githubusercontent.com/Blockchains/policypilot-monad/main/web/public/momentum/143/';
const base = () => `${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/momentum/143/`;
const cache = new Map<string, { t: number; v: Promise<any> }>();
/** JSON from the job: raw GitHub first (fresh within minutes), then the deployed copy. Cached for 60 s. */
export function loadJson<T = any>(name: string, ttl = 60_000): Promise<T | null> {
  const hit = cache.get(name); if (hit && Date.now() - hit.t < ttl) return hit.v;
  const v = (async () => {
    for (const u of [RAW + name, base() + name]) {
      try { const r = await fetch(u, { cache: 'no-store' }); if (r.ok) return await r.json(); } catch { /* next */ }
    }
    return null;
  })();
  cache.set(name, { t: Date.now(), v }); return v;
}
export async function loadCandles(id: string, months = 2): Promise<Candle[]> {
  const idx = await loadJson<any>('candles/index.json'); const ms: string[] = idx?.series?.[id]?.months ?? [];
  const parts = await Promise.all(ms.slice(-months).map(m => loadJson<Candle[]>(`candles/${id}/${m}.json`)));
  return parts.flatMap(x => x ?? []);
}

// ---------------------------------------------------------------- settings (the user's own limits; kept per vault)
export type Settings = {
  allocationMon: number; assets: string[]; mode: 'review'; riskPerTradePct: number; maxPerPositionMon: number; maxTotalExposureMon: number; maxPositions: number;
  exits: ExitParams; pausedNew: boolean; ruleVersion: string;
};
export const defaultSettings = (allocationMon: number): Settings => ({
  allocationMon, assets: ['WETH'], mode: 'review', riskPerTradePct: 1, maxPerPositionMon: Math.max(0.3, +(allocationMon * 0.5).toFixed(2)), maxTotalExposureMon: Math.max(0.3, +(allocationMon * 0.8).toFixed(2)), maxPositions: 2,
  exits: { ...EXITS_V1 }, pausedNew: false, ruleVersion: RULES_V1.version,
});
const sk = (net: number, vault: string) => `pp.momentum.${net}.${vault.toLowerCase()}.settings`;
export function loadSettings(net: number, vault: string): Settings | null { try { const s = localStorage.getItem(sk(net, vault)); return s ? JSON.parse(s) : null; } catch { return null; } }
export function saveSettings(net: number, vault: string, s: Settings) { try { localStorage.setItem(sk(net, vault), JSON.stringify(s)); } catch { /* private mode */ } }
const vk = (net: number, acct: string) => `pp.momentum.${net}.${acct.toLowerCase()}.vault`;
export const rememberVault = (net: number, acct: string, vault: string, block: number) => { try { localStorage.setItem(vk(net, acct), JSON.stringify({ vault, block })); } catch { /* */ } };
export const rememberedVault = (net: number, acct: string): { vault: string; block: number } | null => { try { const s = localStorage.getItem(vk(net, acct)); return s ? JSON.parse(s) : null; } catch { return null; } };

// ---------------------------------------------------------------- vault discovery + state
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
export type MVault = { address: Address; mon: bigint; tokens: Record<string, bigint>; paused: boolean; momentum: boolean };
/** The user's Momentum vault candidates: v4 vaults they own whose executor is their own wallet or the Momentum keeper. */
export async function findVaults(pub: PublicClient, account: Address): Promise<Address[]> {
  const vs = await pub.readContract({ address: V4_FACTORY, abi: factoryAbi, functionName: 'vaultsOf', args: [account] }) as readonly Address[];
  const ex = await Promise.all(vs.map(v => pub.readContract({ address: v, abi: vaultCallAbi, functionName: 'executor' }).catch(() => null)));
  // executor = the owner's own wallet (Review each entry) or the Momentum keeper (the owner opted in to Automatic)
  return vs.filter((_, i) => { const e = (ex[i] as string | null)?.toLowerCase(); return e === account.toLowerCase() || e === KEEPER.toLowerCase(); });
}
export async function readVaultState(pub: PublicClient, v: Address): Promise<MVault> {
  const [mon, paused, ...bals] = await Promise.all([
    pub.getBalance({ address: v }), pub.readContract({ address: v, abi: vaultCallAbi, functionName: 'paused' }),
    ...ASSETS.map(a => pub.readContract({ address: a.address, abi: erc20, functionName: 'balanceOf', args: [v] })),
    pub.readContract({ address: WMON, abi: erc20, functionName: 'balanceOf', args: [v] }),
  ]);
  const tokens: Record<string, bigint> = {}; ASSETS.forEach((a, i) => { tokens[a.address.toLowerCase()] = bals[i] as bigint; }); tokens.wmon = bals[ASSETS.length] as bigint;
  return { address: v, mon: mon as bigint, tokens, paused: paused as boolean, momentum: true };
}

// ---------------------------------------------------------------- ledger: public index + live tail of the newest blocks
const LOG_RPC = 'https://rpc2.monad.xyz'; // 10,000-block getLogs range
let logClient: PublicClient | null = null;
const logPub = (net: Net) => (logClient ??= createPublicClient({ transport: limitedTransport(http(LOG_RPC, { batch: false, retryCount: 1, timeout: 15_000 }), gateOf(net)) }) as PublicClient);
const TOPICS = ['DappCalled(bytes32,address,bytes4,uint256,address,uint256,uint256)', 'Deposited(address,uint256,uint256)', 'Withdrawn(address,uint256,uint256)', 'TokenWithdrawn(address,address,uint256)'].map(s => keccak256(toHex(s)));
export type LedgerSrc = { events: LedgerEv[]; indexedTo: number; tailTo: number; fromIndex: number; fromTail: number };
export async function readLedger(net: Net, pub: PublicClient, vault: Address, createdHint?: number): Promise<LedgerSrc> {
  const idx = await loadJson<any>('ledger.json', 30_000);
  const row = idx?.vaults?.[vault.toLowerCase()];
  const evs: LedgerEv[] = (row?.events ?? []).map((e: any) => e.kind === 'call' ? { ...e, valueWei: BigInt(e.valueWei), received: BigInt(e.received) } : e.kind === 'tokenWithdraw' ? { ...e, qty: BigInt(e.qty) } : e);
  const fromIndex = evs.length;
  const tip = Number(await pub.getBlockNumber());
  let from = row ? Math.max((idx.lastBlock ?? 0) + 1, row.createdBlock) : (createdHint ?? tip - 20_000);
  if (tip - from > 50_000) from = tip - 50_000; // live tail stays inside the RPC budget (≤ 5 requests); older events come from the index
  const lp = logPub(net); let tail = 0;
  for (let a = from; a <= tip; a += 10_000) {
    const b = Math.min(tip, a + 9_999);
    const ls = await lp.request({ method: 'eth_getLogs', params: [{ address: vault, fromBlock: toHex(a), toBlock: toHex(b), topics: [TOPICS] }] } as any) as any[];
    for (const l of ls) {
      if (evs.some(e => e.tx === l.transactionHash && (e as any).li === l.logIndex)) continue;
      const ev = decodeEventLog({ abi: vaultCallAbi, data: l.data, topics: l.topics }) as any;
      const [tx, rc] = await Promise.all([pub.getTransaction({ hash: l.transactionHash }), pub.getTransactionReceipt({ hash: l.transactionHash })]);
      const gasMon = (Number(tx.gas) * Number(rc.effectiveGasPrice)) / 1e18; // Monad charges the gas limit
      const t = l.blockTimestamp ? parseInt(l.blockTimestamp, 16) : Math.floor(Date.now() / 1000);
      const b0 = { block: parseInt(l.blockNumber, 16), t, tx: l.transactionHash as Hex, li: l.logIndex, gasMon };
      const x = ev.args;
      if (ev.eventName === 'DappCalled') evs.push({ kind: 'call', ...b0, rid: x.requestId, valueWei: x.value, outAsset: x.outToken, received: x.received } as any);
      else if (ev.eventName === 'Deposited') evs.push({ kind: 'deposit', ...b0, mon: Number(x.amount) / 1e18 } as any);
      else if (ev.eventName === 'Withdrawn') evs.push({ kind: 'withdraw', ...b0, mon: Number(x.amount) / 1e18 } as any);
      else evs.push({ kind: 'tokenWithdraw', ...b0, token: x.token, qty: x.amount } as any);
      tail++;
    }
  }
  return { events: evs, indexedTo: idx?.lastBlock ?? 0, tailTo: tip, fromIndex, fromTail: tail };
}
export const positionsOf = (l: LedgerSrc, s: MVault) => buildPositions(l.events, s.tokens);

// ---------------------------------------------------------------- quotes
async function q(pub: PublicClient, i: Address, o: Address, amt: bigint, fee: number) { try { const r = await pub.call({ to: PCS.quoter, data: quoteData(i, o, amt, fee) }); return quoteOut(r.data); } catch { return 0n; } }
async function s0(pub: PublicClient, pool: Address) { try { return await pub.readContract({ address: pool, abi: slot0Abi, functionName: 'slot0' }) as readonly [bigint, ...unknown[]]; } catch { return null; } }
export const GAS_UNITS = { entry: 360_000n, exit: 370_000n };
export async function gasPrice(pub: PublicClient) { try { return await pub.getGasPrice(); } catch { return 102_000_000_000n; } }
/** Fresh quote for this exact size: buy, then the sell of exactly what the buy returns (the exit route), pool mid, USDC reference. */
export async function quoteEntry(pub: PublicClient, a: Asset, amountIn: bigint): Promise<EntryQuote & { usdPerMon: number | null }> {
  const [out, pool, ref, mu, gp] = await Promise.all([q(pub, WMON, a.address, amountIn, a.fee), s0(pub, a.pool), a.refPool ? s0(pub, a.refPool) : Promise.resolve(null), s0(pub, MON_USDC_POOL), gasPrice(pub)]);
  const back = out > 0n ? await q(pub, a.address, WMON, out, a.fee) : 0n;
  const mid = pool ? monPerAsset(pool[0], a.token0IsMon, a.decimals) : NaN;
  const usdMon = mu ? usdPerMon(mu[0]) : null; const usdA = ref ? usdPerAsset(ref[0], a) : null;
  return { at: Math.floor(Date.now() / 1000), amountIn, out, back, midMonPerAsset: mid, refMonPerAsset: usdA && usdMon ? refDev(mid, usdA, usdMon).ref : null, gasRoundTripMon: Number((GAS_UNITS.entry + GAS_UNITS.exit) * gp) / 1e18, usdPerMon: usdMon };
}
export async function quoteSell(pub: PublicClient, a: Asset, qty: bigint) { return qty > 0n ? q(pub, a.address, WMON, qty, a.fee) : 0n; }
export async function monUsd(pub: PublicClient) { const mu = await s0(pub, MON_USDC_POOL); return mu ? usdPerMon(mu[0]) : null; }
export const tokenBalance = (pub: PublicClient, token: Address, who: Address) => pub.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [who] }) as Promise<bigint>;
export const createVaultData = (executor: Address) => encodeFunctionData({ abi: factoryAbi, functionName: 'createVault', args: [executor] });
export const wmonUnwrapCall = (vault: Address, rid: Hex, amt: bigint) => ({ to: vault, data: encodeFunctionData({ abi: vaultCallAbi, functionName: 'executeCall', args: [rid, WMON, 0n, encodeFunctionData({ abi: parseAbi(['function withdraw(uint256)']), functionName: 'withdraw', args: [amt] }), { approveToken: '0x0000000000000000000000000000000000000000', approveAmount: 0n, outToken: '0x0000000000000000000000000000000000000000', minOut: 0n }] }) });
export const vaultTx = {
  withdraw: (vault: Address, to: Address, amt: bigint) => ({ to: vault, data: encodeFunctionData({ abi: vaultCallAbi, functionName: 'withdraw', args: [to, amt] }) }),
  withdrawToken: (vault: Address, token: Address, to: Address, amt: bigint) => ({ to: vault, data: encodeFunctionData({ abi: vaultCallAbi, functionName: 'withdrawToken', args: [token, to, amt] }) }),
  deposit: (vault: Address, amt: bigint) => ({ to: vault, data: encodeFunctionData({ abi: vaultCallAbi, functionName: 'deposit' }), value: amt }),
  setPaused: (vault: Address, p: boolean) => ({ to: vault, data: encodeFunctionData({ abi: vaultCallAbi, functionName: 'setPaused', args: [p] }) }),
};
export { completed, getAddress, decodeFunctionResult };
export type { Position };
