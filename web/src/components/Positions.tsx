'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatEther, formatUnits, getAddress, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ExternalLink, Layers, LogOut, RefreshCw, ShieldCheck } from 'lucide-react';
import { Btn, Card, Pill, Sheet, Switch } from './ui';
import PolicyDashboard from './Dashboard';
import { everyVisible } from '@/lib/rpcLimit';
import { loadIndex } from '@/lib/activity';
import { monUsdcPrice, short, type Net } from '@/lib/vault';
import { pricedGas, sendWithKey, withDeadline, preflightGas } from '@/lib/fastPath';
import { positions as journeyPositions } from '@/lib/journeyStore';
import { byId } from '@/lib/journey';
import {
  buildClosePlan, closeBlocker, discoverTokens, errText, findVaults, fmtUnits, isEmpty, readRates, readVaultPositions, readWalletPositions, runPlan, SHOWCASE_LABEL, totals,
  type AgentAccess, type FoundVault, type Plan, type PoolRef, type Rates, type Step, type StepState, type VaultPos, type WalletPos,
} from '@/lib/positionsCore';

const REFRESH_MS = 30_000;
const AGENT_SCAN_MS = 300_000;
const DISCOVERY_MS = 300_000;
const m4 = (x: bigint | null | undefined, d = 4) => (x == null ? 'unknown value' : `${Number(formatEther(x)).toLocaleString('en-GB', { maximumFractionDigits: d })} MON`);
const usd = (x: bigint | null) => (x == null ? 'no live quote' : `${Number(formatUnits(x, 6)).toLocaleString('en-GB', { maximumFractionDigits: 2 })} USDC`);

type Props = { net: Net; pub: PublicClient; slowPub: PublicClient; account: Address | null; wallet: WalletClient | null; need: () => Promise<boolean>; send: (w: WalletClient, req: { to?: Address; data?: Hex; value?: bigint; gas?: bigint }) => Promise<{ transactionHash: Hex; status: string }>; toast: (t: React.ReactNode, k?: 'ok' | 'bad' | 'info') => void; openConnect: () => void };

/** Policy tab: Positions (default) and the original testnet reference dashboard. */
export default function PolicyView(p: Props) {
  const [sub, setSub] = useState<'positions' | 'reference'>('positions');
  return (
    <div className="min-w-0">
      <div className="mb-4 inline-flex rounded-2xl border border-white/10 bg-white/[0.03] p-1" role="tablist">
        {([['positions', 'Positions'], ['reference', 'Reference policy (testnet)']] as const).map(([id, l]) => <button key={id} role="tab" aria-selected={sub === id} data-testid={`policy-sub-${id}`} onClick={() => setSub(id)} className={`min-h-11 rounded-xl px-3 text-sm ${sub === id ? 'bg-white/10 text-white' : 'text-zinc-400'}`}>{l}</button>)}
      </div>
      {sub === 'positions' ? <Positions {...p} /> : <PolicyDashboard embedded />}
    </div>
  );
}

const agentKeys = (): Map<string, Hex> => {
  const m = new Map<string, Hex>();
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i) ?? ''; if (k.startsWith('pp.agentkey.')) { const v = localStorage.getItem(k); if (v && /^0x[0-9a-fA-F]{64}$/.test(v)) m.set(k.slice(12).toLowerCase(), v as Hex); } } } catch { /* private mode */ }
  return m;
};
const savedPools = (net: Net, account: Address | null): PoolRef[] => {
  if (!account) return [];
  const out: PoolRef[] = [];
  for (const kind of ['clip', 'spread', 'prime'] as const) { const a = localStorage.getItem(`pp.${kind}.${net.id}.${account.toLowerCase()}`); if (a && /^0x[0-9a-fA-F]{40}$/.test(a)) out.push({ kind, address: getAddress(a) }); }
  // Pools opened from the Start wizard (My money) are closed by the same plan.
  for (const p of journeyPositions(net.id, account)) {
    const kind = byId(p.strategy)?.kind;
    if ((kind === 'clip' || kind === 'spread') && !out.some(x => x.address.toLowerCase() === p.address.toLowerCase())) out.push({ kind, address: getAddress(p.address) });
  }
  return out;
};
const idxCache = {
  get: (k: string) => { try { return (localStorage.getItem(`pp.idx.${k}`) as Address) || undefined; } catch { return undefined; } },
  set: (k: string, v: Address) => { try { localStorage.setItem(`pp.idx.${k}`, v); } catch { /* full */ } },
};
const PROGRESS = (a: string) => `pp.close.${a.toLowerCase()}`;
const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
/** Vault addresses per factory from the activity index (refreshed at most every 5 minutes), so the agent scan skips allVaults(i). */
let indexed: { at: number; m: Map<string, Address[]> } | null = null;
async function indexedVaults(): Promise<Map<string, Address[]> | undefined> {
  if (indexed && Date.now() - indexed.at < AGENT_SCAN_MS) return indexed.m;
  const idx = await loadIndex(BASE).catch(() => null); if (!idx) return indexed?.m;
  const byLabel = new Map(Object.entries(idx.factories).map(([a, l]) => [l, a.toLowerCase()]));
  const m = new Map<string, Address[]>();
  for (const v of [...idx.vaults].sort((x, y) => x.b - y.b)) { const f = byLabel.get(v.f); if (!f) continue; const xs = m.get(f) ?? []; xs.push(getAddress(v.a)); m.set(f, xs); }
  indexed = { at: Date.now(), m }; return m;
}

