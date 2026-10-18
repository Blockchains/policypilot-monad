'use client';
import { everyVisible } from '../lib/rpcLimit';
import { useEffect, useState } from 'react';
import { formatEther, type Address, type Hex, type PublicClient } from 'viem';
import { ArrowDownToLine, Lock } from 'lucide-react';
import { Btn, Pill, Switch } from './ui';
import { SERVICES, TOKENS, type TokenSym } from '@/lib/services';
import { cashoutPlan, changePct, COLORS, fmtAmt, fmtMon, loadBook, navKey, navUsdc, pctOf, pushSample, PX_KEY, readToks, type Book, type CashStep, type Sample } from '@/lib/portfolio';
import { APP_VAULT_MON, mon, plain, reasonOf, vaultAbi, vcall, type Net, type VaultState } from '@/lib/vault';
import type { SuperVault } from '@/lib/superVaults';

type RunAgent = (s: VaultState, kind: string, amount: bigint, extra?: { to?: Address; venues?: ('uniswap' | 'pancake')[] }) => Promise<{ ok: boolean; msg: React.ReactNode; detail: string }>;
type OwnerTx = (label: string, req: { to: Address; data: Hex; value?: bigint }) => Promise<{ ok: boolean; msg: React.ReactNode }>;

const STEP_TEXT: Record<string, string> = {
  kintsu: 'Stakes MON and keeps the sMON receipt in the vault. This vault cannot unstake — you redeem sMON in Kintsu after cash-out.',
  apriori: 'Stakes MON into aprMON. The share price comes from convertToAssets. Redeem aprMON in aPriori after cash-out.',
  magma: 'Stakes MON into gMON. The share price comes from convertToAssets. Redeem gMON in Magma after cash-out.',
  bestswap: 'Quotes Uniswap v3, PancakeSwap v3 and Kuru, then swaps on the venue that returns the most USDC. The vault enforces minOut = quote − 3%.',
  unwrap: 'Turns any WMON the vault is holding back into native MON.',
  'pay-each': 'Pays the same amount of MON to every approved payee, and stops if the vault runs short.',
  payto: 'Pays MON only to addresses you have approved.',
  wmon: 'Wraps MON into WMON, 1:1, for apps that need the ERC-20.',
};

function workings(s: VaultState, template?: SuperVault): { title: string; steps: { icon: string; title: string; text: string }[] } {
  if (template) {
    return {
      title: `How ${template.name} works`,
      steps: [
        { icon: '📥', title: 'You fund it', text: `One deposit, up to ${APP_VAULT_MON} MON on a new vault. The agent may move at most ${template.cap} MON per action and ${template.budget} MON in total. Output has to come back to the vault.` },
        ...template.playbook.map(st => ({ icon: st.kind === 'pay-each' ? '💸' : '▸', title: st.label, text: STEP_TEXT[st.kind] ?? '' })),
        { icon: '↩️', title: 'You cash out', text: 'MON comes back to your wallet. Receipt tokens come back too, for you to redeem in the protocol’s own app. Closing also pauses the agent.' },
      ],
    };
  }
  const steps: { icon: string; title: string; text: string }[] = [
    { icon: '🛡️', title: 'The policy', text: `Each action is at most ${mon(s.cap)}. The budget is ${mon(s.budget)} and ${mon(s.spent)} is already spent. ${s.paused ? 'The agent is paused.' : 'The agent is live.'}` },
  ];
  for (const id of s.rules) {
    const svc = SERVICES.find(x => x.id === id);
    if (svc) steps.push({ icon: svc.icon, title: svc.name, text: svc.novice });
  }
  if (!s.rules.length) steps.push({ icon: '📭', title: 'Nothing allowlisted', text: 'The agent cannot move funds. You can still withdraw everything below.' });
  steps.push({ icon: '↩️', title: 'You stay the owner', text: 'Only the creator can withdraw MON, pull tokens, change the agent, or pause. The agent cannot call withdraw.' });
  return { title: 'How this vault works', steps };
}

