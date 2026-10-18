'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createWalletClient, custom, formatEther, formatUnits, getAddress, http, isAddress, parseEther, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { Activity, Bot, Check, ChevronRight, ExternalLink, KeyRound, LayoutGrid, Lock, Play, Rocket, ShieldCheck, Sparkles, Wallet, Gauge, Coins, Users, Zap } from 'lucide-react';
import { Btn, Card, Pill, Sheet, Slider, Switch, useToasts } from './ui';
import PolicyDashboard from './Dashboard';
import ShowcaseAgents from './ShowcaseAgents';
import { discoverWallets, deepLinks, INSTALL, isMobile, haptic, type Discovered, type Eip1193 } from '@/lib/wallets';
import { addLocal, APP_VAULT_MON, buildAction, buildCreate, buildStarter, chainOf, decodeInput, erc20, executableMon, factoryAbi, fetchTeamSnapshot, loadHistory, mon, plain, pubOf, quoteAll, readVault, reasonOf, resolveNet, sendFault, services, short, STARTER, TEAM_LABEL, vaultAbi, vcall, type Quote, type Ev, type Net, type Policy, type TeamAgent, type TeamSnapshot, type VaultState } from '@/lib/vault';
import { TOKENS, type TokenSym } from '@/lib/services';
import { buildSuper, matchSuper, SUPER_VAULTS, type SuperVault } from '@/lib/superVaults';
import { limitsFor } from '@/lib/spend';
import VaultReport from './VaultReport';
import FastDispatch from './FastDispatch';
import PrimeTerminal from './PrimeTerminal';
import SpreadDesk from './SpreadDesk';
import ClipDesk from './ClipDesk';
import MonaDefi from './MonaDefi';
import { chainIdNumber, ensureWalletChain, evaluateVault, fixedOwnerGas, GAS, isConnectorDead, isPromptTimeout, isUserReject, pendingReceiptError, planWalletReload, pricedGas, queueWallet, receiptWaitMs, revertedReceiptError, sendViaWallet, sendWithKey, watchHeads, withDeadline } from '@/lib/fastPath';

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
type Tab = 'home' | 'launch' | 'activity' | 'agents' | 'services' | 'policy';
const TABS: { id: Tab; label: string; icon: any }[] = [
  { id: 'home', label: 'Home', icon: Coins }, { id: 'launch', label: 'Launch', icon: Rocket }, { id: 'activity', label: 'Activity', icon: Activity }, { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'services', label: 'Services', icon: LayoutGrid }, { id: 'policy', label: 'Policy', icon: Gauge },
];