function Positions({ net, pub, slowPub, account, wallet, need, send, toast, openConnect }: Props) {
  const [found, setFound] = useState<FoundVault[] | null>(null);
  const [rows, setRows] = useState<VaultPos[]>([]);
  const [show, setShow] = useState<VaultPos[]>([]);
  const [walletPos, setWalletPos] = useState<WalletPos | null>(null);
  const [rates, setRates] = useState<Rates | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showOpen, setShowOpen] = useState(false);
  const [modal, setModal] = useState<{ scope: 'all' | Address } | null>(null);
  const scanAt = useRef(0); const disc = useRef(new Map<string, { at: number; v: Awaited<ReturnType<typeof discoverTokens>> }>());
  const mainnet = net.id === 143;

  const discover = useCallback(async (fv: FoundVault) => {
    const k = fv.vault.toLowerCase(); const hit = disc.current.get(k);
    if (hit && Date.now() - hit.at < DISCOVERY_MS) return hit.v;
    const d = await discoverTokens(fv.vault); disc.current.set(k, { at: Date.now(), v: d }); return d;
  }, []);
  // Token discovery (Blockscout, no RPC) for every vault first, then every vault's chain reads start together, so the
  // batching client folds each round of all vaults into a few Multicall3 calls instead of one round trip per vault.
  const readMany = useCallback(async (c: PublicClient, fvs: FoundVault[], r: Rates, pools: PoolRef[]) => {
    const ds = await Promise.all(fvs.map(fv => discover(fv).catch(() => null)));
    return Promise.all(fvs.map((fv, i) => readVaultPositions(c, fv, { rates: r, pools, discovered: ds[i] }).catch(e => { console.warn(e); return null; })));
  }, [discover]);

  const load = useCallback(async (opts: { fresh?: boolean } = {}) => {
    if (!mainnet) return;
    const c = opts.fresh ? pub : slowPub;
    setLoading(true);
    try {
      const keys = agentKeys();
      const agentAddrs = [...keys.keys()].map(a => getAddress(a));
      let f = found;
      if (!f || Date.now() - scanAt.current > AGENT_SCAN_MS || opts.fresh) {
        f = await findVaults(c, { account, agentAddrs, scanAgents: true, cache: idxCache, includeShowcase: true, indexed: await indexedVaults() });
        scanAt.current = Date.now(); setFound(f);
      }
      const price = await monUsdcPrice(c, (account ?? f[0]?.vault ?? '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A') as Address).catch(() => null);
      const r = await readRates(c, price && price.usdcPerMon > 0n ? price : null); setRates(r);
      const pools = savedPools(net, account);
      const mine = f.filter(x => !x.factory.showcase || x.relations.some(y => y !== 'showcase'));
      const [vs, w] = await Promise.all([
        readMany(c, mine, r, pools),
        account ? readWalletPositions(c, account, { rates: r, pools }) : Promise.resolve(null),
      ]);
      setRows(vs.filter((x): x is VaultPos => !!x)); setWalletPos(w); setErr(null);
    } catch (e) { setErr(errText(e)); } finally { setLoading(false); }
  }, [mainnet, pub, slowPub, account, found, net, readMany]);

  const loadShow = useCallback(async () => {
    if (!mainnet || !found || !rates) return;
    const team = found.filter(x => x.factory.showcase);
    const vs = await readMany(slowPub, team, rates, []);
    setShow(vs.filter((x): x is VaultPos => !!x));
  }, [mainnet, found, rates, slowPub, readMany]);

  // On demand: read when the tab opens, then about every 30s only while the page is visible.
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => { setFound(null); scanAt.current = 0; }, [account]);
  useEffect(() => { if (!mainnet) return; loadRef.current(); return everyVisible(() => loadRef.current(), REFRESH_MS); }, [mainnet, account]);
  const showRef = useRef(loadShow); showRef.current = loadShow;
  useEffect(() => { if (!showOpen) return; showRef.current(); return everyVisible(() => showRef.current(), REFRESH_MS); }, [showOpen, found !== null, rates !== null]); // eslint-disable-line

  const t = useMemo(() => (rates ? totals(rows, rates, walletPos) : null), [rows, rates, walletPos]);
  const owned = rows.filter(r => account && r.owner.toLowerCase() === account.toLowerCase());
  const closable = owned.filter(r => !isEmpty(r));
  const walletHasClose = !!walletPos && (walletPos.pools.length > 0 || walletPos.aprRequests.some(q => q.claimable));

  if (!mainnet) return <Card><p className="text-sm text-zinc-300">Positions read Monad mainnet contracts. Switch the network to Mainnet to see them.</p></Card>;

  return (
    <div className="grid min-w-0 gap-4" data-testid="positions-view">
      <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-200" data-testid="positions-alpha">Alpha · unaudited contract · only deposit what you&apos;re happy to lose.</div>
      <Card data-testid="positions-summary">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Layers className="h-5 w-5 text-monad" /><h1 className="mr-auto text-lg font-semibold text-zinc-50">Positions</h1>
          <Btn kind="ghost" className="px-3" onClick={() => load({ fresh: true })} disabled={loading} data-testid="positions-refresh"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />{loading ? 'Reading…' : 'Refresh'}</Btn>
        </div>
        {!account && <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-zinc-300"><span className="min-w-0 flex-1">Connect a wallet to list every vault it owns or is the agent of, across the v1, v2, v3, v4 showcase and Unlimited factories.</span><Btn kind="pri" onClick={openConnect}>Connect</Btn></div>}
        {account && <>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[['Total (MON)', t ? m4(t.navMon) : '…'], ['Total (USDC)', t ? usd(t.usdc) : '…'], ['Vaults', String(rows.length)], ['Unknown value', t ? `${t.unknown} item(s)` : '…']].map(([k, v]) => <div key={k} className="min-w-0 rounded-2xl bg-black/30 p-3"><div className="truncate font-mono text-base tabular-nums text-white" data-testid={`sum-${k}`}>{v}</div><div className="truncate text-[11px] text-zinc-400">{k}</div></div>)}
          </div>
          <p className="mt-2 text-xs text-zinc-500" data-testid="valuation-note">Values are live on-chain reads: MON and WMON 1:1, aprMON and gMON via convertToAssets, pool shares via assetsOf, queued aPriori withdrawals at their recorded MON. USDC uses the live {rates?.venue ?? '—'} MON/USDC quote{rates?.usdcPerMon ? '' : ' (unavailable right now, so USDC is not in the MON total)'}. {t?.par ? `${t.par} item(s) counted at par (sMON). ` : ''}Items with no price are shown as “unknown value” and left out of the totals. Nothing here is a promised amount.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Btn kind="danger" data-testid="close-all" disabled={!wallet || (!closable.length && !walletHasClose)} onClick={() => setModal({ scope: 'all' })}><LogOut className="h-4 w-4" />Close all my positions</Btn>
            <span className="min-w-0 flex-1 text-xs text-zinc-400" data-testid="close-all-why">{!closable.length && !walletHasClose ? (owned.length ? 'Every vault you own is already empty.' : rows.length ? 'You own none of these vaults, so there is nothing you can withdraw. Only a vault’s owner can.' : 'No vaults found for this wallet.') : `Withdraws from ${closable.length} vault(s) you own to ${short(account)}${walletHasClose ? ', plus your own pool and aPriori claims' : ''}. Team showcase vaults are never included.`}</span>
          </div>
        </>}
        {err && <p className="mt-2 break-words text-xs text-red-300">Read error: {err}. Retrying on the next refresh.</p>}
      </Card>

      {account && walletPos && <WalletCard w={walletPos} net={net} />}
      {account && found && !rows.length && !loading && <Card><p className="text-sm text-zinc-300" data-testid="no-vaults">No vault in any factory has this wallet as owner or agent, and no agent key in this browser matches one.</p></Card>}
      {rows.map(r => <VaultCard key={r.vault} p={r} net={net} account={account} keyHere={agentKeys().has(r.executor.toLowerCase())} onClose={() => setModal({ scope: r.vault })} />)}

      <Card data-testid="showcase-section">
        <button className="flex min-h-11 w-full items-center gap-2 text-left" onClick={() => setShowOpen(x => !x)} data-testid="showcase-toggle"><ShieldCheck className="h-4 w-4 text-zinc-400" /><span className="min-w-0 flex-1 font-semibold text-zinc-100">{SHOWCASE_LABEL}</span><span className="text-xs text-zinc-400">{showOpen ? 'Hide' : `Show ${found ? found.filter(x => x.factory.showcase).length : 13} (read-only)`}</span></button>
        {showOpen && <div className="mt-3 grid gap-3">
          <p className="text-xs text-zinc-400">Read-only. These 13 ShowcaseAgentVaults are run by the team’s scheduled agents; nothing here can be closed from this page.</p>
          {!show.length && <p className="text-xs text-zinc-500">Reading…</p>}
          {show.map(r => <VaultCard key={r.vault} p={r} net={net} account={account} keyHere={false} readOnly />)}
        </div>}
      </Card>

      {modal && account && wallet && rates && <CloseModal {...{ net, pub, account, wallet, need, send, toast, rates }} scope={modal.scope}
        targets={(found ?? []).filter(f => !f.factory.showcase && (modal.scope === 'all' ? closable.some(r => r.vault === f.vault) : f.vault.toLowerCase() === modal.scope.toLowerCase()))}
        reread={async (fs: FoundVault[]) => (await readMany(pub, fs, rates!, savedPools(net, account))).filter((x): x is VaultPos => !!x)}
        onClose={() => setModal(null)} onDone={() => load({ fresh: true })} />}
    </div>
  );
}

