'use client';
import { decodeErrorResult, decodeFunctionResult, encodeDeployData, encodeFunctionData, parseAbi, parseEther, toHex, type Abi, type Address, type Hex } from 'viem';
import artifact from './spreadArtifact.json';
import { KURU, QUOTERS, SERVICES, TOKENS } from './services';

export const spreadAbi = artifact.abi as Abi;
export const SPREAD_BYTECODE = artifact.bytecode as Hex;
/** Deployed runtime from this compile. Immutable words are zero here and filled in at construction. */
export const SPREAD_RUNTIME = (artifact.runtime as string).toLowerCase();
const SPREAD_IMMUTABLES = artifact.immutables as unknown as readonly (readonly [number, number])[];

/** Zero the constructor-filled immutable words so two deployments of this compile compare equal. */
export function maskSpreadRuntime(code: string): string {
  const hex = code.toLowerCase();
  if (!hex.startsWith('0x')) return hex;
  const chars = hex.split('');
  for (const [start, length] of SPREAD_IMMUTABLES) {
    const from = 2 + start * 2;
    const to = from + length * 2;
    for (let i = from; i < to && i < chars.length; i++) chars[i] = '0';
  }
  return chars.join('');
}

/** True only for a pool deployed from the current spread artifact. */
export function isCurrentSpreadCode(code: string | null | undefined): boolean {
  if (!code || code === '0x') return false;
  const live = code.toLowerCase();
  return live.length === SPREAD_RUNTIME.length && maskSpreadRuntime(live) === maskSpreadRuntime(SPREAD_RUNTIME);
}

/** New pools accept any increase in MON, and a shortfall of at most this many basis points. A positive floor is still allowed, up to 500 bps. */
export const MIN_PROFIT_BPS = 0;
/** Matches PolicyPilotClipVault and PolicyPilotSpreadVault LOSS_BPS. Half a percent of the MON sold. */
export const LOSS_BPS = 50;
export const KEEPER_BPS = 1_000;
export const PROTOCOL_BPS = 1_000;
export const SPREAD_CAP = parseEther('10');
export const MAX_TRADE_BPS = 10_000;
/** 500,000 gas at the 100 gwei minimum base fee. A revert still costs the gas limit. */
export const ROUGH_GAS_WEI = 500_000n * 100_000_000_000n;

export type VenueId = 'uniswap' | 'pancake' | 'uniswap-thin';

const quoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
]);

export const VENUES: Record<VenueId, { name: string; router: Address; quoter: Address; fee: number; index: 0 | 1 | 2 }> = {
  uniswap: { name: 'Uniswap 0.30%', router: SERVICES.find(s => s.id === 'uniswap')!.address!, quoter: QUOTERS.uniswap.address, fee: QUOTERS.uniswap.fee, index: 0 },
  pancake: { name: 'PancakeSwap 0.05%', router: SERVICES.find(s => s.id === 'pancake')!.address!, quoter: QUOTERS.pancake.address, fee: QUOTERS.pancake.fee, index: 1 },
  'uniswap-thin': { name: 'Uniswap 0.05%', router: SERVICES.find(s => s.id === 'uniswap')!.address!, quoter: QUOTERS.uniswap.address, fee: 500, index: 2 },
};

export const SETTLEMENT_VENUES: VenueId[] = ['uniswap', 'pancake', 'uniswap-thin'];

/** Sizes checked up to the 10 MON pool cap. The largest size whose shortfall stays inside half a percent is used. */
export const PROFIT_SIZES = ['0.05', '0.1', '0.2', '0.3', '0.4', '0.5', '0.6', '0.7', '0.8', '0.9', '1', '1.5', '2', '3', '5', '8', '10'] as const;

export const venueIndex = (id: VenueId): 0 | 1 | 2 => VENUES[id].index;

export function floorProfit(amount: bigint): bigint {
  return (amount * BigInt(MIN_PROFIT_BPS)) / 10_000n;
}

