'use client';
import { useEffect, useRef, useState } from 'react';
import { formatEther, formatUnits, parseEther, type Address, type PublicClient, type WalletClient } from 'viem';
import { AlertTriangle, CheckCircle2, Zap } from 'lucide-react';
import { Btn, receiptClass } from './ui';
import { haptic } from '@/lib/wallets';
import { addLocal, factoryAbi, isUnlimited, MAX_UINT, mon, quoteAll, readVault, sendFault, short, vcall, type Net, type VaultState } from '@/lib/vault';
import { buildSuper, SUPER_VAULTS, type SuperVault } from '@/lib/superVaults';
import { createGas } from '@/lib/fastPath';
import { limitsFor, loadFunders, parseFunder, planSpend, saveFunders, SIGNER_RESERVE, type FundSource } from '@/lib/spend';

type RunAgent = (s: VaultState, kind: string, amount: bigint) => Promise<{ ok: boolean; msg: React.ReactNode; detail: string }>;

const ACTION: Record<SuperVault['id'], { kind: string; target: string; verb: string }> = {
  yield: { kind: 'kintsu', target: 'Kintsu', verb: 'Stake' },
  trader: { kind: 'bestswap', target: 'the best of Uniswap, PancakeSwap and Kuru', verb: 'Swap' },
  payments: { kind: 'pay', target: 'your wallet', verb: 'Pay yourself' },
};

const presetAmount = (t: SuperVault) => String(t.deposit);

function fits(s: VaultState, t: SuperVault) {
  return t.services.every(id => s.rules.includes(id));
}
function canSign(s: VaultState, account: Address | null) {
  return !!(s.key || (account && s.executor.toLowerCase() === account.toLowerCase()));
}

