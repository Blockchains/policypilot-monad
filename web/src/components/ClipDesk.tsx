'use client';
import { useOnScreen } from '@/lib/useOnScreen';
import { useEffect, useRef, useState } from 'react';
import { formatEther, getAddress, isAddress, parseEther, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { AlertTriangle, CheckCircle2, Zap } from 'lucide-react';
import { Btn, receiptClass, Switch } from './ui';
import { haptic } from '@/lib/wallets';
import { addLocal, mon, sendFault, short, type Net } from '@/lib/vault';
import { pricedGas } from '@/lib/fastPath';
import {
  bestProfitSize, clearsFloor, decodeQuote, fetchCalls, forwardQuotes, roundTripBacks, SETTLEMENT_VENUES, VENUES, workerUrl,
  type CallRow, type QuoteCall, type VenueId,
} from '@/lib/spread';
import {
  CLIP_CAP, CLIP_GAS, clipAbi, clipCallData, clipCharge, clipDeployData, clipDepositData, clipGate, clipWithdrawData, explainClip, isCurrentClipCode,
} from '@/lib/clip';

type Quote = {
  amount: bigint; sell: VenueId | null; buy: VenueId | null; usdc: bigint; back: bigint; profit: bigint; ok: boolean;
};

function asRows(rows: unknown): CallRow[] {
  if (!Array.isArray(rows)) throw new Error('Quote failed');
  return rows.map((r) => {
    if (typeof r === 'string') return { ok: true, result: r as Hex };
    if (r && typeof r === 'object' && 'ok' in r) return r as CallRow;
    return { ok: false, error: 'Quote failed' };
  });
}

function ask(worker: Worker | null, rpc: string, calls: QuoteCall[]): Promise<CallRow[]> {
  if (!worker) return fetchCalls(rpc, calls);
  const id = `${Date.now()}-${Math.random()}`;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => { worker.removeEventListener('message', onMsg); reject(new Error('Quote timed out')); }, 8_000);
    const onMsg = (ev: MessageEvent) => {
      if (ev.data?.id !== id) return;
      window.clearTimeout(timer);
      worker.removeEventListener('message', onMsg);
      if (!ev.data.ok) reject(new Error(ev.data.error || 'Quote failed'));
      else resolve(asRows(ev.data.rows));
    };
    worker.addEventListener('message', onMsg);
    worker.postMessage({ id, rpc, calls });
  });
}