export default function App() {
  const [net, setNet] = useState<Net | null>(null);
  const pub = useMemo(() => (net ? pubOf(net) : null), [net]);
  const [tab, setTabState] = useState<Tab>('home');
  const { push: toast, view: toasts } = useToasts();
  const [wallets, setWallets] = useState<Discovered[]>([]);
  const [prov, setProv] = useState<Eip1193 | null>(null);
  const [account, setAccount] = useState<Address | null>(null);
  const [wallet, setWallet] = useState<WalletClient | null>(null);
  const [bal, setBal] = useState<bigint | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [block, setBlock] = useState<bigint | null>(null);
  const [heads, setHeads] = useState<'socket' | 'polling'>('polling');
  const [vaults, setVaults] = useState<VaultState[] | null>(null);
  const [hist, setHist] = useState<{ events: Ev[]; showcase: any } | null>(null);
  const [kpi, setKpi] = useState<{ vaults: number; tvl: bigint; note: string } | null>(null);

  useEffect(() => {
    const n = resolveNet(); setNet(n);
    // MonaDefi is the default home (#/ and #/deploy, #/withdraw, ...). Every existing tab keeps its own hash (#launch, #activity, ...).
    const h = (location.hash.slice(1) as Tab); if (TABS.some(t => t.id === h)) setTabState(h); else if (location.pathname.replace(/\/$/, '').endsWith('/app') || !location.hash || location.hash.startsWith('#/')) setTabState('home');
    const off = discoverWallets(setWallets);
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register(`${BASE}/sw.js`).catch(() => {});
    return off;
  }, []);
  const setTab = (t: Tab) => { haptic(6); setTabState(t); history.replaceState(null, '', `${location.pathname}${location.search}#${t === 'home' ? '/' : t}`); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const switchNet = (key: 'mainnet' | 'testnet') => { localStorage.setItem('pp.netkey', key); const u = new URL(location.href); u.searchParams.set('net', key); u.searchParams.delete('rpc'); u.searchParams.delete('factory'); location.href = u.toString(); };

  // WebSocket heads when a public endpoint connects; HTTP poll until then, and whenever ?rpc= replaced the public list.
  useEffect(() => {
    if (!pub || !net) return;
    let on = true; let live = false;
    const tick = () => pub.getBlockNumber().then(b => { if (on && !live) setBlock(b); }).catch(() => {});
    tick();
    const http = setInterval(tick, 6000);
    setHeads('polling');
    const stop = watchHeads(net, n => { if (!on) return; live = true; clearInterval(http); setBlock(n); setHeads('socket'); });
    return () => { on = false; clearInterval(http); stop(); };
  }, [pub, net]);

  const refreshHist = useCallback(async () => {
    if (!pub || !net) return;
    try { setHist(await loadHistory(pub, net, BASE)); } catch (e) { console.warn(e); }
    try {
      let n = 0; const addrs: Address[] = [];
      for (const f of [net.factory, ...(net.legacy ?? [])]) {
        const c = Number(await pub.readContract({ address: f, abi: factoryAbi, functionName: 'vaultCount' }).catch(() => 0n)); n += c;
        const idx = [...Array(Math.min(c, 40)).keys()];
        addrs.push(...await Promise.all(idx.map(i => pub.readContract({ address: f, abi: factoryAbi, functionName: 'allVaults', args: [BigInt(i)] }) as Promise<Address>)));
      }
      const bals = await Promise.all(addrs.map(a => pub.getBalance({ address: a })));
      setKpi({ vaults: n, tvl: bals.reduce((s, x) => s + x, 0n), note: n > 80 ? 'MON-in-vaults covers the first 40 vaults per factory' : '' });
    } catch { setKpi(null); }
  }, [pub, net]);
  useEffect(() => { refreshHist(); const t = setInterval(refreshHist, 45000); return () => clearInterval(t); }, [refreshHist]);

  const loadVaults = useCallback(async (acc = account) => {
    if (!pub || !net || !acc) return;
    try {
      const list = (await Promise.all([...(net.legacy ?? []), net.factory].map(f => pub.readContract({ address: f, abi: factoryAbi, functionName: 'vaultsOf', args: [acc] }).catch(() => []) as Promise<Address[]>))).flat();
      const out: VaultState[] = []; for (const v of [...list].reverse()) out.push(await readVault(pub, net, v));
      setVaults(out);
    } catch (e: any) { toast(`Couldn't load your agents: ${e.shortMessage ?? e.message}`, 'bad'); }
  }, [pub, net, account]);

  // ---------- wallet ----------
  // A prompt, a chain switch, or a receipt wait must not reload the page out from under itself.
  const sendsInFlight = useRef(0);
  const deferredReload = useRef(false);
  const watched = useRef(new WeakSet<object>());
  const session = useRef({ account: null as Address | null, wallet: null as WalletClient | null, prov: null as Eip1193 | null, net, pub, wallets });
  session.current = { account, wallet, prov, net, pub, wallets };
  const endFlight = () => {
    sendsInFlight.current = Math.max(0, sendsInFlight.current - 1);
    if (sendsInFlight.current === 0 && deferredReload.current) location.reload();
  };
  const onWalletEvent = (changed: boolean) => {
    const plan = planWalletReload(sendsInFlight.current, changed);
    if (plan === 'reload') location.reload();
    else if (plan === 'defer') deferredReload.current = true;
  };
  const arm = (p: Eip1193) => {
    if (watched.current.has(p)) return;
    watched.current.add(p);
    p.on?.('accountsChanged', (accs: string[]) => {
      const next = (accs?.[0] ?? '').toLowerCase();
      onWalletEvent(next !== (session.current.account ?? '').toLowerCase());
    });
    p.on?.('chainChanged', (id: string) => onWalletEvent(chainIdNumber(id) !== session.current.net?.id));
  };
  const connectWith = async (d: Discovered, silent = false) => {
    const live = session.current;
    if (!live.net || !live.pub) return false;
    sendsInFlight.current += 1;
    try {
      const accs: string[] = await withDeadline(d.provider.request({ method: silent ? 'eth_accounts' : 'eth_requestAccounts' }), 45_000, () => new Error("Your wallet didn't answer. Try connecting again."));
      if (!accs?.length) return false;
      await ensureWalletChain(d.provider, live.net);
      const a = getAddress(accs[0]);
      const client = createWalletClient({ account: a, chain: chainOf(live.net), transport: custom(d.provider, { retryCount: 0 }) });
      session.current = { ...session.current, account: a, prov: d.provider, wallet: client };
      setProv(d.provider); setAccount(a); setWallet(client);
      localStorage.setItem('pp.wallet', d.info.rdns); setConnectOpen(false);
      const b = await live.pub.getBalance({ address: a }); setBal(b);
      if (!silent) toast(<>Connected <b>{d.info.name}</b> · {short(a)}</>, 'ok');
      if (b === 0n && !silent) toast(live.net.faucet ? <>0 MON. Get test MON at the <a className="underline" href={live.net.faucet} target="_blank" rel="noreferrer">faucet</a>.</> : 'Your wallet has 0 MON on Monad.', 'bad');
      arm(d.provider);
      loadVaults(a);
      session.current = { ...session.current, account: a, prov: d.provider, wallet: client, net: live.net, pub: live.pub };
      return true;
    } catch (e) { if (!silent) toast(plain(reasonOf(e)), 'bad'); return false; }
    finally { endFlight(); }
  };
  const autoTried = useRef(false);
  useEffect(() => { if (autoTried.current || !net || !wallets.length) return; const r = localStorage.getItem('pp.wallet'); const d = wallets.find(w => w.info.rdns === r); if (d) { autoTried.current = true; connectWith(d, true); } }, [wallets, net]); // eslint-disable-line
  const need = async () => {
    const live = session.current;
    if (live.account && live.wallet && live.prov && live.net) {
      sendsInFlight.current += 1;
      try { await ensureWalletChain(live.prov, live.net); return true; }
      finally { endFlight(); }
    }
    setConnectOpen(true); return false;
  };
  const waitReceipt = async (hash: Hex, deploy: boolean) => {
    const ms = receiptWaitMs(deploy);
    try {
      const rc = await withDeadline(
        session.current.pub!.waitForTransactionReceipt({ hash, timeout: ms, pollingInterval: 400 }),
        ms + 3_000,
        () => pendingReceiptError(hash),
      );
      if (rc.status !== 'success') throw revertedReceiptError(hash);
      return rc;
    } catch (e) {
      if ((e as { hash?: Hex }).hash) throw e;
      throw pendingReceiptError(hash);
    }
  };
  const submit = async (client: WalletClient, req: { to?: Address; data?: Hex; value?: bigint; gas?: bigint }, onHash?: (h: Hex) => void) => {
    if (!client?.account) throw new Error('Connect your wallet first.');
    const live = session.current;
    sendsInFlight.current += 1;
    try {
      if (live.prov && live.net) await ensureWalletChain(live.prov, live.net);
      const hash = await queueWallet(() => sendViaWallet(client, async () => (await session.current.pub!.getBlock()).baseFeePerGas ?? null, req));
      onHash?.(hash);
      return await waitReceipt(hash, !req.to);
    } finally { endFlight(); }
  };
  const send = async (w: WalletClient, req: { to?: Address; data?: Hex; value?: bigint; gas?: bigint }, onHash?: (h: Hex) => void) => {
    try {
      return await submit(w, req, onHash);
    } catch (e) {
      if (isUserReject(e) || isPromptTimeout(e) || !isConnectorDead(e)) throw e;
      const rdns = localStorage.getItem('pp.wallet');
      const d = session.current.wallets.find(x => x.info.rdns === rdns);
      if (!d) throw e;
      const ok = await connectWith(d, true);
      const next = session.current.wallet;
      if (!ok || !next) throw e;
      return await submit(next, req, onHash);
    }
  };
  const refreshBal = () => account && pub?.getBalance({ address: account }).then(setBal).catch(() => {});

  // ---------- agent actions ----------
  const agentWallet = (s: VaultState) => (s.key ? createWalletClient({ account: privateKeyToAccount(s.key as Hex), chain: chainOf(net!), transport: http(net!.rpc) }) : s.executor === account ? wallet : null);
  const runAgent = async (s: VaultState, kind: string, amount: bigint, extra: { to?: Address; venues?: ('uniswap' | 'pancake')[] } = {}): Promise<{ ok: boolean; msg: React.ReactNode; detail: string }> => {
    const blocked = (label: string, detail: string, revertReason: string, value: bigint, dapp = 'Vault', icon = '🛡️') => {
      addLocal(net!, { label, kind: 'blocked', dapp, icon, revertReason, simulated: true, value });
      refreshHist();
      return { ok: false as const, detail, msg: <>🛡️ <b>Blocked by the vault:</b> {detail} Nothing was sent and no gas was spent.</> };
    };
    const local = evaluateVault(s, s.executor, kind, amount, extra.to);
    if (!local.ok) return blocked(`Blocked: ${kind}`, plain({ name: local.name, args: local.args }), `${local.name}(${(local.args ?? []).map(String).join(', ')})`, amount);
    const a = await buildAction(pub!, kind, s.v, s.owner, s.executor, amount, s.cap, extra);
    const fromChain = (e: unknown) => { const r = reasonOf(e); return blocked(`Blocked: ${a.label}`, plain(r), r.name ? `${r.name}(${(r.args ?? []).map(String).join(', ')})` : (r.raw ?? plain(r)), a.value, a.dapp, a.icon); };
    const w = agentWallet(s);
    if (!w) {
      try { await pub!.call({ account: s.executor, ...a.req }); }
      catch (e) { return fromChain(e); }
      return { ok: true, detail: 'Passes the policy. The agent key is not in this browser, so nothing was sent.', msg: <>✅ This passes the policy. Your agent {short(s.executor)} signs it with its own key (not in this browser).</> };
    }
    let gas: bigint;
    if (kind === 'pay') gas = GAS.pay;
    else if (kind === 'payto') {
      try { await pub!.call({ account: s.executor, ...a.req }); }
      catch (e) { return fromChain(e); }
      gas = GAS.pay;
    } else { try { gas = await pricedGas(pub!, w.account!.address, a.req); } catch (e) { return fromChain(e); } }
    let rc;
    if (s.key) {
      try {
        const hash = await sendWithKey(net!, s.key as Hex, { ...a.req, gas }, pub!);
        rc = await waitReceipt(hash, false);
      } catch (e) {
        if ((e as { hash?: Hex }).hash || isUserReject(e) || isPromptTimeout(e)) throw e;
        rc = await send(w, { ...a.req, gas });
      }
    } else rc = await send(w, { ...a.req, gas });
    addLocal(net!, { label: a.label, kind: 'allowed', tx: rc.transactionHash, from: w.account!.address });
    refreshHist(); loadVaults();
    return { ok: true, detail: a.label, msg: <>✅ <b>Done:</b> {a.label}. <a className="underline" href={`${net!.exp}/tx/${rc.transactionHash}`} target="_blank" rel="noreferrer">View tx ↗</a></> };
  };
  const ownerTx = async (label: string, req: { to: Address; data: Hex; value?: bigint; gas?: bigint }) => {
    if (!(await need())) throw new Error('Connect your wallet first');
    const gas = req.gas ?? fixedOwnerGas(req.data) ?? await pricedGas(pub!, account!, { to: req.to, data: req.data, value: req.value });
    const rc = await send(wallet!, { ...req, gas }); addLocal(net!, { label, kind: 'owner', tx: rc.transactionHash, from: account }); refreshHist(); loadVaults(); refreshBal();
    return { ok: true, msg: <>✅ {label}. <a className="underline" href={`${net!.exp}/tx/${rc.transactionHash}`} target="_blank" rel="noreferrer">View tx ↗</a></> };
  };

  if (!net) return <div className="grid min-h-dvh place-items-center text-zinc-500">Loading…</div>;
  const conn = account ? <><span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" /><span className="font-mono">{short(account)}</span>{bal != null && <span className="hidden font-mono tabular-nums text-zinc-400 sm:inline">{Number(formatEther(bal)).toFixed(3)}</span>}</> : <><Wallet className="h-4 w-4 shrink-0" /><span>Connect</span></>;

  return (
    <div className="min-h-dvh overflow-x-clip pb-[calc(5.5rem+env(safe-area-inset-bottom))] lg:pb-10">
      {toasts}
      <div className="bg-amber-500/10 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)] text-center text-[11px] leading-5 text-amber-200" data-testid="alpha">⚠️ <b>Alpha · unaudited contract · only deposit what you&apos;re happy to lose.</b> Max {APP_VAULT_MON} MON per new vault. An earlier vault can be raised up to its own on-chain cap from Dispatch.{net.id === 143 ? ' Monad mainnet = real MON.' : ' Testnet = free test MON.'}</div>
      <header className="sticky top-0 z-40 border-b border-white/5 bg-ink">
        <div className="mx-auto flex h-16 min-w-0 max-w-6xl items-center gap-2 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
          <button onClick={() => setTab('home')} className="flex min-h-11 min-w-0 items-center gap-2" aria-label="MonaDefi home"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-monad/20"><ShieldCheck className="h-5 w-5 text-monad" /></span><span className="truncate text-base font-semibold text-zinc-50">MonaDefi</span><span className="hidden truncate text-xs text-zinc-500 sm:inline">by PolicyPilot</span></button>
          <nav className="ml-4 hidden items-center gap-1 lg:flex">{TABS.map(t => <button key={t.id} onClick={() => setTab(t.id)} className={`min-h-11 rounded-xl px-3 text-sm transition ${tab === t.id ? 'bg-white/10 text-white' : 'text-zinc-400 hover:text-white'}`}>{t.label}</button>)}<a href={`${BASE}/research/`} className="flex min-h-11 items-center rounded-xl px-3 text-sm text-zinc-400 hover:text-white">Tape</a></nav>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <button data-testid="net" data-heads={heads} aria-label={`Network: Monad ${net.name}. Tap to switch.`} onClick={() => switchNet(net.id === 143 ? 'testnet' : 'mainnet')} className="flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-2xl border border-white/10 px-2 text-xs text-zinc-300 sm:px-3" title={heads === 'socket' ? 'Live blocks over WebSocket. Tap to switch network.' : 'Blocks by polling. Tap to switch network.'}><span className={`h-2.5 w-2.5 rounded-full ${block ? (net.id === 143 ? 'bg-emerald-400' : 'bg-amber-400') : 'bg-zinc-600'}`} /><span className="hidden sm:inline">{net.id === 143 ? 'Mainnet' : 'Testnet'}</span></button>
            <Btn kind={account ? 'ghost' : 'pri'} data-testid="connect" className="shrink-0 px-3" onClick={() => setConnectOpen(true)}>{conn}</Btn>
          </div>
        </div>
      </header>

      <main className="mx-auto min-w-0 max-w-6xl pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-4">
        {tab === 'home' && <MonaDefi {...{ net, pub: pub!, account, wallet, bal, need, send, toast, block, setTab, refreshBal, base: BASE }} openConnect={() => setConnectOpen(true)} />}
        {tab === 'launch' && <Launch {...{ net, pub: pub!, account, wallet, bal, vaults, need, send, runAgent, ownerTx, toast, refreshHist, loadVaults, setTab, block, kpi, hist }} />}
        {tab === 'activity' && <ActivityView {...{ net, pub, hist, kpi, block, vaults, account, runAgent, setTab, refresh: refreshHist }} />}
        {tab === 'agents' && <Agents {...{ net, pub: pub!, account, wallet, need, send, vaults, loadVaults, runAgent, ownerTx, setConnectOpen, setTab, toast, refreshHist }} />}
        {tab === 'services' && <ServicesView net={net} />}
        {tab === 'policy' && <PolicyDashboard embedded />}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-ink pb-[env(safe-area-inset-bottom)] lg:hidden" data-testid="tabbar">
        <div className="mx-auto grid max-w-lg grid-cols-6 pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
          {TABS.map(t => { const I = t.icon; const on = tab === t.id; return (
            <button key={t.id} onClick={() => setTab(t.id)} aria-current={on ? 'page' : undefined} className={`flex min-h-16 min-w-0 flex-col items-center justify-center gap-1 text-[11px] transition active:scale-90 ${on ? 'text-white' : 'text-zinc-500'}`}>
              <span className={`grid h-8 w-12 place-items-center rounded-full transition ${on ? 'bg-monad/25' : ''}`}><I className={`h-5 w-5 ${on ? 'text-violet-300' : ''}`} /></span>{t.label}
            </button>); })}
        </div>
      </nav>

      <ConnectSheet open={connectOpen} onClose={() => setConnectOpen(false)} wallets={wallets} onPick={d => connectWith(d)} account={account} onDisconnect={() => { localStorage.removeItem('pp.wallet'); onWalletEvent(true); }} />
    </div>
  );
}

// ---------------- Connect wallet ----------------
function ConnectSheet({ open, onClose, wallets, onPick, account, onDisconnect }: { open: boolean; onClose: () => void; wallets: Discovered[]; onPick: (d: Discovered) => void; account: Address | null; onDisconnect: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const links = typeof window !== 'undefined' ? deepLinks(location.href) : [];
  const mobile = isMobile();
  return (
    <Sheet open={open} onClose={onClose} title={account ? 'Wallet' : 'Connect a wallet'}>
      {account && <div className="mb-4 flex items-center gap-2 rounded-2xl bg-white/5 p-3"><span className="min-w-0 flex-1 truncate font-mono text-sm">{account}</span><Btn kind="ghost" onClick={onDisconnect}>Disconnect</Btn></div>}
      <p className="mb-3 text-sm text-zinc-400">Wallets found in this browser (EIP-6963):</p>
      <div className="grid gap-2" data-testid="wallet-list">
        {wallets.map(w => (
          <button key={w.info.uuid} data-testid="wallet-option" onClick={async () => { setBusy(w.info.uuid); await onPick(w); setBusy(null); }} className="flex min-h-14 w-full min-w-0 items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-3 text-left transition hover:border-monad/60 active:scale-[0.99]">
            {w.info.icon ? <img src={w.info.icon} alt="" className="h-9 w-9 shrink-0 rounded-xl" /> : <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-monad/20"><Wallet className="h-5 w-5 text-monad" /></span>}
            <span className="min-w-0 flex-1 truncate font-medium">{w.info.name}</span>
            {busy === w.info.uuid ? <span className="text-xs text-zinc-400">Check your wallet…</span> : <ChevronRight className="h-4 w-4 shrink-0 text-zinc-500" />}
          </button>
        ))}
        {!wallets.length && <div className="rounded-2xl border border-dashed border-white/15 p-4 text-sm text-zinc-400">No wallet detected here.{mobile ? ' Open this app inside your wallet’s browser:' : ' Install one (MetaMask, Rabby, Phantom, Backpack, OKX, Coinbase), then reload.'}</div>}
      </div>
      <p className="mb-2 mt-5 text-sm text-zinc-400">{mobile ? 'On your phone? Open in your wallet app:' : 'On mobile, these open this page in your wallet’s browser:'}</p>
      <div className="grid grid-cols-2 gap-2" data-testid="deeplinks">
        {links.map(l => <a key={l.id} href={l.href} rel="noopener noreferrer" className="flex min-h-11 min-w-0 items-center justify-center gap-1 truncate rounded-2xl border border-white/10 bg-white/[0.03] px-2 text-sm hover:border-monad/60">{l.name}<ExternalLink className="h-3 w-3 shrink-0 opacity-60" /></a>)}
      </div>
      {!mobile && !wallets.length && <div className="mt-4 flex flex-wrap gap-2">{INSTALL.map(i => <a key={i.name} className="text-xs text-violet-300 underline" href={i.href} target="_blank" rel="noreferrer">Get {i.name}</a>)}</div>}
      <p className="mt-4 text-xs text-zinc-500">No WalletConnect QR: it needs a project ID from a third-party signup, so we left it out. The deep links above cover mobile.</p>
    </Sheet>
  );
}

// ---------------- Launch (novice flow) ----------------
function Step({ n, title, done, active, children, testid }: { n: number; title: string; done?: boolean; active?: boolean; children: React.ReactNode; testid?: string }) {
  return (
    <Card data-testid={testid} className={`transition ${active ? 'ring-1 ring-monad/60' : ''}`}>
      <div className="mb-3 flex items-center gap-3"><span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-semibold ${done ? 'bg-emerald-500 text-white' : active ? 'bg-monad text-white' : 'bg-white/10 text-zinc-400'}`}>{done ? <Check className="h-4 w-4" /> : n}</span><h2 className="min-w-0 flex-1 truncate font-semibold text-zinc-50">{title}</h2></div>
      {children}
    </Card>
  );
}
function Launch({ net, pub, account, wallet, bal, vaults, need, send, runAgent, ownerTx, toast, refreshHist, loadVaults, setTab, kpi, hist, block }: any) {
  const live = services(net).filter(s => s.status === 'live');
  const [agentMode, setAgentMode] = useState<'new' | 'external'>('new');
  const [ext, setExt] = useState('');
  const [p, setP] = useState<Policy>({ budgetOn: true, budget: APP_VAULT_MON, capOn: true, cap: APP_VAULT_MON, deposit: 2.5, gas: 2, services: live.map(s => s.id), payees: [], startPaused: false });
  const [payeesTxt, setPayeesTxt] = useState('');
  const [prog, setProg] = useState<{ t: string; s: 'run' | 'ok' | 'err'; h?: string }[]>([]);
  const [busy, setBusy] = useState(false); const [doneVault, setDoneVault] = useState<string | null>(null);
  const up = (o: Partial<Policy>) => setP(x => { const n = { ...x, ...o }; if (n.cap > n.budget) n.cap = n.budget; if (n.budget > APP_VAULT_MON) n.budget = APP_VAULT_MON; return n; });
  const extOk = agentMode === 'new' || isAddress(ext.trim());
  const step = !account ? 1 : !extOk ? 2 : 3;
  const allowed = live.filter(s => p.services.includes(s.id));
  const summary = `Your agent can spend ${p.capOn ? `at most ${p.cap.toFixed(3)} MON per action` : 'any amount per action'}${p.budgetOn ? ` and ${p.budget.toFixed(3)} MON in total` : ` (bounded only by the ${APP_VAULT_MON} MON vault cap)`}, only on ${allowed.length ? allowed.map(s => s.name).join(', ') : 'nothing yet'}. Every output comes back to the vault. You can pause it or pull everything back in one tap.`;

  const [room, setRoom] = useState<bigint | null>(null);
  useEffect(() => { let on = true; (async () => { try { const [gc, td] = await Promise.all([pub.readContract({ address: net.factory, abi: factoryAbi, functionName: 'globalCap' }), pub.readContract({ address: net.factory, abi: factoryAbi, functionName: 'totalDeposited' })]) as [bigint, bigint]; if (on) setRoom(gc > td ? gc - td : 0n); } catch { /* older factory */ } })(); return () => { on = false; }; }, [pub, net, block]);
  const depWei = BigInt(Math.round(p.deposit * 1e6)) * 10n ** 12n; const overRoom = room != null && depWei > room;
  const launch = async () => {
    try { if (!(await need())) return; } catch (e) { const f = sendFault(e); toast(f.text, 'bad'); return; }
    setBusy(true); setProg([]); setDoneVault(null);
    const add = (t: string) => { setProg(l => [...l, { t, s: 'run' }]); return { ok: (h?: string) => setProg(l => l.map((x, i) => (i === l.length - 1 ? { ...x, s: 'ok', h } : x))), err: (m: string) => setProg(l => l.map((x, i) => (i === l.length - 1 ? { ...x, s: 'err', t: `${x.t} – ${m}` } : x))) }; };
    let cur: any;
    try {
      let exec: Address = account; let key: Hex | null = null;
      if (agentMode === 'new') { key = generatePrivateKey(); exec = privateKeyToAccount(key).address; localStorage.setItem(`pp.agentkey.${exec.toLowerCase()}`, key); }
      else exec = getAddress(ext.trim());
      const payees = payeesTxt.split(/[\s,]+/).filter(Boolean).map(a => { if (!isAddress(a)) throw new Error(`Bad payee address ${a}`); return getAddress(a); });
      const c = buildCreate(exec, account, { ...p, payees });
      cur = add('Creating your vault with every rule baked in (1 signature)');
      await pub.call({ account, to: net.factory, data: c.data, value: c.value });
      const rc = await send(wallet, { to: net.factory, data: c.data, value: c.value, gas: GAS.createVault }); cur.ok(rc.transactionHash);
      addLocal(net, { label: 'Harness on: vault created with limits + services', kind: 'owner', tx: rc.transactionHash, from: account });
      const list = await pub.readContract({ address: net.factory, abi: factoryAbi, functionName: 'vaultsOf', args: [account] }) as Address[]; const v = list[list.length - 1];
      if (p.startPaused) { cur = add('Starting paused'); const r = await send(wallet, { ...vcall(v, 'setPaused', [true]), gas: GAS.pause }); cur.ok(r.transactionHash); addLocal(net, { label: 'Owner pauses the agent', kind: 'owner', tx: r.transactionHash, from: account }); }
      if (key && p.gas > 0) { cur = add(`Sending ${p.gas} MON of gas to your agent`); const r = await send(wallet, { to: exec, value: parseEther(String(p.gas)), gas: 21_000n }); cur.ok(r.transactionHash); addLocal(net, { label: 'Gas sent to agent key', kind: 'owner', tx: r.transactionHash, from: account }); }
      setDoneVault(v); haptic([10, 40, 10] as any); toast('🚀 Your agent is out in the wild, with a harness on.', 'ok'); loadVaults(); refreshHist();
    } catch (e) { const f = sendFault(e); cur ? cur.err(f.text) : toast(f.text, f.pending ? 'info' : 'bad'); }
    setBusy(false);
  };

  const [desk, setDesk] = useState('desk-dispatch');
  useEffect(() => {
    const ids = ['desk-dispatch', 'desk-prime', 'desk-spread', 'desk-clip', 'desk-rules'];
    const obs = new IntersectionObserver(entries => {
      const hit = entries.filter(e => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (hit?.target.id) setDesk(hit.target.id);
    }, { rootMargin: '-20% 0px -60% 0px', threshold: [0.15, 0.4] });
    ids.forEach(id => { const el = document.getElementById(id); if (el) obs.observe(el); });
    return () => obs.disconnect();
  }, []);
  const jump = (id: string) => {
    haptic(6);
    const el = document.getElementById(id);
    if (el instanceof HTMLDetailsElement) el.open = true;
    setDesk(id);
    requestAnimationFrame(() => el?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  const products = [
    { id: 'desk-dispatch', label: 'Dispatch', title: 'Stake, swap, or pay yourself. The button sends one real transaction.' },
    { id: 'desk-prime', label: 'Prime', title: 'Open your two-tranche pool. Capped at 10 MON. No promised rate.' },
    { id: 'desk-spread', label: 'Spread', title: 'Quotes Uniswap 0.30%, Uniswap 0.05%, PancakeSwap, and Kuru. Sends the largest size inside a 0.50% shortfall.' },
    { id: 'desk-clip', label: 'Clip', title: 'Low-gas round trip on the pools directly. Sends the largest size inside a 0.50% shortfall. Gas is still the 420,000 limit.' },
    { id: 'desk-rules', label: 'Rules', title: 'Custom agent, budget, cap, and which services are allowed.' },
  ];

  return (
    <div className="grid gap-4">
      <nav data-testid="product-rail" aria-label="Products" className="sticky top-16 z-30 grid grid-cols-3 gap-1 rounded-2xl border border-white/10 bg-zinc-950 p-1 shadow-[0_12px_30px_-12px_rgba(0,0,0,0.9)] sm:grid-cols-5">
        {products.map(item => (
          <button key={item.id} type="button" data-testid={`jump-${item.id}`} title={item.title} aria-current={desk === item.id ? 'true' : undefined} onClick={() => jump(item.id)} className={`flex min-h-11 min-w-0 items-center justify-center rounded-xl px-1 text-[11px] font-semibold transition active:scale-95 sm:text-sm ${desk === item.id ? 'bg-white/10 text-white' : 'text-zinc-400'}`}>{item.label}</button>
        ))}
      </nav>
      <a href={`${BASE}/research/`} data-testid="desk-tape" className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3 text-xs text-zinc-200">Desk tape · 16 Oct<span className="mt-0.5 block truncate text-[11px] font-normal text-zinc-500">Four fills landed. The next set did not clear.</span></a>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" data-testid="jump-agents" onClick={() => setTab('agents')} className="min-h-11 min-w-0 rounded-2xl border border-white/10 bg-white/[0.03] px-3 text-left text-xs text-zinc-200">Your vaults<span className="mt-0.5 block truncate text-[11px] font-normal text-zinc-500">Deposit, pause, pull MON back</span></button>
        <button type="button" data-testid="jump-activity" onClick={() => setTab('activity')} className="min-h-11 min-w-0 rounded-2xl border border-white/10 bg-white/[0.03] px-3 text-left text-xs text-zinc-200">Live activity<span className="mt-0.5 block truncate text-[11px] font-normal text-zinc-500">Real mainnet transactions</span></button>
      </div>
      <section className="relative min-w-0 overflow-hidden rounded-[2rem] border border-white/10 bg-[radial-gradient(120%_120%_at_0%_0%,rgba(131,110,249,.35),transparent_55%),radial-gradient(90%_90%_at_100%_100%,rgba(34,211,238,.12),transparent_60%)] p-5 sm:p-8">
        <Pill tone="monad"><Sparkles className="h-3 w-3" /> Monad {net.name} · block {block ? block.toLocaleString() : '…'}</Pill>
        <h1 className="mt-3 text-[clamp(1.75rem,7vw,3.25rem)] font-bold leading-[1.05] tracking-tight text-white" data-testid="tagline">Love agents.<br />Love control.<br /><span className="bg-gradient-to-r from-violet-300 to-cyan-300 bg-clip-text text-transparent">PolicyPilot.</span></h1>
        <p className="mt-3 max-w-xl text-sm text-zinc-300 sm:text-base">Give your AI agent a wallet with a harness: a budget, a per-action cap and only the services you switch on. It’s all enforced on-chain, so you can pull everything back any time.</p>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[['Vaults', kpi ? String(kpi.vaults) : '–'], ['MON in vaults', kpi ? Number(formatEther(kpi.tvl)).toFixed(3) : '–'], ['Allowed', hist ? String(hist.events.filter((e: Ev) => e.status === 'allowed').length) : '–'], ['Blocked', hist ? String(hist.events.filter((e: Ev) => e.status === 'blocked').length) : '–']].map(([k, v]) => (
            <div key={k} className="min-w-0 rounded-2xl bg-black/30 p-3"><div className="truncate font-mono text-xl tabular-nums text-white">{v}</div><div className="truncate text-[11px] text-zinc-400">{k}</div></div>))}
        </div>
      </section>

      <FastDispatch net={net} pub={pub} account={account} wallet={wallet} bal={bal} vaults={vaults} need={need} send={send} runAgent={runAgent} loadVaults={loadVaults} refreshHist={refreshHist} toast={toast} ownerTx={ownerTx} />

      <PrimeTerminal net={net} pub={pub} account={account} wallet={wallet} bal={bal} need={need} send={send} toast={toast} block={block} />

      <SpreadDesk net={net} pub={pub} account={account} wallet={wallet} bal={bal} need={need} send={send} toast={toast} block={block} />

      <ClipDesk net={net} pub={pub} account={account} wallet={wallet} bal={bal} need={need} send={send} toast={toast} block={block} />

      <details id="desk-rules" data-testid="custom-rules" className="min-w-0 scroll-mt-16 rounded-[2rem] border border-white/10 bg-white/[0.02] p-4 sm:p-5">
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-zinc-200">Custom agent and custom rules</summary>
        <p className="mt-2 text-xs text-zinc-400">The full setup: your own agent key or an external agent, every limit as a slider, and each service switched on by hand.</p>
        <div className="mt-4 grid gap-4">
      <Step n={1} title="Connect your wallet" done={!!account} active={step === 1} testid="step1">
        {account ? <p className="text-sm text-zinc-300">Connected as <span className="font-mono">{short(account)}</span>. You stay the owner, and only you can withdraw.</p>
          : <Btn kind="pri" className="w-full sm:w-auto" onClick={() => need()}><Wallet className="h-4 w-4" />Connect wallet</Btn>}
      </Step>

      <Step n={2} title="Connect your agent" done={!!account && extOk} active={step === 2} testid="step2">
        <div className="grid gap-2 sm:grid-cols-2">
          {([['new', KeyRound, 'Create an agent key', 'Generated in this browser. Great for trying it out.'], ['external', Bot, 'I have an agent', 'Paste its address (ElizaOS, a script, a bot…).']] as const).map(([id, I, t, s]) => (
            <button key={id} data-testid={`agent-${id}`} onClick={() => { haptic(); setAgentMode(id); }} className={`flex min-h-16 min-w-0 items-start gap-3 rounded-2xl border p-3 text-left transition active:scale-[0.99] ${agentMode === id ? 'border-monad bg-monad/10' : 'border-white/10 bg-white/[0.02]'}`}>
              <I className="mt-0.5 h-5 w-5 shrink-0 text-violet-300" /><span className="min-w-0"><span className="block font-medium text-zinc-50">{t}</span><span className="block text-xs text-zinc-400">{s}</span></span>
            </button>))}
        </div>
        {agentMode === 'external' && <div className="mt-3 grid gap-2">
          <input data-testid="agent-addr" value={ext} onChange={e => setExt(e.target.value)} placeholder="0x… your agent's address" className="min-h-11 w-full min-w-0 rounded-2xl border border-white/10 bg-black/40 px-3 font-mono text-sm outline-none focus:border-monad" />
          <details className="rounded-2xl bg-black/30 p-3 text-xs text-zinc-400"><summary className="flex min-h-11 cursor-pointer items-center text-zinc-300">How does my ElizaOS / custom agent use it?</summary>
            <p className="mt-2">Your agent signs with its own key and calls the vault, never your wallet:</p>
            <pre className="mt-2 min-w-0 max-w-full overflow-x-auto whitespace-pre rounded-xl bg-black/50 p-2 font-mono text-[11px] text-zinc-300">{`vault.execute(requestId, payee, amountWei)\nvault.executeCall(requestId, service, valueWei, calldata, opts)`}</pre>
            <p className="mt-2">If it goes over a limit or calls a service you didn’t switch on, the vault reverts with the exact reason. Our <code>plugin-eliza</code> ships the <code>EXECUTE_POLICY_PAYMENT</code> action for the PolicyPilot contract; vault support for the plugin is next.</p></details>
        </div>}
        {agentMode === 'new' && <p className="mt-3 text-xs text-zinc-400"><KeyRound className="mr-1 inline h-3 w-3" />The agent key is stored only in this browser (alpha). Even with the key, the agent can only act inside your rules.</p>}
      </Step>

      <Step n={3} title="Set the rules" active={step === 3} testid="step3">
        <div className="grid gap-1 lg:grid-cols-2 lg:gap-x-6">
          <div className="min-w-0">
            <Switch testid="sw-budget" on={p.budgetOn} onChange={v => up({ budgetOn: v })} label={<>Total budget {p.budgetOn && <span className="font-mono text-violet-300">{p.budget.toFixed(3)} MON</span>}</>} sub="The most it can ever spend" />
            {p.budgetOn && <div className="px-3"><Slider label="Budget" testid="sl-budget" value={p.budget} min={1} max={APP_VAULT_MON} step={1} onChange={v => up({ budget: v })} /></div>}
            <Switch testid="sw-cap" on={p.capOn} onChange={v => up({ capOn: v })} label={<>Per-action cap {p.capOn && <span className="font-mono text-violet-300">{p.cap.toFixed(3)} MON</span>}</>} sub="Max for any single action" />
            {p.capOn && <div className="px-3"><Slider label="Per-action cap" testid="sl-cap" value={p.cap} min={1} max={p.budgetOn ? p.budget : APP_VAULT_MON} step={1} onChange={v => up({ cap: v })} /></div>}
            <div className="px-3 pt-2 text-sm text-zinc-100">Deposit now <span className="font-mono text-violet-300">{p.deposit.toFixed(2)} MON</span></div>
            <div className="px-3"><Slider label="Deposit" testid="sl-deposit" value={p.deposit} min={0} max={APP_VAULT_MON} step={0.1} onChange={v => up({ deposit: v })} /></div>
            {agentMode === 'new' && <><div className="px-3 pt-1 text-sm text-zinc-100">Gas for the agent <span className="font-mono text-violet-300">{p.gas.toFixed(2)} MON</span></div><div className="px-3"><Slider label="Agent gas" testid="sl-gas" value={p.gas} min={0} max={5} step={0.01} onChange={v => up({ gas: v })} /></div></>}
            <Switch testid="sw-paused" on={p.startPaused} onChange={v => up({ startPaused: v })} label="Start paused" sub="Flip it on later from Agents" />
          </div>
          <div className="min-w-0">
            <div className="px-3 pb-1 pt-3 text-xs uppercase tracking-wider text-zinc-500 lg:pt-0">Allowed services</div>
            {live.map(s => <Switch key={s.id} testid={`sw-svc-${s.id}`} on={p.services.includes(s.id)} onChange={v => up({ services: v ? [...p.services, s.id] : p.services.filter(x => x !== s.id) })} label={<>{s.icon} {s.name}</>} sub={s.novice} />)}
            {p.services.includes('pay') && <input value={payeesTxt} onChange={e => setPayeesTxt(e.target.value)} placeholder="Extra payees 0x…, 0x… (you're added automatically)" className="mx-3 mt-1 min-h-11 w-[calc(100%-1.5rem)] min-w-0 rounded-2xl border border-white/10 bg-black/40 px-3 font-mono text-xs outline-none focus:border-monad" />}
            <button onClick={() => setTab('services')} className="mt-2 min-h-11 px-3 text-left text-xs text-violet-300">+ {services(net).filter(s => s.status === 'soon').length} more services coming soon →</button>
          </div>
        </div>
        <p className="mt-3 rounded-2xl bg-monad/10 p-3 text-sm text-violet-100" data-testid="summary">{summary}</p>
      </Step>

      <div>
        {room != null && <p data-testid="capacity" className={`mb-2 text-xs ${overRoom ? 'text-amber-300' : 'text-zinc-400'}`}>Alpha safety cap: {mon(room, 3)} of deposit room left across all vaults.{overRoom ? ' Lower the deposit to fit (you can launch with 0 and top up later).' : ''}</p>}
        <Btn kind="pri" data-testid="launch" disabled={busy || !extOk || overRoom} onClick={launch} className="h-14 w-full rounded-3xl text-base">{busy ? 'Launching…' : <><Rocket className="h-5 w-5" />Let it go into the wild</>}</Btn>
        <p className="mt-2 text-xs text-zinc-500">Creating a vault uses a fixed 8,000,000 gas limit so it cannot run out of gas. Monad charges that limit, about 0.8 MON at a 100 gwei base fee.</p>
      </div>
      {prog.length > 0 && <Card data-testid="progress"><ol className="grid gap-2 text-sm">{prog.map((x, i) => <li key={i} className={`flex min-w-0 items-start gap-2 ${x.s === 'err' ? 'text-red-300' : x.s === 'ok' ? 'text-emerald-300' : 'text-zinc-300'}`}><span className="shrink-0">{x.s === 'ok' ? '✅' : x.s === 'err' ? '⛔' : '⏳'}</span><span className="min-w-0 break-words">{x.t}{x.h && <> · <a className="underline" href={`${net.exp}/tx/${x.h}`} target="_blank" rel="noreferrer">tx ↗</a></>}</span></li>)}</ol>
        {doneVault && <div className="mt-4 grid gap-2 sm:grid-cols-2" data-testid="launched"><Btn kind="pri" onClick={() => setTab('activity')}><Activity className="h-4 w-4" />Watch it live</Btn><Btn onClick={() => setTab('agents')}><Bot className="h-4 w-4" />Manage my agent</Btn></div>}
      </Card>}
        </div>
      </details>
    </div>
  );
}

// ---------------- Activity ----------------
function ActivityView({ net, pub, hist, kpi, vaults, account, runAgent, setTab, refresh }: any) {
  const [f, setF] = useState('all'); const [open, setOpen] = useState<number | null>(null);
  const events: Ev[] = hist?.events ?? [];
  const dapps = [...new Set(events.filter(e => e.status !== 'owner').map(e => e.dapp))];
  const list = events.filter(e => f === 'all' || (f.startsWith('d:') ? e.dapp === f.slice(2) : e.status === f)).slice().reverse();
  const mine: VaultState[] = (vaults ?? []).filter((v: VaultState) => v.key || v.executor === account);
  return (
    <div className="grid gap-4">
      <div className="flex min-w-0 items-end gap-3"><div className="min-w-0 flex-1"><h1 className="text-2xl font-bold text-white">Live activity</h1><p className="truncate text-xs text-zinc-400">{hist?.showcase ? `Feed: team demo vault ${short(hist.showcase.vault)} (operated by the team) + your own agents. Read from chain.` : 'Your actions + on-chain reads'}</p></div><Btn onClick={refresh} className="shrink-0">Refresh</Btn></div>
      {mine.length > 0 && <QuickAgent s={mine[0]} net={net} runAgent={runAgent} pub={pub} account={account} />}
      {!mine.length && account && <Card className="flex flex-wrap items-center gap-3"><span className="min-w-0 flex-1 text-sm text-zinc-300">No agent with a key in this browser yet.</span><Btn kind="pri" onClick={() => setTab('launch')}><Rocket className="h-4 w-4" />Launch one</Btn></Card>}
      <ShowcaseAgents net={net} pub={pub} base={BASE} totalVaults={kpi ? Number(kpi.vaults) : undefined} extraTeamVaults={hist?.showcase ? 1 : 0} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[['Vaults created (all)', kpi ? String(kpi.vaults) : '–'], ['MON in vaults', kpi ? Number(formatEther(kpi.tvl)).toFixed(4) : '–'], ['✅ Allowed', String(events.filter(e => e.status === 'allowed').length)], ['⛔ Blocked', String(events.filter(e => e.status === 'blocked').length)]].map(([k, v]) => <Card key={k} className="p-3 sm:p-4"><div className="font-mono text-xl tabular-nums text-white">{v}</div><div className="truncate text-[11px] text-zinc-400">{k}</div></Card>)}
      </div>
      <Card><h3 className="mb-2 text-sm font-medium text-zinc-300">MON the agents spent, by block</h3><Chart events={events} /></Card>
      <div className="-mx-1 flex min-w-0 flex-wrap gap-2 px-1" data-testid="filters">
        {[['all', 'All'], ['allowed', '✅ Allowed'], ['blocked', '⛔ Blocked'], ['owner', '👤 Owner'], ...dapps.map(d => ['d:' + d, d])].map(([v, l]) => <button key={v} onClick={() => { haptic(); setF(v); }} className={`min-h-11 max-w-full truncate rounded-full px-4 text-sm transition active:scale-95 ${f === v ? 'bg-monad text-white' : 'border border-white/10 text-zinc-300'}`}>{l}</button>)}
      </div>
      <ol className="relative grid gap-2 border-l border-white/10 pl-4" data-testid="feed">
        {!hist && <li className="text-sm text-zinc-500">Loading real transactions from the chain…</li>}
        {hist && !list.length && <li className="text-sm text-zinc-500">Nothing here yet.</li>}
        {list.map((e, i) => {
          const tone = e.status === 'allowed' ? 'ok' : e.status === 'blocked' ? 'bad' : 'zinc';
          return (
            <li key={`${e.tx ?? 'sim'}-${i}`} data-testid="ev" data-status={e.status} className="relative animate-[pop_.25s_ease-out]" style={{ animationDelay: `${Math.min(i, 15) * 30}ms` }}>
              <span className={`absolute -left-[22px] top-4 h-3 w-3 rounded-full ring-4 ring-ink ${e.status === 'allowed' ? 'bg-emerald-400' : e.status === 'blocked' ? 'bg-red-500' : 'bg-zinc-500'}`} />
              <button onClick={() => setOpen(open === i ? null : i)} className={`w-full min-w-0 rounded-2xl border p-3 text-left transition active:scale-[0.99] ${e.status === 'blocked' ? 'border-red-500/25 bg-red-500/[0.06]' : e.status === 'allowed' ? 'border-emerald-500/20 bg-emerald-500/[0.04]' : 'border-white/10 bg-white/[0.03]'}`}>
                <div className="flex min-w-0 items-start gap-2"><span className="shrink-0 text-lg leading-6">{e.icon}</span><span className="min-w-0 flex-1 break-words text-sm font-medium text-zinc-100">{e.label}</span><Pill tone={tone as any}>{e.simulated ? 'blocked · simulated' : e.status === 'allowed' ? 'allowed' : e.status === 'blocked' ? 'blocked' : 'owner'}</Pill></div>
                <div className="mt-1 truncate pl-7 text-xs text-zinc-400">{e.dapp}{e.value ? ` · ${mon(e.value)}` : ''}{e.block ? ` · block ${e.block}` : ''}{e.src === 'you' ? ' · you' : ''}</div>
                {e.status === 'blocked' && <div className="mt-1 break-words pl-7 text-xs text-red-200">🛡️ {plain(e.reason)}</div>}
                {open === i && <div className="mt-2 grid gap-1 break-all pl-7 font-mono text-[11px] text-zinc-400">
                  {e.tx && <a className="text-violet-300 underline" href={`${net.exp}/tx/${e.tx}`} target="_blank" rel="noreferrer" onClick={x => x.stopPropagation()}>{e.tx} ↗</a>}
                  {e.from && <div>signed by {e.from}</div>}{decodeInput(e.input) && <div>{decodeInput(e.input)}</div>}
                  {e.fee !== undefined && <div>gas {String(e.gasUsed)} · fee {mon(e.fee!, 6)}</div>}
                  {e.simulated && <div>Simulated with eth_call. Rejected before sending, so no tx exists.</div>}
                </div>}
              </button>
            </li>);
        })}
      </ol>
    </div>
  );
}
function Chart({ events }: { events: Ev[] }) {
  const pts = events.filter(e => e.block && e.status === 'allowed'); const blocked = events.filter(e => e.block && e.status === 'blocked');
  if (!pts.length) return <div className="grid h-32 place-items-center text-sm text-zinc-500">No spend yet</div>;
  let cum = 0n; const s = pts.map(e => { cum += e.value; return { b: Number(e.block), v: Number(formatEther(cum)) }; });
  const all = events.filter(e => e.block).map(e => Number(e.block)); const b0 = Math.min(...all), b1 = Math.max(...all), vm = Math.max(...s.map(x => x.v)) || 1;
  const X = (b: number) => 8 + (b1 === b0 ? 292 : ((b - b0) / (b1 - b0)) * 584), Y = (v: number) => 150 - (v / vm) * 130;
  let d = `M${X(b0)},150`; for (const x of s) d += ` L${X(x.b)},${Y(x.v)}`;
  return (
    <svg viewBox="0 0 600 170" className="h-auto w-full" role="img" aria-label="Cumulative spend">
      <defs><linearGradient id="g1" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#836EF9" stopOpacity=".45" /><stop offset="1" stopColor="#836EF9" stopOpacity="0" /></linearGradient></defs>
      <path d={`${d} L${X(s[s.length - 1].b)},150 Z`} fill="url(#g1)" /><path d={d} fill="none" stroke="#836EF9" strokeWidth="3" strokeLinejoin="round" />
      {s.map((x, i) => <circle key={i} cx={X(x.b)} cy={Y(x.v)} r="4.5" fill="#34d399" />)}
      {blocked.map((e, i) => <circle key={'b' + i} cx={X(Number(e.block))} cy="150" r="4.5" fill="#ef4444" />)}
      <text x="10" y="14" fill="#a1a1aa" fontSize="14">{vm.toFixed(3)} MON</text>
    </svg>
  );
}

// ---------------- Agents: vault picker (your vaults + team vaults) ----------------
const ACTIONS: { kind: string; label: string; svc: string; amt: string }[] = [
  { kind: 'payto', label: '💸 Pay an address', svc: 'pay', amt: '0.005' }, { kind: 'wmon', label: '🎁 Wrap', svc: 'wmon', amt: '0.01' }, { kind: 'unwrap', label: '🎁 Unwrap', svc: 'wmon', amt: '0.01' },
  { kind: 'bestswap', label: '🎯 Best-price swap', svc: 'bestswap', amt: '0.01' }, { kind: 'kuru', label: '📗 Kuru swap', svc: 'kuru', amt: '0.01' }, { kind: 'uniswap', label: '🦄 Uniswap swap', svc: 'uniswap', amt: '0.01' }, { kind: 'pancake', label: '🥞 PancakeSwap swap', svc: 'pancake', amt: '0.01' },
  { kind: 'kintsu', label: '🥩 Kintsu', svc: 'kintsu', amt: '0.01' }, { kind: 'apriori', label: '⚡ aPriori', svc: 'apriori', amt: '0.01' }, { kind: 'magma', label: '🌋 Magma', svc: 'magma', amt: '0.01' },
];
const ATTACKS = [['x-cap', 'Spend 2× the cap'], ['x-stranger', 'Pay a stranger'], ['x-drain', 'Move USDC out with transfer()'], ['x-self', 'Swap but send output to itself'], ['x-withdraw', 'Withdraw the vault']] as const;
/** Services a vault's buttons should show: its rules, plus best-price swap when at least two swap venues are on. */
const actionsFor = (rules: string[]) => ACTIONS.filter(a => rules.includes(a.svc) || (a.svc === 'bestswap' && ['uniswap', 'pancake', 'kuru'].filter(x => rules.includes(x)).length >= 2));
/** How the connected browser can sign for this vault's agent: with a browser-held key, with the connected wallet (it IS the executor), or not at all (simulate only). */
const superOf = (s: VaultState): SuperVault | undefined => {
  const hit = matchSuper(s.rules); if (hit) return hit;
  try { const id = localStorage.getItem(`pp.super.${s.v.toLowerCase()}`); const t = SUPER_VAULTS.find(x => x.id === id); if (t && t.services.every(sv => s.rules.includes(sv))) return t; } catch { /* private mode */ }
  return undefined;
};
const signerOf = (s: VaultState, account: Address | null): 'key' | 'wallet' | null => (s.key ? 'key' : account && s.executor.toLowerCase() === account.toLowerCase() ? 'wallet' : null);

function ActionSheet({ s, kind, onClose, runAgent, net, pub, account, ownerTx, readOnly }: { s: VaultState; kind: string | null; onClose: () => void; runAgent: any; net: Net; pub: PublicClient; account: Address | null; ownerTx?: any; readOnly?: boolean }) {
  const a = ACTIONS.find(x => x.kind === kind); const [amt, setAmt] = useState(a?.amt ?? '0.01'); const [to, setTo] = useState(''); const [atk, setAtk] = useState<string>('x-cap');
  const [res, setRes] = useState<{ ok: boolean; msg: React.ReactNode } | null>(null); const [busy, setBusy] = useState(false); const [step, setStep] = useState('');
  const ownerHere = !!(account && s.owner.toLowerCase() === account.toLowerCase());
  const ceiling = s.vaultCap > 0n ? s.vaultCap : s.cap;
  const maxWei = kind === 'unwrap' ? (s.toks.WMON ?? 0n) : ownerHere ? (s.bal < ceiling ? s.bal : ceiling) : executableMon(s);
  useEffect(() => { setRes(null); setStep(''); if (kind && kind !== 'break') setAmt(formatEther(maxWei)); setTo(account ?? ''); }, [kind]); // eslint-disable-line
  const live = signerOf(s, account) !== null && !readOnly;
  const [quotes, setQuotes] = useState<Quote[] | null>(null);
  useEffect(() => { // best-price swap: show the live quotes from all three venues before sending
    if (kind !== 'bestswap') { setQuotes(null); return; } let on = true; setQuotes(null);
    const t = setTimeout(() => { let wei = 0n; try { wei = parseEther(amt || '0'); } catch { return; } if (wei === 0n) return; quoteAll(pub, s.v, wei).then(q => on && setQuotes(q)).catch(() => {}); }, 300);
    return () => { on = false; clearTimeout(t); };
  }, [kind, amt, pub, s.v]);
  const go = async () => {
    setBusy(true); setRes(null);
    try {
      let extra: { to?: Address } = {};
      if (kind === 'payto') {
        if (!isAddress(to.trim())) throw new Error('Enter a valid 0x address to pay.'); extra = { to: getAddress(to.trim()) };
        const allowed = await pub.readContract({ address: s.v, abi: vaultAbi, functionName: 'allowedRecipient', args: [extra.to] }) as boolean;
        if (!allowed && live && account && s.owner.toLowerCase() === account.toLowerCase() && ownerTx) { setStep(`Allowlisting ${short(extra.to)} as a payee (owner signature 1 of 2)…`); await ownerTx(`Owner allows payee ${short(extra.to)}`, vcall(s.v, 'setRecipient', [extra.to, true])); setStep('Paying (signature 2 of 2)…'); }
      }
      let vault = s;
      if (live && kind !== 'break' && kind !== 'unwrap' && ownerHere && ownerTx) {
        const wei = parseEther(amt || '0');
        const raise = limitsFor(s, wei);
        if (raise.cap != null) { setStep('Raising the per-action cap…'); await ownerTx('Owner raises the per-action cap to the vault cap', vcall(s.v, 'setPerPaymentCap', [raise.cap])); vault = { ...vault, cap: raise.cap }; }
        if (raise.budget != null) { setStep('Raising the budget…'); await ownerTx('Owner raises the budget to cover the vault cap', vcall(s.v, 'setBudget', [raise.budget])); vault = { ...vault, budget: raise.budget }; }
      }
      setRes(await runAgent(vault, kind === 'break' ? atk : kind, kind === 'break' ? 0n : parseEther(amt || '0'), extra));
    } catch (e) { setRes({ ok: false, msg: sendFault(e).text }); }
    setStep(''); setBusy(false);
  };
  return (
    <Sheet open={!!kind} onClose={onClose} title={kind === 'break' ? '😈 Try to break the harness' : `Agent: ${a?.label ?? ''}`}>
      {kind === 'break' ? <div className="grid gap-2" data-testid="attacks">{ATTACKS.filter(([k]) => net.id === 143 || !['x-drain', 'x-self'].includes(k)).map(([k, l]) => <button key={k} data-testid={`atk-${k}`} onClick={() => setAtk(k)} className={`min-h-12 rounded-2xl border px-3 text-left text-sm ${atk === k ? 'border-red-400 bg-red-500/10' : 'border-white/10'}`}>{l}</button>)}<p className="text-xs text-zinc-400">Checked before anything is sent, so no gas is spent and nothing moves.</p></div>
        : <div className="grid gap-3">
          {kind === 'payto' && <label className="grid gap-1 text-sm text-zinc-300">Pay to (0x address)<input data-testid="payto" value={to} onChange={e => setTo(e.target.value)} placeholder="0x…" className="min-h-12 w-full min-w-0 rounded-2xl border border-white/10 bg-black/40 px-3 font-mono text-sm outline-none focus:border-monad" /><span className="text-xs text-zinc-500">Must be an approved payee. If you own this vault and it isn’t yet, you’ll be asked to approve it first (1 extra signature).</span></label>}
          <label className="grid gap-1 text-sm text-zinc-300"><span className="flex min-w-0 items-center justify-between gap-2"><span>Amount ({kind === 'unwrap' ? 'WMON' : 'MON'})</span><button type="button" data-testid="amt-max" onClick={() => setAmt(formatEther(maxWei))} className="shrink-0 rounded-full border border-white/15 px-2 py-1 text-[11px] text-violet-200">Max {mon(maxWei, 6)}</button></span><input data-testid="amt" inputMode="decimal" value={amt} onChange={e => setAmt(e.target.value)} className="min-h-12 w-full min-w-0 rounded-2xl border border-white/10 bg-black/40 px-3 font-mono text-base outline-none focus:border-monad" /></label>
          {ownerHere && kind !== 'unwrap' && <p className="text-xs text-zinc-500">Max is this vault’s balance, up to its on-chain cap. A send above the current per-action cap raises that cap first. Add more MON from Dispatch with a balancer or deployer wallet.</p>}
        </div>}
      {(kind === 'uniswap' || kind === 'pancake') && <p className="mt-2 text-xs text-zinc-400">Live quote from the official QuoterV2; minOut = quote − 3%. USDC comes back to the vault.</p>}
      {kind === 'kuru' && <p className="mt-2 text-xs text-zinc-400">Quoted on Kuru’s on-chain order book (MON-USDC market); minOut = quote − 3%. USDC comes back to the vault.</p>}
      {kind === 'bestswap' && <div className="mt-2 rounded-2xl border border-white/10 bg-black/30 p-3 text-xs" data-testid="quotes"><div className="mb-1 text-zinc-400">Live quotes for {amt || '0'} MON → USDC{quotes ? '' : ' (fetching…)'}</div>
        {quotes && (() => { const best = quotes.filter(q => q.out).reduce<Quote | null>((a, b) => (!a || (b.out! > a.out!) ? b : a), null); return quotes.map(q => <div key={q.id} className={`flex min-w-0 items-center gap-2 py-1 ${best?.id === q.id ? 'text-emerald-200' : 'text-zinc-300'}`}><span>{q.icon}</span><span className="min-w-0 flex-1 truncate">{q.name}</span><span className="font-mono tabular-nums">{q.out === null ? 'n/a' : `${Number(formatUnits(q.out, 6)).toFixed(6)} USDC`}</span>{best?.id === q.id && <Pill tone="ok">best</Pill>}</div>); })()}
        <div className="mt-1 text-zinc-500">The swap is sent to the best venue; the vault enforces minOut = best quote − 3%.</div></div>}
      <p className="mt-2 text-xs text-zinc-400">{live ? (signerOf(s, account) === 'wallet' ? 'Your wallet is this vault’s agent: this sends a real transaction through the vault’s policy.' : 'Signed by the agent key stored in this browser: a real transaction through the vault’s policy.') : 'Read-only here: the agent key never enters the browser, so this runs the policy check as a free eth_call and sends nothing.'}</p>
      <Btn kind={kind === 'break' ? 'danger' : 'pri'} data-testid="go" disabled={busy} onClick={go} className="mt-4 w-full">{busy ? (step || 'Working…') : kind === 'break' ? 'Attack!' : live ? 'Send' : 'Simulate'}</Btn>
      {res && <div data-testid="result" data-ok={res.ok ? '1' : '0'} className={`mt-3 break-words rounded-2xl border p-3 text-sm ${res.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100' : 'border-red-500/40 bg-red-500/10 text-red-100'}`}>{res.msg}</div>}
    </Sheet>
  );
}
function QuickAgent({ s, net, runAgent, pub, account }: { s: VaultState; net: Net; runAgent: any; pub: PublicClient; account: Address | null }) {
  const [k, setK] = useState<string | null>(null); const pct = s.budget > 0n ? Number((s.spent * 1000n) / s.budget) / 10 : 0;
  return (
    <Card data-testid="quick-agent">
      <div className="flex min-w-0 items-center gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-monad/20"><Bot className="h-5 w-5 text-violet-300" /></span><div className="min-w-0 flex-1"><div className="truncate font-medium text-white">Your agent {short(s.executor)}</div><div className="truncate text-xs text-zinc-400">{mon(s.spent)} of {mon(s.budget)} used · {s.paused ? 'paused' : 'active'}</div></div><Pill tone={s.paused ? 'warn' : 'ok'}>{s.paused ? 'Paused' : 'Live'}</Pill></div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-all" style={{ width: `${pct}%` }} /></div>
      <div className="mt-3 flex flex-wrap gap-2">{actionsFor(s.rules).map(a => <Btn key={a.kind} kind="soft" data-testid={`qa-${a.kind}`} onClick={() => setK(a.kind)} className="px-3">{a.label}</Btn>)}<Btn kind="danger" data-testid="qa-break" onClick={() => setK('break')} className="px-3">😈 Break it</Btn></div>
      <ActionSheet s={s} kind={k} onClose={() => setK(null)} runAgent={runAgent} net={net} pub={pub} account={account} />
    </Card>
  );
}
function useTeamSnapshot(net: Net, base: string) {
  const [snap, setSnap] = useState<TeamSnapshot | null>(null);
  useEffect(() => { fetchTeamSnapshot(net, base).then(setSnap).catch(() => setSnap(null)); }, [net, base]);
  return snap;
}
const Row = ({ onClick, active, icon, title, sub, right, testid }: { onClick: () => void; active: boolean; icon: React.ReactNode; title: React.ReactNode; sub: React.ReactNode; right?: React.ReactNode; testid?: string }) => (
  <button data-testid={testid} onClick={onClick} aria-current={active ? 'true' : undefined} className={`flex min-h-14 w-full min-w-0 items-center gap-3 rounded-2xl border px-3 py-2 text-left transition active:scale-[0.99] ${active ? 'border-monad bg-monad/10' : 'border-white/10 bg-white/[0.02] hover:border-white/25'}`}>
    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/5 text-lg">{icon}</span>
    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-zinc-50">{title}</span><span className="block truncate text-xs text-zinc-400">{sub}</span></span>
    {right}<ChevronRight className={`h-4 w-4 shrink-0 ${active ? 'text-violet-300' : 'text-zinc-600'}`} />
  </button>
);
function Agents({ net, pub, account, wallet, need, send, vaults, loadVaults, runAgent, ownerTx, setConnectOpen, setTab, toast, refreshHist }: any) {
  const snap = useTeamSnapshot(net, BASE);
  const teamAgents: TeamAgent[] = (snap?.agents ?? []).filter((a: TeamAgent) => a.vault);
  const teamName = (v: string) => { const a = teamAgents.find(x => x.vault!.toLowerCase() === v.toLowerCase()); return a ? `${a.emoji} ${a.name}` : null; };
  const own: VaultState[] = vaults ?? [];
  const [sel, setSel] = useState<string | null>(null);
  const [teamState, setTeamState] = useState<Record<string, VaultState | 'loading' | 'error'>>({});
  const [starting, setStarting] = useState(false);
  const [superOpen, setSuperOpen] = useState<SuperVault | null>(null);
  const [superPayees, setSuperPayees] = useState('');
  const [superBusy, setSuperBusy] = useState(false);
  const selOwn = own.find(s => s.v.toLowerCase() === sel?.toLowerCase());
  const selTeam = !selOwn ? teamAgents.find(a => a.vault!.toLowerCase() === sel?.toLowerCase()) : undefined;
  const detailRef = useRef<HTMLDivElement>(null);
  const pick = (v: string) => { haptic(); setSel(v); if (window.innerWidth < 1024) setTimeout(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); };
  useEffect(() => { if (!sel && own.length) setSel(own[0].v); }, [own.length]); // eslint-disable-line
  useEffect(() => {
    if (!selTeam || teamState[selTeam.vault!]) return; const v = selTeam.vault!;
    setTeamState(x => ({ ...x, [v]: 'loading' })); readVault(pub, net, v).then(s => setTeamState(x => ({ ...x, [v]: s }))).catch(() => setTeamState(x => ({ ...x, [v]: 'error' })));
  }, [selTeam?.vault]); // eslint-disable-line
  const refreshTeam = (v: string) => readVault(pub, net, v as Address).then(s => setTeamState(x => ({ ...x, [v]: s }))).catch(() => {});

  const starter = async () => {
    try { if (!(await need())) return; } catch (e) { toast(sendFault(e).text, 'bad'); return; }
    setStarting(true);
    try {
      let dep = parseEther(String(STARTER.deposit)); let twoStep = false;
      try { const [gc, td] = await Promise.all([pub.readContract({ address: net.factory, abi: factoryAbi, functionName: 'globalCap' }), pub.readContract({ address: net.factory, abi: factoryAbi, functionName: 'totalDeposited' })]) as [bigint, bigint]; if (gc - td < dep) { dep = 0n; twoStep = true; } } catch { /* older factory */ }
      const c = buildStarter(account, Number(formatEther(dep)));
      await pub.call({ account, to: net.factory, data: c.data, value: c.value });
      const rc = await send(wallet, { to: net.factory, data: c.data, value: c.value, gas: GAS.createVault });
      addLocal(net, { label: `Starter vault created${dep > 0n ? ` + ${STARTER.deposit} MON deposited` : ''} (1 tx)`, kind: 'owner', tx: rc.transactionHash, from: account });
      const list = await pub.readContract({ address: net.factory, abi: factoryAbi, functionName: 'vaultsOf', args: [account] }) as Address[]; const v = list[list.length - 1];
      haptic([10, 40, 10] as any); toast(<>⚡ Starter vault ready. Your wallet is its agent, so every action below is real. <a className="underline" href={`${net.exp}/tx/${rc.transactionHash}`} target="_blank" rel="noreferrer">tx ↗</a></>, 'ok');
      if (twoStep) toast('The alpha deposit cap is full right now, so the vault was created empty. Deposit later from the Owner section.', 'info');
      await loadVaults(); pick(v); refreshHist();
    } catch (e) { const f = sendFault(e); toast(f.text, f.pending ? 'info' : 'bad'); }
    setStarting(false);
  };
  const createSuper = async (t: SuperVault) => {
    try { if (!(await need())) return; } catch (e) { toast(sendFault(e).text, 'bad'); return; }
    setSuperBusy(true);
    try {
      const extras = superPayees.split(/[\s,]+/).filter(Boolean).map(a => { if (!isAddress(a)) throw new Error(`Bad payee address ${a}`); return getAddress(a); });
      let dep = parseEther(String(t.deposit)); let shortDeposit = false;
      try { const [gc, td] = await Promise.all([pub.readContract({ address: net.factory, abi: factoryAbi, functionName: 'globalCap' }), pub.readContract({ address: net.factory, abi: factoryAbi, functionName: 'totalDeposited' })]) as [bigint, bigint]; const room = gc > td ? gc - td : 0n; if (dep > room) { dep = room > parseEther('0.020001') ? room - parseEther('0.000001') : 0n; shortDeposit = true; } } catch { /* older factory */ }
      const c = buildSuper(t, account, t.payees ? extras : [], Number(formatEther(dep)));
      await pub.call({ account, to: net.factory, data: c.data, value: c.value });
      const rc = await send(wallet, { to: net.factory, data: c.data, value: c.value, gas: GAS.createVault });
      addLocal(net, { label: `${t.name} created${dep > 0n ? ` + ${formatEther(dep)} MON deposited` : ''} (1 tx)`, kind: 'owner', tx: rc.transactionHash, from: account });
      const list = await pub.readContract({ address: net.factory, abi: factoryAbi, functionName: 'vaultsOf', args: [account] }) as Address[]; const v = list[list.length - 1];
      localStorage.setItem(`pp.super.${v.toLowerCase()}`, t.id);
      if (extras.length) localStorage.setItem(`pp.payees.${v.toLowerCase()}`, JSON.stringify(extras));
      haptic([10, 40, 10] as any);
      toast(<>{t.emoji} <b>{t.name}</b> is live. Run its playbook below. <a className="underline" href={`${net.exp}/tx/${rc.transactionHash}`} target="_blank" rel="noreferrer">tx ↗</a></>, 'ok');
      if (shortDeposit) toast(dep === 0n ? 'The alpha deposit cap is full, so the vault was created empty. Deposit from the Owner section before running the playbook.' : `Deposit was reduced to ${formatEther(dep)} MON to fit the alpha cap.`, 'info');
      setSuperOpen(null); setSuperPayees(''); await loadVaults(); pick(v); refreshHist();
    } catch (e) { const f = sendFault(e); toast(f.text, f.pending ? 'info' : 'bad'); }
    setSuperBusy(false);
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,22rem),minmax(0,1fr)] lg:items-start">
      <Card data-testid="vault-picker" className="grid grid-cols-[minmax(0,1fr)] gap-3">
        <div className="flex items-center gap-3"><h1 className="min-w-0 flex-1 text-xl font-bold text-white">Vaults</h1><Btn onClick={() => { loadVaults(); if (sel && teamState[sel]) refreshTeam(sel); }} className="shrink-0 px-3 text-xs">Refresh</Btn></div>
        <div>
          <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wider text-zinc-500"><Wallet className="h-3.5 w-3.5" />Your vaults{account && <span className="ml-auto font-mono normal-case tracking-normal">{short(account)}</span>}</div>
          {!account && <Btn kind="pri" className="w-full" onClick={() => setConnectOpen(true)}><Wallet className="h-4 w-4" />Connect wallet to see yours</Btn>}
          {account && !vaults && <div className="text-sm text-zinc-500">Loading your vaults from both factories…</div>}
          {account && vaults && !own.length && <p className="mb-2 text-sm text-zinc-400">No vaults for this wallet on Monad {net.name} yet.</p>}
          <div className="grid gap-2">
            {own.map(s => { const sup = superOf(s); return <Row key={s.v} testid="own-vault" onClick={() => pick(s.v)} active={sel?.toLowerCase() === s.v.toLowerCase()} icon={sup ? sup.emoji : <ShieldCheck className="h-5 w-5 text-violet-300" />} title={<>{teamName(s.v) ?? (sup ? sup.name : `Vault ${short(s.v)}`)}</>} sub={<>{mon(s.bal)} · agent {signerOf(s, account) === 'wallet' ? 'your wallet' : signerOf(s, account) === 'key' ? 'key in this browser' : short(s.executor)}</>} right={<Pill tone={s.paused ? 'warn' : 'ok'}>{s.paused ? 'Paused' : 'Live'}</Pill>} />; })}
          </div>
          {account && <button data-testid="starter" disabled={starting} onClick={starter} className="mt-2 flex min-h-14 w-full min-w-0 items-center gap-3 rounded-2xl border border-dashed border-monad/50 bg-monad/5 px-3 py-2 text-left transition hover:bg-monad/10 active:scale-[0.99] disabled:opacity-60">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-monad/20"><Zap className="h-5 w-5 text-violet-200" /></span>
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-zinc-50">{starting ? 'Creating…' : 'One-click starter vault'}</span><span className="block text-xs text-zinc-400">Create + deposit {STARTER.deposit} MON in one transaction. Your wallet is the agent. Cap and budget sit at the {STARTER.cap} MON vault cap. Wrap, Kuru, Uniswap, PancakeSwap, and paying yourself are on.</span></span>
          </button>}
          {account && <p className="mt-1 text-[11px] leading-4 text-zinc-500">Vault creation uses a fixed 8,000,000 gas limit. Monad charges that whole limit, about 0.8 MON at a 100 gwei base fee.</p>}
          {net.id === 143 && <button onClick={() => setTab('launch')} className="mt-1 min-h-11 px-1 text-left text-xs text-violet-300">Want a separate agent key and custom rules? Use Launch →</button>}
        </div>
        {net.id === 143 && <div data-testid="super-vaults">
          <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wider text-zinc-500"><Sparkles className="h-3.5 w-3.5" />Super vaults</div>
          <div className="grid gap-2">
            {SUPER_VAULTS.map(t => (
              <button key={t.id} data-testid={`super-${t.id}`} disabled={superBusy} onClick={() => { haptic(); setSuperPayees(''); setSuperOpen(t); }} className="flex min-h-14 w-full min-w-0 items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.02] px-3 py-2 text-left transition hover:border-monad/50 active:scale-[0.99] disabled:opacity-60">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/5 text-lg">{t.emoji}</span>
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-zinc-50">{t.name}</span><span className="block truncate text-xs text-zinc-400">{t.tagline}</span></span>
                <ChevronRight className="h-4 w-4 shrink-0 text-zinc-600" />
              </button>))}
          </div>
        </div>}
        <div>
          <div className="mb-2 flex min-w-0 items-center gap-2 text-[11px] uppercase tracking-wider text-zinc-500"><Users className="h-3.5 w-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate">{TEAM_LABEL}</span></div>
          {net.id !== 143 && <p className="text-xs text-zinc-500">Team vaults live on mainnet only.</p>}
          {net.id === 143 && !snap && <div className="text-sm text-zinc-500">Loading team vaults…</div>}
          <div className="grid gap-2">
            {teamAgents.map(a => <Row key={a.id} testid="team-vault" onClick={() => pick(a.vault!)} active={sel?.toLowerCase() === a.vault!.toLowerCase()} icon={a.emoji} title={a.name} sub={<>{short(a.vault!)} · ✅ {a.allowed} · ⛔ {a.blocked}</>} right={<Pill tone="zinc"><Lock className="h-3 w-3" />read-only</Pill>} />)}
          </div>
          {!!snap?.agents.some((a: TeamAgent) => !a.vault) && <p className="mt-2 text-xs text-zinc-500">{snap!.agents.filter((a: TeamAgent) => !a.vault).map((a: TeamAgent) => `${a.emoji} ${a.name}`).join(', ')}: pending (vault + agent key not created yet).</p>}
        </div>
      </Card>
      <div ref={detailRef} className="min-w-0 scroll-mt-20">
        {!sel && <Card className="grid place-items-center gap-3 py-10 text-center"><ShieldCheck className="h-8 w-8 text-violet-300" /><p className="text-zinc-300">Pick a vault on the left{own.length ? '' : ', or create a starter vault'}.</p></Card>}
        {selOwn && <OwnVault s={selOwn} net={net} pub={pub} account={account} runAgent={runAgent} ownerTx={ownerTx} toast={toast} teamName={teamName(selOwn.v)} template={superOf(selOwn)} reload={() => loadVaults()} />}
        {selTeam && <TeamVault a={selTeam} s={teamState[selTeam.vault!]} net={net} pub={pub} account={account} runAgent={runAgent} owner={snap?.owner} />}
      </div>
      <Sheet open={!!superOpen} onClose={() => !superBusy && setSuperOpen(null)} title={superOpen ? `${superOpen.emoji} ${superOpen.name}` : ''}>
        {superOpen && <div className="grid gap-3" data-testid="super-sheet">
          <p className="text-sm text-zinc-300">{superOpen.tagline}</p>
          <ul className="grid gap-1 text-sm text-zinc-200">{superOpen.value.map(v => <li key={v} className="flex min-w-0 gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" /><span className="min-w-0 break-words">{v}</span></li>)}</ul>
          <p className="text-xs text-zinc-400">One transaction: your wallet becomes the agent. Limits: {superOpen.cap} MON per action, {superOpen.budget} MON total, {superOpen.deposit} MON deposited now (max {APP_VAULT_MON} MON per new vault).</p>
          <ol className="grid gap-1 text-xs text-zinc-400">{superOpen.playbook.map((st, i) => <li key={i}>{i + 1}. {st.label}</li>)}</ol>
          {superOpen.payees && <label className="grid gap-1 text-sm text-zinc-300">Extra payees (you are included)<textarea data-testid="super-payees" value={superPayees} onChange={e => setSuperPayees(e.target.value)} placeholder="0x…, 0x…" rows={2} className="w-full min-w-0 rounded-2xl border border-white/10 bg-black/40 px-3 py-2 font-mono text-xs outline-none focus:border-monad" /></label>}
          <Btn kind="pri" data-testid="super-create" disabled={superBusy} onClick={() => createSuper(superOpen)} className="w-full">{superBusy ? 'Creating…' : <>Create + deposit {superOpen.deposit} MON</>}</Btn>
        </div>}
      </Sheet>
    </div>
  );
}
function OwnVault({ s, net, pub, account, runAgent, ownerTx, toast, teamName, template, reload }: { s: VaultState; net: Net; pub: PublicClient; account: Address; runAgent: any; ownerTx: any; toast: any; teamName: string | null; template?: SuperVault; reload: () => void }) {
  const [k, setK] = useState<string | null>(null); const [own, setOwn] = useState<{ s: VaultState; kind: string } | null>(null);
  const signer = signerOf(s, account); const toks = (Object.entries(s.toks) as [TokenSym, bigint][]).filter(([, b]) => b > 0n);
  const acts = actionsFor(s.rules);
  return (
    <Card data-testid="vault-card">
      <div className="flex min-w-0 items-center gap-3"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-monad/20 text-xl">{template ? template.emoji : <ShieldCheck className="h-5 w-5 text-violet-300" />}</span>
        <div className="min-w-0 flex-1"><div className="break-words font-semibold text-white">{teamName ?? template?.name ?? `Vault ${short(s.v)}`}</div><a className="block truncate text-xs text-violet-300" href={`${net.exp}/address/${s.v}`} target="_blank" rel="noreferrer">{s.v} ↗</a>{template && <p className="mt-1 break-words text-xs text-zinc-400">{template.tagline}</p>}{teamName && <div className="mt-1 min-w-0 max-w-full"><Pill tone="zinc">{TEAM_LABEL}</Pill></div>}</div>
        <Pill tone={s.paused ? 'warn' : 'ok'}>{s.paused ? 'Paused' : 'Active'}</Pill></div>
      <VaultReport key={s.v} s={s} net={net} pub={pub} account={account} template={template} runAgent={runAgent} ownerTx={ownerTx} reload={reload} canSign={signer !== null} isOwner readOnly={false} />
      <Switch testid="sw-pause-vault" on={!s.paused} onChange={async v => { try { await ownerTx(v ? 'Owner resumes the agent' : 'Owner pauses the agent', vcall(s.v, 'setPaused', [!v])); toast(v ? '▶️ Agent resumed' : '⏸ Agent paused', 'ok'); } catch (e) { const f = sendFault(e); toast(f.text, f.pending ? 'info' : 'bad'); } }} label={s.paused ? 'Agent is paused' : 'Agent is live'} sub="Instant kill-switch, one signature" />
      {template && <Playbook s={s} template={template} pub={pub} runAgent={runAgent} canSign={signer !== null} reload={reload} account={account} ownerTx={ownerTx} />}
      <div className="mt-2 text-[11px] uppercase tracking-wider text-zinc-500">Agent actions · {signer === 'wallet' ? 'real, signed by your wallet' : signer === 'key' ? 'real, signed by the key in this browser' : 'simulate only'}</div>
      <p className="mt-1 break-words text-xs text-zinc-400">{signer === 'wallet' ? <>Your wallet <span className="font-mono">{short(s.executor)}</span> is this vault’s agent. Every button sends a real transaction that the vault checks against your policy first.</> : signer === 'key' ? <>Agent key <span className="font-mono">{short(s.executor)}</span> is stored in this browser. Buttons send real transactions through the vault’s policy.</> : <>Agent <span className="font-mono">{short(s.executor)}</span> signs elsewhere, so buttons here run a free policy check (eth_call) and send nothing. To act from this wallet, make it the agent below (owner signature).</>}</p>
      <div className="mt-2 flex flex-wrap gap-2">{acts.map(a => <Btn key={a.kind} kind="soft" className="px-3" data-testid={`act-${a.kind}`} onClick={() => setK(a.kind)}>{a.label}</Btn>)}<Btn kind="danger" className="px-3" data-testid="break" onClick={() => setK('break')}>😈 Break it</Btn></div>
      {!acts.length && <p className="mt-2 text-xs text-amber-200/80">No services are switched on for this vault yet, so there’s nothing the agent is allowed to do.</p>}
      <div className="mt-3 text-[11px] uppercase tracking-wider text-zinc-500">Owner</div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Btn onClick={() => setOwn({ s, kind: 'deposit' })}><Coins className="h-4 w-4" />Deposit</Btn><Btn onClick={() => setOwn({ s, kind: 'withdraw' })}>Withdraw</Btn>
        {signer !== 'wallet' && <Btn data-testid="take-seat" className="col-span-2" onClick={async () => { try { const r = await ownerTx('Owner makes this wallet the agent', vcall(s.v, 'setExecutor', [account])); toast(r.msg, 'ok'); } catch (e) { const f = sendFault(e); toast(f.text, f.pending ? 'info' : 'bad'); } }}><KeyRound className="h-4 w-4" />Make my wallet the agent</Btn>}
        <Btn kind="danger" data-testid="pull-back" className="col-span-2" disabled={s.bal === 0n} onClick={async () => { try { const r = await ownerTx(`Owner pulls ${mon(s.bal)} back`, vcall(s.v, 'withdraw', [account, s.bal])); toast(r.msg, 'ok'); } catch (e) { const f = sendFault(e); toast(f.text, f.pending ? 'info' : 'bad'); } }}>Pull all MON back (no pause)</Btn>
        {toks.length > 0 && <Btn data-testid="tokens" className="col-span-2" onClick={async () => { try { for (const [kk, b] of toks) await ownerTx(`Withdraw ${kk}`, vcall(s.v, 'withdrawToken', [TOKENS[kk].address, account, b])); toast('Tokens sent to your wallet', 'ok'); } catch (e) { const f = sendFault(e); toast(f.text, f.pending ? 'info' : 'bad'); } }}>Withdraw tokens ({toks.map(t => t[0]).join(', ')})</Btn>}
        {s.key && <Btn className="col-span-2 text-xs" onClick={() => { if (confirm('Show the agent key? Anyone holding it can act as this agent, though only within the vault limits.')) prompt('Agent key (keep it secret):', s.key!); }}>Export agent key</Btn>}
      </div>
      <ActionSheet s={s} kind={k} onClose={() => setK(null)} runAgent={runAgent} net={net} pub={pub} account={account} ownerTx={ownerTx} />
      <OwnerSheet x={own} onClose={() => setOwn(null)} ownerTx={ownerTx} account={account} />
    </Card>
  );
}
function Playbook({ s, template, pub, runAgent, canSign, reload, account, ownerTx }: { s: VaultState; template: SuperVault; pub: PublicClient; runAgent: any; canSign: boolean; reload: () => void; account: Address | null; ownerTx: (label: string, req: { to: Address; data: `0x${string}`; value?: bigint }) => Promise<unknown> }) {
  const [lines, setLines] = useState<{ ok: boolean; text: string; msg?: React.ReactNode }[]>([]); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false);
  const run = async () => {
    if (!canSign) return; setBusy(true); setDone(false); setLines([]);
    const push = (ok: boolean, text: string, msg?: React.ReactNode) => setLines(l => [...l, { ok, text, msg }]);
    let stopped = false;
    const ownerHere = !!(account && s.owner.toLowerCase() === account.toLowerCase());
    let vault = s;
    const readLimits = async () => {
      const [bal, budget, spent, cap, vaultCap] = await Promise.all([
        pub.getBalance({ address: s.v }),
        pub.readContract({ address: s.v, abi: vaultAbi, functionName: 'budget' }) as Promise<bigint>,
        pub.readContract({ address: s.v, abi: vaultAbi, functionName: 'totalSpent' }) as Promise<bigint>,
        pub.readContract({ address: s.v, abi: vaultAbi, functionName: 'perPaymentCap' }) as Promise<bigint>,
        pub.readContract({ address: s.v, abi: vaultAbi, functionName: 'vaultCap' }) as Promise<bigint>,
      ]);
      return { bal, budget, spent, cap, vaultCap };
    };
    const fitMon = async (want: bigint) => {
      const live = await readLimits();
      if (ownerHere && live.vaultCap > 0n) {
        const room = live.bal < live.vaultCap ? live.bal : live.vaultCap;
        return want < room ? want : room;
      }
      const room = executableMon(live);
      return want < room ? want : room;
    };
    const lift = async (amount: bigint) => {
      if (!ownerHere) return;
      const live = await readLimits();
      const raise = limitsFor(live, amount);
      if (raise.cap != null) {
        await ownerTx('Owner raises the per-action cap to the vault cap', vcall(s.v, 'setPerPaymentCap', [raise.cap]));
        vault = { ...vault, cap: raise.cap };
      }
      if (raise.budget != null) {
        await ownerTx('Owner raises the budget to cover the vault cap', vcall(s.v, 'setBudget', [raise.budget]));
        vault = { ...vault, budget: raise.budget };
      }
    };
    const step = async (kind: string, amount: bigint, label: string, extra?: { to?: Address }) => {
      const r = await runAgent(vault, kind, amount, extra ?? {});
      push(r.ok, label, r.ok ? undefined : r.msg); if (!r.ok) stopped = true;
    };
    try {
      for (const st of template.playbook) {
        if (stopped) break;
        if (st.kind === 'pay-each') {
          let stored: string[] = []; try { stored = JSON.parse(localStorage.getItem(`pp.payees.${s.v.toLowerCase()}`) || '[]'); } catch { /* none */ }
          const allowed: Address[] = [];
          for (const raw of [s.owner, ...stored]) { if (!isAddress(raw)) continue; const a = getAddress(raw); if (allowed.some(x => x.toLowerCase() === a.toLowerCase())) continue; if (await pub.readContract({ address: s.v, abi: vaultAbi, functionName: 'allowedRecipient', args: [a] })) allowed.push(a); }
          if (!allowed.length) { push(false, 'No approved payees on this vault.'); stopped = true; break; }
          for (const to of allowed) {
            const want = parseEther(st.amount); const amt = await fitMon(want);
            if (amt === 0n) { push(false, 'Stopped: nothing left inside the cap and budget for the next payment.'); stopped = true; break; }
            await lift(amt);
            await step('payto', amt, `Paid ${formatEther(amt)} MON to ${short(to)}`, { to }); if (stopped) break;
          }
          continue;
        }
        let amount: bigint; let label = st.label;
        if (st.amount === 'wmon-all') {
          amount = await pub.readContract({ address: TOKENS.WMON.address, abi: erc20, functionName: 'balanceOf', args: [s.v] }).catch(() => 0n) as bigint;
          if (amount === 0n) { push(true, 'No WMON to unwrap — skipped.'); continue; }
        } else {
          const want = parseEther(st.amount); amount = await fitMon(want);
          if (amount === 0n) { push(false, `Stopped: nothing left inside the cap and budget for “${st.label}”.`); stopped = true; break; }
          if (amount !== want) label = `${st.label} — sent ${formatEther(amount)} MON, the most this vault can move`;
          await lift(amount);
        }
        await step(st.kind, amount, label);
      }
      if (!stopped) { push(true, 'Playbook finished. Receipts stay in the vault until you withdraw them.'); setDone(true); }
    } catch (e) { push(false, sendFault(e).text); }
    setBusy(false); reload();
  };
  return (
    <div className="mt-3 rounded-2xl border border-monad/30 bg-monad/5 p-3" data-testid="playbook">
      <div className="text-[11px] uppercase tracking-wider text-violet-200">Playbook · {template.name}</div>
      <ol className="mt-1 grid gap-0.5 text-xs text-zinc-300">{template.playbook.map((st, i) => <li key={i} className="break-words">{i + 1}. {st.label}</li>)}</ol>
      <Btn kind="pri" data-testid="playbook-run" disabled={busy || !canSign} onClick={run} className="mt-2 w-full"><Play className="h-4 w-4" />{busy ? 'Running…' : done ? 'Run playbook again' : 'Run playbook'}</Btn>
      {!canSign && <p className="mt-1 text-xs text-zinc-400">This browser can’t sign for the agent, so the playbook stays off. Make your wallet the agent below to run it for real.</p>}
      {lines.length > 0 && <ol data-testid="playbook-log" className="mt-2 grid gap-1 text-xs">{lines.map((l, i) => <li key={i} className={`break-words ${l.ok ? 'text-emerald-200' : 'text-red-200'}`}>{l.ok ? '✅' : '⛔'} {l.text}{l.msg && <div className="pl-4 text-zinc-300">{l.msg}</div>}</li>)}</ol>}
    </div>
  );
}
function TeamVault({ a, s, net, pub, account, runAgent, owner }: { a: TeamAgent; s?: VaultState | 'loading' | 'error'; net: Net; pub: PublicClient; account: Address | null; runAgent: any; owner?: Address }) {
  const [k, setK] = useState<string | null>(null);
  const st = s && s !== 'loading' && s !== 'error' ? s : null;
  const idle = a.lastSkip;
  return (
    <Card data-testid="team-card" className="border-amber-400/25 bg-amber-400/[0.04]">
      <div className="flex min-w-0 items-center gap-3"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-white/5 text-2xl">{a.emoji}</span>
        <div className="min-w-0 flex-1"><div className="truncate font-semibold text-white">{a.name}</div><a className="block truncate text-xs text-violet-300" href={`${net.exp}/address/${a.vault}`} target="_blank" rel="noreferrer">{a.vault} ↗</a></div>
        <Pill tone="zinc"><Lock className="h-3 w-3" />read-only</Pill></div>
      <div className="mt-2 min-w-0 max-w-full"><Pill tone="warn">{TEAM_LABEL}</Pill></div>
      <p className="mt-2 text-sm text-zinc-300">{a.about}</p>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-300"><span>✅ {a.allowed} allowed</span><span>⛔ {a.blocked} blocked on-chain</span><span>cap {a.perActionCapMON} MON</span>{a.agent && <span className="font-mono">agent {short(a.agent)}</span>}</div>
      {idle && <p className="mt-2 break-words rounded-xl bg-amber-400/10 p-2 text-[11px] text-amber-100/80">Last runner note ({new Date(idle.ts).toLocaleString()}): {idle.reason}</p>}
      {s === 'loading' && <div className="mt-3 text-sm text-zinc-500">Reading the vault…</div>}
      {s === 'error' && <div className="mt-3 text-sm text-red-300">Couldn’t read this vault right now.</div>}
      {st && <>
        <VaultReport key={st.v} s={st} net={net} pub={pub} account={account} runAgent={runAgent} ownerTx={async () => { throw new Error('This team vault is read-only here.'); }} reload={() => {}} canSign={false} isOwner={false} readOnly />
        <div className="mt-3 text-[11px] uppercase tracking-wider text-zinc-500">Simulate what this agent may do</div>
        <p className="mt-1 text-xs text-zinc-400">The team’s agent keys live only in encrypted GitHub Actions secrets and never enter a browser. Buttons run the vault’s policy check as a free eth_call from the agent’s address and send nothing.{owner && account && owner.toLowerCase() === account.toLowerCase() ? ' You are the owner: this vault also appears under “Your vaults” with real owner actions.' : ''}</p>
        <div className="mt-2 flex flex-wrap gap-2">{actionsFor(st.rules).map(x => <Btn key={x.kind} kind="soft" className="px-3" onClick={() => setK(x.kind)}>{x.label}</Btn>)}<Btn kind="danger" className="px-3" onClick={() => setK('break')}>😈 Break it</Btn></div>
        <ActionSheet s={st} kind={k} onClose={() => setK(null)} runAgent={runAgent} net={net} pub={pub} account={account} readOnly />
      </>}
    </Card>
  );
}
function OwnerSheet({ x, onClose, ownerTx, account }: any) {
  const [amt, setAmt] = useState('0.05'); const [res, setRes] = useState<any>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { setRes(null); if (x) setAmt(x.kind === 'withdraw' ? formatEther(x.s.bal) : '0.05'); }, [x]);
  if (!x) return null;
  const go = async () => { setBusy(true); try { const v = parseEther(amt || '0'); setRes(await (x.kind === 'deposit' ? ownerTx(`Deposit ${amt} MON`, { ...vcall(x.s.v, 'deposit', []), value: v }) : ownerTx(`Withdraw ${amt} MON`, vcall(x.s.v, 'withdraw', [account, v])))); } catch (e) { setRes({ ok: false, msg: sendFault(e).text }); } setBusy(false); };
  return <Sheet open onClose={onClose} title={x.kind === 'deposit' ? 'Deposit MON' : 'Withdraw MON'}><label className="grid gap-1 text-sm text-zinc-300">Amount (MON)<input inputMode="decimal" value={amt} onChange={e => setAmt(e.target.value)} className="min-h-12 w-full min-w-0 rounded-2xl border border-white/10 bg-black/40 px-3 font-mono text-base outline-none focus:border-monad" /></label>{x.kind === 'deposit' && <p className="mt-2 text-xs text-zinc-400">This vault stops at {mon(x.s.vaultCap)}.</p>}<Btn kind="pri" disabled={busy} onClick={go} className="mt-4 w-full">{busy ? 'Working…' : 'Confirm'}</Btn>{res && <div className={`mt-3 break-words rounded-2xl border p-3 text-sm ${res.ok ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-red-500/40 bg-red-500/10'}`}>{res.msg}</div>}</Sheet>;
}

