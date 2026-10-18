'use client';
import { Gate, limitedTransport } from './rpcLimit';
import { createPublicClient, decodeErrorResult, fallback, decodeFunctionData, encodeFunctionData, formatEther, formatUnits, http, keccak256, parseAbi, toHex, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import ABI from './vault-abi.json';
import { KURU, LIVE, QUOTERS, SERVICES, TOKENS, type Service, type TokenSym } from './services';

export const factoryAbi = ABI.factory as Abi; export const vaultAbi = ABI.vault as Abi;
/** v4 UnlimitedAgentVaultFactory: createVault(executor) with no caps, no budget, no allowlists. */
export const unlimitedFactoryAbi = ABI.unlimitedFactory as Abi;
const errAbi = [...(ABI.vault as any[]), ...(ABI.factory as any[])].filter((x, i, a) => x.type === 'error' && a.findIndex(y => y.type === 'error' && y.name === x.name) === i) as Abi;
export const ZERO = '0x0000000000000000000000000000000000000000' as Address;

export type Net = { id: 143 | 10143; key: 'mainnet' | 'testnet'; name: string; hex: Hex; rpc: string; exp: string; factory: Address; unlimited?: boolean; legacy?: Address[]; faucet?: string; publicRpc: string; rpcs?: string[] };
export const NETS: Record<'mainnet' | 'testnet', Net> = {
  mainnet: { id: 143, key: 'mainnet', name: 'Mainnet', hex: '0x8f', rpc: 'https://rpc.monad.xyz', publicRpc: 'https://rpc.monad.xyz', exp: 'https://monadvision.com', factory: '0x41d6667aA35c3634D19068A39481d4c955f6557D', unlimited: true, legacy: ['0x52727226aF0efe2bfe3E5c97e46B704613344a92', '0x0342d29055d77ba155c50233f550539E3029BA6a', '0x8738B74778502ff3623A8319837A819d8dBdEeB7'], rpcs: ['https://rpc.monad.xyz', 'https://rpc1.monad.xyz', 'https://rpc3.monad.xyz', 'https://rpc-mainnet.monadinfra.com', 'https://rpc2.monad.xyz'] },
  testnet: { id: 10143, key: 'testnet', name: 'Testnet', hex: '0x279f', rpc: 'https://testnet-rpc.monad.xyz', publicRpc: 'https://testnet-rpc.monad.xyz', exp: 'https://testnet.monadexplorer.com', factory: '0x09DE725CE72B30aF0d13AB1288D2E0c634681780', unlimited: true, legacy: ['0x2E40E06C0B864caF87cCB00f31e6EE2d0689cDd7'], faucet: 'https://faucet.monad.xyz', rpcs: ['https://testnet-rpc.monad.xyz'] },
};
/** ?net=mainnet|testnet, plus ?rpc= & ?factory= overrides used for local fork testing. */
export function resolveNet(): Net {
  if (typeof window === 'undefined') return NETS.mainnet;
  const q = new URLSearchParams(location.search);
  const key = (q.get('net') as 'mainnet' | 'testnet') || (localStorage.getItem('pp.netkey') as any) || 'mainnet';
  const n = { ...(NETS[key] ?? NETS.mainnet) };
  if (q.get('rpc')) { n.rpc = q.get('rpc')!; n.rpcs = undefined; } if (q.get('factory')) { n.factory = q.get('factory') as Address; n.unlimited = q.get('legacyFactory') !== '1'; }
  return n;
}
export const chainOf = (n: Net) => ({ id: n.id, name: `Monad ${n.name}`, nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [n.rpc] } }, blockExplorers: { default: { name: 'Explorer', url: n.exp } } }) as const;
/** Public reads go through the official Monad RPC list (docs.monad.xyz) with automatic fallback. */
const gates = new Map<string, Gate>();
export const gateOf = (n: Net) => { const k = `${n.id}:${n.rpc}`; let g = gates.get(k); if (!g) gates.set(k, (g = new Gate(4))); return g; };
/** Public reads go through the official Monad RPC list (docs.monad.xyz) with automatic fallback, behind a shared
 *  concurrency-4 gate with dedupe and 429 back-off. ttlMs>0 also caches state reads (for background dashboards). */