export default function ClipDesk({ net, pub, account, wallet, bal, need, send, toast, block }: {
  net: Net; pub: PublicClient; account: Address | null; wallet: WalletClient | null; bal: bigint | null;
  need: () => Promise<boolean>;
  send: (w: WalletClient, req: { to?: Address; data?: Hex; value?: bigint; gas?: bigint }) => Promise<{ transactionHash: Hex; contractAddress?: Address | null }>;
  toast: (m: React.ReactNode, k?: 'ok' | 'bad' | 'info') => void;
  block: bigint | null;
}) {
  const [amount, setAmount] = useState('0.2');
  const [bestSize, setBestSize] = useState<{ amount: bigint; profit: bigint } | null>(null);
  const [bestBusy, setBestBusy] = useState(false);
  const scanning = useRef(false);
  const [vault, setVault] = useState<Address | null>(null);
  const [snap, setSnap] = useState<{ pool: bigint; shares: bigint; yours: bigint; cap: bigint } | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [baseFee, setBaseFee] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(false);
  const [paste, setPaste] = useState('');
  const [topUp, setTopUp] = useState('0.02');
  const [line, setLine] = useState<{ ok: boolean; pending?: boolean; text: string; href?: string } | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const tried = useRef<bigint | null>(null);
  const key = account ? `pp.clip.${net.id}.${account.toLowerCase()}` : '';

  useEffect(() => {
    let w: Worker | null = null;
    try { w = new Worker(workerUrl()); workerRef.current = w; } catch { workerRef.current = null; }
    return () => { w?.terminate(); workerRef.current = null; };
  }, []);

  useEffect(() => {
    if (!key) { setVault(null); return; }
    const saved = localStorage.getItem(key);
    setVault(saved && isAddress(saved) ? getAddress(saved) : null);
  }, [key]);

  useEffect(() => {
    if (!vault) { setSnap(null); return; }
    let on = true;
    (async () => {
      const code = await pub.getCode({ address: vault });
      if (!on) return;
      if (!code || code === '0x') { if (key) localStorage.removeItem(key); setVault(null); return; }
      if (!isCurrentClipCode(code)) {
        if (key) localStorage.removeItem(key);
        setVault(null);
        setLine({ ok: false, text: 'That saved pool is not the current clip bytecode, so it was cleared. Open a new pool.' });
        return;
      }
      const who = account ?? '0x0000000000000000000000000000000000000000';
      const [pool, shares, yours, cap] = await Promise.all([
        pub.getBalance({ address: vault }),
        pub.readContract({ address: vault, abi: clipAbi, functionName: 'balanceOf', args: [who] }),
        pub.readContract({ address: vault, abi: clipAbi, functionName: 'assetsOf', args: [who] }),
        pub.readContract({ address: vault, abi: clipAbi, functionName: 'vaultCap' }),
      ]) as [bigint, bigint, bigint, bigint];
      if (on) setSnap({ pool, shares, yours, cap });
    })().catch(() => { if (on) setSnap(null); });
    return () => { on = false; };
  }, [vault, pub, account, block, key]);

  const ctx = useRef({ amount, rpc: net.rpc, mainnet: net.id === 143 });
  ctx.current = { amount, rpc: net.rpc, mainnet: net.id === 143 };
  const lastAt = useRef(0);
  const inflight = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // Background quotes (1 s timer and every new block) only while the desk is on screen or auto-submit is on;
  // a typed amount or a vault change still quotes at once.
  const [deskRef, onScreen] = useOnScreen<HTMLElement>();
  const live = useRef(false); live.current = onScreen || auto;
  useEffect(() => { if (onScreen) void quoteOnce(false); }, [onScreen]); // eslint-disable-line react-hooks/exhaustive-deps
  const quoteOnce = async (force: boolean) => {
    if (scanning.current) return;
    if (!force && !live.current) return;
    const { amount: amt, rpc, mainnet } = ctx.current;
    if (!mainnet) { if (alive.current) { setQuote(null); setQuoting(false); } return; }
    let wei = 0n;
    try { wei = parseEther(amt || '0'); } catch { if (alive.current) setQuote(null); return; }
    if (wei <= 0n) { if (alive.current) { setQuote(null); setQuoting(false); } return; }
    if (inflight.current) return;
    if (!force && Date.now() - lastAt.current < 1_000) return;
    inflight.current = true;
    lastAt.current = Date.now();
    if (alive.current) { setQuoting(true); setQuoteError(null); }
    try {
      pub.getBlock().then(b => { if (alive.current) setBaseFee(b.baseFeePerGas ?? null); }).catch(() => {});
      const calls = forwardQuotes(wei);
      const rows = await ask(workerRef.current, rpc, calls);
      if (!alive.current) return;
      const legs = SETTLEMENT_VENUES.map((id, i) => {
        const row = rows[i];
        let usdc = 0n;
        if (row?.ok) { try { usdc = decodeQuote(row.result); } catch { usdc = 0n; } }
        return { id, usdc };
      });
      const backs = roundTripBacks(legs);
      const empty: Quote = { amount: wei, sell: null, buy: null, usdc: 0n, back: 0n, profit: 0n, ok: false };
      if (!backs.length) { setQuote(empty); return; }
      const backRows = await ask(workerRef.current, rpc, backs.map(b => b.call));
      if (!alive.current) return;
      let best: Quote | null = null;
      for (let i = 0; i < backs.length; i++) {
        const row = backRows[i];
        if (!row?.ok) continue;
        let back = 0n;
        try { back = decodeQuote(row.result); } catch { continue; }
        const cleared = clearsFloor(wei, back);
        const better = !best || (cleared.ok && !best.ok) || (cleared.ok === best.ok && back > best.back);
        if (better) {
          best = { amount: wei, sell: backs[i].sell, buy: backs[i].buy, usdc: backs[i].usdc, back, profit: cleared.profit, ok: cleared.ok };
        }
      }
      if (!best) throw new Error('Quote failed');
      setQuote(best);
    } catch (e) {
      if (!alive.current) return;
      setQuote(null);
      setQuoteError(e instanceof Error ? e.message : 'Quote failed');
    } finally {
      inflight.current = false;
      if (alive.current) setQuoting(false);
    }
  };

  useEffect(() => { const t = window.setTimeout(() => void quoteOnce(true), 200); return () => window.clearTimeout(t); }, [amount, net.id, net.rpc, vault]);
  useEffect(() => { const t = window.setInterval(() => void quoteOnce(false), 1_000); return () => window.clearInterval(t); }, [net.id, net.rpc]);
  useEffect(() => { if (block != null) void quoteOnce(false); }, [block]);

  let wei = 0n;
  try { wei = parseEther(amount || '0'); } catch { wei = 0n; }
  const quoteForAmount = quote && quote.amount === wei ? quote : null;
  const charge = clipCharge(baseFee);
  const netPositive = !!quoteForAmount?.ok && quoteForAmount.profit > charge;
  const gate = clipGate({
    mainnet: net.id === 143, account: !!account, vault: !!vault, amount,
    pool: snap?.pool ?? 0n, walletBal: bal,
    quoting: !quoteForAmount && !quoteError && (quoting || !!vault),
    quoteOk: quoteForAmount ? quoteForAmount.ok : quoteError ? false : null,
    netPositive,
    smallLoss: !!quoteForAmount?.ok && quoteForAmount.profit === 0n,
  });

  const remember = (a: Address) => { if (key) localStorage.setItem(key, a); setVault(a); };
  const fail = (e: unknown) => {
    const f = sendFault(e);
    const text = explainClip(e, f.text);
    setLine({ ok: false, pending: f.pending, text });
    toast(text, f.pending ? 'info' : 'bad');
    if (auto) setAuto(false);
  };

  const useBest = async () => {
    if (bestBusy) return;
    const maxIn = vault ? (snap?.pool && snap.pool > 0n ? snap.pool : CLIP_CAP) : CLIP_CAP;
    scanning.current = true;
    setBestBusy(true);
    setLine(null);
    await new Promise(resolve => setTimeout(resolve, 250));
    try {
      const found = await bestProfitSize(net.rpcs?.length ? net.rpcs : [net.rpc], maxIn);
      if (!found) { toast('No size up to the cap stays inside a 0.50% shortfall right now.', 'info'); return; }
      setBestSize({ amount: found.amount, profit: found.profit });
      setAmount(formatEther(found.amount));
    } catch (e) { fail(e); }
    finally { scanning.current = false; setBestBusy(false); }
  };

  const go = async () => {
    if (gate.code === 'flat' && bestSize && bestSize.profit > 0n) { setAmount(formatEther(bestSize.amount)); setLine(null); return; }
    if (gate.code === 'flat') { await useBest(); return; }
    if (gate.code === 'connect') { try { await need(); } catch (e) { fail(e); } return; }
    if (!gate.ok || !account || !wallet) return;
    setBusy(true); setLine(null);
    const size = parseEther(amount);
    try {
      if (!vault) {
        const data = clipDeployData(account);
        const gas = await pricedGas(pub, account, { data, value: size });
        const rc = await send(wallet, { data, value: size, gas });
        if (!rc.contractAddress) throw new Error(`The transaction was included, but the pool address was not in the receipt. ${rc.transactionHash}`);
        const deployed = await pub.getCode({ address: rc.contractAddress });
        if (!isCurrentClipCode(deployed)) throw new Error('The deployed pool is not the current clip bytecode.');
        remember(rc.contractAddress);
        addLocal(net, { label: `Opened a clip pool with ${amount} MON`, kind: 'owner', tx: rc.transactionHash, from: account });
        const href = `${net.exp}/tx/${rc.transactionHash}`;
        setLine({ ok: true, text: `Opened ${short(rc.contractAddress)} with ${amount} MON.`, href });
        toast(<>Pool opened. <a className="underline" href={href} target="_blank" rel="noreferrer">View tx ↗</a></>, 'ok');
      } else {
        const q = quote && quote.amount === size ? quote : null;
        if (!q?.sell || !q.buy || !q.ok) throw new Error('That quote is no longer current.');
        const data = clipCallData(q.sell, q.buy, size, q.usdc, q.back);
        const gas = await pricedGas(pub, account, { to: vault, data });
        const rc = await send(wallet, { to: vault, data, gas });
        addLocal(net, { label: `Clip ${amount} MON via ${VENUES[q.sell].name} → ${VENUES[q.buy].name}`, kind: 'allowed', tx: rc.transactionHash, from: account });
        const href = `${net.exp}/tx/${rc.transactionHash}`;
        setLine({ ok: true, text: `Clip submitted. The receipt is the result.`, href });
        toast(<>Submitted. <a className="underline" href={href} target="_blank" rel="noreferrer">View tx ↗</a></>, 'ok');
      }
      haptic(20);
    } catch (e) { fail(e); }
    setBusy(false);
  };

  useEffect(() => {
    if (!auto || busy || (gate.code !== 'net' && gate.code !== 'gain' && gate.code !== 'loss') || block == null || !quoteForAmount?.ok || !vault) return;
    if (tried.current === block) return;
    tried.current = block;
    const timer = window.setTimeout(() => { void go(); }, 180);
    return () => { window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, busy, gate.code, block, quoteForAmount?.ok, vault]);

  const withdraw = async () => {
    if (!vault || !wallet || !account || !snap || snap.shares === 0n) return;
    try { if (!(await need())) return; } catch (e) { fail(e); return; }
    setBusy(true); setLine(null);
    try {
      const data = clipWithdrawData(snap.shares);
      const gas = await pricedGas(pub, account, { to: vault, data });
      const rc = await send(wallet, { to: vault, data, gas });
      addLocal(net, { label: 'Withdrew from the clip pool', kind: 'owner', tx: rc.transactionHash, from: account });
      const href = `${net.exp}/tx/${rc.transactionHash}`;
      setLine({ ok: true, text: 'Withdrew your shares to this wallet.', href });
      toast(<>Withdrawn. <a className="underline" href={href} target="_blank" rel="noreferrer">View tx ↗</a></>, 'ok');
    } catch (e) { fail(e); }
    setBusy(false);
  };

  const usePaste = async () => {
    if (!account) { await need(); return; }
    if (!isAddress(paste.trim())) { toast('Paste the pool address, starting with 0x.', 'bad'); return; }
    const a = getAddress(paste.trim());
    const code = await pub.getCode({ address: a }).catch(() => undefined);
    if (!isCurrentClipCode(code)) { toast('That address is not the current clip pool.', 'bad'); return; }
    remember(a); setPaste('');
    toast(`Using pool ${short(a)}.`, 'ok');
  };

  const flatBest = gate.code === 'flat' && !!bestSize && bestSize.profit > 0n;
  const button = gate.code === 'connect' ? 'Connect wallet' : flatBest && bestSize ? `Use ${mon(bestSize.amount)}` : gate.code === 'open' ? `Open pool · ${amount || '0'} MON` : gate.code === 'net' || gate.code === 'gain' || gate.code === 'loss' ? 'Submit clip' : 'Waiting for a clip';
  const netMon = quoteForAmount && quoteForAmount.profit > charge ? quoteForAmount.profit - charge : 0n;

  return (
    <section ref={deskRef} id="desk-clip" data-testid="clip-desk" className="min-w-0 scroll-mt-16 rounded-[2rem] border border-white/10 bg-white/[0.03] p-4 sm:p-5">
      <div className="mb-4 flex min-w-0 flex-wrap items-center gap-2">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-cyan-400/15 text-cyan-200"><Zap className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-white">Clip</h2>
          <p className="break-words text-xs text-zinc-400">A separate pool that sells and buys on the Uniswap v3 and PancakeSwap v3 pools directly, so the repeating transaction skips the router. It checks every new block and fills the largest size, up to 10 MON, whose shortfall stays inside 0.50%. The whole pool can be the trade. One signature sends it. There is no promised rate.</p>
        </div>
      </div>

      <div data-testid="clip-quote" className="grid gap-2 rounded-2xl border border-white/10 bg-black/20 p-3 text-xs text-zinc-300">
        <div className="flex min-w-0 justify-between gap-3"><span className="min-w-0 break-words">{quoteForAmount?.sell ? `${VENUES[quoteForAmount.sell].name} → ${VENUES[quoteForAmount.buy!].name}` : 'Round trip'}</span><span className="shrink-0 font-mono">{quoteForAmount?.sell ? mon(quoteForAmount.back) : '—'}</span></div>
        <div className="flex min-w-0 flex-wrap justify-between gap-x-3 gap-y-1 text-zinc-400">
          <span>Quoted gain {quoteForAmount ? mon(quoteForAmount.profit, 6) : '—'}</span>
          <span data-testid="clip-gas">Gas charge {mon(charge, 4)} at {CLIP_GAS.toString()} gas</span>
          <span>Net {quoteForAmount?.ok ? mon(netMon, 6) : '—'}</span>
        </div>
        {quoteForAmount?.ok && quoteForAmount.profit === 0n && <p data-testid="clip-loss-note" className="break-words text-amber-200">This quote is flat or inside a 0.50% shortfall. Submitting still runs the clip. You pay the gas.</p>}
        {quoteForAmount?.ok && quoteForAmount.profit > 0n && !netPositive && <p data-testid="clip-gas-note" className="break-words text-amber-200">This gain is smaller than the gas this limit charges. Submitting still runs the clip. You pay the gas.</p>}
        {quoteForAmount?.ok && netPositive && <p data-testid="clip-net-note" className="break-words text-emerald-200">This gain clears the gas charge. Auto-submit sends one clip per block while the quote stays inside the band.</p>}
        {bestSize && <p data-testid="clip-best-note" className="break-words text-zinc-300">Largest size inside the band is {mon(bestSize.amount)} with {mon(bestSize.profit, 6)} quoted gain.</p>}
        {quoteError && <p className="break-words text-rose-300">{quoteError}</p>}
      </div>

      <div className="mt-3 flex min-w-0 flex-wrap gap-2 text-[11px] text-zinc-400">
        <span className="rounded-full bg-black/30 px-2 py-1">Pool {mon(snap?.pool ?? 0n)}</span>
        <span className="rounded-full bg-black/30 px-2 py-1">Yours {mon(snap?.yours ?? 0n)}</span>
        <span className="rounded-full bg-black/30 px-2 py-1">Cap {mon(snap?.cap ?? CLIP_CAP, 2)}</span>
        {vault && <span className="max-w-full break-all rounded-full bg-black/30 px-2 py-1 font-mono">{short(vault)}</span>}
      </div>

      <div className="mt-4 grid grid-cols-1 items-end gap-3 md:grid-cols-2">
        <label className="grid min-w-0 gap-1 text-xs text-zinc-400"><span className="flex min-w-0 items-center justify-between gap-2"><span>{vault ? 'Clip (MON)' : 'Deposit (MON)'}</span><span className="flex shrink-0 gap-1"><button type="button" data-testid="clip-best" disabled={bestBusy} onClick={() => void useBest()} className="rounded-full border border-white/15 px-2 py-1 text-[11px] text-emerald-200 disabled:opacity-40">{bestBusy ? 'Checking…' : 'Best'}</button><button type="button" data-testid="clip-max" onClick={() => { const room = vault ? (snap?.pool ?? 0n) : (bal != null && bal < CLIP_CAP ? bal : CLIP_CAP); setAmount(formatEther(room)); setLine(null); }} className="rounded-full border border-white/15 px-2 py-1 text-[11px] text-violet-200">Max</button></span></span>
          <input data-testid="clip-amount" inputMode="decimal" value={amount} onChange={e => { setAmount(e.target.value); setLine(null); }} className="min-h-12 w-full min-w-0 rounded-xl border border-white/10 bg-black/40 px-3 font-mono text-base text-white outline-none focus:border-monad" />
        </label>
        <div className="min-w-0">
          <div data-testid="clip-gate" data-code={gate.code} className={`mb-2 flex min-w-0 items-start gap-2 text-sm ${gate.ok ? 'text-emerald-300' : 'text-rose-300'}`}>
            {gate.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
            <span className="min-w-0"><span className="font-mono text-xs">{gate.label}</span><span className="mt-0.5 block break-words text-[11px] text-zinc-400">{gate.detail}</span></span>
          </div>
          <Btn kind="pri" data-testid="clip-go" disabled={busy || (!gate.ok && gate.code !== 'connect' && !flatBest)} onClick={() => void go()} className="h-14 w-full text-base">{busy ? 'Working…' : button}</Btn>
        </div>
      </div>

      <Switch testid="clip-auto" on={auto} disabled={!vault} onChange={v => { tried.current = null; setAuto(v); }} label="Auto-submit" sub="Off until you turn it on. One send per block while the shortfall stays inside 0.50%. Each send pays the gas limit." />

      {snap && snap.shares > 0n && (
        <Btn kind="ghost" data-testid="clip-withdraw" disabled={busy} onClick={() => void withdraw()} className="mt-2 w-full">Withdraw {mon(snap.yours)} to this wallet</Btn>
      )}

      {line && <div data-testid="clip-receipt" className={`mt-3 break-words rounded-2xl border p-3 text-xs ${receiptClass(line)}`}>{line.text}{line.href && <> <a className="underline" href={line.href} target="_blank" rel="noreferrer">tx ↗</a></>}</div>}

      <p className="mt-3 break-words text-[11px] text-zinc-500">There is no profit floor and no size cap inside the pool. 10% of a gain pays the wallet that submitted it, 10% goes to the wallet that opened the pool, and the rest stays. The caller pays the gas limit even when the transaction reverts. A measured clip is about {CLIP_GAS.toLocaleString()} gas.</p>

      {vault && snap && snap.pool < snap.cap && (
        <form className="mt-3 flex min-w-0 flex-col gap-2 sm:flex-row" onSubmit={e => { e.preventDefault(); void (async () => {
          if (!vault || !wallet || !account) return;
          let add = 0n;
          try { add = parseEther(topUp || '0'); } catch { toast('Use a MON amount such as 0.02.', 'bad'); return; }
          if (add <= 0n) { toast('The amount needs to be more than 0 MON.', 'bad'); return; }
          if ((snap?.pool ?? 0n) + add > (snap?.cap ?? CLIP_CAP)) { toast('That deposit would pass the cap.', 'bad'); return; }
          try { if (!(await need())) return; } catch (err) { fail(err); return; }
          setBusy(true);
          try {
            const data = clipDepositData();
            const gas = await pricedGas(pub, account, { to: vault, data, value: add });
            const rc = await send(wallet, { to: vault, data, value: add, gas });
            setLine({ ok: true, text: `Added ${topUp} MON to the pool.`, href: `${net.exp}/tx/${rc.transactionHash}` });
          } catch (err) { fail(err); }
          setBusy(false);
        })(); }}>
          <input data-testid="clip-topup" inputMode="decimal" value={topUp} onChange={e => setTopUp(e.target.value)} placeholder="Add MON" className="min-h-11 w-full min-w-0 flex-1 rounded-xl border border-white/10 bg-black/40 px-3 font-mono text-xs outline-none focus:border-monad" />
          <Btn type="submit" kind="ghost" className="shrink-0">Add to pool</Btn>
        </form>
      )}
      <form className="mt-3 flex min-w-0 flex-col gap-2 sm:flex-row" onSubmit={e => { e.preventDefault(); void usePaste(); }}>
        <input data-testid="clip-address" value={paste} onChange={e => setPaste(e.target.value)} placeholder="Already opened one? Paste 0x…" className="min-h-11 w-full min-w-0 flex-1 rounded-xl border border-white/10 bg-black/40 px-3 font-mono text-xs outline-none focus:border-monad" />
        <Btn type="submit" kind="ghost" className="shrink-0">Use pool</Btn>
      </form>
    </section>
  );
}