/** "Withdraw everything" from My money: the same close-all plan and modal as Policy → Positions, for every vault this wallet owns plus its pools. */
export function CloseAll({ net, pub, account, wallet, need, send, toast, onClose, onDone }: { net: Net; pub: PublicClient; account: Address; wallet: WalletClient; need: Props['need']; send: Props['send']; toast: Props['toast']; onClose: () => void; onDone: () => void }) {
  const [ctx, setCtx] = useState<{ rates: Rates; targets: FoundVault[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    (async () => {
      const keys = agentKeys();
      const [rates, found] = await Promise.all([
        readRates(pub, null),
        findVaults(pub, { account, agentAddrs: [...keys.keys()].map(a => getAddress(a)), scanAgents: false, cache: idxCache, includeShowcase: false, indexed: await indexedVaults() }),
      ]);
      if (on) setCtx({ rates, targets: found.filter(f => !f.factory.showcase && f.relations.includes('owner')) });
    })().catch(e => on && setErr(errText(e)));
    return () => { on = false; };
  }, [pub, account]);
  if (err) return <Sheet open onClose={onClose} title="Withdraw everything"><p className="text-sm text-red-200" data-testid="close-error">{err}</p></Sheet>;
  if (!ctx) return <Sheet open onClose={onClose} title="Withdraw everything"><p className="text-sm text-zinc-400" data-testid="close-reading">Reading fresh balances…</p></Sheet>;
  return <CloseModal {...{ net, pub, account, wallet, need, send, toast, rates: ctx.rates }} scope="all" targets={ctx.targets}
    reread={async (fs: FoundVault[]) => (await Promise.all(fs.map(fv => readVaultPositions(pub, fv, { rates: ctx.rates, pools: savedPools(net, account), discover: true }).catch(() => null)))).filter((x): x is VaultPos => !!x)}
    onClose={onClose} onDone={onDone} />;
}