const slowClients = new Map<string, PublicClient>();
/** One shared cached client per network for background dashboards, so every view shares the same cache. */
export const slowPubOf = (n: Net) => { const k = `${n.id}:${n.rpc}:${(n.rpcs ?? []).join()}`; let c = slowClients.get(k); if (!c) slowClients.set(k, (c = pubOf(n, 25_000))); return c; };
export const pubOf = (n: Net, ttlMs = 0) => createPublicClient({ chain: chainOf(n), transport: limitedTransport(n.rpcs?.length ? fallback(n.rpcs.map(u => http(u, { batch: false, retryCount: 1, retryDelay: 300, timeout: 12_000 })), { rank: false, retryCount: 2 }) : http(n.rpc, { batch: false, retryCount: 4, retryDelay: 500 }) , gateOf(n), ttlMs) }) as PublicClient;
export const services = (n: Net) => (n.id === 143 ? SERVICES : SERVICES.filter(s => s.id === 'pay').concat(SERVICES.filter(s => s.id !== 'pay').map(s => ({ ...s, status: 'soon' as const, why: s.why ?? 'Mainnet only: these are mainnet contracts.' }))));

export const mon = (v: bigint | number | string, d = 4) => `${Number(formatEther(BigInt(v))).toLocaleString(undefined, { maximumFractionDigits: d })} MON`;
/** Largest MON a value action can attach: the vault balance (v4 vaults have no cap or budget; v1-v3 vaults also clear their cap and remaining budget). */
export function executableMon(s: { cap: bigint; budget: bigint; spent: bigint; bal: bigint }): bigint {
  const rem = s.budget > s.spent ? s.budget - s.spent : 0n;
  let n = s.cap < s.bal ? s.cap : s.bal;
  if (rem < n) n = rem;
  return n > 0n ? n : 0n;
}
export const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
export const rid = (t: string) => keccak256(toHex(`${t}:${Date.now()}:${Math.random()}`));

// ---------- plain-English reasons ----------
const byAddr: Record<string, { name: string; icon: string }> = {};
for (const s of SERVICES) if (s.address) byAddr[s.address.toLowerCase()] = { name: s.name, icon: s.icon };
for (const [k, t] of Object.entries(TOKENS)) byAddr[t.address.toLowerCase()] ??= { name: k, icon: '🪙' };
const SELS: Record<string, string> = { '0xa9059cbb': 'transfer' }; for (const s of SERVICES) for (const r of s.rules ?? []) SELS[r.selector] = r.fn.split('(')[0];
export const dappName = (a: string) => byAddr[String(a).toLowerCase()]?.name ?? short(a);
export const dappInfo = (a?: string) => (a ? byAddr[String(a).toLowerCase()] : undefined);
export const selName = (sel?: string) => (sel ? SELS[sel.toLowerCase()] : undefined);
export type Reason = { name: string | null; args?: readonly any[]; raw?: string };
const PLAIN: Record<string, (a: readonly any[]) => string> = {
  PerPaymentCapExceeded: a => `Over the per-action cap: tried ${mon(a[0])}, but the cap is ${mon(a[1])}.`,
  BudgetExceeded: a => `Over budget: tried ${mon(a[0])}, only ${mon(a[1])} left.`,
  RecipientNotAllowed: a => `${short(a[0])} isn't an approved payee.`,
  CallNotAllowed: a => `${dappName(a[0])} → ${SELS[String(a[1]).toLowerCase()] ?? a[1]} isn't an allowed service action.`,
  RecipientMustBeVault: a => `Tried to send the output to ${short(a[0])} instead of back to the vault.`,
  TokenCapExceeded: a => `Token approval ${a[1]} is over the cap of ${a[2]}.`,
  MinOutNotMet: a => `Slippage guard: got ${a[0]}, needed at least ${a[1]}.`,
  RequestAlreadyExecuted: () => 'Replay blocked: that request already ran.',
  Paused: () => 'The owner paused this agent.', NotExecutor: () => "This key isn't the vault's agent.", NotOwner: () => 'Only the vault owner can do that.',
  VaultCapExceeded: a => `Vault cap: the balance would be ${mon(a[0])}, but the max is ${mon(a[1])}.`, GlobalCapExceeded: a => `The alpha safety cap for all vaults together is ${mon(a[1] ?? 0n)}; this deposit would take it to ${mon(a[0] ?? 0n)}. Try a smaller deposit (or 0) and top up later.`,
  InsufficientBalance: a => `The vault only holds ${mon(a[1] ?? 0n)}.`, ForbiddenSelector: () => 'Approve/transfer functions can never be allowlisted.', ForbiddenTarget: () => "That address can't be a service target.",
  UserRejected: () => 'You cancelled in your wallet.',
  NoLimitToProbe: () => 'This vault has no spending limits or allowlists, so that attempt would succeed and move funds. The app does not send it.',
};
function faultParts(e: any): { parts: string[]; code?: number } {
  const parts: string[] = [];
  const seen = new Set<any>();
  let x = e;
  let code: number | undefined;
  while (x && typeof x === 'object' && !seen.has(x)) {
    seen.add(x);
    if (code == null && typeof x.code === 'number') code = x.code;
    for (const s of [x.details, x.shortMessage, x.message]) if (typeof s === 'string' && s.trim()) parts.push(s);
    const data = x.data;
    if (typeof data === 'string') parts.push(data);
    else if (data && typeof data === 'object' && typeof data.message === 'string') parts.push(data.message);
    x = x.cause;
  }
  return { parts, code };
}
export function reasonOf(e: any): Reason {
  let x = e;
  while (x) {
    const d = x.data?.data ?? x.data;
    if (typeof d === 'string' && d.startsWith('0x') && d.length >= 10) { try { const r = decodeErrorResult({ abi: errAbi, data: d as Hex }); return { name: r.errorName, args: r.args as any }; } catch { /* next */ } }
    if (x.data?.errorName) return { name: x.data.errorName, args: x.data.args };
    x = x.cause;
  }
  const { parts, code } = faultParts(e);
  const text = parts.join('\n');
  const feeish = /fee|underpriced|intrinsic gas|maxfee|max fee|priority fee|base fee/i.test(text);
  if (!feeish && (code === 4001 || code === 5000 || /user rejected the request|user denied transaction signature|user (?:cancelled|canceled)/i.test(text))) return { name: 'UserRejected' };
  const generic = /^(an unknown rpc error occurred\.?|an internal error was received\.?|http request failed\.?)$/i;
  const raw = parts.map(p => p.split('\n')[0].trim()).find(p => p && !generic.test(p)) ?? parts[0]?.split('\n')[0] ?? 'The wallet did not complete that request.';
  return { name: null, raw };
}
export const plain = (r?: Reason | null) => (r?.name && PLAIN[r.name] ? PLAIN[r.name](r.args ?? []) : r?.raw || r?.name || 'Reverted');
/** A hash that is still waiting is not a revert. Callers use `pending` to keep the button honest. */
export function sendFault(e: unknown): { pending: boolean; text: string } {
  const pending = !!e && typeof e === 'object' && (e as { pending?: boolean }).pending === true;
  return { pending, text: plain(reasonOf(e)) };
}
export const parseRecorded = (s?: string): Reason => { const m = /^(\w+)\((.*)\)$/.exec(s || ''); if (!m) return { name: null, raw: s }; return { name: m[1], args: m[2] ? m[2].split(', ').map(x => (/^\d+$/.test(x) ? BigInt(x) : x)) : [] }; };