// ---------------- Services ----------------
function ServicesView({ net }: { net: Net }) {
  const list = services(net);
  return (
    <div className="grid gap-4">
      <div><h1 className="text-2xl font-bold text-white">Top Monad services</h1><p className="text-sm text-zinc-400">“Live” means the address comes from the protocol’s own docs and passes a mainnet fork test. Everything else is honestly marked “coming soon”.</p></div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="services">
        {list.map(s => (
          <Card key={s.id} data-testid={`svc-${s.id}`} data-status={s.status} className={s.status === 'soon' ? 'opacity-80' : ''}>
            <div className="flex min-w-0 items-center gap-3"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-white/5 text-2xl">{s.icon}</span><div className="min-w-0 flex-1"><div className="truncate font-semibold text-white">{s.name}</div><div className="truncate text-xs text-zinc-400">{s.category} · {s.blurb}</div></div><Pill tone={s.status === 'live' ? 'ok' : 'zinc'}>{s.status === 'live' ? 'Live' : 'Soon'}</Pill></div>
            <p className="mt-3 text-sm text-zinc-300">{s.novice}</p>
            {s.status === 'live' && s.address && <div className="mt-3 grid gap-1 text-xs"><a className="flex min-h-8 min-w-0 items-center gap-1 text-violet-300" href={`${net.exp}/address/${s.address}`} target="_blank" rel="noreferrer"><span className="truncate font-mono">{s.address}</span><ExternalLink className="h-3 w-3 shrink-0" /></a><a className="flex min-h-8 items-center gap-1 text-zinc-400 underline" href={s.source} target="_blank" rel="noreferrer">Official source ↗</a><span className="text-zinc-500">Fork test: {s.forkTest}</span></div>}
            {s.status === 'soon' && <p className="mt-3 text-xs text-zinc-500">{s.why}</p>}
          </Card>))}
      </div>
    </div>
  );
}