export function lossAllowance(amount: bigint): bigint {
  return (amount * BigInt(LOSS_BPS)) / 10_000n;
}

export function splitProfit(profit: bigint): { bounty: bigint; fee: bigint; pool: bigint } {
  const bounty = (profit * BigInt(KEEPER_BPS)) / 10_000n;
  const fee = (profit * BigInt(PROTOCOL_BPS)) / 10_000n;
  return { bounty, fee, pool: profit - bounty - fee };
}

/** `ok` is a quote inside the loss band that meets the pool floor. A flat quote and a shortfall of at most half a percent are ok when the floor is zero. Rough gas is reported beside it and does not veto the quote. */
export function clearsFloor(amount: bigint, wmonBack: bigint): { profit: bigint; short: bigint; allowance: bigint; floor: bigint; bounty: bigint; fee: bigint; pool: bigint; ok: boolean; coversGas: boolean } {
  const profit = wmonBack > amount ? wmonBack - amount : 0n;
  const short = amount > wmonBack ? amount - wmonBack : 0n;
  const floor = floorProfit(amount);
  const allowance = floor === 0n ? lossAllowance(amount) : 0n;
  const split = splitProfit(profit);
  const ok = wmonBack > 0n && short <= allowance && profit >= floor;
  return { profit, short, allowance, floor, ...split, ok, coversGas: ok && profit > ROUGH_GAS_WEI };
}

export function chooseSell(uniUsdc: bigint, cakeUsdc: bigint): { sell: VenueId; buy: VenueId; usdc: bigint } | null {
  if (uniUsdc <= 0n && cakeUsdc <= 0n) return null;
  if (uniUsdc >= cakeUsdc && uniUsdc > 0n) return { sell: 'uniswap', buy: 'pancake', usdc: uniUsdc };
  if (cakeUsdc > 0n) return { sell: 'pancake', buy: 'uniswap', usdc: cakeUsdc };
  return null;
}

export function minOuts(amount: bigint, usdc: bigint, wmonBack: bigint): { minUsdc: bigint; minWmon: bigint } {
  const need = amount + floorProfit(amount);
  const allowance = floorProfit(amount) === 0n ? lossAllowance(amount) : 0n;
  const lossFloor = need > allowance ? need - allowance : 1n;
  const slipped = (wmonBack * 99n) / 100n;
  let minWmon = slipped > lossFloor ? slipped : lossFloor;
  if (wmonBack >= lossFloor && minWmon > wmonBack) minWmon = wmonBack;
  return { minUsdc: (usdc * 99n) / 100n > 0n ? (usdc * 99n) / 100n : 1n, minWmon };
}

export type SpreadGate = { ok: boolean; code: string; label: string; detail: string };