// ---------- createVault args ----------
/** New vaults (v4) have no spending limits and no allowlists: any amount, any recipient, any contract. */
export type Policy = { deposit: number; gas: number; startPaused: boolean };
/** Unlimited, shown wherever an old cap/budget used to be. */
export const MAX_UINT = 2n ** 256n - 1n;
export const isUnlimited = (x: bigint) => x >= MAX_UINT / 2n;
/** MON → wei for any amount the user types (up to 6 decimals). */
export const toWei = (x: number) => (Number.isFinite(x) && x > 0 ? BigInt(Math.round(x * 1e6)) * 10n ** 12n : 0n);
/** createVault(executor) on the v4 UnlimitedAgentVaultFactory, with an optional initial deposit of any size. */
export function buildCreate(executor: Address, _owner: Address, p: Pick<Policy, 'deposit'>) {
  return { data: encodeFunctionData({ abi: unlimitedFactoryAbi, functionName: 'createVault', args: [executor] }), value: toWei(p.deposit), cap: MAX_UINT, budget: MAX_UINT };
}
/** Owner txs that lift every limit an older (v1-v3) AgentVault lets its owner lift: per-action cap and budget to max,
 *  every known token approval cap to max, and every live service's call rule switched on. The immutable vault cap,
 *  the payee allowlist (it can only be added to), the "output must come back to the vault" check and the forbidden
 *  approve/transfer selectors are in that bytecode and cannot be switched off; moving funds to a v4 vault removes them. */