function Row({ k, v, note, testid }: { k: React.ReactNode; v: React.ReactNode; note?: React.ReactNode; testid?: string }) {
  return <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-t border-white/5 py-2 text-sm first:border-0" data-testid={testid}><span className="min-w-0 truncate text-zinc-200">{k}</span><span className="text-right font-mono tabular-nums text-zinc-100">{v}</span>{note && <span className="col-span-2 text-[11px] text-zinc-500">{note}</span>}</div>;
}

function WalletCard({ w, net }: { w: WalletPos; net: Net }) {
  const any = w.aprMon > 0n || w.aprRequests.length || w.pools.length;
  return (
    <Card data-testid="wallet-positions">
      <h2 className="font-semibold text-zinc-50">Your wallet’s own positions</h2>
      <p className="mb-2 text-xs text-zinc-500">MonaDefi aprMON and the Prime/Spread/Clip pools this browser opened for {short(w.account)}.</p>
      {!any && <p className="text-sm text-zinc-400">No MonaDefi aprMON, queued aPriori withdrawals or saved pool shares.</p>}
      {w.aprMon > 0n && <Row k="MonaDefi aprMON position" v={`${fmtUnits(w.aprMon, 18)} aprMON`} note={<>≈ {m4(w.aprMonValue)} via convertToAssets. Already in your wallet; turning it into MON is a queued aPriori withdrawal, not instant.</>} />}
      {w.aprRequests.map(q => <Row key={String(q.id)} k={`aPriori withdrawal #${q.id}`} v={m4(q.assets)} note={q.claimable ? 'Unlocked: Close all claims it to your wallet.' : `Queued (unlock epoch ${q.unlockEpoch}). Not claimable yet.`} />)}
      {w.pools.map(s => <Row key={s.pool + (s.tranche ?? '')} k={<>{s.kind} pool{s.kind === 'prime' ? (s.tranche === 0 ? ' senior' : ' junior') : ''} <a className="text-violet-300" href={`${net.exp}/address/${s.pool}`} target="_blank" rel="noreferrer">{short(s.pool)}</a></>} v={m4(s.assets)} note="Your shares; Close all exits them to your wallet." />)}
      {w.errors.length > 0 && <p className="mt-1 text-[11px] text-amber-300">{w.errors.join(' · ')}</p>}
    </Card>
  );
}