export function spreadGate(o: {
  mainnet: boolean; account: boolean; vault: boolean; amount: string; pool: bigint;
  walletBal: bigint | null; quoting: boolean; quoteOk: boolean | null; coversGas?: boolean; smallLoss?: boolean;
}): SpreadGate {
  let wei: bigint;
  try { wei = parseEther(o.amount || '0'); } catch {
    return { ok: false, code: 'amount', label: 'ENTER AN AMOUNT', detail: 'Use a MON amount such as 0.05.' };
  }
  if (wei <= 0n) return { ok: false, code: 'amount', label: 'ENTER AN AMOUNT', detail: 'The amount needs to be more than 0 MON.' };
  if (!o.mainnet) return { ok: false, code: 'net', label: 'MAINNET ONLY', detail: 'These quotes are Uniswap v3, PancakeSwap v3, and Kuru on Monad mainnet.' };
  if (!o.vault && wei > SPREAD_CAP) return { ok: false, code: 'cap', label: 'EXCEEDS CAP', detail: 'A new spread pool holds at most 10 MON.' };
  if (o.vault && wei > o.pool) return { ok: false, code: 'bal', label: 'LARGER THAN THE POOL', detail: 'A round trip cannot sell more MON than the pool holds.' };
  if (!o.account) return { ok: false, code: 'connect', label: 'CONNECT WALLET', detail: 'One wallet connection opens the pool or submits a round trip.' };
  if (!o.vault) {
    if (o.walletBal != null && wei > o.walletBal) return { ok: false, code: 'wallet', label: 'NOT ENOUGH MON', detail: 'Your wallet does not hold this deposit.' };
    return { ok: true, code: 'open', label: 'READY TO OPEN', detail: 'Two signatures: one opens your pool, one deposits this MON. Each is simulated before you sign. There is no promised rate.' };
  }
  if (o.quoting || o.quoteOk == null) return { ok: false, code: 'quote', label: 'QUOTING', detail: 'Asking Uniswap, PancakeSwap, and Kuru for this size.' };
  if (!o.quoteOk) return { ok: false, code: 'flat', label: 'LOSS TOO LARGE', detail: 'Every quoted round trip is more than 0.50% under the MON sold. Nothing is sent.' };
  if (o.smallLoss) return { ok: true, code: 'loss', label: 'SMALL LOSS', detail: 'This size is flat or inside a 0.50% shortfall. The round trip still sends. You pay the gas.' };
  if (!o.coversGas) return { ok: true, code: 'go', label: 'QUOTED GAIN', detail: 'The pool gains MON on this quote. Rough gas can be larger than that gain, and you pay it.' };
  return { ok: true, code: 'go', label: 'SPREAD COVERS GAS', detail: 'Submit the largest size that stays inside a 0.50% shortfall.' };
}

export type QuoteCall = { to: Address; data: Hex; value?: Hex; from?: Address };
export type CallRow = { ok: true; result: Hex } | { ok: false; error: string };
export type StateOverride = Record<string, { balance: Hex }>;

/** eth_call sender used only for the Kuru simulation. Its balance is overridden for that call. */
const KURU_FROM: Address = '0x0000000000000000000000000000000000000001';
const kuruAbi = parseAbi([
  'function anyToAnySwap(address[] markets,bool[] isBuy,bool[] nativeSend,address debitToken,address creditToken,uint256 amount,uint256 minAmountOut) payable returns (uint256)',
]);

export function quoteCall(venue: VenueId, tokenIn: Address, tokenOut: Address, amountIn: bigint): QuoteCall {
  const v = VENUES[venue];
  return {
    to: v.quoter,
    data: encodeFunctionData({
      abi: quoterAbi,
      functionName: 'quoteExactInputSingle',
      args: [{ tokenIn, tokenOut, amountIn, fee: v.fee, sqrtPriceLimitX96: 0n }],
    }),
  };
}

export function forwardQuotes(amount: bigint): QuoteCall[] {
  const wmon = TOKENS.WMON.address;
  const usdc = TOKENS.USDC.address;
  return SETTLEMENT_VENUES.map(id => quoteCall(id, wmon, usdc, amount));
}

export function backQuote(venue: VenueId, usdcAmount: bigint): QuoteCall {
  return quoteCall(venue, TOKENS.USDC.address, TOKENS.WMON.address, usdcAmount);
}

export type BackLeg = { sell: VenueId; buy: VenueId; usdc: bigint; call: QuoteCall };

/** Every ordered pair of settlement venues. Kuru is not a leg. */
export function roundTripBacks(legs: { id: VenueId; usdc: bigint }[], allow: VenueId[] = SETTLEMENT_VENUES): BackLeg[] {
  const allowed = new Set(allow);
  const rows: BackLeg[] = [];
  for (const sell of legs) {
    if (!allowed.has(sell.id) || sell.usdc <= 0n) continue;
    for (const buy of legs) {
      if (buy.id === sell.id || !allowed.has(buy.id)) continue;
      rows.push({ sell: sell.id, buy: buy.id, usdc: sell.usdc, call: backQuote(buy.id, sell.usdc) });
    }
  }
  return rows;
}