export function removeLimitsTxs(s: Pick<VaultState, 'v' | 'cap' | 'budget' | 'rules'>): { label: string; req: { to: Address; data: Hex } }[] {
  const out: { label: string; req: { to: Address; data: Hex } }[] = [];
  if (!isUnlimited(s.cap)) out.push({ label: 'Per-action cap → unlimited', req: vcall(s.v, 'setPerPaymentCap', [MAX_UINT]) });
  if (!isUnlimited(s.budget)) out.push({ label: 'Budget → unlimited', req: vcall(s.v, 'setBudget', [MAX_UINT]) });
  for (const [k, t] of Object.entries(TOKENS)) out.push({ label: `${k} approval cap → unlimited`, req: vcall(s.v, 'setTokenCap', [t.address, MAX_UINT]) });
  for (const svc of LIVE.filter(x => x.address && !s.rules.includes(x.id))) for (const r of svc.rules ?? []) out.push({ label: `Allow ${svc.name} (${r.fn.split('(')[0]})`, req: vcall(s.v, 'setCallRule', [svc.address, r.selector, true, r.recipientWord]) });
  return out;
}

// ---------- agent actions ----------
const routerAbi = parseAbi(['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)']);
const quoterAbi = parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)']);
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)']);
const wmonAbi = parseAbi(['function deposit() payable', 'function withdraw(uint256)']);
const kintsuAbi = parseAbi(['function deposit(uint96 minShares,address receiver) payable returns (uint96)']);
const aprAbi = parseAbi(['function deposit(uint256 assets,address receiver) payable returns (uint256)']);
const magmaAbi = parseAbi(['function depositMON(address receiver,uint256 referralId) payable']);
const kuruAbi = parseAbi(['function anyToAnySwap(address[] markets,bool[] isBuy,bool[] nativeSend,address debitToken,address creditToken,uint256 amount,uint256 minAmountOut) payable returns (uint256)']);
const NONE = { approveToken: ZERO, approveAmount: 0n, outToken: ZERO, minOut: 0n };
const svc = (id: string) => SERVICES.find(s => s.id === id)! as Service & { address: Address };
export const vcall = (v: Address, fn: string, args: readonly unknown[]) => ({ to: v, data: encodeFunctionData({ abi: vaultAbi, functionName: fn as any, args: args as any }) });

/** One-click starter vault: your own wallet is the agent, so every action below can be sent from it for real.
 *  No spending limits and no allowlists. You choose the deposit (any amount, 0 is fine); `deposit` is only the prefilled suggestion. */
export const STARTER = { deposit: 0.5 };
export const buildStarter = (owner: Address, deposit = STARTER.deposit) => buildCreate(owner, owner, { deposit });

/** Live MON → USDC quotes on all three venues (null = venue unavailable right now). */
export type Quote = { id: 'uniswap' | 'pancake' | 'kuru'; name: string; icon: string; out: bigint | null };
export async function quoteAll(pub: PublicClient, vault: Address, amount: bigint): Promise<Quote[]> {
  const uni = async (id: 'uniswap' | 'pancake') => { const Q = QUOTERS[id]; const q = await pub.simulateContract({ address: Q.address, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ tokenIn: TOKENS.WMON.address, tokenOut: TOKENS.USDC.address, amountIn: amount, fee: Q.fee, sqrtPriceLimitX96: 0n }] }); return q.result[0] as bigint; };
  const kuru = async () => { const sim = await pub.simulateContract({ account: vault, address: KURU.router, abi: kuruAbi, functionName: 'anyToAnySwap', args: [[KURU.monUsdc], [false], [true], ZERO, TOKENS.USDC.address, amount, 1n] as any, value: amount }); return sim.result as bigint; };
  const rs = await Promise.allSettled([uni('uniswap'), uni('pancake'), kuru()]);
  return (['uniswap', 'pancake', 'kuru'] as const).map((id, i) => ({ id, name: svc(id).name, icon: svc(id).icon, out: rs[i].status === 'fulfilled' ? (rs[i] as PromiseFulfilledResult<bigint>).value : null }));
}

/** Reference MON→USDC price: best of the live venue quotes for 0.1 MON, scaled to 1 MON (USDC has 6 decimals). */
export async function monUsdcPrice(pub: PublicClient, vault: Address): Promise<{ usdcPerMon: bigint; venue: string; venues: { id: Quote['id']; name: string; icon: string; usdcPerMon: bigint | null }[] }> {
  const quotes = await quoteAll(pub, vault, 10n ** 17n);
  const shortName = { uniswap: 'Uniswap', pancake: 'Pancake', kuru: 'Kuru' } as const;
  const venues = quotes.map(q => ({ id: q.id, name: shortName[q.id], icon: q.icon, usdcPerMon: q.out && q.out > 0n ? q.out * 10n : null }));
  const ok = venues.filter(v => v.usdcPerMon && v.usdcPerMon > 0n);
  const best = ok.reduce<(typeof ok)[number] | null>((a, b) => (!a || b.usdcPerMon! > a.usdcPerMon! ? b : a), null);
  return { usdcPerMon: best?.usdcPerMon ?? 0n, venue: best?.name ?? '', venues };
}

