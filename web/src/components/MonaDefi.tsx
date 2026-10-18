'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { decodeEventLog, encodeFunctionData, getAddress, isAddress, parseEther, type Address, type Hex, type PublicClient, type TransactionReceipt, type WalletClient } from 'viem';
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Check, ChevronLeft, Copy, ExternalLink, ListChecks, Wallet } from 'lucide-react';
import { Btn, Card, Pill, Switch } from './ui';
import { PasskeyAccess, PasskeyBadge } from './PasskeyAccess';
import type { Discovered } from '@/lib/wallets';
import { pricedGas } from '@/lib/fastPath';
import { sendFault, TEAM_LABEL, type Net } from '@/lib/vault';
import {
  annualised, aprMonAbi, ASSET, AUTO_MODE_AVAILABLE, AUTO_MODE_WHY, availableToDeploy, capOf, combineSteps, DEFAULT_RULES, DEFAULT_SLIPPAGE_BPS, deployGate,
  describeRules, fmt, isDuplicate, isOpen, isStale, minAfterSlippage, parseMon, performance, presetAmount, PRIMARY_VAULT, proposeActions, afterClaimBaseline,
  requestState, reserveOf, settleDeposit, sharesFor, signedFmt, TX_STATES, validateRules, VAULTS, withdrawGate, withdrawPreview,
  type Preview, type Proposal, type RequestRow, type Rules, type TxRecord, type TxState, type VaultInfo, type WithdrawPick,
} from '@/lib/monadefi';

type SendFn = (w: WalletClient, req: { to?: Address; data?: Hex; value?: bigint; gas?: bigint }, onHash?: (h: Hex) => void) => Promise<TransactionReceipt>;
type View = 'home' | 'deploy' | 'withdraw' | 'withdraw-all' | 'rules' | 'vaults';
const VIEWS: View[] = ['home', 'deploy', 'withdraw', 'withdraw-all', 'rules', 'vaults'];
const ONE = 10n ** 18n;
const V = PRIMARY_VAULT;
const timeOf = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : '—');
const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

type Facts = { paused: boolean; feeBps: number; rewardFee: number; minimum: bigint; rate: bigint; at: number; block: bigint };
type Ret = { apr: number | null; days: number; at: number } | null;
type Position = { shares: bigint; value: bigint; at: number };
type ChainEv = { kind: 'Deposit' | 'Withdrawal requested' | 'Withdrawal claimed'; amount: bigint; shares: bigint; hash?: string; block?: bigint; ts?: number; id?: bigint };

function mintedFrom(rc: Pick<TransactionReceipt, 'logs'>, owner: string): bigint | null {
  let minted: bigint | null = null;
  for (const l of rc.logs) {
    if (l.address.toLowerCase() !== V.address.toLowerCase()) continue;
    try { const d = decodeEventLog({ abi: aprMonAbi, data: l.data, topics: l.topics }); if (d.eventName === 'Deposit' && (d.args as any).owner.toLowerCase() === owner) minted = (minted ?? 0n) + ((d.args as any).shares as bigint); } catch { /* other event */ }
  }
  return minted;
}
const stateTone = (s: TxState): 'ok' | 'bad' | 'warn' | 'zinc' | 'monad' => (s === 'Completed' ? 'ok' : s === 'Failed' ? 'bad' : s === 'Action required' || s === 'Partially completed' ? 'warn' : s === 'Withdrawal requested' || s === 'Waiting for liquidity' ? 'monad' : 'zinc');

function useLocal<T>(key: string, init: T): [T, (v: T | ((x: T) => T)) => void] {
  const [v, setV] = useState<T>(init);
  useEffect(() => { if (!key) { setV(init); return; } try { const s = localStorage.getItem(key); setV(s ? { ...(init as any), ...JSON.parse(s) } : init); } catch { setV(init); } }, [key]); // eslint-disable-line
  const set = useCallback((x: T | ((p: T) => T)) => setV(prev => { const n = typeof x === 'function' ? (x as (p: T) => T)(prev) : x; if (key) try { localStorage.setItem(key, JSON.stringify(n)); } catch { /* full */ } return n; }), [key]);
  return [v, set];
}