function VaultCard({ p, net, account, keyHere, readOnly, onClose }: { p: VaultPos; net: Net; account: Address | null; keyHere: boolean; readOnly?: boolean; onClose?: () => void }) {
  const why = closeBlocker(p, account);
  const empty = isEmpty(p);
  const rel = (r: string) => ({ owner: <Pill key={r} tone="ok">You own it</Pill>, agent: <Pill key={r} tone="monad">You are the agent</Pill>, 'browser-key': <Pill key={r} tone="monad">Agent key in this browser</Pill>, showcase: <Pill key={r} tone="zinc">Team showcase</Pill> } as any)[r];
  const lnk = (a: Address) => <a className="font-mono text-violet-300" href={`${net.exp}/address/${a}`} target="_blank" rel="noreferrer">{short(a)}</a>;
  return (
    <Card data-testid={readOnly ? 'showcase-vault' : 'vault-card'} data-vault={p.vault}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <a href={`${net.exp}/address/${p.vault}`} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1 font-mono text-sm text-zinc-50">{short(p.vault)}<ExternalLink className="h-3 w-3 opacity-60" /></a>
        <Pill tone="zinc">{p.factory.label}</Pill>
        {p.paused ? <Pill tone="warn">Paused</Pill> : <Pill tone="ok">Active</Pill>}
        {p.relations.map(rel)}
        {keyHere && !p.relations.includes('browser-key') && <Pill tone="monad">Agent key in this browser</Pill>}
        <span className="ml-auto font-mono text-sm tabular-nums text-zinc-100" data-testid="vault-total">{m4(p.navMon)}{p.unknown ? ` + ${p.unknown} unknown` : ''}</span>
      </div>
      <div className="mt-1 text-xs text-zinc-400">Owner {lnk(p.owner)}{account && p.owner.toLowerCase() === account.toLowerCase() ? ' (you)' : ''} · Agent {lnk(p.executor)}{account && p.executor.toLowerCase() === account.toLowerCase() ? ' (you)' : ''}</div>
      <div className="mt-2" data-testid="vault-assets">
        <Row k="MON (native)" v={m4(p.native, 6)} testid="asset-MON" />
        {p.tokens.map(x => <Row key={x.address} testid={`asset-${x.sym}`} k={<>{x.sym}{x.source === 'transfer-logs' && <span className="ml-1 text-[11px] text-zinc-500">({x.name || 'ERC-20'} · {short(x.address)}, found in Transfer logs)</span>}</>} v={<>{fmtUnits(x.amount, x.decimals)} {x.sym}<span className="block text-[11px] text-zinc-400">{x.monValue == null ? 'unknown value' : `≈ ${m4(x.monValue)}`}{x.priced === 'par' ? ' (par)' : ''}</span></>} note={x.note} />)}
        {p.lpNfts.map(n => <Row key={`${n.manager}${n.tokenId}`} k={`${n.venue} LP NFT #${n.tokenId}`} v="unknown value" note="Detected via the position manager. This app does not value LP ranges." />)}
        {p.pools.map(s => <Row key={s.pool + (s.tranche ?? '')} k={`${s.kind} pool shares ${short(s.pool)}`} v={m4(s.assets)} />)}
        {p.aprRequests.map(q => <Row key={String(q.id)} k={`aPriori queued withdrawal #${q.id}`} v={m4(q.assets)} note={q.claimable ? 'Unlocked: claimable.' : `Queued until unlock epoch ${q.unlockEpoch}; not claimable yet.`} />)}
        {p.kuru.map(k => <Row key={k.sym} k={`Kuru margin ${k.sym}`} v={`${fmtUnits(k.amount, k.sym === 'USDC' ? 6 : 18)} ${k.sym}`} />)}
        {empty && <p className="pt-1 text-xs text-zinc-500">Nothing in this vault.</p>}
        <p className="pt-1 text-[11px] text-zinc-500">{p.discovery === 'ok' ? 'Other ERC-20s: checked against Transfer logs to this vault (public Blockscout index).' : p.discovery === 'unavailable' ? 'Other ERC-20s: the Transfer-log index did not answer, so only WMON, USDC, sMON, aprMON and gMON were checked.' : ''} Uniswap/PancakeSwap LP NFTs, Kuru margin balances, aPriori requests and this browser’s saved pools are checked on-chain.</p>
        {p.errors.length > 0 && <p className="text-[11px] text-amber-300">{p.errors.join(' · ')}</p>}
      </div>
      {!readOnly && <div className="mt-3 flex flex-wrap items-center gap-2">
        <Btn kind="danger" data-testid="close-vault" disabled={!!why || empty} onClick={onClose}><LogOut className="h-4 w-4" />Close &amp; withdraw all</Btn>
        <span className="min-w-0 flex-1 text-xs text-zinc-400" data-testid="close-why">{why ?? (empty ? 'Empty: nothing to withdraw.' : `Everything goes to the owner wallet ${short(p.owner)}.`)}</span>
      </div>}
    </Card>
  );
}