/** USDC → WMON through an allowlisted v3 router. `usdcAmount` is raw 6-decimal units. minOut = best quote − 3%. */
async function buildUsdcToWmon(pub: PublicClient, vault: Address, usdcAmount: bigint, venues: ('uniswap' | 'pancake')[]): Promise<AgentAction> {
  if (usdcAmount <= 0n) throw new Error('No USDC to swap back.');
  const list = venues.length ? venues : (['uniswap', 'pancake'] as const);
  const quote = async (id: 'uniswap' | 'pancake') => {
    const Q = QUOTERS[id];
    const q = await pub.simulateContract({ address: Q.address, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ tokenIn: TOKENS.USDC.address, tokenOut: TOKENS.WMON.address, amountIn: usdcAmount, fee: Q.fee, sqrtPriceLimitX96: 0n }] });
    return { id, out: q.result[0] as bigint, fee: Q.fee };
  };
  const rs = await Promise.all(list.map(id => quote(id).catch(() => null)));
  const ok = rs.filter((x): x is { id: 'uniswap' | 'pancake'; out: bigint; fee: number } => !!x && x.out > 0n);
  if (!ok.length) throw new Error('No venue could quote USDC → WMON right now.');
  const best = ok.reduce((a, b) => (b.out > a.out ? b : a));
  const minOut = (best.out * 97n) / 100n;
  if (minOut === 0n) throw new Error('That USDC amount is too small to swap back safely.');
  const data = encodeFunctionData({ abi: routerAbi, functionName: 'exactInputSingle', args: [{ tokenIn: TOKENS.USDC.address, tokenOut: TOKENS.WMON.address, fee: best.fee, recipient: vault, amountIn: usdcAmount, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] });
  const x = svc(best.id);
  return { label: `Agent swaps ${formatUnits(usdcAmount, 6)} USDC → WMON on ${x.name}`, dapp: x.name, icon: x.icon, value: 0n, req: vcall(vault, 'executeCall', [rid('back'), x.address, 0n, data, { approveToken: TOKENS.USDC.address, approveAmount: usdcAmount, outToken: TOKENS.WMON.address, minOut }]) };
}