function Delta({ samples }: { samples: Sample[] }) {
  const p = changePct(samples);
  if (p === null) return <span className="text-[11px] text-zinc-500">first sample</span>;
  const up = p > 0.005, down = p < -0.005;
  const cls = up ? 'text-emerald-300' : down ? 'text-rose-300' : 'text-zinc-400';
  return <span className={`font-mono text-[11px] tabular-nums ${cls}`}>{up ? '▲' : down ? '▼' : '●'} {Math.abs(p) < 0.01 && p !== 0 ? p.toFixed(4) : p.toFixed(2)}%</span>;
}

function Spark({ samples, color, testid, label }: { samples: Sample[]; color: string; testid: string; label: string }) {
  const w = 320, h = 76, pad = 6;
  const vs = samples.map(s => s.v);
  const lo = vs.length ? Math.min(...vs) : 0, hi = vs.length ? Math.max(...vs) : 1;
  const Y = (v: number) => (hi === lo ? h / 2 : pad + (1 - (v - lo) / (hi - lo)) * (h - pad * 2));
  const X = (i: number) => (samples.length < 2 ? w / 2 : pad + (i / (samples.length - 1)) * (w - pad * 2));
  let d = '';
  samples.forEach((s, i) => { d += `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(s.v).toFixed(1)} `; });
  const last = samples[samples.length - 1];
  const area = samples.length > 1 ? `${d}L${X(samples.length - 1).toFixed(1)},${h} L${X(0).toFixed(1)},${h} Z` : '';
  const gid = `sg-${testid}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="block h-16 w-full min-w-0 max-w-full" role="img" aria-label={label} data-testid={testid}>
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.45" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {samples.length < 2 && <line x1={pad} x2={w - pad} y1={h / 2} y2={h / 2} stroke={color} strokeOpacity="0.35" strokeDasharray="3 4" />}
      {area && <path d={area} fill={`url(#${gid})`} />}
      {d && <path d={d} fill="none" stroke={color} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />}
      {last && <circle cx={X(samples.length - 1)} cy={samples.length < 2 ? h / 2 : Y(last.v)} r="3.4" fill={color} />}
    </svg>
  );
}

function Donut({ parts }: { parts: { color: string; pct: number }[] }) {
  const r = 38, C = 2 * Math.PI * r;
  let off = 0;
  const segs = parts.filter(p => p.pct > 0);
  return (
    <svg viewBox="0 0 100 100" className="h-24 w-24 shrink-0 -rotate-90" aria-hidden>
      <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="12" />
      {segs.map((p, i) => {
        const len = Math.max(0, C * (p.pct / 100) - (segs.length > 1 ? 1.5 : 0));
        const el = <circle key={i} cx="50" cy="50" r={r} fill="none" stroke={p.color} strokeWidth="12" strokeLinecap="butt" strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-off} />;
        off += C * (p.pct / 100);
        return el;
      })}
    </svg>
  );
}