type Done = { step: Step; st: StepState };
function CloseModal({ net, pub, account, wallet, send, need, toast, rates, scope, targets, reread, onClose, onDone }: { net: Net; pub: PublicClient; account: Address; wallet: WalletClient; need: () => Promise<boolean>; send: Props['send']; toast: Props['toast']; rates: Rates; scope: 'all' | Address; targets: FoundVault[]; reread: (f: FoundVault[]) => Promise<VaultPos[]>; onClose: () => void; onDone: () => void }) {
  const [unwrap, setUnwrap] = useState(true);
  const [state, setState] = useState<{ before: VaultPos[]; wallet: WalletPos | null } | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [batch, setBatch] = useState<boolean | null>(null);
  const [prog, setProg] = useState<StepState[] | null>(null);
  const [running, setRunning] = useState(false);
  const [after, setAfter] = useState<VaultPos[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const keys = useMemo(agentKeys, []);
  const access = useCallback((p: VaultPos): AgentAccess => (keys.has(p.executor.toLowerCase()) ? 'key' : p.executor.toLowerCase() === account.toLowerCase() ? 'wallet' : null), [keys, account]);
  const [rt] = useState(rates); // pinned for this modal so a background refresh does not restart the read
  const tKey = targets.map(t => t.vault).join();
  const tRef = useRef(targets); tRef.current = targets;
  // Fresh, uncached reads (shared throttled client) right before anything is planned.
  const readFresh = useCallback(async () => {
    const pools = savedPools(net, account);
    const vs = await reread(tRef.current);
    const w = scope === 'all' ? await readWalletPositions(pub, account, { rates: rt, pools }) : null;
    return { before: vs.filter(v => v.owner.toLowerCase() === account.toLowerCase()), wallet: w };
  }, [tKey, pub, rt, net, account, scope]); // eslint-disable-line
  const readAt = useRef(0);
  useEffect(() => { let on = true; readFresh().then(s => { if (on) { readAt.current = Date.now(); setState(s); } }).catch(e => on && setErr(errText(e))); return () => { on = false; }; }, [readFresh]);
  useEffect(() => { if (state) setPlan(buildClosePlan({ account, vaults: state.before, wallet: state.wallet, access, unwrap })); }, [state, unwrap, access, account]);
  useEffect(() => {
    (async () => {
      try {
        const caps: any = await withDeadline((wallet as any).request({ method: 'wallet_getCapabilities', params: [account, [net.hex]] }), 4000, () => new Error('timeout'));
        const c = caps?.[net.hex] ?? caps?.[String(net.id)] ?? {};
        setBatch(['supported', 'ready'].includes(c?.atomic?.status) || c?.atomicBatch?.supported === true);
      } catch { setBatch(false); }
    })();
  }, [wallet, account, net]);

  const waitOk = async (hash: Hex) => {
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 90_000, pollingInterval: 500 });
    if (rc.status !== 'success') throw Object.assign(new Error('The transaction reverted on-chain.'), { hash });
    return hash;
  };
  const runner = useMemo(() => ({
    async send(s: Step): Promise<Hex> {
      if (s.signer === 'agent-key') {
        const v = state?.before.find(x => x.vault === s.vault); const key = v && keys.get(v.executor.toLowerCase());
        if (!key) throw new Error('The agent key is no longer in this browser.');
        const from = privateKeyToAccount(key).address;
        const gas = await pricedGas(pub, from, { to: s.to, data: s.data });
        return waitOk(await sendWithKey(net, key, { to: s.to, data: s.data, gas }, pub));
      }
      if (!(await need())) throw new Error('Connect the owner wallet first.');
      const gas = await pricedGas(pub, account, { to: s.to, data: s.data });
      const rc = await send(wallet, { to: s.to, data: s.data, gas });
      return rc.transactionHash;
    },
    sendBatch: batch ? async (ss: Step[]): Promise<Hex[]> => {
      if (!(await need())) throw new Error('Connect the owner wallet first.');
      // Simulate the first call (later ones depend on it); a revert stops here with nothing sent.
      if (ss[0]) await preflightGas(pub, account, { to: ss[0].to, data: ss[0].data });
      let id: any;
      try { id = await (wallet as any).request({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: net.hex, from: account, atomicRequired: true, calls: ss.map(s => ({ to: s.to, data: s.data, value: '0x0' })) }] }); }
      catch (e: any) { if (e?.code === 4200 || e?.code === -32601 || e?.code === 5700 || /not supported|unsupported|does not exist/i.test(String(e?.message))) throw Object.assign(new Error('batch unsupported'), { batchUnsupported: true }); throw e; }
      const bid = typeof id === 'string' ? id : id?.id;
      for (let i = 0; i < 180; i++) {
        const r: any = await (wallet as any).request({ method: 'wallet_getCallsStatus', params: [bid] }).catch(() => null);
        const st = r?.status;
        if (st === 200 || st === 'CONFIRMED' || st === 'confirmed') {
          const hs = (r.receipts ?? []).map((x: any) => x.transactionHash as Hex);
          if ((r.receipts ?? []).some((x: any) => x.status === '0x0' || x.status === 'reverted')) throw new Error('The batch reverted on-chain.');
          return hs;
        }
        if (typeof st === 'number' && st >= 400) throw new Error(`The wallet reports the batch failed (${st}).`);
        await new Promise(res => setTimeout(res, 1000));
      }
      throw new Error('The wallet did not confirm the batch in 3 minutes. Re-read before retrying.');
    } : undefined,
  }), [state, keys, pub, net, need, account, send, wallet, batch]);

  const go = async () => {
    if (!plan) return;
    setRunning(true); setErr(null);
    try {
      // Resume: wait for anything a previous, interrupted run already sent.
      const prev = JSON.parse(localStorage.getItem(PROGRESS(account)) || 'null');
      for (const x of prev?.steps ?? []) if (x.hash && x.status === 'sending') await pub.waitForTransactionReceipt({ hash: x.hash, timeout: 60_000 }).catch(() => null);
      // Re-read only if the preview is older than 30s (or this is a retry), so the modal shows exactly what is sent.
      let fresh = state!;
      if (prog || !readAt.current || Date.now() - readAt.current > 30_000) { fresh = await readFresh(); readAt.current = Date.now(); setState(fresh); }
      const pl = buildClosePlan({ account, vaults: fresh.before, wallet: fresh.wallet, access, unwrap }); setPlan(pl);
      const save = (s: StepState[]) => { setProg(s); localStorage.setItem(PROGRESS(account), JSON.stringify({ at: Date.now(), steps: s.map((x, i) => ({ ...x, label: pl.steps[i]?.label })) })); };
      const res = await runPlan(pl, runner, save);
      const ok = res.every(x => x.status === 'done');
      if (!ok) setErr(res.find(x => x.status === 'failed')?.error ?? 'Stopped.');
      const after = await readFresh(); readAt.current = Date.now(); setAfter(after.before);
      if (ok) { localStorage.removeItem(PROGRESS(account)); toast('Close finished. Balances re-read below.', 'ok'); }
      onDone();
    } catch (e) { setErr(errText(e)); } finally { setRunning(false); }
  };

  const doneList: Done[] = plan && prog ? plan.steps.map((s, i) => ({ step: s, st: prog[i] })).filter(x => x.st) : [];
  const finished = !!prog && prog.every(x => x.status === 'done');
  return (
    <Sheet open onClose={() => !running && onClose()} title={scope === 'all' ? 'Close all my positions' : `Close & withdraw all · ${short(scope)}`}>
      <div data-testid="close-modal" className="grid gap-3 text-sm">
        <p className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100">Alpha · unaudited contract · only deposit what you&apos;re happy to lose. Everything below goes to the vault owner, <b className="font-mono">{account}</b> (this wallet). Staked tokens arrive as tokens, not MON.</p>
        {!plan && !err && <p className="text-zinc-400">Reading fresh balances…</p>}
        {plan && <>
          <Switch on={unwrap} onChange={setUnwrap} disabled={running || !!prog} label="Unwrap WMON to MON" sub="Off: WMON is withdrawn as WMON." testid="unwrap-toggle" />
          <div data-testid="close-steps">
            <div className="mb-1 text-xs uppercase tracking-wider text-zinc-400">What will move</div>
            {!plan.steps.length && <p className="text-zinc-400">Nothing to move.</p>}
            <ol className="grid gap-2">
              {plan.steps.map((s, i) => { const st = prog?.[i]; return (
                <li key={s.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3" data-testid="close-step" data-status={st?.status ?? 'todo'}>
                  <div className="flex items-start gap-2"><span className="font-mono text-xs text-zinc-500">{i + 1}.</span><span className="min-w-0 flex-1 text-zinc-100">{s.label}</span><Pill tone={s.signer === 'agent-key' ? 'monad' : 'zinc'}>{s.signer === 'agent-key' ? 'agent key (no popup)' : s.signer === 'agent-wallet' ? 'wallet as agent' : 'wallet'}</Pill></div>
                  {s.vault && <div className="mt-1 text-[11px] text-zinc-500">Vault {short(s.vault)}</div>}
                  {s.moves.map((m, j) => <div key={j} className="mt-1 text-xs text-zinc-300">{m.what} → {m.to === 'vault' ? 'the vault (then swept to you)' : <span className="font-mono">{short(m.to)}{m.to.toLowerCase() === account.toLowerCase() ? ' (you)' : ''}</span>}</div>)}
                  {st && <div className={`mt-1 text-xs ${st.status === 'done' ? 'text-emerald-300' : st.status === 'failed' ? 'text-red-300' : 'text-zinc-400'}`}>{st.status === 'sending' ? 'Sending…' : st.status === 'done' ? 'Done' : st.status === 'failed' ? `Failed: ${st.error}` : 'Waiting'}{st.hash && <> · <a className="underline" href={`${net.exp}/tx/${st.hash}`} target="_blank" rel="noreferrer">tx ↗</a></>}</div>}
                </li>); })}
            </ol>
          </div>
          {plan.manual.length > 0 && <div data-testid="close-manual"><div className="mb-1 text-xs uppercase tracking-wider text-zinc-400">Not closable in one click</div>{plan.manual.map((m, i) => <p key={i} className="text-xs text-zinc-300">• <b>{m.what}</b>{m.vault ? ` (vault ${short(m.vault)})` : ''}: {m.why}</p>)}</div>}
          {plan.notes.map((n, i) => <p key={i} className="text-xs text-zinc-400">{n}</p>)}
          {plan.disabled.length > 0 && <div className="text-xs text-zinc-400">{plan.disabled.map(d => <p key={d.vault}>• {short(d.vault)}: {d.why}</p>)}</div>}
          <p className="text-xs text-zinc-400" data-testid="sig-count">{plan.walletSigs === 0 ? 'No wallet signature needed: the agent key in this browser signs.' : batch ? `Your wallet supports batched calls: consecutive wallet steps go out in one confirmation (${plan.walletSigs} calls).` : `${plan.walletSigs} wallet signature(s), one after another. These vaults have no multicall, so each owner call is its own transaction.`}{plan.steps.some(s => s.signer === 'agent-key') ? ' Agent-key steps are signed in this browser with no popup.' : ''} Empty vaults are skipped.</p>
          {!finished && <Btn kind="danger" data-testid="close-confirm" disabled={running || !plan.steps.length} onClick={go}>{running ? 'Working…' : prog ? 'Retry / resume' : `Confirm: move it all to ${short(account)}`}</Btn>}
        </>}
        {err && <p className="break-words rounded-2xl border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-100" data-testid="close-error">{err} Re-read and press Retry / resume: finished steps are not repeated.</p>}
        {after && <div data-testid="close-result" className="rounded-2xl border border-white/10 p-3">
          <div className="mb-1 text-xs uppercase tracking-wider text-zinc-400">After (fresh read)</div>
          {after.map(v => <p key={v.vault} className="text-xs text-zinc-200"><a className="font-mono text-violet-300" href={`${net.exp}/address/${v.vault}`} target="_blank" rel="noreferrer">{short(v.vault)}</a>: {isEmpty(v) ? 'empty (0 MON, no tokens)' : `${m4(v.native, 6)}${v.tokens.length ? ` + ${v.tokens.map(t => `${fmtUnits(t.amount, t.decimals)} ${t.sym}`).join(', ')}` : ''} still inside`}{v.paused ? ' · paused' : ''}</p>)}
          {doneList.filter(x => x.st.hash).map(x => <p key={x.step.id} className="text-xs"><a className="underline" href={`${net.exp}/tx/${x.st.hash}`} target="_blank" rel="noreferrer">{x.step.label} ↗</a></p>)}
        </div>}
      </div>
    </Sheet>
  );
}