export type AgentAction = { label: string; dapp: string; icon: string; req: { to: Address; data: Hex }; value: bigint; quotes?: Quote[] };
export async function buildAction(pub: PublicClient, kind: string, vault: Address, owner: Address, executor: Address, amount: bigint, cap: bigint, extra: { to?: Address; venues?: ('uniswap' | 'pancake')[] } = {}): Promise<AgentAction> {
  const call = (s: string, value: bigint, data: Hex, out: { outToken: Address; minOut: bigint }, label: string) => {
    const x = svc(s); return { label, dapp: x.name, icon: x.icon, value, req: vcall(vault, 'executeCall', [rid(s), x.address, value, data, { ...NONE, ...out }]) };
  };
  const swap = async (id: 'uniswap' | 'pancake') => {
    const Q = QUOTERS[id]; const q = await pub.simulateContract({ address: Q.address, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ tokenIn: TOKENS.WMON.address, tokenOut: TOKENS.USDC.address, amountIn: amount, fee: Q.fee, sqrtPriceLimitX96: 0n }] });
    const minOut = (q.result[0] * 97n) / 100n;
    const data = encodeFunctionData({ abi: routerAbi, functionName: 'exactInputSingle', args: [{ tokenIn: TOKENS.WMON.address, tokenOut: TOKENS.USDC.address, fee: Q.fee, recipient: vault, amountIn: amount, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] });
    return call(id, amount, data, { outToken: TOKENS.USDC.address, minOut }, `Agent swaps ${formatEther(amount)} MON → USDC on ${svc(id).name}`);
  };
  switch (kind) {
    case 'pay': return { label: `Agent pays ${formatEther(amount)} MON to ${short(owner)}`, dapp: 'Pay people', icon: '💸', value: amount, req: vcall(vault, 'execute', [rid('pay'), owner, amount]) };
    case 'payto': { const to = extra.to ?? owner; return { label: `Agent pays ${formatEther(amount)} MON to ${short(to)}`, dapp: 'Pay people', icon: '💸', value: amount, req: vcall(vault, 'execute', [rid('pay'), to, amount]) }; }
    case 'wmon': return call('wmon', amount, encodeFunctionData({ abi: wmonAbi, functionName: 'deposit' }), { outToken: TOKENS.WMON.address, minOut: amount }, `Agent wraps ${formatEther(amount)} MON → WMON`);
    case 'unwrap': return call('wmon', 0n, encodeFunctionData({ abi: wmonAbi, functionName: 'withdraw', args: [amount] }), { outToken: ZERO, minOut: amount }, `Agent unwraps ${formatEther(amount)} WMON → MON`);
    case 'uniswap': return swap('uniswap');
    case 'pancake': return swap('pancake');
    case 'bestswap': { // best execution: quote all three venues, route to the best USDC out, keep the vault's minOut guard
      const quotes = await quoteAll(pub, vault, amount); const ok = quotes.filter(q => q.out !== null && q.out > 0n);
      if (!ok.length) throw new Error('No venue could quote this swap right now.');
      const best = ok.reduce((a, b) => (b.out! > a.out! ? b : a));
      const a = best.id === 'kuru' ? await buildAction(pub, 'kuru', vault, owner, executor, amount, cap) : await swap(best.id);
      return { ...a, quotes, label: `Agent swaps ${formatEther(amount)} MON → USDC on ${best.name} (best of ${ok.length} venues)` };
    }
    case 'usdctowmon': return buildUsdcToWmon(pub, vault, amount, extra.venues ?? ['uniswap', 'pancake']); // amount is USDC raw (6 decimals), not MON
    case 'kuru': {
      const args = [[KURU.monUsdc], [false], [true], ZERO, TOKENS.USDC.address, amount, 1n] as const;
      const sim = await pub.simulateContract({ account: vault, address: KURU.router, abi: kuruAbi, functionName: 'anyToAnySwap', args: args as any, value: amount }); // exact output, simulated from the vault
      const minOut = ((sim.result as bigint) * 97n) / 100n;
      const data = encodeFunctionData({ abi: kuruAbi, functionName: 'anyToAnySwap', args: [[KURU.monUsdc], [false], [true], ZERO, TOKENS.USDC.address, amount, minOut] });
      return call('kuru', amount, data, { outToken: TOKENS.USDC.address, minOut }, `Agent swaps ${formatEther(amount)} MON → USDC on Kuru`);
    }
    case 'kintsu': return call('kintsu', amount, encodeFunctionData({ abi: kintsuAbi, functionName: 'deposit', args: [1n, vault] }), { outToken: TOKENS.sMON.address, minOut: 1n }, `Agent stakes ${formatEther(amount)} MON → sMON (Kintsu)`);
    case 'apriori': return call('apriori', amount, encodeFunctionData({ abi: aprAbi, functionName: 'deposit', args: [amount, vault] }), { outToken: TOKENS.aprMON.address, minOut: 1n }, `Agent stakes ${formatEther(amount)} MON → aprMON (aPriori)`);
    case 'magma': return call('magma', amount, encodeFunctionData({ abi: magmaAbi, functionName: 'depositMON', args: [vault, 0n] }), { outToken: TOKENS.gMON.address, minOut: 1n }, `Agent stakes ${formatEther(amount)} MON → gMON (Magma)`);
    // attacks
    case 'x-cap': if (isUnlimited(cap)) throw new Error('This vault has no per-action cap to go over.'); return { label: `Agent tries to spend ${formatEther(cap * 2n)} MON (2× cap)`, dapp: 'Pay people', icon: '😈', value: cap * 2n, req: vcall(vault, 'execute', [rid('x'), owner, cap * 2n]) };
    case 'x-stranger': return { label: 'Agent tries to pay a stranger', dapp: 'Pay people', icon: '😈', value: 1n, req: vcall(vault, 'execute', [rid('x'), '0x000000000000000000000000000000000000dEaD', 1n]) };
    case 'x-drain': return { label: 'Agent tries USDC.transfer() to itself', dapp: 'USDC', icon: '😈', value: 0n, req: vcall(vault, 'executeCall', [rid('x'), TOKENS.USDC.address, 0n, encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [executor, 1n] }), NONE]) };
    case 'x-self': return { label: 'Agent tries a swap that pays itself', dapp: 'Uniswap v3', icon: '😈', value: 1000n, req: vcall(vault, 'executeCall', [rid('x'), svc('uniswap').address, 1000n, encodeFunctionData({ abi: routerAbi, functionName: 'exactInputSingle', args: [{ tokenIn: TOKENS.WMON.address, tokenOut: TOKENS.USDC.address, fee: 3000, recipient: executor, amountIn: 1000n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] }), NONE]) };
    case 'x-withdraw': return { label: 'Agent tries to withdraw the vault', dapp: 'Owner-only', icon: '😈', value: 0n, req: vcall(vault, 'withdraw', [executor, 1n]) };
  }
  throw new Error('unknown action ' + kind);
}