/** Settlement venues in `SETTLEMENT_VENUES` order, then Kuru. Kuru is a price only. */
export function meshQuotes(amount: bigint): { calls: QuoteCall[]; stateOverride: StateOverride } {
  const kuru = encodeFunctionData({
    abi: kuruAbi,
    functionName: 'anyToAnySwap',
    args: [[KURU.monUsdc], [false], [true], '0x0000000000000000000000000000000000000000', TOKENS.USDC.address, amount, 1n],
  });
  return {
    calls: [
      ...forwardQuotes(amount),
      { to: KURU.router, from: KURU_FROM, value: toHex(amount), data: kuru },
    ],
    stateOverride: { [KURU_FROM]: { balance: toHex(parseEther('1') + amount) } },
  };
}

export function decodeQuote(data: Hex): bigint {
  const out = decodeFunctionResult({ abi: quoterAbi, functionName: 'quoteExactInputSingle', data });
  return out[0];
}

export function decodeKuru(data: Hex): bigint {
  return decodeFunctionResult({ abi: kuruAbi, functionName: 'anyToAnySwap', data });
}

export function workerUrl(): string {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
  return `${base}/spread-worker.js`;
}

export async function fetchCalls(rpc: string, calls: QuoteCall[], stateOverride?: StateOverride): Promise<CallRow[]> {
  return Promise.all(calls.map(async (c): Promise<CallRow> => {
    const tx: { to: Address; data: Hex; value?: Hex; from?: Address } = { to: c.to, data: c.data };
    if (c.from) tx.from = c.from;
    if (c.value) tx.value = c.value;
    try {
      const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: stateOverride ? [tx, 'latest', stateOverride] : [tx, 'latest'] }),
      });
      const json = await res.json() as { result?: Hex; error?: { message?: string } };
      if (!json.result) return { ok: false, error: json.error?.message || 'Quote failed' };
      return { ok: true, result: json.result };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Quote failed' };
    }
  }));
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let rpcCursor = 0;

/** One eth_call, walking the public endpoints so a 429 on one host does not drop the size. */
async function ethCallRotating(rpcs: readonly string[], call: QuoteCall): Promise<Hex | null> {
  const start = rpcCursor % rpcs.length;
  rpcCursor += 1;
  const tx = { to: call.to, data: call.data };
  for (let n = 0; n < rpcs.length; n++) {
    const rpc = rpcs[(start + n) % rpcs.length];
    try {
      const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [tx, 'latest'] }),
      });
      if (res.status === 429 || res.status >= 500) { await pause(200); continue; }
      const json = await res.json() as { result?: Hex };
      if (json.result && json.result !== '0x') return json.result;
    } catch { /* the next endpoint */ }
    await pause(80);
  }
  return null;
}

async function profitAt(rpcs: readonly string[], amount: bigint): Promise<{ quoted: boolean; best: { amount: bigint; profit: bigint; sell: VenueId; buy: VenueId } | null }> {
  const wmon = TOKENS.WMON.address;
  const usdc = TOKENS.USDC.address;
  const forwards: { id: VenueId; usdc: bigint }[] = [];
  for (const id of SETTLEMENT_VENUES) {
    const data = await ethCallRotating(rpcs, quoteCall(id, wmon, usdc, amount));
    let out = 0n;
    if (data) { try { out = decodeQuote(data); } catch { out = 0n; } }
    forwards.push({ id, usdc: out });
  }
  if (forwards.filter(row => row.usdc > 0n).length < 2) return { quoted: false, best: null };
  const backs = roundTripBacks(forwards);
  let best: { amount: bigint; profit: bigint; sell: VenueId; buy: VenueId } | null = null;
  let bestBack = 0n;
  let sawBack = false;
  for (const leg of backs) {
    const data = await ethCallRotating(rpcs, leg.call);
    if (!data) continue;
    let back = 0n;
    try { back = decodeQuote(data); } catch { continue; }
    sawBack = true;
    const cleared = clearsFloor(amount, back);
    if (cleared.ok && (!best || back > bestBack)) { bestBack = back; best = { amount, profit: cleared.profit, sell: leg.sell, buy: leg.buy }; }
  }
  return { quoted: sawBack, best };
}

