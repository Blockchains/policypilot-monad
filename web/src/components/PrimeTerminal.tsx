'use client';
import { useEffect, useState } from 'react';
import { formatEther, getAddress, isAddress, parseEther, type Address, type PublicClient, type WalletClient } from 'viem';
import { AlertTriangle, CheckCircle2, Lock, Shield, Zap } from 'lucide-react';
import { Btn, receiptClass } from './ui';
import { haptic } from '@/lib/wallets';
import { addLocal, mon, notSent, sendFault, short, type Net } from '@/lib/vault';
import { BREAKER_BPS, explainPrime, FEE_BPS, primeAbi, primeDeployData, primeDepositData, primeGasKeep, primeGate, primeWithdrawData, PRIME_CAP, PRIME_HOP, SENIOR_PROFIT_BPS, trancheAssets, type TrancheId } from '@/lib/prime';
import { GAS } from '@/lib/fastPath';
import { openDesk } from '@/lib/desk';

const GAS_KEEP = primeGasKeep;

type Snap = {
  nav: bigint; hwm: bigint; halted: boolean; cap: bigint; ceiling: bigint; drawdown: bigint;
  senior: bigint; junior: bigint; yours: Record<TrancheId, bigint>; shares: Record<TrancheId, bigint>;
};

const CHOICES: { id: TrancheId; title: string; line: string; take: string }[] = [
  { id: 0, title: 'Capital Protected', line: 'Paid 30% of each profit. Loses MON only after the alpha tranche is wiped out.', take: 'Protected' },
  { id: 1, title: 'Max Alpha', line: 'Takes the first loss. Receives the other 70% of each profit.', take: 'Alpha' },
];