export default function FastDispatch({ net, pub, account, wallet, bal, vaults, need, send, runAgent, loadVaults, loadDetail, refreshHist, toast, ownerTx }: {
  net: Net; pub: PublicClient; account: Address | null; wallet: WalletClient | null; bal: bigint | null;
  vaults: VaultState[] | null; need: () => Promise<boolean>; send: (w: WalletClient, req: { to: Address; data?: `0x${string}`; value?: bigint; gas?: bigint }) => Promise<{ transactionHash: `0x${string}` }>;
  runAgent: RunAgent; loadVaults: () => Promise<void>; loadDetail?: (v: Address) => Promise<void>; refreshHist: () => void; toast: (m: React.ReactNode, k?: 'ok' | 'bad' | 'info') => void;
  ownerTx: (label: string, req: { to: Address; data: `0x${string}`; value?: bigint }) => Promise<unknown>;
}) {
  const [preset, setPreset] = useState<SuperVault>(SUPER_VAULTS[0]);
  const [vaultId, setVaultId] = useState<string>('new');
  const [amount, setAmount] = useState(presetAmount(SUPER_VAULTS[0]));
  const [source, setSource] = useState<FundSource>('vault');
  const [funders, setFunders] = useState({ balancer: '', deployer: '' });
  const [funderBal, setFunderBal] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<{ ok: boolean; pending?: boolean; text: string; href?: string } | null>(null);
  const [best, setBest] = useState<string | null>(null);
  const userPicked = useRef(false);
  const amountTyped = useRef(false);
  useEffect(() => { setFunders(loadFunders()); }, []);
  const action = ACTION[preset.id];
  const matches = (vaults ?? []).filter(s => fits(s, preset));
  const selected = vaultId === 'new' ? null : matches.find(s => s.v.toLowerCase() === vaultId.toLowerCase()) ?? null;
  const mainnet = net.id === 143;
  useEffect(() => { if (selected && !selected.full) loadDetail?.(selected.v); }, [selected?.v, selected?.full]); // eslint-disable-line

  useEffect(() => { userPicked.current = false; amountTyped.current = false; setAmount(presetAmount(preset)); setLine(null); setBest(null); }, [preset.id]);
  const funderRaw = source === 'vault' ? '' : funders[source];
  const funder = source === 'vault' ? null : parseFunder(funderRaw);
  const isOwner = selected ? !!(account && selected.owner.toLowerCase() === account.toLowerCase()) : !!account;
  const funderConnected = !!(funder && account && funder.toLowerCase() === account.toLowerCase());
  const cap = selected ? selected.cap : MAX_UINT; // new (v4) vaults: no cap
  const gate = planSpend({
    mainnet, account: !!account, mode: selected ? 'run' : 'create', amount,
    cap, budget: selected?.budget ?? MAX_UINT, spent: selected?.spent ?? 0n,
    bal: selected?.bal ?? 0n, vaultCap: selected?.vaultCap ?? MAX_UINT,
    paused: !!selected?.paused, canSign: selected ? canSign(selected, account) : true, isOwner,
    source, funder, funderConnected, funderBal: funderBal ?? 0n,
  });
  const CREATE_GAS_KEEP = parseEther('0.3'); // left in the wallet for the ~0.23 MON creation gas
  const maxWei = selected ? gate.maxWei : bal != null && bal > CREATE_GAS_KEEP ? bal - CREATE_GAS_KEEP : 0n;

  useEffect(() => {
    if (!funder) { setFunderBal(null); return; }
    let on = true;
    pub.getBalance({ address: funder }).then(b => { if (on) setFunderBal(b); }).catch(() => { if (on) setFunderBal(null); });
    return () => { on = false; };
  }, [funder, pub, bal]);
  useEffect(() => {
    if (amountTyped.current) return;
    if (!selected) { setAmount(presetAmount(preset)); return; }
    setAmount(maxWei > 0n ? formatEther(maxWei) : '0');
  }, [preset.id, selected, maxWei]);
  useEffect(() => {
    if (userPicked.current) return;
    const ranked = (list: VaultState[]) => list.sort((a, b) => (a.bal > b.bal ? -1 : 1));
    const live = ranked((vaults ?? []).filter(s => fits(s, preset) && !s.paused && s.bal > 0n));
    const paused = ranked((vaults ?? []).filter(s => fits(s, preset) && s.paused));
    setVaultId(live[0]?.v ?? paused[0]?.v ?? 'new');
  }, [preset.id, vaults]);

  useEffect(() => {
    if (preset.id !== 'trader' || !selected) { setBest(null); return; }
    let on = true;
    const t = setTimeout(() => {
      let wei = 0n; try { wei = parseEther(amount || '0'); } catch { return; }
      if (wei === 0n) return;
      quoteAll(pub, selected.v, wei).then(qs => {
        if (!on) return;
        const ok = qs.filter(q => q.out && q.out > 0n);
        const top = ok.reduce<(typeof ok)[number] | null>((a, b) => (!a || b.out! > a.out! ? b : a), null);
        setBest(top ? `${top.name} · ${Number(formatUnits(top.out!, 6)).toFixed(6)} USDC` : 'No venue quoted this amount');
      }).catch(() => on && setBest(null));
    }, 280);
    return () => { on = false; clearTimeout(t); };
  }, [preset.id, selected?.v, amount, pub]);

  const pickPreset = (t: SuperVault) => { haptic(); setPreset(t); };
  const pickVault = (id: string) => { haptic(); userPicked.current = true; amountTyped.current = false; setVaultId(id); setLine(null); };
  const writeFunder = (id: 'balancer' | 'deployer', value: string) => {
    const next = { ...funders, [id]: value };
    setFunders(next); saveFunders(next); setLine(null);
  };

  const note = (e: unknown) => {
    const f = sendFault(e);
    setLine({ ok: false, pending: f.pending, text: f.text });
    toast(f.text, f.pending ? 'info' : 'bad');
  };
  const create = async () => {
    try { if (!(await need()) || !account || !wallet) return; }
    catch (e) { note(e); return; }
    setBusy(true); setLine(null);
    try {
      const dep = parseEther(amount || '0'); // any amount the user typed (0 is fine)
      const c = buildSuper(preset, account, [], Number(formatEther(dep)));
      await pub.call({ account, to: net.factory, data: c.data, value: c.value });
      const rc = await send(wallet, { to: net.factory, data: c.data, value: c.value, gas: await createGas(pub, account, { to: net.factory, data: c.data, value: c.value }) });
      addLocal(net, { label: `${preset.name} created${dep > 0n ? ` + ${formatEther(dep)} MON deposited` : ''} (1 tx)`, kind: 'owner', tx: rc.transactionHash, from: account });
      const list = await pub.readContract({ address: net.factory, abi: factoryAbi, functionName: 'vaultsOf', args: [account] }) as Address[];
      const v = list[list.length - 1];
      localStorage.setItem(`pp.super.${v.toLowerCase()}`, preset.id);
      await loadVaults(); refreshHist();
      setVaultId(v);
      setLine({ ok: true, text: `${preset.name} is live${dep > 0n ? ` with ${formatEther(dep)} MON` : ''}. Tap Dispatch to send the first action.`, href: `${net.exp}/tx/${rc.transactionHash}` });
      haptic(20);
    } catch (e) { note(e); }
    setBusy(false);
  };

  const go = async () => {
    if (busy) return;
    if (gate.code === 'connect') { try { await need(); } catch (e) { note(e); } return; }
    if (!gate.ok) return;
    if (gate.code === 'create') { await create(); return; }
    if (!selected || !account) return;
    setBusy(true); setLine(null);
    try {
      let live = selected;
      const wei = parseEther(amount);
      if (gate.pull > 0n) {
        setLine({ ok: true, pending: true, text: `Depositing ${formatEther(gate.pull)} MON from the ${source} wallet…` });
        await ownerTx(`Deposit ${formatEther(gate.pull)} MON from the ${source} wallet`, { ...vcall(live.v, 'deposit', []), value: gate.pull });
        live = await readVault(pub, net, live.v);
      }
      const raise = limitsFor(live, wei);
      if (raise.cap != null) {
        setLine({ ok: true, pending: true, text: 'Raising this older vault’s per-action cap to its on-chain vault cap…' });
        await ownerTx('Owner raises the per-action cap to the vault cap', vcall(live.v, 'setPerPaymentCap', [raise.cap]));
        live = { ...live, cap: raise.cap };
      }
      if (raise.budget != null) {
        setLine({ ok: true, pending: true, text: 'Raising this older vault’s budget…' });
        await ownerTx('Owner raises the budget to cover the vault cap', vcall(live.v, 'setBudget', [raise.budget]));
        live = { ...live, budget: raise.budget };
      }
      if (gate.pull > 0n || raise.cap != null || raise.budget != null) live = await readVault(pub, net, live.v);
      const r = await runAgent(live, action.kind, wei);
      setLine({ ok: r.ok, text: r.detail });
      toast(r.msg, r.ok ? 'ok' : 'bad');
      if (r.ok) { await loadVaults(); refreshHist(); }
    } catch (e) { note(e); }
    setBusy(false);
  };

  const button = gate.code === 'connect' ? 'Connect wallet'
    : gate.code === 'create' ? `Create vault · ${amount || '0'} MON`
    : gate.code === 'sim' ? 'Check (no send)'
    : gate.pull > 0n && gate.lift ? 'Fund, raise limit, dispatch'
    : gate.pull > 0n ? 'Fund and dispatch'
    : gate.lift ? 'Raise limit and dispatch'
    : '1-click dispatch';

  return (
    <section id="desk-dispatch" data-testid="fast-dispatch" className="min-w-0 scroll-mt-16 rounded-[2rem] border border-white/10 bg-white/[0.03] p-4 sm:p-5">
      <div className="mb-4 flex min-w-0 flex-wrap items-center gap-2">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-monad/20 text-violet-200"><Zap className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-white">Three taps</h2>
          <p className="text-xs text-zinc-400">A preset, a vault, then one real action. Add MON to a balancer or deployer wallet when the vault needs a larger size.</p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="min-w-0">
          <div className="mb-2 text-[11px] uppercase tracking-wider text-zinc-500">1 · Preset</div>
          <div className="grid gap-2">
            {SUPER_VAULTS.map(t => {
              const on = preset.id === t.id;
              return (
                <button key={t.id} type="button" data-testid={`preset-${t.id}`} onClick={() => pickPreset(t)} className={`min-w-0 rounded-2xl border p-3 text-left transition active:scale-[0.99] ${on ? 'border-monad bg-monad/10' : 'border-white/10 bg-white/[0.02]'}`}>
                  <div className="flex min-w-0 items-center gap-2"><span className="text-lg">{t.emoji}</span><span className="min-w-0 flex-1 truncate font-medium text-zinc-50">{t.name}</span></div>
                  <p className="mt-1 break-words text-xs text-zinc-400">{t.tagline}</p>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-zinc-300"><span>No spending limits</span><span>Deposit any amount</span></div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="min-w-0">
          <div className="mb-2 text-[11px] uppercase tracking-wider text-zinc-500">2 · Vault</div>
          <div className="grid max-h-80 gap-2 overflow-y-auto">
            <button type="button" data-testid="vault-new" onClick={() => pickVault('new')} className={`min-w-0 rounded-2xl border border-dashed p-3 text-left transition active:scale-[0.99] ${vaultId === 'new' ? 'border-monad bg-monad/10' : 'border-white/15 bg-white/[0.02]'}`}>
              <div className="font-medium text-zinc-50">New {preset.name}</div>
              <p className="mt-1 break-words text-xs text-zinc-400">Create and deposit the amount you type (any amount, 0 is fine) in one transaction. Your wallet is the agent. No spending limits or allowlists: it can move all of the vault’s funds. Creation gas is the estimate plus 10% (about 0.23 MON at 100 gwei; Monad charges the whole limit).</p>
            </button>
            {!account && <p className="text-xs text-zinc-500">Connect to see vaults you already own.</p>}
            {account && !vaults && <p className="text-xs text-zinc-500">Loading your vaults…</p>}
            {matches.map(s => {
              const on = selected?.v === s.v;
              const unl = isUnlimited(s.budget); const pct = s.budget > 0n && !unl ? Math.min(100, Number((s.spent * 1000n) / s.budget) / 10) : 0;
              const left = s.budget > s.spent ? s.budget - s.spent : 0n;
              const low = !unl && s.budget > 0n && left * 5n < s.budget;
              const dot = s.paused ? 'bg-red-500 shadow-[0_0_10px_#ef4444]' : low ? 'bg-amber-400 shadow-[0_0_10px_#fbbf24]' : 'bg-emerald-400 shadow-[0_0_10px_#34d399]';
              return (
                <button key={s.v} type="button" data-testid="vault-choice" onClick={() => pickVault(s.v)} className={`min-w-0 rounded-2xl border p-3 text-left transition active:scale-[0.99] ${on ? 'border-monad bg-monad/10' : 'border-white/10 bg-white/[0.02]'}`}>
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-50">Vault {short(s.v)}</span>
                    <span className="shrink-0 font-mono text-[11px] text-zinc-300">{mon(s.bal)}</span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-violet-400 to-fuchsia-400" style={{ width: `${pct}%` }} /></div>
                  <div className="mt-1 flex min-w-0 justify-between gap-2 text-[11px] text-zinc-500"><span className="min-w-0 truncate">{unl ? 'No spending limits' : `${mon(left)} budget left`}</span><span className="shrink-0">{s.paused ? 'Paused' : low ? 'Low' : 'Live'}</span></div>
                </button>
              );
            })}
            {account && vaults && !matches.length && <p className="text-xs text-zinc-500">None of your vaults have this preset’s services. Create one above.</p>}
          </div>
        </div>

        <div className="flex min-w-0 flex-col">
          <div className="mb-2 text-[11px] uppercase tracking-wider text-zinc-500">3 · Dispatch</div>
          <div className="flex flex-1 flex-col gap-3 rounded-2xl border border-white/10 bg-black/30 p-3">
            <div className="break-words text-sm text-zinc-200">{action.verb} on {action.target}</div>
            <div data-testid="fund-sources" className="grid min-w-0 gap-2">
              <div className="text-[11px] uppercase tracking-wider text-zinc-500">Funds</div>
              <div className="grid grid-cols-3 gap-1">
                {(['vault', 'balancer', 'deployer'] as const).map(id => (
                  <button key={id} type="button" data-testid={`fund-${id}`} onClick={() => { haptic(); amountTyped.current = false; setSource(id); setLine(null); }} className={`min-w-0 truncate rounded-xl border px-1 py-2 text-[11px] capitalize ${source === id ? 'border-monad bg-monad/15 text-white' : 'border-white/10 text-zinc-400'}`}>{id}</button>
                ))}
              </div>
              {source !== 'vault' && (
                <label className="grid min-w-0 gap-1 text-xs text-zinc-400">
                  <span className="flex min-w-0 items-center justify-between gap-2"><span className="shrink-0">Address</span>
                    <span className="flex shrink-0 gap-1">
                      {funder && <button type="button" data-testid="fund-copy" onClick={() => { navigator.clipboard?.writeText(funder); toast('Address copied. Send MON to it, then connect it.', 'info'); }} className="rounded-full border border-white/15 px-2 py-1 text-[11px] text-violet-200">Copy</button>}
                      <button type="button" data-testid="fund-use" disabled={!account} onClick={() => account && writeFunder(source, account)} className="rounded-full border border-white/15 px-2 py-1 text-[11px] text-violet-200 disabled:opacity-40">Use connected</button>
                    </span>
                  </span>
                  <input data-testid="fund-address" value={funders[source]} onChange={e => writeFunder(source, e.target.value)} placeholder="0x… wallet you add MON to" spellCheck={false} className="min-h-11 w-full min-w-0 rounded-xl border border-white/10 bg-black/40 px-3 font-mono text-xs text-white outline-none focus:border-monad" />
                  <span className="break-words text-[11px] text-zinc-500">{funder ? `${funderConnected ? 'Connected' : 'Not connected'} · ${funderBal == null ? 'reading balance…' : mon(funderBal)}.` : 'Paste the wallet you will add MON to.'} Dispatch keeps {mon(SIGNER_RESERVE)} on it for gas and deposits only when that wallet owns the vault.</span>
                </label>
              )}
            </div>
            <label className="grid gap-1 text-xs text-zinc-400"><span className="flex min-w-0 items-center justify-between gap-2"><span>Amount (MON)</span><button type="button" data-testid="dispatch-max" onClick={() => { amountTyped.current = false; setAmount(formatEther(maxWei)); setLine(null); }} className="shrink-0 rounded-full border border-white/15 px-2 py-1 text-[11px] text-violet-200">Max {mon(maxWei, 6)}</button></span>
              <input data-testid="dispatch-amount" inputMode="decimal" value={amount} onChange={e => { amountTyped.current = true; setAmount(e.target.value); setLine(null); }} className="min-h-12 w-full min-w-0 rounded-xl border border-white/10 bg-black/40 px-3 font-mono text-base text-white outline-none focus:border-monad" />
            </label>
            <div className="break-words text-[11px] text-zinc-500">{!selected || (isUnlimited(selected.cap) && isUnlimited(selected.vaultCap)) ? (selected ? 'No per-action cap, budget or vault cap: only the vault balance limits this.' : 'Amount = the deposit for the new vault. It will have no spending limits.') : `Older vault: cap ${mon(selected.cap)} · vault cap ${mon(selected.vaultCap)} · budget ${mon(selected.budget)}`}</div>
            {best && <div data-testid="dispatch-quote" className="break-words text-xs text-emerald-200">Best quote: {best}</div>}
            <div data-testid="dispatch-gate" data-code={gate.code} className={`flex min-w-0 items-start gap-2 rounded-xl px-1 text-sm ${gate.ok ? 'text-emerald-300' : 'text-rose-300'}`}>
              {gate.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
              <span className="min-w-0"><span className="font-mono text-xs">{gate.label}</span><span className="mt-0.5 block break-words text-[11px] text-zinc-400">{gate.detail}</span></span>
            </div>
            {bal != null && account && vaultId === 'new' && (() => { try { return bal < parseEther(amount || '0'); } catch { return false; } })() && <p className="break-words text-[11px] text-amber-200">Your wallet has {mon(bal)}. Creating this vault deposits {amount} MON.</p>}
            <Btn kind="pri" data-testid="dispatch-go" disabled={busy || (!gate.ok && gate.code !== 'connect')} onClick={go} className="mt-auto h-14 w-full text-base">{busy ? 'Working…' : button}</Btn>
          </div>
          {line && <div data-testid="dispatch-receipt" className={`mt-3 break-words rounded-2xl border p-3 text-xs ${receiptClass(line)}`}>{line.text}{line.href && <> <a className="underline" href={line.href} target="_blank" rel="noreferrer">tx ↗</a></>}</div>}
        </div>
      </div>
    </section>
  );
}