/** The largest size at or below `maxIn` whose shortfall stays inside half a percent. Each leg uses the next public endpoint. A deeper loss is skipped. An unread size is tried once more. */
export async function bestProfitSize(rpc: string | readonly string[], maxIn: bigint): Promise<{ amount: bigint; profit: bigint; sell: VenueId; buy: VenueId } | null> {
  const rpcs = (Array.isArray(rpc) ? rpc : [rpc]).filter(Boolean);
  if (!rpcs.length) return null;
  let best: { amount: bigint; profit: bigint; sell: VenueId; buy: VenueId } | null = null;
  for (const size of PROFIT_SIZES) {
    const amount = parseEther(size);
    if (amount <= 0n || amount > maxIn) continue;
    let row = await profitAt(rpcs, amount).catch(() => ({ quoted: false, best: null }));
    if (!row.quoted) {
      await pause(300);
      row = await profitAt(rpcs, amount).catch(() => ({ quoted: false, best: null }));
    }
    if (row.best && (!best || row.best.amount >= best.amount)) best = row.best;
    await pause(60);
  }
  return best;
}

/** `floorBps` > 0 makes the contract revert any round trip that gains less (0 to 500). */
export function spreadDeployData(treasury: Address, floorBps: number = MIN_PROFIT_BPS): Hex {
  return encodeDeployData({ abi: spreadAbi, bytecode: SPREAD_BYTECODE, args: [treasury, SPREAD_CAP, BigInt(floorBps), MAX_TRADE_BPS] });
}

export function spreadCaptureData(sell: VenueId, buy: VenueId, amount: bigint, minUsdc: bigint, minWmon: bigint): Hex {
  return encodeFunctionData({ abi: spreadAbi, functionName: 'capture', args: [venueIndex(sell), venueIndex(buy), amount, minUsdc, minWmon] });
}

export function spreadDepositData(): Hex {
  return encodeFunctionData({ abi: spreadAbi, functionName: 'deposit' });
}

export function spreadWithdrawData(shares: bigint): Hex {
  return encodeFunctionData({ abi: spreadAbi, functionName: 'withdraw', args: [shares] });
}

const SPREAD_PLAIN: Record<string, string> = {
  Floor: 'That round trip is outside the pool’s floor. A zero floor still allows a 0.50% shortfall.',
  Unprofitable: 'The shortfall was more than the pool allows, so the whole round trip reverted.',
  SameVenue: 'The two legs have to be different pools.',
  TradeTooLarge: 'That size is larger than this pool allows.',
  VaultCapExceeded: 'That deposit would pass this pool’s cap.',
  InsufficientShares: 'Those shares are not in this wallet.',
  WrongNetwork: 'This pool only deploys on Monad mainnet.',
  ZeroAmount: 'The amount needs to be more than 0.',
  TransferFailed: 'The MON transfer failed.',
  ApproveFailed: 'The token approval failed.',
};

export function explainSpread(e: unknown, fallback: string): string {
  let x: unknown = e;
  while (x && typeof x === 'object') {
    const rec = x as { data?: unknown; cause?: unknown };
    const inner = rec.data && typeof rec.data === 'object' ? (rec.data as { data?: unknown }).data : rec.data;
    const data = typeof inner === 'string' ? inner : typeof rec.data === 'string' ? rec.data : undefined;
    if (data && data.startsWith('0x') && data.length >= 10) {
      try { return SPREAD_PLAIN[decodeErrorResult({ abi: spreadAbi, data: data as Hex }).errorName] ?? fallback; } catch { /* next */ }
    }
    x = rec.cause;
  }
  return fallback;
}