// ---------- reads ----------
export type VaultState = { v: Address; unlimited?: boolean; owner: Address; executor: Address; cap: bigint; budget: bigint; spent: bigint; paused: boolean; bal: bigint; vaultCap: bigint; agentBal: bigint; toks: Partial<Record<TokenSym, bigint>>; key: string | null; rules: string[] };
export async function readVault(pub: PublicClient, n: Net, v: Address): Promise<VaultState> {
  const rd = (f: string, args?: unknown[]) => pub.readContract({ address: v, abi: vaultAbi, functionName: f as any, args: args as any }) as Promise<any>;
  const [owner, executor, cap, budget, spent, paused, bal, vaultCap] = await Promise.all([rd('owner'), rd('executor'), rd('perPaymentCap'), rd('budget'), rd('totalSpent'), rd('paused'), pub.getBalance({ address: v }), rd('vaultCap')]);
  const agentBal = await pub.getBalance({ address: executor });
  const unlimited = await rd('unlimited').then(Boolean).catch(() => false);
  const toks: VaultState['toks'] = {}; const rules: string[] = [];
  if (n.id === 143) {
    await Promise.all((Object.keys(TOKENS) as TokenSym[]).map(async k => { toks[k] = await pub.readContract({ address: TOKENS[k].address, abi: erc20, functionName: 'balanceOf', args: [v] }).catch(() => 0n); }));
    await Promise.all(LIVE.filter(s => s.address).map(async s => { const r = s.rules![0]; const ok = await rd('callRule', [s.address, r.selector]).catch(() => null); if (ok && (ok === true || ok?.[0] === true || ok?.allowed === true)) rules.push(s.id); }));
  }
  const allowedOwner = await rd('allowedRecipient', [owner]).catch(() => false); if (allowedOwner) rules.push('pay');
  return { v, unlimited, owner, executor, cap, budget, spent, paused, bal, vaultCap, agentBal, toks, key: localStorage.getItem(`pp.agentkey.${executor.toLowerCase()}`), rules };
}

// ---------- team showcase snapshot (written by the scheduled Actions runner) ----------
export type TeamAgent = { id: string; name: string; emoji: string; about: string; vault: Address | null; agent: Address | null; perActionCapMON?: string; allowed: number; blocked: number; pending?: boolean; lastSkip?: { ts: string; reason: string } };
export type TeamSnapshot = { label: string; note: string; updatedAt: string; startedAt: string; owner: Address; totals: { allowed: number; blocked: number; ownerTxs: number; skipped?: number; monConsumed?: string }; agents: TeamAgent[]; recent: { ts: string; persona: string; actor: string; label: string; status: string; reason?: string; tx: string }[]; status: string };
export const TEAM_LABEL = 'PolicyPilot showcase agents (operated by the team)';
const RAW_SNAPSHOT = 'https://raw.githubusercontent.com/Blockchains/policypilot-monad/main/web/public/showcase-agents-143.json';
/** Freshest of: raw GitHub (updated every round by the runner) and the copy deployed with Pages. */
export async function fetchTeamSnapshot(n: Net, base: string): Promise<TeamSnapshot | null> {
  if (n.id !== 143) return null;
  const get = (u: string) => fetch(u, { cache: 'no-store' }).then(r => (r.ok ? r.json() : Promise.reject(r.status)));
  const rs = await Promise.allSettled([get(RAW_SNAPSHOT), get(`${base}/showcase-agents-143.json`)]);
  const xs = rs.filter(x => x.status === 'fulfilled').map(x => (x as PromiseFulfilledResult<TeamSnapshot>).value);
  return xs.sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt))[0] ?? null;
}