export default function VaultReport({ s, net, pub, account, template, runAgent, ownerTx, reload, canSign, isOwner, readOnly }: {
  s: VaultState; net: Net; pub: PublicClient; account: Address | null; template?: SuperVault;
  runAgent: RunAgent; ownerTx: OwnerTx; reload: () => void; canSign: boolean; isOwner: boolean; readOnly?: boolean;
}) {
  const mainnet = net.id === 143;
  const [book, setBook] = useState<Book | null>(null);
  const [navSeries, setNavSeries] = useState<Sample[]>([]);
  const [pxSeries, setPxSeries] = useState<Sample[]>([]);
  const [usdcCap, setUsdcCap] = useState<bigint | null>(null);
  const [liveToks, setLiveToks] = useState<Partial<Record<TokenSym, bigint>>>(s.toks);
  const [liveBal, setLiveBal] = useState(s.bal);
  const [pauseAfter, setPauseAfter] = useState(true);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<{ ok: boolean | null; text: string }[]>([]);
  const sig = `${s.v}:${s.bal}:${(Object.keys(TOKENS) as TokenSym[]).map(k => s.toks[k] ?? 0n).join(',')}`;

  useEffect(() => { setLines([]); }, [s.v]);
  useEffect(() => {
    if (!mainnet) { setUsdcCap(0n); return; }
    let on = true;
    pub.readContract({ address: s.v, abi: vaultAbi, functionName: 'tokenCap', args: [TOKENS.USDC.address] }).then(c => { if (on) setUsdcCap(c as bigint); }).catch(() => { if (on) setUsdcCap(0n); });
    return () => { on = false; };
  }, [pub, s.v, mainnet]);
  useEffect(() => {
    let on = true;
    const tick = async () => {
      try {
        let state = s;
        if (mainnet) {
          const [bal, toks] = await Promise.all([pub.getBalance({ address: s.v }), readToks(pub, s.v)]);
          state = { ...s, bal, toks };
          if (on) { setLiveBal(bal); setLiveToks(toks); }
        }
        const next = await loadBook(pub, state, mainnet);
        if (!on) return;
        setBook(next);
        setNavSeries(pushSample(navKey(s.v), Number(formatEther(next.navMon))));
        if (next.usdcPerMon && next.usdcPerMon > 0n) setPxSeries(pushSample(PX_KEY, Number(formatEther(next.usdcPerMon * 10n ** 12n))));
      } catch { /* a quote hiccup just retries on the next tick */ }
    };
    tick();
    // Read-only (team) vaults are background views: poll slower. Both pause while the tab is hidden.
    const off = everyVisible(tick, readOnly ? 60_000 : 20_000);
    return () => { on = false; off(); };
  }, [pub, sig, mainnet]); // eslint-disable-line

  const plan: CashStep[] = cashoutPlan({ rules: s.rules, canSign: canSign && !readOnly, monBal: liveBal, toks: liveToks, usdcCap });
  const empty = plan.length === 0;
  const usd = book ? navUsdc(book.navMon, book.usdcPerMon) : null;
  const parts = (book?.holdings ?? []).filter(h => h.monValue && h.monValue > 0n && book!.navMon > 0n).map(h => ({ color: h.color, pct: pctOf(h.monValue!, book!.navMon), sym: h.sym }));
  const how = workings(s, template);
  const needsAgent = plan.some(p => (p.id === 'usdc' || p.id === 'unwrap') && p.mode === 'run');

  const go = async () => {
    if (busy || readOnly || !isOwner || !account || empty) return;
    setBusy(true); setLines([]);
    const mark = (text: string) => setLines(l => [...l, { ok: null, text }]);
    const done = (ok: boolean, text: string) => setLines(l => { const n = [...l]; n[n.length - 1] = { ok, text }; return n; });
    let resumed = false;
    const restorePause = async () => {
      if (!resumed) return;
      try { await ownerTx('Owner pauses the vault again after a stopped cash-out', vcall(s.v, 'setPaused', [true])); setLines(l => [...l, { ok: true, text: 'Paused the vault again, since cash-out stopped.' }]); } catch { /* the stop reason above is the one that matters */ }
    };
    try {
      const toks0 = mainnet ? await readToks(pub, s.v) : ({} as Record<TokenSym, bigint>);
      const venues = (['uniswap', 'pancake'] as const).filter(id => s.rules.includes(id));
      const cap = mainnet ? await pub.readContract({ address: s.v, abi: vaultAbi, functionName: 'tokenCap', args: [TOKENS.USDC.address] }).catch(() => 0n) as bigint : 0n;
      const usdc = toks0.USDC ?? 0n;
      const canSwap = usdc > 0n && canSign && venues.length > 0 && cap > 0n && usdc <= cap;
      const canUnwrap = (w: bigint) => w > 0n && canSign && s.rules.includes('wmon');
      if (s.paused && (canSwap || canUnwrap(toks0.WMON ?? 0n))) {
        mark('Resuming the agent so it can swap or unwrap…');
        await ownerTx('Owner resumes the agent for cash-out', vcall(s.v, 'setPaused', [false]));
        resumed = true;
        done(true, 'Agent resumed for cash-out.');
      }
      if (canSwap) {
        mark(`Swapping ${fmtAmt(usdc, 6)} USDC back to WMON…`);
        const r = await runAgent(s, 'usdctowmon', usdc, { venues: [...venues] });
        if (!r.ok) { done(false, `Stopped on the USDC swap. ${r.detail}`); await restorePause(); setBusy(false); reload(); return; }
        done(true, r.detail);
      }
      const wmon = mainnet ? (await readToks(pub, s.v)).WMON : 0n;
      if (canUnwrap(wmon)) {
        mark(`Unwrapping ${fmtAmt(wmon, 18, 4)} WMON → MON…`);
        const r = await runAgent(s, 'unwrap', wmon);
        if (!r.ok) { done(false, `Stopped on the unwrap. ${r.detail}`); await restorePause(); setBusy(false); reload(); return; }
        done(true, r.detail);
      }
      if (mainnet) {
        const left = await readToks(pub, s.v);
        for (const sym of Object.keys(TOKENS) as TokenSym[]) {
          const b = left[sym] ?? 0n;
          if (b === 0n) continue;
          mark(`Returning ${fmtAmt(b, TOKENS[sym].decimals)} ${sym} to your wallet…`);
          await ownerTx(`Return ${sym} to the creator`, vcall(s.v, 'withdrawToken', [TOKENS[sym].address, account, b]));
          done(true, `${sym} is in your wallet.${sym === 'sMON' || sym === 'aprMON' || sym === 'gMON' ? ' Redeem it in the protocol’s own app — this vault cannot unstake.' : ''}`);
        }
      }
      const bal = await pub.getBalance({ address: s.v });
      if (bal > 0n) {
        mark(`Sending ${mon(bal)} to your wallet…`);
        await ownerTx(`Cash out ${mon(bal)} to the creator`, vcall(s.v, 'withdraw', [account, bal]));
        done(true, `${mon(bal)} is back in your wallet.`);
      }
      if (pauseAfter) {
        mark('Pausing the agent…');
        await ownerTx('Owner closes the vault (pause)', vcall(s.v, 'setPaused', [true]));
        done(true, 'Vault closed. The agent is paused and can be resumed later.');
      } else if (resumed) {
        setLines(l => [...l, { ok: true, text: 'Left the agent live, because “pause after” is off.' }]);
      }
      setLines(l => [...l, { ok: true, text: 'Cash-out finished. MON and any receipt tokens are back with the creator.' }]);
    } catch (e) {
      setLines(l => {
        const n = [...l];
        const text = `Stopped. ${plain(reasonOf(e))}`;
        if (n.length && n[n.length - 1].ok === null) n[n.length - 1] = { ok: false, text };
        else n.push({ ok: false, text });
        return n;
      });
      await restorePause();
    }
    setBusy(false); reload();
  };

  return (
    <div className="mt-4 min-w-0 max-w-full" data-testid="vault-report">
      <div className="min-w-0 max-w-full rounded-3xl border border-white/10 bg-gradient-to-br from-violet-500/15 via-white/[0.03] to-emerald-400/10 p-4">
        <div className="flex min-w-0 items-center gap-3">
          <Donut parts={parts} />
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-wider text-zinc-400">Estimated value</div>
            <div className="break-words font-mono text-2xl font-semibold tabular-nums text-white" data-testid="nav-mon">{book ? `${fmtMon(book.navMon)} MON` : '…'}</div>
            <div className="mt-0.5 font-mono text-sm tabular-nums text-emerald-200/90" data-testid="nav-usdc">{usd === null ? (mainnet ? 'USDC price loading' : 'Mainnet prices only') : `≈ ${fmtAmt(usd, 6)} USDC`}</div>
            <div className="mt-0.5"><Delta samples={navSeries} /></div>
            <div className="mt-1 break-words text-[11px] text-zinc-500" data-testid="vault-bal">{mon(liveBal)} native{book?.venue ? ` · priced on ${book.venue}` : ''}</div>
          </div>
        </div>
        {book?.hasPar && <p className="mt-2 break-words text-[11px] text-amber-200/80" data-testid="par-note">sMON is counted at par: Kintsu’s contract does not expose an exchange rate. aprMON and gMON use convertToAssets.</p>}
        {!!parts.length && (
          <div className="mt-3" data-testid="allocation">
            <div className="flex h-2.5 overflow-hidden rounded-full bg-white/10">
              {parts.map(p => <div key={p.sym} style={{ width: `${p.pct}%`, background: p.color }} />)}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
              {parts.map(p => (
                <span key={p.sym} data-testid={`alloc-${p.sym}`} className="inline-flex items-center gap-1.5 text-[11px] text-zinc-300">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: p.color }} />{p.sym} {p.pct.toFixed(0)}%
                </span>
              ))}
            </div>
          </div>
        )}
        {mainnet && (
          <div className="mt-3 min-w-0 max-w-full rounded-2xl bg-black/30 p-3">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-[11px] uppercase tracking-wider text-zinc-500">MON / USDC</span>
              <span className="font-mono text-sm tabular-nums text-white" data-testid="price-now">{book?.usdcPerMon ? `${fmtAmt(book.usdcPerMon, 6)} USDC` : '—'}</span>
              <Delta samples={pxSeries} />
            </div>
            <Spark samples={pxSeries} color="#34D399" testid="price-chart" label="MON priced in USDC, sampled in this browser" />
            <div className="grid grid-cols-3 gap-1.5">
              {(book?.venues ?? []).map(v => (
                <div key={v.id} data-testid={`venue-${v.id}`} className={`min-w-0 rounded-xl px-2 py-1.5 ${book?.venue === v.name ? 'bg-emerald-400/10' : 'bg-white/[0.03]'}`}>
                  <div className="truncate text-[10px] text-zinc-500">{v.icon} {v.name}</div>
                  <div className="truncate font-mono text-[11px] tabular-nums text-zinc-200">{v.usdcPerMon ? fmtAmt(v.usdcPerMon, 6) : '—'}</div>
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-baseline gap-2 text-[11px] text-zinc-500"><span className="uppercase tracking-wider">Vault value</span><Delta samples={navSeries} /></div>
            <Spark samples={navSeries} color="#A78BFA" testid="nav-chart" label="Estimated vault value in MON, sampled in this browser" />
            <p className="text-[10px] leading-4 text-zinc-500">Both lines are sampled every 20s while this page is open and saved in this browser. There is no paid price feed and no history from before you opened it. USDC per MON is the best of the live Uniswap, PancakeSwap and Kuru quotes.</p>
          </div>
        )}
      </div>

      <div className="mt-3">
        <div className="mb-1 flex min-w-0 flex-wrap items-center justify-between gap-x-2 text-[11px] text-zinc-500"><span>Budget</span><span className="min-w-0 break-words text-right font-mono tabular-nums">{s.budget > 0n ? `${Math.min(100, Number((s.spent * 1000n) / s.budget) / 10).toFixed(0)}%` : '0%'} · {mon(s.spent)} / {mon(s.budget)}</span></div>
        <div className="h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-violet-400 to-fuchsia-400 transition-all" style={{ width: `${s.budget > 0n ? Math.min(100, Number((s.spent * 1000n) / s.budget) / 10) : 0}%` }} /></div>
        <div className="mt-1 break-words text-[11px] text-zinc-500">Per action ≤ {mon(s.cap)} · agent gas {mon(s.agentBal)}</div>
      </div>

      <div className="mt-4">
        <div className="text-[11px] uppercase tracking-wider text-zinc-500">Inside the vault</div>
        {!book && <div className="mt-2 text-sm text-zinc-500">Reading balances and prices…</div>}
        {book && !book.holdings.length && <p className="mt-2 text-sm text-zinc-400">This vault is empty.</p>}
        <ul className="mt-2 grid gap-2">
          {book?.holdings.map(h => {
            const pct = h.monValue !== null && book.navMon > 0n ? pctOf(h.monValue, book.navMon) : null;
            return (
              <li key={h.sym} data-testid={`holding-${h.sym}`} className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="h-8 w-1 shrink-0 rounded-full" style={{ background: h.color || COLORS.MON }} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-white">{h.sym}</span>
                    <span className="block font-mono text-xs tabular-nums text-zinc-400">{fmtAmt(h.amount, h.decimals)} {h.sym}</span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block font-mono text-sm tabular-nums text-zinc-100">{h.monValue === null ? '—' : `${fmtMon(h.monValue)} MON`}</span>
                    <span className="block text-[11px] text-zinc-500">{pct === null ? 'unpriced' : `${pct.toFixed(1)}%`}</span>
                  </span>
                </div>
                <p className="mt-1.5 break-words text-[11px] leading-4 text-zinc-500">{h.note}</p>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="mt-4" data-testid="how-it-works">
        <div className="text-[11px] uppercase tracking-wider text-zinc-500">{how.title}</div>
        <ol className="mt-2 grid gap-2">
          {how.steps.map((st, i) => (
            <li key={i} className="flex min-w-0 gap-3">
              <span className="relative grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/10 bg-white/5 text-sm">{st.icon}</span>
              <span className="min-w-0 pt-0.5"><span className="block text-sm font-medium text-zinc-100">{st.title}</span>{st.text && <span className="mt-0.5 block break-words text-xs leading-5 text-zinc-400">{st.text}</span>}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="mt-4 rounded-3xl border border-emerald-400/25 bg-emerald-400/[0.04] p-4" data-testid="cashout" data-readonly={readOnly ? '1' : '0'}>
        <div className="flex min-w-0 items-center gap-2">
          <ArrowDownToLine className="h-4 w-4 shrink-0 text-emerald-300" />
          <div className="min-w-0 flex-1 text-sm font-medium text-white">Cash out / close</div>
          {readOnly && <Pill tone="zinc"><Lock className="h-3 w-3" />read-only</Pill>}
        </div>
        <p className="mt-1 break-words text-xs leading-5 text-zinc-400">Returns everything to the creator. MON is withdrawn. WMON is unwrapped first when this browser can sign and the wrap rule is on. USDC is swapped back to MON when a Uniswap or PancakeSwap rule allows it and the amount fits the vault’s approval cap; otherwise the token itself is returned. Staking receipts cannot be unstaked here. Nothing uses the emergency withdraw, which would pause the vault on its own.</p>
        {s.paused && needsAgent && !readOnly && <p className="mt-2 break-words text-[11px] text-amber-200/90">This vault is paused. Cash-out resumes it long enough to unwrap or swap, then pauses it again if the switch below is on.</p>}
        <ol className="mt-3 grid gap-2" data-testid="cashout-preview">
          {plan.map(st => (
            <li key={st.id} data-testid={`cash-${st.id}`} className="min-w-0">
              <div className="flex min-w-0 items-center gap-2 text-sm text-zinc-100"><span className={st.mode === 'run' ? 'text-emerald-300' : 'text-zinc-500'}>{st.mode === 'run' ? '▸' : '○'}</span><span className="min-w-0 break-words">{st.title}</span></div>
              <p className="break-words pl-5 text-[11px] leading-4 text-zinc-500">{st.detail}</p>
            </li>
          ))}
          {empty && <li className="text-sm text-zinc-400">Nothing in this vault to return.</li>}
        </ol>
        <div className="mt-2">
          <Switch testid="cashout-pause" on={pauseAfter} disabled={!!readOnly || busy} onChange={setPauseAfter} label="Pause the agent after" sub="Closes the vault once funds are back. Leave this off to cash out and keep it live." />
        </div>
        <Btn kind="pri" data-testid="cashout-run" disabled={busy || !!readOnly || !isOwner || empty} onClick={go} className="mt-2 w-full whitespace-normal">
          {busy ? 'Working…' : pauseAfter ? 'Close and return funds' : 'Cash out to my wallet'}
        </Btn>
        {readOnly && <p className="mt-2 text-xs text-zinc-400">Read-only. Team agent keys never enter the browser, and only the vault creator can return funds. Open the same vault under Your vaults if this wallet is the owner.</p>}
        {!readOnly && !isOwner && <p className="mt-2 text-xs text-zinc-400">Only the vault creator can cash out.</p>}
        {!readOnly && isOwner && !canSign && !empty && <p className="mt-2 text-xs text-amber-200/80">This browser can’t sign as the agent, so WMON and USDC come back as tokens instead of being unwrapped or swapped. Make your wallet the agent to cash those out as MON.</p>}
        {lines.length > 0 && <ol data-testid="cashout-log" className="mt-3 grid gap-1 text-xs">{lines.map((l, i) => <li key={i} className={`break-words ${l.ok === false ? 'text-red-200' : l.ok ? 'text-emerald-200' : 'text-zinc-300'}`}>{l.ok === false ? '⛔' : l.ok ? '✅' : '…'} {l.text}</li>)}</ol>}
      </div>
    </div>
  );
}