export default function PrimeTerminal({ net, pub, account, wallet, bal, need, send, toast, block }: {
  net: Net; pub: PublicClient; account: Address | null; wallet: WalletClient | null; bal: bigint | null;
  need: () => Promise<boolean>;
  send: (w: WalletClient, req: { to?: Address; data?: `0x${string}`; value?: bigint; gas?: bigint }) => Promise<{ transactionHash: `0x${string}`; contractAddress?: Address | null }>;
  toast: (m: React.ReactNode, k?: 'ok' | 'bad' | 'info') => void; block: bigint | null;
}) {
  const [tranche, setTranche] = useState<TrancheId>(0);
  const [amount, setAmount] = useState('0.05');
  const [vault, setVault] = useState<Address | null>(null);
  const [snap, setSnap] = useState<Snap | null>(null);
  const [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState('');
  const [line, setLine] = useState<{ ok: boolean; pending?: boolean; text: string; href?: string } | null>(null);
  const key = account ? `pp.prime.${net.id}.${account.toLowerCase()}` : '';

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
      if (!code || code === '0x') {
        if (key) localStorage.removeItem(key);
        setVault(null);
        return;
      }
      const c = { address: vault, abi: primeAbi };
      const who = account ?? '0x0000000000000000000000000000000000000000';
      const [senior, junior, hwm, halted, cap, ceiling, drawdown, yS, yJ, shS, shJ] = await Promise.all([
        pub.readContract({ ...c, functionName: 'seniorTranche' }),
        pub.readContract({ ...c, functionName: 'juniorTranche' }),
        pub.readContract({ ...c, functionName: 'highWatermark' }),
        pub.readContract({ ...c, functionName: 'isEmergencyHalted' }),
        pub.readContract({ ...c, functionName: 'vaultCap' }),
        pub.readContract({ ...c, functionName: 'hopCeiling' }),
        pub.readContract({ ...c, functionName: 'drawdownBps' }),
        pub.readContract({ ...c, functionName: 'assetsOf', args: [who, 0] }),
        pub.readContract({ ...c, functionName: 'assetsOf', args: [who, 1] }),
        pub.readContract({ ...c, functionName: 'userShares', args: [who, 0] }),
        pub.readContract({ ...c, functionName: 'userShares', args: [who, 1] }),
      ]) as [unknown, unknown, bigint, boolean, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
      if (!on) return;
      const s = trancheAssets(senior);
      const j = trancheAssets(junior);
      setSnap({
        nav: s + j, hwm, halted, cap, ceiling, drawdown, senior: s, junior: j,
        yours: { 0: yS, 1: yJ }, shares: { 0: shS, 1: shJ },
      });
    })().catch(() => { if (on) setSnap(null); });
    return () => { on = false; };
  }, [vault, pub, account, block, key]);

  const nav = snap?.nav ?? 0n;
  const cap = snap?.cap ?? PRIME_CAP;
  const halted = !!snap?.halted || (snap != null && snap.drawdown >= BigInt(BREAKER_BPS));
  const gate = primeGate({ account: !!account, vault: !!vault, halted, amount, nav, cap, walletBal: bal });
  const choice = CHOICES[tranche];
  const juniorPct = nav > 0n ? Math.min(100, Number((snap!.junior * 1000n) / nav) / 10) : 0;
  const low = !!snap && snap.drawdown > BigInt(BREAKER_BPS) / 2n;
  const dot = !vault ? 'bg-zinc-500' : halted ? 'bg-red-500 shadow-[0_0_10px_#ef4444]' : low ? 'bg-amber-400 shadow-[0_0_10px_#fbbf24]' : 'bg-emerald-400 shadow-[0_0_10px_#34d399]';
  const status = !vault ? 'Not opened' : halted ? 'Halted' : low ? 'Near the floor' : 'Live';

  const remember = (a: Address) => { if (key) localStorage.setItem(key, a); setVault(a); };
  const fail = (e: unknown) => {
    const f = sendFault(e);
    const decoded = explainPrime(e, '');
    const text = decoded ? notSent(e, decoded) : f.text;
    setLine({ ok: false, pending: f.pending, text });
    toast(text, f.pending ? 'info' : 'bad');
  };

  const go = async () => {
    if (gate.code === 'connect') { try { await need(); } catch (e) { fail(e); } return; }
    if (!gate.ok || !account || !wallet) return;
    setBusy(true); setLine(null);
    const wei = parseEther(amount);
    try {
      if (!vault) {
        // Open through the desk factory (an ordinary call: wallets keep its gas limit), then deposit. Both are simulated first.
        const r = await openDesk({ chainId: net.id, pub, account, wallet, send: send as any, kind: 'prime', initcode: primeDeployData(account, account, account, tranche), value: wei, depositData: primeDepositData(tranche), onOpened: a => remember(a) });
        addLocal(net, { label: `Opened a prime vault${r.depositTx ? ` and deposited ${amount} MON into ${choice.take}` : ''}`, kind: 'owner', tx: r.depositTx ?? r.openTx, from: account });
        const href = `${net.exp}/tx/${r.depositTx ?? r.openTx}`;
        setLine({ ok: true, text: `Opened ${short(r.vault)} and deposited ${amount} MON into ${choice.take}.`, href });
        toast(<>Vault opened and funded. <a className="underline" href={href} target="_blank" rel="noreferrer">View tx ↗</a></>, 'ok');
      } else {
        const rc = await send(wallet, { to: vault, data: primeDepositData(tranche), value: wei, gas: GAS.primeDeposit }); // simulated first in send()
        addLocal(net, { label: `Deposited ${amount} MON into ${choice.take}`, kind: 'owner', tx: rc.transactionHash, from: account });
        const href = `${net.exp}/tx/${rc.transactionHash}`;
        setLine({ ok: true, text: `Deposited ${amount} MON into ${choice.take}.`, href });
        toast(<>Deposited. <a className="underline" href={href} target="_blank" rel="noreferrer">View tx ↗</a></>, 'ok');
      }
      haptic([10, 40, 10] as any);
    } catch (e) { fail(e); }
    setBusy(false);
  };

  const withdraw = async () => {
    if (!vault || !wallet || !account || !snap || snap.shares[tranche] === 0n) return;
    try { if (!(await need())) return; } catch (e) { fail(e); return; }
    setBusy(true); setLine(null);
    try {
      const rc = await send(wallet, { to: vault, data: primeWithdrawData(tranche, snap.shares[tranche]), gas: GAS.primeWithdraw });
      addLocal(net, { label: `Withdrew ${choice.take}`, kind: 'owner', tx: rc.transactionHash, from: account });
      const href = `${net.exp}/tx/${rc.transactionHash}`;
      setLine({ ok: true, text: `Withdrew your ${choice.take} tranche.`, href });
      toast(<>Withdrawn. <a className="underline" href={href} target="_blank" rel="noreferrer">View tx ↗</a></>, 'ok');
    } catch (e) { fail(e); }
    setBusy(false);
  };

  const usePaste = async () => {
    if (!account) { await need(); return; }
    if (!isAddress(paste.trim())) { toast('Paste the vault address, starting with 0x.', 'bad'); return; }
    const a = getAddress(paste.trim());
    const code = await pub.getCode({ address: a }).catch(() => '0x');
    if (!code || code === '0x') { toast('That address has no contract on this network.', 'bad'); return; }
    try { await pub.readContract({ address: a, abi: primeAbi, functionName: 'vaultCap' }); }
    catch { toast('That contract is not a PolicyPilot prime vault.', 'bad'); return; }
    remember(a); setPaste('');
    toast(`Using vault ${short(a)}.`, 'ok');
  };

  const button = gate.code === 'connect' ? 'Connect wallet' : gate.code === 'halt' ? 'Trading halted' : !gate.ok ? 'Deposit blocked' : `Deposit into ${choice.take}`;

  return (
    <section id="desk-prime" data-testid="prime-terminal" className="min-w-0 scroll-mt-16 rounded-[2rem] border border-white/10 bg-white/[0.03] p-4 sm:p-5">
      <div className="mb-4 flex min-w-0 flex-wrap items-center gap-2">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-sky-400/15 text-sky-200"><Shield className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-white">Prime</h2>
          <p className="break-words text-xs text-zinc-400">Two choices. Protected is paid first and loses last. Alpha takes the first loss and the rest of the profit. No promised rate.</p>
        </div>
        <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-white/10 bg-black/30 px-2.5 py-1 text-[11px] text-zinc-300">
          <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />{status}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {CHOICES.map(c => {
          const on = tranche === c.id;
          const Icon = c.id === 0 ? Shield : Zap;
          const yours = snap?.yours[c.id] ?? 0n;
          const pool = c.id === 0 ? snap?.senior ?? 0n : snap?.junior ?? 0n;
          return (
            <button key={c.id} type="button" data-testid={c.id === 0 ? 'tranche-senior' : 'tranche-junior'} aria-pressed={on} onClick={() => { haptic(); setTranche(c.id); setLine(null); }}
              className={`min-w-0 rounded-2xl border p-3 text-left transition active:scale-[0.99] ${on ? 'border-monad bg-monad/10' : 'border-white/10 bg-white/[0.02]'}`}>
              <div className="flex min-w-0 items-center gap-2">
                <Icon className={`h-4 w-4 shrink-0 ${c.id === 0 ? 'text-sky-300' : 'text-violet-300'}`} />
                <span className="min-w-0 flex-1 truncate font-medium text-zinc-50">{c.title}</span>
                <span className="shrink-0 font-mono text-[11px] text-zinc-300">{c.id === 0 ? '30% of profit' : '70% of profit'}</span>
              </div>
              <p className="mt-1 break-words text-xs text-zinc-400">{c.line}</p>
              <div className="mt-2 flex min-w-0 flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-zinc-300">
                <span>Yours {mon(yours)}</span>
                <span>Pool {mon(pool)}</span>
              </div>
            </button>
          );
        })}
      </div>

      {nav > 0n && (
        <div className="mt-3 min-w-0">
          <div className="mb-1 flex min-w-0 justify-between gap-2 text-[11px] text-zinc-500"><span className="min-w-0">Alpha buffer</span><span className="shrink-0">{juniorPct.toFixed(1)}% of the pool</span></div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-sky-400 to-violet-400" style={{ width: `${juniorPct}%` }} /></div>
        </div>
      )}

      <div className="mt-3 flex min-w-0 flex-wrap gap-2 text-[11px] text-zinc-400">
        <span className="rounded-full bg-black/30 px-2 py-1">Pool {mon(nav)}</span>
        <span className="rounded-full bg-black/30 px-2 py-1">Watermark {mon(snap?.hwm ?? 0n)}</span>
        <span className="rounded-full bg-black/30 px-2 py-1">Drawdown {snap ? (Number(snap.drawdown) / 100).toFixed(2) : '0.00'}% / {(BREAKER_BPS / 100).toFixed(2)}%</span>
        <span className="rounded-full bg-black/30 px-2 py-1">Hop ceiling {mon(snap?.ceiling ?? PRIME_HOP)}</span>
        {vault && <span className="max-w-full break-all rounded-full bg-black/30 px-2 py-1 font-mono">{short(vault)}</span>}
      </div>

      <div className="mt-4 grid grid-cols-1 items-end gap-3 md:grid-cols-2">
        <label className="grid min-w-0 gap-1 text-xs text-zinc-400"><span className="flex min-w-0 items-center justify-between gap-2"><span>Deposit (MON)</span><button type="button" data-testid="prime-max" onClick={() => { const room = cap > nav ? cap - nav : 0n; const spend = bal != null ? (bal > GAS_KEEP(!vault) ? bal - GAS_KEEP(!vault) : 0n) : room; const maxDep = spend < room ? spend : room; setAmount(formatEther(maxDep)); setLine(null); }} className="shrink-0 rounded-full border border-white/15 px-2 py-1 text-[11px] text-violet-200">Max</button></span>
          <input data-testid="prime-amount" inputMode="decimal" value={amount} onChange={e => { setAmount(e.target.value); setLine(null); }} className="min-h-12 w-full min-w-0 rounded-xl border border-white/10 bg-black/40 px-3 font-mono text-base text-white outline-none focus:border-monad" />
        </label>
        <div className="min-w-0">
          <div data-testid="prime-gate" data-code={gate.code} className={`mb-2 flex min-w-0 items-start gap-2 text-sm ${gate.ok ? 'text-emerald-300' : 'text-rose-300'}`}>
            {gate.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
            <span className="min-w-0"><span className="font-mono text-xs">{gate.label}</span><span className="mt-0.5 block break-words text-[11px] text-zinc-400">{gate.detail}</span></span>
          </div>
          <Btn kind="pri" data-testid="prime-go" disabled={busy || (!gate.ok && gate.code !== 'connect')} onClick={go} className="h-14 w-full text-base">{busy ? 'Working…' : button}</Btn>
        </div>
      </div>

      {snap && snap.shares[tranche] > 0n && (
        <Btn kind="ghost" data-testid="prime-withdraw" disabled={busy} onClick={withdraw} className="mt-3 w-full">Withdraw {mon(snap.yours[tranche])} from {choice.take}</Btn>
      )}

      {line && <div data-testid="prime-receipt" className={`mt-3 break-words rounded-2xl border p-3 text-xs ${receiptClass(line)}`}>{line.text}{line.href && <> <a className="underline" href={line.href} target="_blank" rel="noreferrer">tx ↗</a></>}</div>}

      <details className="mt-4 min-w-0 rounded-2xl bg-black/20 p-3 text-xs text-zinc-400">
        <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-zinc-300"><Lock className="h-3.5 w-3.5 shrink-0" />How the pool protects the two tranches</summary>
        <div className="mt-2 grid gap-2 break-words">
          <p>Junior MON is the only cushion. A loss reduces the alpha tranche first. Protected MON drops only after alpha is at zero. There is no outside guarantee.</p>
          <p>Each hop can move the whole pool, and never more than {mon(PRIME_HOP)} on a vault opened here. A hop that loses more than 0.05 MON reverts. A smaller loss still settles. If the pool falls {BREAKER_BPS / 100}% under its high watermark, new hops and deposits stop. Withdrawals stay open.</p>
          <p>The performance fee is {FEE_BPS / 100}% of gains above the high watermark, paid to the treasury chosen when the vault was opened (your wallet, for a vault you open here). Principal is not charged. {SENIOR_PROFIT_BPS / 100}% of what remains goes to Protected and the rest to Alpha.</p>
          <p>The cap is {mon(cap)}. This contract is alpha and unaudited. Deposit only what you can lose.</p>
          <form className="flex min-w-0 flex-col gap-2 sm:flex-row" onSubmit={e => { e.preventDefault(); void usePaste(); }}>
            <input data-testid="prime-address" value={paste} onChange={e => setPaste(e.target.value)} placeholder="Already opened one? Paste 0x…" className="min-h-11 w-full min-w-0 flex-1 rounded-xl border border-white/10 bg-black/40 px-3 font-mono text-xs outline-none focus:border-monad" />
            <Btn type="submit" kind="ghost" className="shrink-0">Use vault</Btn>
          </form>
        </div>
      </details>
    </section>
  );
}