// ---------- history ----------
export type Ev = { tx?: Hex; from?: string; label: string; kind?: string; status: 'allowed' | 'blocked' | 'owner'; simulated?: boolean; dapp: string; icon: string; value: bigint; block?: bigint; fee?: bigint; gasUsed?: bigint; reason?: Reason | null; input?: Hex; vault?: Address; src: 'showcase' | 'you'; ts?: number };
const LOCAL = (n: Net) => `pp.hist.${n.id}`;
export const localHist = (n: Net): any[] => { try { return JSON.parse(localStorage.getItem(LOCAL(n)) || '[]'); } catch { return []; } };
export const addLocal = (n: Net, e: Record<string, unknown>) => { const h = localHist(n); h.unshift({ ...e, ts: Date.now() }); localStorage.setItem(LOCAL(n), JSON.stringify(h.slice(0, 200), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))); };
async function pool<T, R>(items: T[], k: number, fn: (t: T) => Promise<R>) { const out: (R | null)[] = []; let i = 0; await Promise.all(Array.from({ length: k }, async () => { while (i < items.length) { const j = i++; out[j] = await fn(items[j]).catch(() => null); } })); return out; }
function classify(tx: any, step: any): Ev {
  const ev: Ev = { tx: tx?.hash ?? step.tx, from: tx?.from ?? step.from, label: step.label, kind: step.kind, value: 0n, dapp: 'Owner', icon: '👤', status: 'owner', src: step.src };
  try {
    const f = decodeFunctionData({ abi: vaultAbi, data: tx.input }) as any;
    if (f.functionName === 'execute') { ev.dapp = 'Pay people'; ev.icon = '💸'; ev.value = f.args[2]; }
    else if (f.functionName === 'executeCall') { const d = byAddr[String(f.args[1]).toLowerCase()]; ev.dapp = d?.name ?? short(f.args[1]); ev.icon = d?.icon ?? '🧩'; ev.value = f.args[2]; }
    else ev.icon = ({ setPaused: '⏸', emergencyWithdrawAll: '🧯', withdraw: '↩️', withdrawToken: '↩️', deposit: '📥' } as any)[f.functionName] ?? '⚙️';
  } catch { try { decodeFunctionData({ abi: factoryAbi, data: tx.input }); ev.icon = '🛡️'; } catch { ev.icon = '⛽'; } }
  return ev;
}
export async function loadHistory(pub: PublicClient, n: Net, base: string): Promise<{ events: Ev[]; showcase: any }> {
  let show: any = null; try { show = await (await fetch(`${base}/showcase-${n.id}.json`, { cache: 'no-store' })).json(); } catch { /* none */ }
  const steps = [...(show?.steps ?? []).map((s: any) => ({ ...s, src: 'showcase' })), ...localHist(n).map(s => ({ ...s, src: 'you' }))];
  const rows = await pool(steps, 3, async (s: any): Promise<Ev> => {
    if (!s.tx) return { label: s.label, simulated: true, status: 'blocked', value: s.value ? BigInt(s.value) : 0n, dapp: s.dapp ?? 'Pay people', icon: s.icon ?? '🛡️', reason: s.revertReason ? parseRecorded(s.revertReason) : null, src: s.src, ts: s.ts };
    const [tx, rc] = await Promise.all([pub.getTransaction({ hash: s.tx }), pub.getTransactionReceipt({ hash: s.tx })]);
    const ev = classify(tx, s); ev.block = rc.blockNumber; ev.gasUsed = rc.gasUsed; ev.fee = rc.gasUsed * rc.effectiveGasPrice; ev.vault = tx.to ?? undefined; ev.input = tx.input; ev.ts = s.ts;
    ev.reason = s.revertReason ? parseRecorded(s.revertReason) : null;
    ev.status = s.kind === 'owner' ? (rc.status === 'success' ? 'owner' : 'blocked') : rc.status === 'success' ? 'allowed' : 'blocked';
    return ev;
  });
  const events = (rows.filter(Boolean) as Ev[]).sort((a, b) => Number((a.block ?? 10n ** 12n) - (b.block ?? 10n ** 12n)) || (a.ts ?? 0) - (b.ts ?? 0));
  return { events, showcase: show };
}
export function decodeInput(input?: Hex) {
  if (!input) return ''; try { const f = decodeFunctionData({ abi: vaultAbi, data: input }) as any; return `${f.functionName}(${(f.args ?? []).map((a: any) => (typeof a === 'object' && a !== null ? JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) : typeof a === 'string' && a.length > 80 ? a.slice(0, 74) + '…' : String(a))).join(', ')})`; } catch { return ''; }
}
export { erc20 };