export default function MonaDefi({ net, pub, account, wallet, bal, need, send, toast, block, setTab, openConnect, refreshBal, base, connectProvider }: {
  net: Net; pub: PublicClient; account: Address | null; wallet: WalletClient | null; bal: bigint | null;
  need: () => Promise<boolean>; send: SendFn; toast: (m: React.ReactNode, k?: 'ok' | 'bad' | 'info') => void; block: bigint | null;
  setTab: (t: any) => void; openConnect: () => void; refreshBal: () => void; base: string; connectProvider?: (d: Discovered) => Promise<boolean>;
}) {
  const mainnet = net.id === 143;
  const [view, setViewState] = useState<View>('home');
  useEffect(() => { const h = location.hash.replace(/^#\/?/, '') as View; if (VIEWS.includes(h)) setViewState(h); }, []);
  const setView = (v: View) => { setViewState(v); history.replaceState(null, '', `${location.pathname}${location.search}#/${v === 'home' ? '' : v}`); window.scrollTo({ top: 0, behavior: 'smooth' }); };

  const acct = account?.toLowerCase() ?? '';
  const [txs, setTxs] = useLocal<{ list: TxRecord[] }>(acct ? `md.tx.${net.id}.${acct}` : '', { list: [] });
  const [rules, setRules] = useLocal<Rules>(acct ? `md.rules.${net.id}.${acct}` : '', DEFAULT_RULES);
  const list = txs.list;
  const upsert = useCallback((r: TxRecord) => setTxs(x => ({ list: [r, ...x.list.filter(t => t.id !== r.id)].slice(0, 100) })), [setTxs]);
  // Records left open by a closed tab are settled from the chain, so a pending row never blocks forever and never becomes a phantom position.
  useEffect(() => {
    if (!mainnet || !acct) return;
    const stuck = list.filter(t => isOpen(t.state) && Date.now() - t.updated > 15_000);
    if (!stuck.length) return;
    let on = true;
    (async () => {
      for (const t of stuck) {
        if (!t.hash) { if (Date.now() - t.at > 300_000) upsert({ ...t, state: 'Failed', note: 'No signature was received. Nothing was sent.', updated: Date.now() }); continue; }
        try {
          const rc = await pub.getTransactionReceipt({ hash: t.hash as Hex });
          if (!on) return;
          if (t.kind === 'deploy') upsert(settleDeposit(t, { status: rc.status }, mintedFrom(rc, acct)));
          else {
            const ids: string[] = [];
            for (const l of rc.logs) { if (l.address.toLowerCase() !== V.address.toLowerCase()) continue; try { const d = decodeEventLog({ abi: aprMonAbi, data: l.data, topics: l.topics }); if (d.eventName === 'RedeemRequest') ids.push(((d.args as any).requestId as bigint).toString()); } catch { /* other */ } }
            upsert({ ...t, state: rc.status === 'success' ? (t.kind === 'request' ? 'Withdrawal requested' : 'Completed') : 'Failed', requestIds: t.kind === 'request' ? ids : t.requestIds, updated: Date.now(), note: rc.status === 'success' ? t.note : 'The transaction reverted.' });
          }
        } catch { if (on) upsert({ ...t, state: 'Confirming', updated: Date.now() }); }
      }
    })();
    return () => { on = false; };
  }, [block, mainnet, acct]); // eslint-disable-line

  // ---------- real mainnet reads ----------
  const [facts, setFacts] = useState<Facts | null>(null);
  const [factsErr, setFactsErr] = useState<string | null>(null);
  const [ret, setRet] = useState<Ret>(null);
  const [retState, setRetState] = useState<'loading' | 'ok' | 'none'>('loading');
  const [pos, setPos] = useState<Position | null>(null);
  const [reqs, setReqs] = useState<RequestRow[] | null>(null);
  const [recent, setRecent] = useState<ChainEv[]>([]);
  const c = { address: V.address, abi: aprMonAbi } as const;

  const readFacts = useCallback(async () => {
    if (!mainnet) return;
    try {
      const [paused, fee, rf, minimum, rate, b] = await Promise.all([
        pub.readContract({ ...c, functionName: 'paused' }), pub.readContract({ ...c, functionName: 'withdrawalFee' }), pub.readContract({ ...c, functionName: 'rewardFee' }),
        pub.readContract({ ...c, functionName: 'minimumRedeem' }), pub.readContract({ ...c, functionName: 'convertToAssets', args: [ONE] }), pub.getBlockNumber(),
      ]);
      setFacts({ paused, feeBps: Number(fee), rewardFee: Number(rf), minimum, rate, at: Date.now(), block: b }); setFactsErr(null);
    } catch (e: any) { setFactsErr(e?.shortMessage ?? 'Could not read the vault.'); }
  }, [pub, mainnet]); // eslint-disable-line

  const readReturn = useCallback(async () => {
    if (!mainnet) return;
    try {
      const head = await pub.getBlock();
      const probe = await pub.getBlock({ blockNumber: head.number - 100_000n });
      const spb = Number(head.timestamp - probe.timestamp) / 100_000;
      for (const days of [7, 3, 1]) {
        const back = BigInt(Math.round((days * 86_400) / Math.max(spb, 0.05)));
        try {
          const then = await pub.getBlock({ blockNumber: head.number - back });
          const [now, old] = await Promise.all([
            pub.readContract({ ...c, functionName: 'convertToAssets', args: [ONE], blockNumber: head.number }),
            pub.readContract({ ...c, functionName: 'convertToAssets', args: [ONE], blockNumber: head.number - back }),
          ]);
          const apr = annualised(now, old, Number(head.timestamp - then.timestamp));
          if (apr != null) { setRet({ apr, days, at: Date.now() }); setRetState('ok'); return; }
        } catch { /* this RPC does not keep that much history; try a shorter window */ }
      }
      setRet(null); setRetState('none');
    } catch { setRetState('none'); }
  }, [pub, mainnet]); // eslint-disable-line

  const readPosition = useCallback(async () => {
    if (!mainnet || !account) { setPos(null); setReqs(null); return; }
    try {
      const shares = await pub.readContract({ ...c, functionName: 'balanceOf', args: [account] });
      const value = shares > 0n ? await pub.readContract({ ...c, functionName: 'previewRedeem', args: [shares] }) : 0n;
      setPos({ shares, value, at: Date.now() });
      const n = await pub.readContract({ ...c, functionName: 'getUserRequestDataCount', args: [account] });
      const start = n > 50n ? n - 50n : 0n;
      const rows = n > 0n ? await pub.readContract({ ...c, functionName: 'getUserRequestData', args: [account, start, n - start] }) : [];
      setReqs(rows.map(r => ({ id: r.id, claimed: r.claimed, claimable: r.claimable, shares: r.shares, assets: r.assets, timestamp: r.timestamp, unlockEpoch: r.unlockEpoch })));
    } catch (e: any) { toast(`Couldn't read your position: ${e?.shortMessage ?? e?.message ?? 'RPC error'}`, 'bad'); }
  }, [pub, account, mainnet]); // eslint-disable-line

  /** Recent Deposit events for this wallet (the public RPC serves 100 blocks per log query, so this covers roughly the last 10 minutes). */
  const readRecent = useCallback(async () => {
    if (!mainnet || !account) { setRecent([]); return; }
    try {
      const head = await pub.getBlockNumber();
      const spans = [...Array(15).keys()].map(i => head - BigInt(i * 100));
      const ev = aprMonAbi.find(x => x.type === 'event' && x.name === 'Deposit') as any;
      const logs = (await Promise.all(spans.map(to => pub.getLogs({ address: V.address, event: ev, args: { owner: account }, fromBlock: to - 99n, toBlock: to }).catch(() => [])))).flat() as any[];
      setRecent(logs.map(l => ({ kind: 'Deposit' as const, amount: l.args.assets as bigint, shares: l.args.shares as bigint, hash: l.transactionHash, block: l.blockNumber })));
    } catch { /* optional */ }
  }, [pub, account, mainnet]); // eslint-disable-line

  useEffect(() => { readFacts(); readReturn(); const t = setInterval(readFacts, 30_000); const r = setInterval(readReturn, 600_000); return () => { clearInterval(t); clearInterval(r); }; }, [readFacts, readReturn]);
  useEffect(() => { readPosition(); readRecent(); const t = setInterval(readPosition, 30_000); return () => clearInterval(t); }, [readPosition, readRecent]);
  const refreshAll = () => { readFacts(); readPosition(); readRecent(); refreshBal(); };

  // ---------- derived ----------
  const wallet0 = bal ?? 0n;
  // Rules only apply once saved. Until then MonaDefi keeps just the gas reserve.
  const activeReserve = rules.savedAt ? reserveOf(rules) : 0n;
  const available = availableToDeploy(wallet0, activeReserve);
  const invested = pos?.value ?? 0n;
  const claimable = (reqs ?? []).filter(r => r.claimable && !r.claimed);
  const queued = (reqs ?? []).filter(r => !r.claimable && !r.claimed);
  const withdrawableNow = claimable.reduce((s, r) => s + r.assets, 0n);
  const queuedMon = queued.reduce((s, r) => s + r.assets, 0n);
  const openTxs = list.filter(t => isOpen(t.state));
  const total = wallet0 + invested + withdrawableNow + queuedMon;
  const busy = openTxs.length > 0;
  const cap = rules.savedAt ? capOf(rules) : null;
  const capRoom = cap == null ? null : cap > invested ? cap - invested : 0n;

  const ledgerDeposits = list.filter(t => t.kind === 'deploy' && (t.state === 'Completed' || t.state === 'Action required') && t.shares);
  const myReqIds = new Set(list.flatMap(t => t.requestIds ?? []));
  const myReqs = (reqs ?? []).filter(r => myReqIds.has(r.id.toString()));
  const rateOf = (s: bigint) => (facts ? (s * facts.rate) / ONE : 0n);
  const perf = performance({
    depositedMon: ledgerDeposits.reduce((s, t) => s + BigInt(t.amount), 0n), depositedShares: ledgerDeposits.reduce((s, t) => s + BigInt(t.shares!), 0n),
    requestedShares: myReqs.reduce((s, r) => s + r.shares, 0n), requestedMon: myReqs.reduce((s, r) => s + r.assets, 0n), heldShares: pos?.shares ?? 0n, value: rateOf,
  });
  const proposals = useMemo(() => (rules.savedAt ? proposeActions({ rules, wallet: wallet0, invested, pending: busy }) : []), [rules, wallet0, invested, busy]);

  // ---------- deploy ----------
  const [amountTxt, setAmountTxt] = useState('');
  const amount = parseMon(amountTxt);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 5_000); return () => clearInterval(t); }, []);
  const previewFor = useCallback(async (amt: bigint): Promise<Preview | null> => {
    try { const [shares, b] = await Promise.all([pub.readContract({ ...c, functionName: 'previewDeposit', args: [amt] }), pub.getBlockNumber()]); return { at: Date.now(), block: b, amount: amt, shares }; } catch { return null; }
  }, [pub]); // eslint-disable-line
  useEffect(() => {
    if (!mainnet || amount == null || amount <= 0n) { setPreview(null); return; }
    // Debounced, then refreshed every 10 s so the review never relies on stale data. Not tied to every block:
    // Monad blocks arrive faster than the debounce.
    let on = true;
    const run = async () => { const p = await previewFor(amount); if (on) setPreview(p); };
    const t = setTimeout(run, 350); const i = setInterval(run, 10_000);
    return () => { on = false; clearTimeout(t); clearInterval(i); };
  }, [amount, mainnet, previewFor]);
  const gate = deployGate({ mainnet, account: !!account, amount, available, paused: facts?.paused ?? null, preview, now, capRoom, busy });
  const minShares = preview ? minAfterSlippage(preview.shares, DEFAULT_SLIPPAGE_BPS) : 0n;

  const confirmDeploy = async () => {
    if (!amount || !preview || !account) return;
    if (isDuplicate(list, { kind: 'deploy', vault: V.id, amount: amount.toString() })) { toast('That deployment was just sent. Wait for it to finish before sending it again.', 'bad'); return; }
    try { if (!(await need())) return; } catch (e) { toast(sendFault(e).text, 'bad'); return; }
    const rec: TxRecord = { id: `d-${Date.now()}`, kind: 'deploy', state: 'Awaiting approval', vault: V.id, amount: amount.toString(), minShares: minShares.toString(), at: Date.now(), updated: Date.now() };
    upsert(rec);
    try {
      const fresh = await previewFor(amount);
      if (!fresh || fresh.shares < minShares) { upsert({ ...rec, state: 'Failed', note: 'The preview moved below your minimum shares before sending. Nothing was sent.', updated: Date.now() }); toast('The vault price moved. Nothing was sent; review again.', 'bad'); setReviewing(false); return; }
      const req = { to: V.address, data: encodeFunctionData({ abi: aprMonAbi, functionName: 'deposit', args: [amount, account] }), value: amount };
      await pub.call({ account, ...req });
      const gas = await pricedGas(pub, account, req);
      let hash: Hex | undefined;
      const rc = await send(wallet!, { ...req, gas }, h => { hash = h; upsert({ ...rec, state: 'Submitted', hash: h, updated: Date.now() }); });
      const minted = mintedFrom(rc, acct);
      const done = settleDeposit({ ...rec, hash: hash ?? rc.transactionHash }, { status: rc.status }, minted);
      upsert(done);
      toast(done.state === 'Completed' ? <>Deployed {fmt(amount)} into {V.provider} {V.share}. <a className="underline" href={`${net.exp}/tx/${rc.transactionHash}`} target="_blank" rel="noreferrer">View tx ↗</a></> : done.note ?? done.state, done.state === 'Completed' ? 'ok' : 'bad');
      setReviewing(false); setAmountTxt(''); refreshAll();
    } catch (e: any) {
      const f = sendFault(e);
      upsert({ ...rec, state: f.pending ? 'Confirming' : 'Failed', hash: e?.hash ?? undefined, note: f.pending ? 'Sent, still waiting for the block. Refresh in a moment.' : `${f.text} No position was created.`, updated: Date.now() });
      toast(f.text, f.pending ? 'info' : 'bad');
    }
  };

  // ---------- withdraw ----------
  const [pick, setPick] = useState<WithdrawPick>({ kind: 'pct', pct: 50 });
  const [wAmountTxt, setWAmountTxt] = useState('');
  const [wSharesTxt, setWSharesTxt] = useState('');
  const [adv, setAdv] = useState(false);
  const [dest, setDest] = useState<'self' | 'other'>('self');
  const [otherTxt, setOtherTxt] = useState('');
  const [wReview, setWReview] = useState(false);
  const position = { shares: pos?.shares ?? 0n, value: invested };
  const effPick: WithdrawPick = pick.kind === 'amount' ? { kind: 'amount', mon: parseMon(wAmountTxt) ?? 0n } : pick.kind === 'shares' ? { kind: 'shares', shares: parseMon(wSharesTxt) ?? 0n } : pick;
  const wShares = sharesFor(effPick, position);
  const grossOf = (s: bigint) => (position.shares > 0n ? (s === position.shares ? position.value : (position.value * s) / position.shares) : 0n);
  const wp = withdrawPreview(wShares, grossOf, facts?.feeBps ?? null);
  const receiverOk = dest === 'self' || isAddress(otherTxt.trim());
  const receiver: Address | null = dest === 'self' ? account : isAddress(otherTxt.trim()) ? getAddress(otherTxt.trim()) : null;
  const wGate = withdrawGate({ account: !!account, mainnet, shares: wShares, position: position.shares, minimum: facts?.minimum ?? null, paused: facts?.paused ?? null, busy, receiverOk, previewAt: pos?.at ?? null, now });

  const requestWithdrawal = async (shares: bigint, label: string, minNet: bigint, recv: Address | null): Promise<TxState> => {
    if (!account) return 'Failed';
    if (isDuplicate(list, { kind: 'request', vault: V.id, amount: shares.toString() })) { toast('That withdrawal was just requested. Wait for it before sending it again.', 'bad'); return 'Failed'; }
    const rec: TxRecord = { id: `r-${Date.now()}`, kind: 'request', state: 'Awaiting approval', vault: V.id, amount: shares.toString(), shares: shares.toString(), at: Date.now(), updated: Date.now(), receiver: recv ?? undefined, note: label };
    upsert(rec);
    try {
      const fresh = await pub.readContract({ ...c, functionName: 'previewRedeem', args: [shares] });
      if (fresh - (fresh * BigInt(facts?.feeBps ?? 0)) / 10_000n < minNet) { upsert({ ...rec, state: 'Failed', note: 'Estimated proceeds fell below your minimum before sending. Nothing was sent.', updated: Date.now() }); toast('Proceeds moved below your minimum. Nothing was sent.', 'bad'); return 'Failed'; }
      const req = { to: V.address, data: encodeFunctionData({ abi: aprMonAbi, functionName: 'requestRedeem', args: [shares, account, account] }) };
      await pub.call({ account, ...req });
      const gas = await pricedGas(pub, account, req);
      const rc = await send(wallet!, { ...req, gas }, h => upsert({ ...rec, state: 'Submitted', hash: h, updated: Date.now() }));
      const ids: string[] = [];
      for (const l of rc.logs) { if (l.address.toLowerCase() !== V.address.toLowerCase()) continue; try { const d = decodeEventLog({ abi: aprMonAbi, data: l.data, topics: l.topics }); if (d.eventName === 'RedeemRequest') ids.push(((d.args as any).requestId as bigint).toString()); } catch { /* other */ } }
      const st: TxState = rc.status === 'success' && ids.length ? 'Withdrawal requested' : rc.status === 'success' ? 'Action required' : 'Failed';
      upsert({ ...rec, state: st, hash: rc.transactionHash, requestIds: ids, updated: Date.now(), note: st === 'Withdrawal requested' ? 'Requested. aPriori unlocks it after a few staking epochs (usually 12–18 hours). Then claim it here.' : st === 'Action required' ? 'The transaction succeeded but no request id was found. Check the explorer.' : 'The transaction reverted.' });
      return st;
    } catch (e: any) {
      const f = sendFault(e);
      upsert({ ...rec, state: f.pending ? 'Confirming' : 'Failed', hash: e?.hash, note: f.pending ? 'Sent, still waiting for the block.' : f.text, updated: Date.now() });
      toast(f.text, f.pending ? 'info' : 'bad');
      return f.pending ? 'Confirming' : 'Failed';
    }
  };
  const claim = async (rows: RequestRow[], recv: Address | null): Promise<TxState> => {
    if (!account || !rows.length || !recv) return 'Failed';
    const ids = rows.map(r => r.id);
    const amount = rows.reduce((s, r) => s + r.assets, 0n);
    if (isDuplicate(list, { kind: 'claim', vault: V.id, amount: ids.join(',') })) { toast('That claim was just sent.', 'bad'); return 'Failed'; }
    const rec: TxRecord = { id: `c-${Date.now()}`, kind: 'claim', state: 'Awaiting approval', vault: V.id, amount: ids.join(','), at: Date.now(), updated: Date.now(), receiver: recv, requestIds: [] };
    upsert(rec);
    try {
      const req = { to: V.address, data: encodeFunctionData({ abi: aprMonAbi, functionName: 'redeem', args: [ids, recv] }) };
      await pub.call({ account, ...req });
      const gas = await pricedGas(pub, account, req);
      const rc = await send(wallet!, { ...req, gas }, h => upsert({ ...rec, state: 'Submitted', hash: h, updated: Date.now() }));
      let got = 0n, fee = 0n;
      for (const l of rc.logs) { if (l.address.toLowerCase() !== V.address.toLowerCase()) continue; try { const d = decodeEventLog({ abi: aprMonAbi, data: l.data, topics: l.topics }); if (d.eventName === 'Redeem') { got += (d.args as any).assets; fee += (d.args as any).fee; } } catch { /* other */ } }
      const st: TxState = rc.status === 'success' && got > 0n ? (got + fee < amount - amount / 1000n ? 'Partially completed' : 'Completed') : 'Failed';
      upsert({ ...rec, state: st, hash: rc.transactionHash, updated: Date.now(), note: `Received ${fmt(got)} (fee ${fmt(fee)}) at ${short(recv)}. MonaDefi does not redeploy withdrawn MON.` });
      if (recv.toLowerCase() === acct && got > 0n) setRules(r => afterClaimBaseline(r, got));
      toast(<>Claimed {fmt(got)}. <a className="underline" href={`${net.exp}/tx/${rc.transactionHash}`} target="_blank" rel="noreferrer">View tx ↗</a></>, 'ok');
      refreshAll();
      return st;
    } catch (e: any) {
      const f = sendFault(e);
      upsert({ ...rec, state: f.pending ? 'Confirming' : 'Failed', hash: e?.hash, note: f.pending ? 'Sent, still waiting for the block.' : f.text, updated: Date.now() });
      toast(f.text, f.pending ? 'info' : 'bad');
      return f.pending ? 'Confirming' : 'Failed';
    }
  };
  const confirmWithdraw = async () => {
    try { if (!(await need())) return; } catch (e) { toast(sendFault(e).text, 'bad'); return; }
    const st = await requestWithdrawal(wShares, `Withdraw ${effPick.kind === 'pct' ? `${effPick.pct}%` : fmt(wp.gross)}`, wp.minNet, receiver);
    if (st === 'Withdrawal requested') { toast('Withdrawal requested. It unlocks in about 12–18 hours; claim it from your dashboard.', 'ok'); setWReview(false); refreshAll(); }
  };

  // ---------- withdraw all ----------
  const [pauseRules, setPauseRules] = useState(true);
  const [allSteps, setAllSteps] = useState<{ label: string; state: TxState }[] | null>(null);
  const withdrawAll = async () => {
    try { if (!(await need())) return; } catch (e) { toast(sendFault(e).text, 'bad'); return; }
    if (pauseRules) setRules(r => ({ ...r, autoDeployOn: false, targetOn: false, mode: 'suggest', savedAt: Date.now() }));
    const steps: { label: string; state: TxState }[] = [];
    const push = (label: string, state: TxState) => { steps.push({ label, state }); setAllSteps([...steps]); };
    if (claimable.length) push(`Claim ${claimable.length} unlocked request(s)`, await claim(claimable, account));
    if (position.shares > 0n) { const all = withdrawPreview(position.shares, grossOf, facts?.feeBps ?? null); push(`Request withdrawal of your whole ${V.share} position`, await requestWithdrawal(position.shares, 'Withdraw all', all.minNet, account)); }
    if (queued.length) push(`${queued.length} earlier request(s) still unlocking: nothing to do now`, 'Waiting for liquidity');
    const combined = combineSteps(steps.filter(s => s.state !== 'Waiting for liquidity').map(s => s.state));
    upsert({ id: `a-${Date.now()}`, kind: 'withdraw-all', state: steps.length ? combined : 'Completed', vault: V.id, amount: position.shares.toString(), at: Date.now(), updated: Date.now(), note: steps.map(s => `${s.label}: ${s.state}`).join(' · ') || 'Nothing to withdraw.' });
    refreshAll();
  };

  // ---------- rules ----------
  const [draft, setDraft] = useState<Rules>(rules);
  useEffect(() => setDraft(rules), [rules]);
  const draftErrs = validateRules(draft);
  const saveRules = () => {
    if (draftErrs.length) { toast(draftErrs[0], 'bad'); return; }
    const baseline = draft.autoDeployOn ? (rules.autoDeployOn && rules.baseline != null ? rules.baseline : wallet0.toString()) : null;
    setRules({ ...draft, baseline, savedAt: Date.now() });
    toast('Rules saved on this device. They only suggest actions; nothing is sent without your approval.', 'ok');
  };
  const stopAutomation = () => { setRules(r => ({ ...r, autoDeployOn: false, targetOn: false, mode: 'suggest', savedAt: Date.now() })); toast('Rule suggestions are off.', 'ok'); };
  const reviewProposal = (p: Proposal) => {
    if (p.kind === 'deploy') { setAmountTxt(String(Number(p.amount) / 1e18)); setView('deploy'); }
    else { setPick({ kind: 'amount', mon: p.amount }); setWAmountTxt(String(Number(p.amount) / 1e18)); setView('withdraw'); }
  };

  // ---------- UI pieces ----------
  const Back = () => <button onClick={() => { setView('home'); setReviewing(false); setWReview(false); }} className="mb-3 flex min-h-11 items-center gap-1 text-sm text-zinc-400 hover:text-white"><ChevronLeft className="h-4 w-4" />Dashboard</button>;
  const Stat = ({ label, value, sub, testid }: { label: string; value: React.ReactNode; sub?: React.ReactNode; testid?: string }) => (
    <div className="min-w-0 rounded-2xl bg-white/[0.04] p-3" data-testid={testid}><div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div><div className="mt-1 truncate font-mono text-lg tabular-nums text-zinc-50">{value}</div>{sub && <div className="mt-0.5 text-[11px] text-zinc-500">{sub}</div>}</div>
  );
  const ReturnLine = () => retState === 'loading' ? <span className="text-zinc-400">Reading…</span> : ret && ret.apr != null
    ? <span>{(ret.apr * 100).toFixed(2)}% a year, estimated <span className="text-zinc-500">(trailing {ret.days}-day change in the aprMON exchange rate, simple annualised; variable, not guaranteed; updated {timeOf(ret.at)})</span></span>
    : <span className="text-zinc-400">Not enough data yet</span>;

  const VaultCard = ({ v, onPick, picked }: { v: VaultInfo; onPick?: () => void; picked?: boolean }) => (
    <Card data-testid="vault-card" className={picked ? 'ring-1 ring-monad/60' : ''}>
      <div className="flex flex-wrap items-center gap-2"><h3 className="min-w-0 flex-1 font-semibold text-zinc-50">{v.provider} · {v.name}</h3><Pill tone="monad">Reviewed</Pill><Pill tone={facts?.paused ? 'bad' : facts ? 'ok' : 'zinc'}>{facts == null ? 'Reading…' : facts.paused ? 'Deposits closed (paused)' : 'Deposits open'}</Pill></div>
      <p className="mt-2 text-sm text-zinc-300">{v.strategy}</p>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <div><dt className="text-[11px] uppercase tracking-wide text-zinc-500">Estimated variable return</dt><dd data-testid="vault-return"><ReturnLine /></dd></div>
        <div><dt className="text-[11px] uppercase tracking-wide text-zinc-500">Asset</dt><dd>{v.asset} in, {v.share} out. 1 {v.share} = {facts ? fmt(facts.rate, 6) : '…'} <span className="text-zinc-500">(updated {timeOf(facts?.at)})</span></dd></div>
        <div><dt className="text-[11px] uppercase tracking-wide text-zinc-500">Withdrawal conditions</dt><dd>{v.withdrawalText} {v.expectedWait}</dd></div>
        <div><dt className="text-[11px] uppercase tracking-wide text-zinc-500">Fees</dt><dd><ul className="list-disc pl-4">{v.feeText({ withdrawalFeeBps: facts?.feeBps ?? null, rewardFee: facts?.rewardFee ?? null }).map(f => <li key={f}>{f}</li>)}</ul></dd></div>
        <div className="sm:col-span-2"><dt className="text-[11px] uppercase tracking-wide text-zinc-500">Principal risks</dt><dd><ul className="list-disc pl-4">{v.risks.map(r => <li key={r}>{r}</li>)}</ul></dd></div>
      </dl>
      <details className="mt-3 text-xs text-zinc-400"><summary className="cursor-pointer">Contract, approvals and routing</summary>
        <p className="mt-2">Contract: <a className="font-mono text-violet-300 underline" href={`${net.exp}/address/${v.address}`} target="_blank" rel="noreferrer">{v.address}</a>. Deposits call <code>deposit(assets, receiver)</code> with your MON. Withdrawals call <code>requestRedeem(shares, you, you)</code> and later <code>redeem(requestIds, receiver)</code>. No token approval is needed: MON is sent with the deposit, and you request withdrawals of your own aprMON. No router, no swap. {v.reviewed}</p>
        <p className="mt-1">{v.sources.map(s => <a key={s.href} className="mr-3 text-violet-300 underline" href={s.href} target="_blank" rel="noreferrer">{s.label} ↗</a>)}</p>
      </details>
      {onPick && <Btn kind={picked ? 'soft' : 'ghost'} className="mt-3" onClick={onPick}>{picked ? <><Check className="h-4 w-4" />Selected</> : 'Choose this vault'}</Btn>}
    </Card>
  );

  const Hero = ({ compact }: { compact?: boolean }) => (
    <section className={`${compact ? 'py-2' : 'py-8 sm:py-12'} text-center`} data-testid="md-hero">
      <p className="text-xs uppercase tracking-[0.2em] text-violet-300">MonaDefi</p>
      <h1 className={`mx-auto mt-2 max-w-3xl font-semibold text-zinc-50 ${compact ? 'text-2xl' : 'text-3xl sm:text-5xl'}`}>Your balance. Your rules. Put it to work.</h1>
      {!compact && <p className="mx-auto mt-4 max-w-2xl text-sm text-zinc-300 sm:text-base">Add supported funds, deploy into selected vaults, and manage partial or full withdrawals from one simple dashboard. Stay in control with clear rules, visible fees, and transparent withdrawal conditions.</p>}
      {!compact && <div className="mt-6 flex flex-wrap justify-center gap-2"><Btn kind="pri" data-testid="get-started" onClick={() => (account ? setView('deploy') : document.getElementById('md-access')?.scrollIntoView({ behavior: 'smooth' }))}>Get started</Btn><Btn kind="ghost" data-testid="explore-vaults" onClick={() => setView('vaults')}>Explore vaults</Btn></div>}
    </section>
  );

  if (!mainnet) return (
    <div className="space-y-4"><Hero /><Card><p className="text-sm text-zinc-300">MonaDefi runs on Monad mainnet, where the reviewed vault lives. You are on testnet. The PolicyPilot tools still work here.</p><Btn kind="pri" className="mt-3" onClick={() => { localStorage.setItem('pp.netkey', 'mainnet'); const u = new URL(location.href); u.searchParams.set('net', 'mainnet'); location.href = u.toString(); }}>Switch to mainnet</Btn></Card></div>
  );

  // ---------- views ----------
  if (view === 'vaults') return (
    <div className="space-y-4" data-testid="md-vaults"><Back /><h2 className="text-xl font-semibold text-zinc-50">Vaults</h2>
      <p className="text-sm text-zinc-400">Vaults are listed in review order, never by highest return. Release 1 has one reviewed vault and one asset ({ASSET.symbol}). {ASSET.note}</p>
      {VAULTS.map(v => <VaultCard key={v.id} v={v} onPick={() => setView('deploy')} />)}
      {factsErr && <p className="text-sm text-red-300">{factsErr}</p>}
    </div>
  );

  if (view === 'deploy') return (
    <div className="space-y-4" data-testid="md-deploy"><Back />
      <h2 className="text-xl font-semibold text-zinc-50">{reviewing ? 'Review and deploy' : 'Deploy funds'}</h2>
      {!account && <Card><p className="text-sm">Connect a wallet to deploy.</p><Btn kind="pri" className="mt-2" onClick={openConnect}>Connect an existing wallet</Btn></Card>}
      {!reviewing ? <>
        <Card>
          <label className="text-sm text-zinc-300" htmlFor="md-amount">Amount (MON)</label>
          <input id="md-amount" data-testid="md-amount" inputMode="decimal" value={amountTxt} onChange={e => setAmountTxt(e.target.value.replace(',', '.'))} placeholder="0.0" className="mt-1 w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3 font-mono text-lg text-zinc-50 outline-none focus:border-monad" />
          <div className="mt-2 flex flex-wrap gap-2">{([25, 50, 75, 100] as const).map(p => <Btn key={p} kind="soft" data-testid={`md-pct-${p}`} disabled={available <= 0n} onClick={() => setAmountTxt(String(Number(presetAmount(available, p)) / 1e18))}>{p === 100 ? 'Max' : `${p}%`}</Btn>)}</div>
          <p className="mt-2 text-xs text-zinc-400">Available to deploy: <b className="font-mono">{fmt(available)}</b> of {fmt(bal)} in your wallet. MonaDefi keeps {fmt(activeReserve > parseEther('0.05') ? activeReserve : parseEther('0.05'))} back for gas{rules.savedAt && rules.reserveOn ? ' and your reserve rule' : ''}.{capRoom != null && <> Your cap leaves room for {fmt(capRoom)}.</>}</p>
        </Card>
        <VaultCard v={V} picked />
        <Card><p className={`text-sm ${gate.ok ? 'text-emerald-300' : 'text-zinc-300'}`} data-testid="md-deploy-gate">{gate.text}</p>
          {preview && <p className="mt-1 text-xs text-zinc-400">Preview: {fmt(preview.amount)} → {fmt(preview.shares, 6).replace('MON', V.share)} at block {preview.block.toString()} ({timeOf(preview.at)}).</p>}
          <div className="mt-3 flex flex-wrap gap-2"><Btn kind="pri" data-testid="md-review" disabled={!gate.ok} onClick={() => setReviewing(true)}>Review</Btn>{gate.code === 'stale' && <Btn onClick={async () => amount && setPreview(await previewFor(amount))}>Refresh preview</Btn>}</div>
        </Card>
      </> : preview && amount && <Card data-testid="md-deploy-review">
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div><dt className="text-zinc-500">Amount</dt><dd className="font-mono">{fmt(amount, 6)}</dd></div>
          <div><dt className="text-zinc-500">Vault</dt><dd>{V.provider} · {V.name} ({V.share})</dd></div>
          <div><dt className="text-zinc-500">Estimated shares</dt><dd className="font-mono">{fmt(preview.shares, 6).replace('MON', V.share)}</dd></div>
          <div><dt className="text-zinc-500">Minimum accepted shares</dt><dd className="font-mono">{fmt(minShares, 6).replace('MON', V.share)} <span className="text-zinc-500">(0.5% guard)</span></dd></div>
          <div><dt className="text-zinc-500">Fees</dt><dd>No deposit fee. Gas is charged on the limit. Withdrawals later pay {facts ? `${(facts.feeBps / 100).toFixed(2)}%` : '…'}.</dd></div>
          <div><dt className="text-zinc-500">Approvals needed</dt><dd>None. You send MON with the deposit; no token allowance is created.</dd></div>
          <div className="sm:col-span-2"><dt className="text-zinc-500">Withdrawal conditions</dt><dd>{V.withdrawalText} {V.expectedWait}</dd></div>
        </dl>
        <p className="mt-3 text-xs text-zinc-400">aPriori’s deposit has no on-chain minimum-shares parameter. MonaDefi re-reads the preview right before sending and refuses if it is under your minimum, then checks the Deposit event in the receipt. If fewer shares arrive, the deployment is marked “Action required”.</p>
        <p className="mt-3 flex items-center gap-2 rounded-2xl bg-amber-500/10 p-3 text-sm text-amber-200"><AlertTriangle className="h-4 w-4 shrink-0" />Investment returns are variable. Your position can lose value.</p>
        <div className="mt-3 flex flex-wrap gap-2"><Btn kind="pri" data-testid="md-confirm" disabled={!gate.ok || busy || isStale(preview, now)} onClick={confirmDeploy}>Confirm deployment</Btn><Btn onClick={() => setReviewing(false)}>Back</Btn></div>
        {isStale(preview, now) && <p className="mt-2 text-xs text-amber-300">The preview is older than 30 seconds. Go back to refresh it.</p>}
      </Card>}
      <TxList list={list.filter(t => t.kind === 'deploy').slice(0, 5)} exp={net.exp} />
    </div>
  );

  if (view === 'withdraw') return (
    <div className="space-y-4" data-testid="md-withdraw"><Back />
      <h2 className="text-xl font-semibold text-zinc-50">{wReview ? 'Review withdrawal' : 'Withdraw'}</h2>
      {!account ? <Card><p className="text-sm">Connect a wallet to withdraw.</p><Btn kind="pri" className="mt-2" onClick={openConnect}>Connect an existing wallet</Btn></Card> : <>
      <Card>
        <div className="grid gap-2 sm:grid-cols-3">
          <Stat label="From vault" value={`${V.provider} ${V.share}`} />
          <Stat label="Estimated position value" value={fmt(invested)} sub={`${fmt(position.shares, 6).replace('MON', V.share)} · updated ${timeOf(pos?.at)}`} testid="md-w-value" />
          <Stat label="Withdrawable now" value={fmt(withdrawableNow)} sub={withdrawableNow > 0n ? 'Unlocked requests ready to claim' : 'This vault queues withdrawals'} />
        </div>
        {!wReview && <>
          <div className="mt-4 flex flex-wrap gap-2">{[25, 50, 75, 100].map(p => <Btn key={p} kind={pick.kind === 'pct' && pick.pct === p ? 'pri' : 'soft'} data-testid={`md-w-${p}`} onClick={() => setPick({ kind: 'pct', pct: p })}>{p}%</Btn>)}<Btn kind={pick.kind === 'amount' ? 'pri' : 'soft'} onClick={() => setPick({ kind: 'amount', mon: 0n })}>Amount</Btn></div>
          <p className="mt-1 text-xs text-zinc-500">A percentage is a share of your current position.</p>
          {pick.kind === 'amount' && <input data-testid="md-w-amount" inputMode="decimal" value={wAmountTxt} onChange={e => setWAmountTxt(e.target.value.replace(',', '.'))} placeholder="MON amount" className="mt-2 w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3 font-mono text-zinc-50 outline-none focus:border-monad" />}
          <button className="mt-3 text-xs text-violet-300 underline" onClick={() => setAdv(!adv)}>{adv ? 'Hide' : 'Show'} advanced</button>
          {adv && <div className="mt-2"><label className="text-xs text-zinc-400">Exact {V.share} shares</label><input inputMode="decimal" value={wSharesTxt} onChange={e => { setWSharesTxt(e.target.value.replace(',', '.')); setPick({ kind: 'shares', shares: 0n }); }} placeholder={`${V.share} amount`} className="mt-1 w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-2 font-mono text-zinc-50 outline-none focus:border-monad" /></div>}
          <fieldset className="mt-4 text-sm"><legend className="text-zinc-300">Receive into</legend>
            <label className="mt-1 flex min-h-11 items-center gap-2"><input type="radio" checked={dest === 'self'} onChange={() => setDest('self')} />My MonaDefi balance (this connected wallet, {short(account)}). MonaDefi never holds your funds, so the two are the same.</label>
            <label className="flex min-h-11 items-center gap-2"><input type="radio" checked={dest === 'other'} onChange={() => setDest('other')} />Another address</label>
            {dest === 'other' && <input value={otherTxt} onChange={e => setOtherTxt(e.target.value)} placeholder="0x…" className="mt-1 w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-2 font-mono text-zinc-50 outline-none focus:border-monad" />}
            <p className="mt-1 text-xs text-zinc-500">The address is used when you claim. You can change it then.</p>
          </fieldset>
        </>}
        <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2" data-testid="md-w-preview">
          <div><dt className="text-zinc-500">Shares to withdraw</dt><dd className="font-mono">{fmt(wShares, 6).replace('MON', V.share)}</dd></div>
          <div><dt className="text-zinc-500">Estimated proceeds</dt><dd className="font-mono">{fmt(wp.net)} <span className="text-zinc-500">(min {fmt(wp.minNet)})</span></dd></div>
          <div><dt className="text-zinc-500">Fees</dt><dd className="font-mono">{fmt(wp.fee)} <span className="text-zinc-500">({facts ? (facts.feeBps / 100).toFixed(2) : '…'}% withdrawal fee) + gas</span></dd></div>
          <div><dt className="text-zinc-500">Expected completion</dt><dd>Request now; claimable in about 12–18 hours (aPriori’s estimate), then one more transaction to claim.</dd></div>
        </dl>
        <p className={`mt-3 text-sm ${wGate.ok ? 'text-emerald-300' : 'text-zinc-300'}`}>{wGate.text}</p>
        {!wReview ? <Btn kind="pri" className="mt-3" data-testid="md-w-review" disabled={!wGate.ok} onClick={() => setWReview(true)}>Review withdrawal</Btn> : <>
          <p className="mt-3 rounded-2xl bg-white/[0.04] p-3 text-sm text-zinc-300">What happens next: your {V.share} is handed to aPriori’s withdrawal queue now and stops earning. When it unlocks, “Claim” appears on your dashboard and sends the MON to {dest === 'self' ? 'your wallet' : short(receiver ?? '')}. MonaDefi never redeploys withdrawn funds.</p>
          <div className="mt-3 flex flex-wrap gap-2"><Btn kind="pri" data-testid="md-w-confirm" disabled={!wGate.ok} onClick={confirmWithdraw}>Request withdrawal</Btn><Btn onClick={() => setWReview(false)}>Back</Btn></div>
        </>}
      </Card>
      <Requests rows={reqs} feeBps={facts?.feeBps ?? null} onClaim={rows => claim(rows, receiver ?? account)} busy={busy} />
      <Card><p className="text-sm text-zinc-300">Leaving entirely?</p><Btn kind="danger" className="mt-2" data-testid="md-withdraw-all-open" onClick={() => setView('withdraw-all')}>Withdraw all</Btn></Card>
      </>}
    </div>
  );

  if (view === 'withdraw-all') {
    const all = withdrawPreview(position.shares, grossOf, facts?.feeBps ?? null);
    return (
      <div className="space-y-4" data-testid="md-withdraw-all"><Back /><h2 className="text-xl font-semibold text-zinc-50">Withdraw all</h2>
        <Card>
          <table className="w-full text-left text-sm"><thead className="text-xs text-zinc-500"><tr><th className="py-1">Position</th><th>Value</th><th>Can exit now?</th></tr></thead><tbody>
            <tr className="border-t border-white/5"><td className="py-2">{V.provider} {V.share}</td><td className="font-mono">{fmt(invested)}</td><td>{facts?.paused ? 'No: aPriori has paused the vault.' : position.shares > 0n ? 'Request now; MON arrives after the queue (12–18 h).' : 'Nothing held.'}</td></tr>
            {claimable.length > 0 && <tr className="border-t border-white/5"><td className="py-2">Unlocked requests</td><td className="font-mono">{fmt(withdrawableNow)}</td><td>Yes, claim now.</td></tr>}
            {queued.length > 0 && <tr className="border-t border-white/5"><td className="py-2">Requests still unlocking</td><td className="font-mono">{fmt(queuedMon)}</td><td>Not yet. Waiting for liquidity.</td></tr>}
          </tbody></table>
          <p className="mt-3 text-sm text-zinc-300">Estimated proceeds {fmt(all.net + withdrawableNow - (withdrawableNow * BigInt(facts?.feeBps ?? 0)) / 10_000n)} after {fmt(all.fee + (withdrawableNow * BigInt(facts?.feeBps ?? 0)) / 10_000n)} in withdrawal fees, plus gas for each step.</p>
          <Switch on={pauseRules} onChange={setPauseRules} label="Also pause my rules" sub="Recommended. Your rules would otherwise keep suggesting deployments." testid="md-pause-rules" />
          <Btn kind="danger" className="mt-2" data-testid="md-withdraw-all-go" disabled={busy || (position.shares === 0n && !claimable.length)} onClick={withdrawAll}>Withdraw everything</Btn>
          {allSteps && <ul className="mt-3 space-y-1 text-sm">{allSteps.map(s => <li key={s.label} className="flex items-center gap-2"><Pill tone={stateTone(s.state)}>{s.state}</Pill>{s.label}</li>)}</ul>}
        </Card>
      </div>
    );
  }

  if (view === 'rules') return (
    <div className="space-y-4" data-testid="md-rules"><Back /><h2 className="text-xl font-semibold text-zinc-50">Your rules</h2>
      <p className="text-sm text-zinc-400">Rules are saved on this device for {account ? short(account) : 'your wallet'}. Saving rules does not give anyone permission to move funds. Each suggested action still needs your signature.</p>
      <Card className="space-y-1">
        <Switch on={draft.reserveOn} onChange={v => setDraft({ ...draft, reserveOn: v })} label="A · Keep a reserve" sub="MON that always stays in your wallet." testid="rule-a" />
        {draft.reserveOn && <input aria-label="Reserve in MON" value={draft.reserve} onChange={e => setDraft({ ...draft, reserve: e.target.value })} className="ml-3 w-40 rounded-xl border border-white/10 bg-black/40 px-3 py-2 font-mono" />}
        <Switch on={draft.autoDeployOn} onChange={v => setDraft({ ...draft, autoDeployOn: v })} label="B · Deploy part of new deposits" sub="Applies only to MON that arrives after you save. Never to your existing balance or to withdrawn MON." testid="rule-b" />
        {draft.autoDeployOn && <label className="ml-3 flex items-center gap-2 text-sm">Percent<input aria-label="Percent of new deposits" type="number" min={1} max={100} value={draft.autoDeployPct} onChange={e => setDraft({ ...draft, autoDeployPct: Number(e.target.value) })} className="w-24 rounded-xl border border-white/10 bg-black/40 px-3 py-2 font-mono" /></label>}
        <Switch on={draft.targetOn} onChange={v => setDraft({ ...draft, targetOn: v })} label="C · Target allocation" sub="Only proposes an action for you to approve." testid="rule-c" />
        {draft.targetOn && <label className="ml-3 flex items-center gap-2 text-sm">% of total value in {V.share}<input aria-label="Target allocation percent" type="number" min={0} max={100} value={draft.targetPct} onChange={e => setDraft({ ...draft, targetPct: Number(e.target.value) })} className="w-24 rounded-xl border border-white/10 bg-black/40 px-3 py-2 font-mono" /></label>}
        <Switch on={draft.capOn} onChange={v => setDraft({ ...draft, capOn: v })} label="D · Cap per vault" sub="The most MON you want in this vault." testid="rule-d" />
        {draft.capOn && <input aria-label="Vault cap in MON" value={draft.cap} onChange={e => setDraft({ ...draft, cap: e.target.value })} className="ml-3 w-40 rounded-xl border border-white/10 bg-black/40 px-3 py-2 font-mono" />}
        <div className="pt-2"><p className="px-3 text-sm font-medium text-zinc-100">E · Execution mode</p>
          <label className="flex min-h-11 items-center gap-2 px-3 text-sm"><input type="radio" checked={draft.mode === 'suggest'} onChange={() => setDraft({ ...draft, mode: 'suggest' })} />Suggest actions for me to approve</label>
          <label className="flex min-h-11 items-center gap-2 px-3 text-sm text-zinc-500"><input type="radio" disabled={!AUTO_MODE_AVAILABLE} checked={draft.mode === 'auto'} onChange={() => setDraft({ ...draft, mode: 'auto' })} />Execute automatically within my approved limits <Pill tone="warn">Not available</Pill></label>
          <p className="px-3 text-xs text-zinc-500" data-testid="auto-why">{AUTO_MODE_WHY}</p>
        </div>
      </Card>
      <Card><p className="text-sm font-medium text-zinc-100">In plain words</p><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-zinc-300" data-testid="rules-sentences">{describeRules(draft).map(s => <li key={s}>{s}</li>)}</ul>
        {draftErrs.length > 0 && <p className="mt-2 text-sm text-red-300">{draftErrs.join(' ')}</p>}
        <Btn kind="pri" className="mt-3" data-testid="save-rules" disabled={!account || draftErrs.length > 0} onClick={saveRules}>Save rules</Btn></Card>
    </div>
  );

  // ---------- dashboard (home) ----------
  const activity: { at: number; label: string; state?: TxState; hash?: string }[] = [
    ...list.map(t => ({ at: t.at, label: t.kind === 'deploy' ? `Deploy ${fmt(BigInt(t.amount))}` : t.kind === 'request' ? `Withdrawal request (${fmt(BigInt(t.amount), 6).replace('MON', V.share)})` : t.kind === 'claim' ? 'Claim unlocked withdrawals' : 'Withdraw all', state: t.state, hash: t.hash })),
    ...(reqs ?? []).filter(r => !myReqIds.has(r.id.toString())).map(r => ({ at: Number(r.timestamp) * 1000, label: `Withdrawal request #${r.id} for ${fmt(r.assets)} (made outside MonaDefi or on another device)`, state: requestState(r) })),
    ...recent.filter(e => !list.some(t => t.hash?.toLowerCase() === e.hash?.toLowerCase())).map(e => ({ at: Date.now(), label: `Deposit of ${fmt(e.amount)} seen on chain at block ${e.block}`, hash: e.hash })),
  ].sort((a, b) => b.at - a.at).slice(0, 12);

  return (
    <div className="space-y-4" data-testid="md-home">
      <Hero compact={!!account} />
      {!account && <Card id="md-access" data-testid="md-access">
        <h2 className="font-semibold text-zinc-50">Access your account</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <Btn kind="pri" data-testid="md-connect" onClick={openConnect}><Wallet className="h-4 w-4" />Connect an existing wallet</Btn>
          <PasskeyAccess net={net} connect={connectProvider} toast={toast} />
        </div>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-zinc-400">
          <li>MonaDefi is non-custodial. Your wallet is your account: your MON and your {V.share} stay in it, and only you can sign.</li>
          <li>Connecting a wallet is not permission to move funds. Every deployment and withdrawal is approved separately in your wallet, and rules only suggest actions.</li>
          <li>Recovery: your wallet’s recovery phrase recovers everything. Your {V.share} position and withdrawal requests live on Monad, so they show up on any device where you connect the same wallet. Only rules and this device’s activity notes are stored in this browser.</li>
          <li>No forced migration: wallets and vaults you already use in PolicyPilot keep working exactly as before.</li>
        </ul>
      </Card>}

      {account && <>
        <PasskeyBadge />
        <Card data-testid="md-balance">
          <div className="flex flex-wrap items-center gap-2"><h2 className="min-w-0 flex-1 font-semibold text-zinc-50">Balance</h2><button onClick={refreshAll} className="text-xs text-violet-300 underline">Refresh</button></div>
          <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
            <Stat label="Estimated total value" value={fmt(total)} sub="Wallet + position + requests" testid="md-total" />
            <Stat label="Available" value={fmt(available)} sub={`${fmt(bal)} in wallet, minus reserve`} testid="md-available" />
            <Stat label="Invested" value={fmt(invested)} sub={`Updated ${timeOf(pos?.at)}`} testid="md-invested" />
            <Stat label="Withdrawable now" value={fmt(withdrawableNow)} sub={queuedMon > 0n ? `${fmt(queuedMon)} still unlocking` : 'Unlocked requests'} testid="md-withdrawable" />
          </div>
          {(openTxs.length > 0 || queued.length > 0) && <p className="mt-2 text-xs text-amber-200" data-testid="md-pending">Pending: {openTxs.length} transaction(s) in progress{queued.length ? `, ${queued.length} withdrawal request(s) waiting for liquidity (${fmt(queuedMon)})` : ''}. Pending amounts are not counted as available.</p>}
          <div className="mt-4 grid grid-cols-2 gap-2"><Btn kind="pri" data-testid="md-deploy-open" onClick={() => setView('deploy')}><ArrowUpFromLine className="h-4 w-4" />Deploy funds</Btn><Btn kind="ghost" data-testid="md-withdraw-open" onClick={() => setView('withdraw')}><ArrowDownToLine className="h-4 w-4" />Withdraw</Btn></div>
          <details className="mt-3 text-xs text-zinc-400"><summary className="cursor-pointer">Add funds</summary><p className="mt-1">Send MON on Monad mainnet to your wallet address: <button className="inline-flex items-center gap-1 font-mono text-violet-300" onClick={() => { navigator.clipboard?.writeText(account); toast('Address copied', 'ok'); }}>{account}<Copy className="h-3 w-3" /></button>. MonaDefi does not take deposits itself and has no card on-ramp. Supported asset: MON. {ASSET.note}</p></details>
        </Card>

        <Card data-testid="md-performance">
          <h2 className="font-semibold text-zinc-50">Investment performance</h2>
          <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
            <Stat label="Net deposits" value={fmt(perf.netDeposits)} sub="Deposits minus withdrawals, via MonaDefi on this device" />
            <Stat label="Current position value" value={fmt(invested)} sub={`Updated ${timeOf(pos?.at)}`} />
            <Stat label="Investment gain / loss" value={perf.gain == null ? 'Not enough data yet' : signedFmt(perf.gain, 6)} sub="Separate from deposits" testid="md-gain" />
            <Stat label="Exit availability" value={facts?.paused ? 'Paused' : 'Queued, 12–18 h'} sub={`Fee ${facts ? (facts.feeBps / 100).toFixed(2) : '…'}% on withdrawal`} />
          </div>
          <p className="mt-2 text-sm text-zinc-300">Estimated variable return: <ReturnLine /></p>
          {perf.untracked > 0n && <p className="mt-1 text-xs text-zinc-500">{fmt(perf.untracked, 6).replace('MON', V.share)} in your wallet did not arrive through MonaDefi on this device, so its cost is unknown and it is left out of the gain.</p>}
        </Card>

        {proposals.length > 0 && <Card data-testid="md-proposals"><h2 className="font-semibold text-zinc-50">Suggested by your rules</h2><ul className="mt-2 space-y-2">{proposals.map(p => <li key={p.id} className="flex flex-wrap items-center gap-2 text-sm"><Pill tone="monad">{p.kind === 'deploy' ? 'Deploy' : 'Withdraw'}</Pill><span className="min-w-0 flex-1">{fmt(p.amount)} · {p.reason}</span><Btn kind="soft" onClick={() => reviewProposal(p)}>Review</Btn></li>)}</ul><p className="mt-2 text-xs text-zinc-500">Nothing is sent until you review and sign.</p></Card>}

        <Card data-testid="md-rules-card">
          <div className="flex flex-wrap items-center gap-2"><h2 className="min-w-0 flex-1 font-semibold text-zinc-50">Your rules</h2><Pill tone={rules.savedAt && (rules.autoDeployOn || rules.targetOn) ? 'monad' : 'zinc'}>Automation {rules.savedAt && (rules.autoDeployOn || rules.targetOn) ? 'on: suggestions only' : 'off'}</Pill></div>
          {rules.savedAt ? <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-zinc-300">{describeRules(rules).map(s => <li key={s}>{s}</li>)}</ul> : <p className="mt-2 text-sm text-zinc-400">No rules yet. MonaDefi does nothing on its own.</p>}
          <div className="mt-3 flex flex-wrap gap-2"><Btn kind="ghost" data-testid="md-rules-open" onClick={() => setView('rules')}><ListChecks className="h-4 w-4" />{rules.savedAt ? 'Edit rules' : 'Set rules'}</Btn>{rules.savedAt && (rules.autoDeployOn || rules.targetOn) && <Btn kind="danger" onClick={stopAutomation}>Stop all suggestions</Btn>}</div>
        </Card>

        <Card data-testid="md-vaults-table">
          <h2 className="font-semibold text-zinc-50">Your vaults</h2>
          <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[420px] text-left text-sm"><thead className="text-xs text-zinc-500"><tr><th className="py-1">Vault</th><th>Position</th><th>Withdrawable now</th></tr></thead><tbody>
            <tr className="border-t border-white/5"><td className="py-2"><button className="text-left underline decoration-white/20" onClick={() => setView('vaults')}>{V.provider} · {V.name}</button></td><td className="font-mono">{fmt(invested)}<div className="text-[11px] text-zinc-500">{fmt(position.shares, 6).replace('MON', V.share)}</div></td><td className="font-mono">{fmt(withdrawableNow)}<div className="text-[11px] text-zinc-500">{queuedMon > 0n ? `${fmt(queuedMon)} unlocking` : 'Queued withdrawals'}</div></td></tr>
          </tbody></table></div>
        </Card>

        <Requests rows={reqs} feeBps={facts?.feeBps ?? null} onClaim={rows => claim(rows, account)} busy={busy} />

        <Card data-testid="md-activity">
          <h2 className="font-semibold text-zinc-50">Recent activity</h2>
          {activity.length ? <ul className="mt-2 space-y-2 text-sm">{activity.map((a, i) => <li key={i} className="flex flex-wrap items-center gap-2">{a.state && <Pill tone={stateTone(a.state)}>{a.state}</Pill>}<span className="min-w-0 flex-1">{a.label}</span><span className="text-xs text-zinc-500">{timeOf(a.at)}</span>{a.hash && <a className="text-xs text-violet-300" href={`${net.exp}/tx/${a.hash}`} target="_blank" rel="noreferrer">tx <ExternalLink className="inline h-3 w-3" /></a>}</li>)}</ul> : <p className="mt-2 text-sm text-zinc-400">No activity yet. Deposits, requests and claims appear here once they are on chain.</p>}
          <p className="mt-3 text-xs text-zinc-500">States: {TX_STATES.join(' · ')}. Withdrawal requests are read from the aPriori contract; deposits from receipts and recent Deposit events.</p>
        </Card>

        <Card><h2 className="font-semibold text-zinc-50">Emergency controls</h2><p className="mt-1 text-sm text-zinc-400">Stop every rule suggestion, or start withdrawing everything. MonaDefi has no access to your funds and cannot pause the vault.</p><div className="mt-2 flex flex-wrap gap-2"><Btn kind="ghost" onClick={stopAutomation}>Stop all suggestions</Btn><Btn kind="danger" onClick={() => setView('withdraw-all')}>Withdraw all</Btn></div></Card>
      </>}

      <Card><h2 className="font-semibold text-zinc-50">How MonaDefi works</h2><ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-zinc-300"><li>Connect a wallet.</li><li>Add MON to it.</li><li>Choose the reviewed vault.</li><li>Set an amount and, if you like, rules.</li><li>Review and deploy.</li><li>Track balance and performance here.</li><li>Withdraw a percentage, an amount, or everything.</li></ol>
        <p className="mt-3 text-xs text-zinc-500">The PolicyPilot tools are still here: <button className="underline" onClick={() => setTab('launch')}>Dispatch and agent vaults</button>, <button className="underline" onClick={() => setTab('activity')}>activity, including the {TEAM_LABEL}</button>, and the <a className="underline" href={`${base}/research/`}>research tape</a>.</p>
      </Card>
    </div>
  );
}

function Requests({ rows, feeBps, onClaim, busy }: { rows: RequestRow[] | null; feeBps: number | null; onClaim: (rows: RequestRow[]) => void; busy: boolean }) {
  const open = (rows ?? []).filter(r => !r.claimed);
  if (!open.length) return null;
  const ready = open.filter(r => r.claimable);
  return (
    <Card data-testid="md-requests"><h2 className="font-semibold text-zinc-50">Withdrawal requests</h2>
      <ul className="mt-2 space-y-2 text-sm">{open.map(r => <li key={r.id.toString()} className="flex flex-wrap items-center gap-2"><Pill tone={r.claimable ? 'warn' : 'monad'}>{r.claimable ? 'Action required: claim' : 'Waiting for liquidity'}</Pill><span className="min-w-0 flex-1">#{r.id.toString()} · {fmt(r.assets)} gross{feeBps != null && ` · ≈ ${fmt(r.assets - (r.assets * BigInt(feeBps)) / 10_000n)} after fee`}</span><span className="text-xs text-zinc-500">requested {new Date(Number(r.timestamp) * 1000).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}</span></li>)}</ul>
      {ready.length > 0 && <Btn kind="pri" className="mt-3" data-testid="md-claim" disabled={busy} onClick={() => onClaim(ready)}>Claim {ready.length} unlocked request(s)</Btn>}
    </Card>
  );
}

function TxList({ list, exp }: { list: TxRecord[]; exp: string }) {
  if (!list.length) return null;
  return (
    <Card><h3 className="text-sm font-semibold text-zinc-100">Transaction status</h3><ul className="mt-2 space-y-2 text-sm">{list.map(t => <li key={t.id} className="flex flex-wrap items-center gap-2"><Pill tone={stateTone(t.state)}>{t.state}</Pill><span className="min-w-0 flex-1">{fmt(BigInt(t.amount))}{t.note ? ` · ${t.note}` : ''}</span>{t.hash && <a className="text-xs text-violet-300" href={`${exp}/tx/${t.hash}`} target="_blank" rel="noreferrer">tx ↗</a>}</li>)}</ul></Card>
  );
}
