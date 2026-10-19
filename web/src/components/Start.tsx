'use client';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { formatEther, parseEther, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { ArrowLeft, Check, ChevronRight, Loader2, RotateCcw } from 'lucide-react';
import { Btn, Card, Pill } from './ui';
import { DEFAULT_GAS_PRICE, GOALS, maxAmount, review, risksFor, strategyFor, type Goal, type Risk, type Strategy } from '@/lib/journey';
import { clearRun, currentRun, subscribe, type Run } from '@/lib/journeyStore';
import { newRun, runJourney, type Receipt } from '@/lib/journeyRun';
import { sendFault, type Net } from '@/lib/vault';
import { haptic } from '@/lib/wallets';
import { MomentumSetup } from './Momentum';

export type StartProps = {
  net: Net; pub: PublicClient; account: Address | null; wallet: WalletClient | null; bal: bigint | null;
  need: () => Promise<boolean>;
  send: (w: WalletClient, req: { to?: Address; data?: Hex; value?: bigint; gas?: bigint }, onHash?: (h: Hex) => void) => Promise<Receipt>;
  sendAgent: (key: Hex, req: { to: Address; data?: Hex; value?: bigint }, onHash?: (h: Hex) => void) => Promise<Receipt>;
  toast: (t: React.ReactNode, k?: 'ok' | 'bad' | 'info') => void;
  openConnect: () => void; goMoney: () => void; refreshBal: () => void; gasPrice: bigint | null;
  goMomentum?: () => void;
};
type Stage = 'goal' | 'risk' | 'amount' | 'review' | 'run' | 'momentum';
const fmt = (x: bigint, d = 4) => `${Number(formatEther(x)).toLocaleString('en-GB', { maximumFractionDigits: d })} MON`;
const ALPHA = <>Alpha · unaudited contract · only deposit what you&apos;re happy to lose</>;

function useRun(netId: number, account: Address | null): Run | null {
  const raw = useSyncExternalStore(subscribe, () => JSON.stringify(currentRun(netId, account)), () => 'null');
  return useMemo(() => JSON.parse(raw) as Run | null, [raw]);
}

function parsePayees(text: string): { to: string; amount: string; wei: bigint }[] {
  return text.split(/\n+/).map(l => l.trim()).filter(Boolean).map(l => {
    const [to = '', amt = ''] = l.split(/[\s,;]+/);
    let wei = 0n; try { wei = parseEther(amt.replace(',', '.') || '0'); } catch { wei = -1n; }
    return { to, amount: amt, wei };
  });
}

export default function Start(p: StartProps) {
  const { net, account, bal } = p;
  const [stage, setStage] = useState<Stage>('goal');
  const [goal, setGoal] = useState<Goal | null>(null);
  const [risk, setRisk] = useState<Risk | null>(null);
  const [amt, setAmt] = useState('');
  const [payText, setPayText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = useRun(net.id, account);
  const live = run && !run.finished ? run : null;
  const s: Strategy | undefined = goal ? strategyFor(goal, goal === 'pay' ? null : risk) : undefined;
  const price = p.gasPrice ?? DEFAULT_GAS_PRICE;
  const payees = useMemo(() => parsePayees(payText), [payText]);
  const rv = s ? review(s, amt, bal, price, { payees: payees.map(x => ({ to: x.to, amount: x.wei })) }) : null;
  const max = s && bal != null ? maxAmount(s, bal, price, payees.length) : null;
  const mainnetOnly = s && (s.kind === 'clip' || s.kind === 'spread' || s.kind === 'aprmon') && net.id !== 143;

  useEffect(() => { if (live && stage !== 'run') setStage('run'); }, [live?.id]); // eslint-disable-line
  useEffect(() => { window.scrollTo({ top: 0 }); }, [stage]);
  useEffect(() => { try { if (sessionStorage.getItem('pp.start.momentum')) { sessionStorage.removeItem('pp.start.momentum'); setStage('momentum'); } } catch { /* */ } }, []);

  const pickGoal = (g: Goal) => { haptic(8); setGoal(g); setRisk(null); setErr(null); setStage(g === 'pay' ? 'amount' : 'risk'); };
  const pickRisk = (r: Risk) => { haptic(8); setRisk(r); setErr(null); setStage('amount'); };
  const back = () => setStage(stage === 'review' ? 'amount' : stage === 'amount' ? (goal === 'pay' ? 'goal' : 'risk') : 'goal');

  const go = async (resume?: Run) => {
    setErr(null);
    if (!account || !p.wallet) { p.openConnect(); return; }
    try { if (!(await p.need())) return; } catch (e) { setErr(sendFault(e).text); return; }
    let r = resume;
    if (!r) {
      if (!s || !rv?.ok) return;
      // Fresh balance right before anything is signed: a short wallet is caught here, not by a failed transaction.
      const fresh = await p.pub.getBalance({ address: account }).catch(() => bal);
      const again = review(s, amt, fresh ?? null, price, { payees: payees.map(x => ({ to: x.to, amount: x.wei })) });
      if (!again.ok) { setErr(again.blocker ?? 'Not enough MON.'); return; }
      r = newRun(net.id, account, s, formatEther(again.amount), again.costs.agentGas, s.kind === 'pay' ? payees.map(x => ({ to: x.to, amount: x.amount })) : undefined);
    }
    setStage('run'); setBusy(true);
    try {
      await runJourney(r, {
        net, pub: p.pub, account,
        wallet: (req, onHash) => p.send(p.wallet!, req, onHash),
        agent: (key, req, onHash) => p.sendAgent(key, req, onHash),
      });
      haptic([10, 40, 10] as any); p.toast('Done. Your money is in My money.', 'ok');
    } catch (e) {
      const f = sendFault(e); setErr(f.pending ? `${f.text} Your progress is saved: press Resume when the network catches up.` : f.text);
    } finally { setBusy(false); p.refreshBal(); }
  };

  const shown: Run | null = live ?? (run?.finished ? run : null);
  return (
    <div className="mx-auto grid w-full max-w-xl gap-4" data-testid="start">
      {stage === 'momentum' && <MomentumSetup {...{ net, pub: p.pub, account, wallet: p.wallet, bal, need: p.need, send: p.send as any, toast: p.toast, refreshBal: p.refreshBal }} openConnect={p.openConnect} onBack={() => setStage('goal')} goMomentum={() => { setStage('goal'); p.goMomentum?.(); }} />}
      {stage !== 'goal' && stage !== 'run' && stage !== 'momentum' && <button onClick={back} data-testid="back" className="flex min-h-11 w-fit items-center gap-1 rounded-xl px-2 text-sm text-zinc-400 hover:text-white"><ArrowLeft className="h-4 w-4" />Back</button>}
      {stage !== 'run' && stage !== 'momentum' && <Progress stage={stage} pay={goal === 'pay'} />}

      {stage === 'goal' && <>
        <h1 className="text-2xl font-semibold text-zinc-50">What do you want your MON to do?</h1>
        <p className="-mt-2 text-sm text-zinc-400">All you need is MON in your wallet. No USDC, no other tokens.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {GOALS.map(g => (
            <button key={g.id} data-testid={`goal-${g.id}`} onClick={() => pickGoal(g.id)} className="flex min-h-24 min-w-0 items-center gap-4 rounded-3xl border border-white/10 bg-white/[0.045] p-4 text-left transition hover:border-monad/60 active:scale-[0.98]">
              <span className="text-3xl" aria-hidden>{g.emoji}</span>
              <span className="min-w-0 flex-1"><span className="block text-lg font-semibold text-zinc-50">{g.title}</span><span className="block text-sm text-zinc-400">{g.sub}</span></span>
              <ChevronRight className="h-5 w-5 shrink-0 text-zinc-500" />
            </button>
          ))}
          <button data-testid="goal-momentum" onClick={() => { haptic(8); setErr(null); setStage('momentum'); }} className="flex min-h-24 min-w-0 items-center gap-4 rounded-3xl border border-white/10 bg-white/[0.045] p-4 text-left transition hover:border-monad/60 active:scale-[0.98]">
            <span className="text-3xl" aria-hidden>📈</span>
            <span className="min-w-0 flex-1"><span className="block text-lg font-semibold text-zinc-50">Momentum</span><span className="block text-sm text-zinc-400">Follow strength against MON, with your own exit limits</span></span>
            <ChevronRight className="h-5 w-5 shrink-0 text-zinc-500" />
          </button>
        </div>
        {!account && <Card className="flex flex-wrap items-center gap-3"><span className="min-w-0 flex-1 text-sm text-zinc-300">You can look around first. Connect when you are ready to put MON in.</span><Btn kind="pri" onClick={p.openConnect} data-testid="start-connect">Connect wallet</Btn></Card>}
      </>}

      {stage === 'risk' && goal && <>
        <h1 className="text-2xl font-semibold text-zinc-50">How much risk?</h1>
        <div className="grid gap-3">
          {risksFor(goal).map(r => r.strategy ? (
            <button key={r.id} data-testid={`risk-${r.id}`} data-offered="1" onClick={() => pickRisk(r.id)} className="min-h-24 min-w-0 rounded-3xl border border-white/10 bg-white/[0.045] p-4 text-left transition hover:border-monad/60 active:scale-[0.98]">
              <span className="flex items-center gap-2"><span className="text-lg font-semibold text-zinc-50">{r.title}</span><Pill tone={r.id === 'low' ? 'ok' : r.id === 'balanced' ? 'monad' : 'warn'}>{r.strategy.name}</Pill></span>
              <span className="mt-1 block text-sm text-zinc-300">{r.strategy.oneLine}</span>
              <span className="mt-1 block text-xs text-zinc-500">{r.strategy.frequency}</span>
            </button>
          ) : (
            <div key={r.id} data-testid={`risk-${r.id}`} data-offered="0" aria-disabled className="min-w-0 rounded-3xl border border-dashed border-white/10 p-4 opacity-70">
              <span className="flex items-center gap-2"><span className="text-lg font-semibold text-zinc-400">{r.title}</span><Pill>Not offered</Pill></span>
              <span className="mt-1 block text-sm text-zinc-400">{r.notOffered?.why}</span>
            </div>
          ))}
        </div>
      </>}

      {stage === 'amount' && s && rv && <>
        <h1 className="text-2xl font-semibold text-zinc-50">{s.name}</h1>
        <Card className="grid gap-3">
          <label className="text-sm text-zinc-300" htmlFor="amt">How much MON?</label>
          <div className="flex min-w-0 gap-2">
            <input id="amt" data-testid="amount" inputMode="decimal" autoComplete="off" placeholder={formatEther(s.min)} value={amt} onChange={e => setAmt(e.target.value)} className="min-h-14 min-w-0 flex-1 rounded-2xl border border-white/15 bg-black/30 px-4 font-mono text-xl text-white outline-none focus:border-monad" />
            <Btn kind="soft" data-testid="max" className="min-h-14 px-5" disabled={!max} onClick={() => max && setAmt(Number(formatEther(max)).toFixed(4).replace(/\.?0+$/, ''))}>Max</Btn>
          </div>
          <p className="text-xs text-zinc-500">{account ? <>Wallet: <span className="font-mono">{bal == null ? '…' : fmt(bal)}</span>. Max leaves the gas you need.{s.cap ? ` This pool holds at most ${fmt(s.cap, 0)}.` : ''}</> : 'Connect a wallet to see your balance.'}</p>
          {s.kind === 'pay' && <>
            <label className="text-sm text-zinc-300" htmlFor="payees">Who to pay: one per line, address then amount</label>
            <textarea id="payees" data-testid="payees" rows={3} placeholder={'0x1234…abcd 0.1\n0x5678…ef01 0.25'} value={payText} onChange={e => setPayText(e.target.value)} className="min-h-24 rounded-2xl border border-white/15 bg-black/30 p-3 font-mono text-sm text-white outline-none focus:border-monad" />
          </>}
          {amt && !rv.ok && <p className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100" data-testid="blocker">{rv.blocker}</p>}
          {mainnetOnly && <p className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100" data-testid="blocker">This runs on Monad mainnet only. Switch the network at the top.</p>}
          <Btn kind="pri" data-testid="to-review" className="min-h-14 text-base" disabled={!account ? false : !rv.ok || !!mainnetOnly} onClick={() => (account ? setStage('review') : p.openConnect())}>{account ? 'Review' : 'Connect wallet'}</Btn>
        </Card>
        <Explain s={s} />
      </>}

      {stage === 'review' && s && rv?.ok && <>
        <h1 className="text-2xl font-semibold text-zinc-50">Check and confirm</h1>
        <Card className="grid gap-2" data-testid="review">
          <div className="text-sm font-medium text-zinc-100">{s.name}</div>
          {rv.lines.map(l => <div key={l.label} className="flex min-w-0 items-start gap-3 border-t border-white/5 pt-2 text-sm"><span className="min-w-0 flex-1 text-zinc-300">{l.label}{l.note && <span className="block text-xs text-zinc-500">{l.note}</span>}</span><span className="shrink-0 font-mono tabular-nums text-zinc-50">{l.value}</span></div>)}
        </Card>
        <Card className="grid gap-1 text-sm" data-testid="review-steps">
          <div className="text-xs uppercase tracking-wider text-zinc-400">What happens ({s.signatures} wallet signature{s.signatures > 1 ? 's' : ''})</div>
          {s.does.map((d, i) => <p key={i} className="text-zinc-300">• {d}</p>)}
          <p className="text-zinc-400">• Every step is simulated first. If it would fail, nothing is sent and no gas is spent.</p>
          <p className="text-zinc-400">• {s.withdraw[0]}</p>
        </Card>
        <p className="text-center text-xs text-amber-200">{ALPHA}.</p>
        {err && <p className="break-words rounded-2xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-100" data-testid="start-error">{err}</p>}
        <Btn kind="pri" data-testid="confirm" className="min-h-14 text-base" disabled={busy} onClick={() => go()}>{busy ? <Loader2 className="h-5 w-5 animate-spin" /> : null}Confirm · {s.signatures} signature{s.signatures > 1 ? 's' : ''}</Btn>
      </>}

      {stage === 'run' && shown && <RunView run={shown} net={net} busy={busy} err={err}
        onResume={() => go(live!)} onDone={() => { clearRun(net.id, account!); setStage('goal'); setGoal(null); setAmt(''); setErr(null); p.goMoney(); }}
        onAbandon={() => { clearRun(net.id, account!); setStage('goal'); setErr(null); }} />}
      {stage === 'run' && !shown && <Card><p className="text-sm text-zinc-400">Preparing…</p></Card>}
    </div>
  );
}

function Progress({ stage, pay }: { stage: Stage; pay: boolean }) {
  const names = pay ? ['Goal', 'Amount', 'Review'] : ['Goal', 'Risk', 'Amount', 'Review'];
  const at = pay ? { goal: 0, amount: 1, review: 2 }[stage as 'goal'] ?? 0 : { goal: 0, risk: 1, amount: 2, review: 3 }[stage as 'goal'] ?? 0;
  return <ol className="flex gap-1" aria-label="Steps" data-testid="wizard-progress">{names.map((n, i) => <li key={n} className={`h-1.5 flex-1 rounded-full ${i <= at ? 'bg-monad' : 'bg-white/10'}`} title={n} aria-current={i === at ? 'step' : undefined}><span className="sr-only">{n}</span></li>)}</ol>;
}

function Explain({ s }: { s: Strategy }) {
  const rows: [string, string[]][] = [['What it does', s.does], ['Fees', s.fees], ['What can go wrong', s.wrong], ['Withdrawing', s.withdraw], ['Permissions', s.permissions], ['How often', [s.frequency]]];
  return (
    <Card className="grid gap-3" data-testid="explain">
      {rows.map(([t, xs]) => <div key={t}><div className="text-xs uppercase tracking-wider text-zinc-400">{t}</div>{xs.map((x, i) => <p key={i} className="mt-1 text-sm text-zinc-200">{x}</p>)}</div>)}
    </Card>
  );
}

function RunView({ run, net, busy, err, onResume, onDone, onAbandon }: { run: Run; net: Net; busy: boolean; err: string | null; onResume: () => void; onDone: () => void; onAbandon: () => void }) {
  const done = !!run.finished;
  const failed = run.steps.some(x => x.status === 'failed');
  const sentAny = run.steps.some(x => x.hash || x.status === 'done');
  return (
    <>
      <h1 className="text-2xl font-semibold text-zinc-50">{done ? 'All set' : busy ? 'Setting up…' : 'Unfinished setup'}</h1>
      {!busy && !done && <p className="-mt-2 text-sm text-zinc-400" data-testid="resume-note">Your progress is saved in this browser. Resume picks up where it stopped; finished steps are never sent twice.</p>}
      <Card className="grid gap-2" data-testid="run">
        {run.steps.map(st => (
          <div key={st.id} className="flex min-w-0 items-start gap-3" data-testid="run-step" data-status={st.status}>
            <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs ${st.status === 'done' ? 'bg-emerald-500 text-white' : st.status === 'failed' ? 'bg-red-500/80 text-white' : st.status === 'sending' ? 'bg-monad text-white' : 'bg-white/10 text-zinc-400'}`}>
              {st.status === 'done' ? <Check className="h-4 w-4" /> : st.status === 'sending' && busy ? <Loader2 className="h-4 w-4 animate-spin" /> : st.status === 'failed' ? '!' : '·'}
            </span>
            <span className="min-w-0 flex-1 text-sm">
              <span className="block text-zinc-100">{st.label}</span>
              <span className="block text-xs text-zinc-500">{st.who === 'agent' ? 'Signed by the agent key in this browser, no popup' : 'Your wallet asks you to sign'}{st.hash && <> · <a className="underline" href={`${net.exp}/tx/${st.hash}`} target="_blank" rel="noreferrer">tx ↗</a></>}</span>
              {st.status === 'failed' && st.error && <span className="block break-words text-xs text-red-300">{st.error}</span>}
            </span>
          </div>
        ))}
      </Card>
      {err && <p className="break-words rounded-2xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-100" data-testid="start-error">{err}</p>}
      {done && <Btn kind="pri" data-testid="go-money" className="min-h-14 text-base" onClick={onDone}>See it in My money</Btn>}
      {!done && !busy && <Btn kind="pri" data-testid="resume" className="min-h-14 text-base" onClick={onResume}><RotateCcw className="h-4 w-4" />{failed || sentAny ? 'Resume' : 'Start'}</Btn>}
      {!done && !busy && <Btn kind="ghost" data-testid="abandon" onClick={onAbandon}>{sentAny ? 'Stop here (anything already sent is in My money)' : 'Cancel'}</Btn>}
    </>
  );
}
