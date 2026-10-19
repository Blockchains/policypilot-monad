/**
 * Runs a Start-wizard plan step by step, saving progress after every step so a closed tab resumes where it stopped.
 * Every send goes through the caller's simulate-first senders (App.send for the wallet, sendWithKey for the agent key),
 * so a step that would revert is never sent. A new vault or pool found on-chain after an interrupted signature is
 * adopted instead of creating a second one.
 */
import { encodeFunctionData, formatEther, getAddress, keccak256, parseAbi, toHex, parseEther, parseEventLogs, type Address, type Hex, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { byId, keyNeeds, thirds, UNITS, type Strategy } from './journey';
import { addJournal, agentKey, ensurePos, positions, saveAgentKey, saveRun, updatePos, type JourneyPos, type Run, type RunStep } from './journeyStore';
import { DESK_FACTORY, DESK_KIND, deskFactoryAbi } from './desk';
import { clipDeployData, clipDepositData } from './clip';
import { spreadDeployData, spreadDepositData } from './spread';
import { aprMonAbi, PRIMARY_VAULT } from './monadefi';
import { buildAction, factoryAbi, unlimitedFactoryAbi, type Net } from './vault';

export type Receipt = { transactionHash: Hex; logs?: readonly any[]; status?: string };
export type Deps = {
  net: Net; pub: PublicClient; account: Address;
  /** Wallet send: simulate first, send, wait for a successful receipt (App.send). */
  wallet: (req: { to: Address; data?: Hex; value?: bigint; gas?: bigint }, onHash?: (h: Hex) => void) => Promise<Receipt>;
  /** Agent-key send: simulate first, sign with the key, wait for a successful receipt. */
  agent: (key: Hex, req: { to: Address; data?: Hex; value?: bigint }, onHash?: (h: Hex) => void) => Promise<Receipt>;
  onUpdate?: (r: Run) => void;
};

export function planSteps(s: Strategy, payees: { to: string; amount: string }[] = []): RunStep[] {
  const w = (id: string, label: string): RunStep => ({ id, label, who: 'wallet', status: 'todo' });
  const a = (id: string, label: string): RunStep => ({ id, label, who: 'agent', status: 'todo' });
  switch (s.kind) {
    case 'aprmon': return [w('deposit', 'Stake your MON with aPriori (you sign)')];
    case 'stake3': return [w('create', 'Create your vault with your MON (you sign)'), w('fund', 'Send the agent key its gas (you sign)'), a('kintsu', 'Agent stakes ⅓ with Kintsu'), a('apriori', 'Agent stakes ⅓ with aPriori'), a('magma', 'Agent stakes ⅓ with Magma')];
    case 'clip': case 'spread': return [w('open', `Open your ${s.kind === 'clip' ? 'fast-trading' : 'arbitrage'} pool (you sign)`), w('deposit', 'Deposit your MON into the pool (you sign)'), w('fund', 'Send the agent key its gas (you sign)'), a('start', 'Start the agent in this browser')];
    case 'pay': return [w('create', 'Create your payments vault with your MON (you sign)'), w('fund', 'Send the agent key its gas (you sign)'), ...payees.map((p, i) => a(`pay-${i}`, `Agent pays ${p.amount} MON to ${p.to.slice(0, 6)}…${p.to.slice(-4)}`))];
  }
}

export function newRun(net: number, account: string, s: Strategy, amount: string, agentGas: bigint, payees?: { to: string; amount: string }[]): Run {
  let agent: Address | undefined;
  if (s.agentUnits > 0n || s.kind === 'pay') {
    const key = generatePrivateKey(); agent = privateKeyToAccount(key).address; saveAgentKey(agent, key); // saved before any MON moves to it
  }
  return { id: `${Date.now().toString(36)}`, net, account: account.toLowerCase(), strategy: s.id, amount, agentGas: agentGas.toString(), agent, payees, steps: planSteps(s, payees), startedAt: Date.now() };
}

const sameSet = (a: Address[]) => new Set(a.map(x => x.toLowerCase()));

/** Run (or resume) every step that is not done. Throws the first failure after saving it on the run. */
export async function runJourney(run0: Run, d: Deps): Promise<Run> {
  let run: Run = { ...run0, steps: run0.steps.map(s => ({ ...s })) };
  const s = byId(run.strategy)!;
  const amount = parseEther(run.amount);
  const put = (r: Run) => { run = r; saveRun(r); d.onUpdate?.(r); };
  const set = (id: string, patch: Partial<RunStep>) => put({ ...run, steps: run.steps.map(x => (x.id === id ? { ...x, ...patch } : x)) });
  const key = agentKey(run.agent);
  if (run.agent && !key) throw new Error('The agent key for this setup is not in this browser any more. Start again; nothing was lost (check My money).');
  const position = (address: Address): JourneyPos => ({ id: address.toLowerCase(), net: run.net, account: run.account, strategy: s.id, address, agent: run.agent, createdAt: Date.now(), loop: s.kind === 'clip' || s.kind === 'spread', payees: run.payees, journal: [] });
  const desk = DESK_FACTORY[d.net.id];

  const listMine = async (): Promise<Address[]> => {
    if (s.kind === 'clip' || s.kind === 'spread') return desk ? [...await d.pub.readContract({ address: desk, abi: deskFactoryAbi, functionName: 'vaultsOf', args: [d.account] })] : [];
    return [...await d.pub.readContract({ address: d.net.factory, abi: factoryAbi, functionName: 'vaultsOf', args: [d.account] }) as Address[]];
  };

  for (const st of run.steps) {
    if (st.status === 'done') continue;
    // A step interrupted after its hash was known: wait for that transaction instead of sending again.
    if (st.hash && st.status === 'sending') {
      const rc = await d.pub.waitForTransactionReceipt({ hash: st.hash, timeout: 90_000 }).catch(() => null);
      if (rc?.status === 'success') { await after(st.id, { transactionHash: st.hash, logs: rc.logs }); set(st.id, { status: 'done' }); continue; }
    }
    set(st.id, { status: 'sending', error: undefined });
    try {
      const rc = await doStep(st.id);
      if (rc) { set(st.id, { hash: rc.transactionHash }); await after(st.id, rc); if (st.who === 'agent' && run.address) addJournal(run.net, run.account, run.address.toLowerCase(), { h: rc.transactionHash, dir: 'act', label: st.label, ...(st.id.startsWith('pay-') ? { amt: parseEther(run.payees![Number(st.id.slice(4))].amount).toString() } : {}) }); }
      set(st.id, { status: 'done' });
    } catch (e: any) {
      set(st.id, { status: 'failed', error: String(e?.shortMessage ?? e?.message ?? e).split('\n')[0].slice(0, 240), hash: e?.hash ?? st.hash });
      throw e;
    }
  }
  put({ ...run, finished: true });
  return run;

  async function doStep(id: string): Promise<Receipt | null> {
    // The hash is saved the moment the wallet / key returns it, so a closed tab resumes by waiting for it, never by resending.
    const mark = (h: Hex) => set(id, { hash: h });
    const W = (req: Parameters<Deps['wallet']>[0]) => d.wallet(req, mark);
    const A = (k: Hex, req: Parameters<Deps['agent']>[1]) => d.agent(k, req, mark);
    const done0 = await already(id);
    if (done0) return null;
    const vault = run.address;
    if (id === 'deposit' && s.kind === 'aprmon') {
      const pre = await d.pub.readContract({ address: PRIMARY_VAULT.address, abi: aprMonAbi, functionName: 'balanceOf', args: [d.account] });
      put({ ...run, steps: run.steps.map(x => (x.id === id ? { ...x, pre: pre.toString() } : x)) });
      return W({ to: PRIMARY_VAULT.address, data: encodeFunctionData({ abi: aprMonAbi, functionName: 'deposit', args: [amount, d.account] }), value: amount });
    }
    if (id === 'create' || id === 'open') {
      // Adopt a vault created by an earlier, interrupted signature.
      const known = (run as Run & { before?: string[] }).before;
      if (known) { const now = await listMine(); const fresh = now.filter(a => !sameSet(known as Address[]).has(a.toLowerCase())); if (fresh.length) { adopt(fresh[fresh.length - 1]); return null; } }
      // Progress lost (tab killed before it was saved): reuse an empty pool of the same kind this wallet opened earlier.
      if (!known && id === 'open') { const o = await orphanPool(); if (o) { adopt(o); return null; } }
      put({ ...run, ...{ before: (await listMine()).map(a => a.toLowerCase()) } } as Run);
      if (id === 'create') return W({ to: d.net.factory, data: encodeFunctionData({ abi: unlimitedFactoryAbi, functionName: 'createVault', args: [run.agent!] }), value: amount });
      if (!desk) throw new Error('Pools open on Monad mainnet only.');
      const init = s.kind === 'clip' ? clipDeployData(d.account) : spreadDeployData(d.account, s.floorBps ?? 0);
      return W({ to: desk, data: encodeFunctionData({ abi: deskFactoryAbi, functionName: 'create', args: [DESK_KIND[s.kind as 'clip' | 'spread'], init] }) });
    }
    if (id === 'deposit') return W({ to: vault!, data: s.kind === 'clip' ? clipDepositData() : spreadDepositData(), value: amount });
    if (id === 'fund') {
      const want = BigInt(run.agentGas); const has = await d.pub.getBalance({ address: run.agent! });
      if (has >= want) return null; // already funded (resume)
      return W({ to: run.agent!, value: want - has });
    }
    if (id === 'start') return null; // the loop picks the position up (loop: true)
    if (st0(id).who === 'agent') { await keyFunded(); await topUpFor(id); }
    if (['kintsu', 'apriori', 'magma'].includes(id)) {
      const part = thirds(amount)[['kintsu', 'apriori', 'magma'].indexOf(id)];
      const a = await buildAction(d.pub, id, vault!, d.account, run.agent!, part, 0n);
      return A(key!, { ...a.req, value: 0n });
    }
    if (id.startsWith('pay-')) {
      const p = run.payees![Number(id.slice(4))];
      const a = await buildAction(d.pub, 'payto', vault!, d.account, run.agent!, parseEther(p.amount), 0n, { to: getAddress(p.to) });
      return A(key!, { ...a.req, value: 0n });
    }
    throw new Error(`Unknown step ${id}`);
  }

  async function orphanPool(): Promise<Address | null> {
    const taken = new Set(positions(run.net, run.account).map(x => x.address.toLowerCase()));
    const probe = parseAbi(['function totalSupply() view returns (uint256)', 'function treasury() view returns (address)', 'function minProfitBps() view returns (uint256)', 'function UNI_THIN_POOL() view returns (address)']);
    for (const a of (await listMine()).filter(x => !taken.has(x.toLowerCase())).reverse().slice(0, 5)) {
      try {
        const [ts, tr, bal, kindOk] = await Promise.all([
          d.pub.readContract({ address: a, abi: probe, functionName: 'totalSupply' }),
          d.pub.readContract({ address: a, abi: probe, functionName: 'treasury' }),
          d.pub.getBalance({ address: a }),
          s.kind === 'clip'
            ? d.pub.readContract({ address: a, abi: probe, functionName: 'UNI_THIN_POOL' }).then(() => true)
            : d.pub.readContract({ address: a, abi: probe, functionName: 'minProfitBps' }).then(f => Number(f) === (s.floorBps ?? 0)),
        ]);
        if (ts === 0n && bal === 0n && kindOk && getAddress(tr) === getAddress(d.account)) return getAddress(a);
      } catch { /* not this kind */ }
    }
    return null;
  }
  /** On-chain check that a step already happened (its record was lost with a closed tab), so it is not sent twice. */
  async function already(id: string): Promise<boolean> {
    const st = st0(id);
    if (st.who === 'agent' && run.agent) {
      // The key is used only by this setup, in step order: agent step k is done once its nonce passed k.
      const k = run.steps.filter(x => x.who === 'agent' && x.id !== 'start').findIndex(x => x.id === id);
      if (k < 0) return false;
      const n = await d.pub.getTransactionCount({ address: run.agent, blockTag: 'latest' });
      return n > k;
    }
    if (id === 'create' && run.agent && !run.address) {
      const mine = await listMine();
      for (const v of mine.slice(-5).reverse()) {
        const ex = await d.pub.readContract({ address: v, abi: parseAbi(['function executor() view returns (address)']), functionName: 'executor' }).catch(() => null);
        if (ex && getAddress(ex) === getAddress(run.agent)) { adopt(getAddress(v)); addJournal(run.net, run.account, v.toLowerCase(), { h: synth(id), dir: 'in', amt: amount.toString(), label: 'Deposit (found on-chain on resume)' }); return true; }
      }
      return false;
    }
    if (id === 'deposit' && run.address && s.kind !== 'aprmon') {
      const assets = await d.pub.readContract({ address: run.address, abi: parseAbi(['function assetsOf(address) view returns (uint256)']), functionName: 'assetsOf', args: [d.account] }).catch(() => 0n);
      if (assets > 0n) { addJournal(run.net, run.account, run.address.toLowerCase(), { h: synth(id), dir: 'in', amt: amount.toString(), label: 'Deposit (found on-chain on resume)' }); return true; }
      return false;
    }
    if (id === 'deposit' && s.kind === 'aprmon' && (st as any).pre != null) {
      const now = await d.pub.readContract({ address: PRIMARY_VAULT.address, abi: aprMonAbi, functionName: 'balanceOf', args: [d.account] });
      if (now > BigInt((st as any).pre)) { ensurePos({ ...position(PRIMARY_VAULT.address), id: `apr:${run.account}`, agent: undefined, loop: false }); updatePos(run.net, run.account, `apr:${run.account}`, x => ({ ...x, shares: undefined })); addJournal(run.net, run.account, `apr:${run.account}`, { h: synth(id), dir: 'in', amt: amount.toString(), label: 'Deposit (found on-chain on resume)' }); return true; }
    }
    return false;
  }
  function synth(id: string): Hex { return keccak256(toHex(`resumed:${run.id}:${id}`)); }
  function st0(id: string) { return run.steps.find(x => x.id === id)!; }
  /** Public RPC nodes can lag a block or two: wait until the agent key's gas is visible before it signs. */
  async function keyFunded() {
    for (let i = 0; i < 20; i++) { const b = await d.pub.getBalance({ address: run.agent! }).catch(() => 0n); if (b > 0n) return; await new Promise(r => setTimeout(r, 1000)); }
  }

  /** If the key cannot cover this step's gas limit at the fee cap (gas used higher than planned), the wallet tops up the gap first. */
  async function topUpFor(id: string) {
    const units = id === 'kintsu' ? UNITS.stakeKintsu : id === 'apriori' ? UNITS.stakeApriori : id === 'magma' ? UNITS.stakeMagma : UNITS.pay;
    const need = keyNeeds(units);
    const b = await d.pub.getBalance({ address: run.agent! }).catch(() => need);
    if (b >= need) return;
    const rc = await d.wallet({ to: run.agent!, value: need - b + 10n ** 15n });
    run = { ...run, agentGas: (BigInt(run.agentGas) + need - b).toString() }; saveRun(run);
    await d.pub.waitForTransactionReceipt({ hash: rc.transactionHash }).catch(() => null); await keyFunded();
  }

  function adopt(address: Address) {
    put({ ...run, address });
    ensurePos(position(address));
  }

  async function after(id: string, rc: Receipt) {
    if (id === 'create' || id === 'open') {
      let addr: Address | null = null;
      if (id === 'open') { try { const ev = parseEventLogs({ abi: deskFactoryAbi, logs: (rc.logs ?? []) as any, eventName: 'DeskCreated' })[0]; if (ev) addr = getAddress(ev.args.vault); } catch { /* read below */ } }
      if (!addr) { const list = await listMine(); addr = list.length ? getAddress(list[list.length - 1]) : null; }
      if (!addr) throw new Error(`Created, but the address could not be read yet. ${rc.transactionHash}`);
      adopt(addr);
      if (id === 'create') addJournal(run.net, run.account, addr.toLowerCase(), { h: rc.transactionHash, dir: 'in', amt: amount.toString() });
    }
    if (id === 'deposit') {
      if (s.kind === 'aprmon') {
        const addr = PRIMARY_VAULT.address;
        if (!run.address) { put({ ...run, address: addr }); }
        ensurePos({ ...position(addr), id: `apr:${run.account}`, agent: undefined, loop: false });
        addJournal(run.net, run.account, `apr:${run.account}`, { h: rc.transactionHash, dir: 'in', amt: amount.toString() });
        // Shares this deposit minted (its Deposit event); a position whose shares are not known yet derives them on read.
        try {
          const minted = parseEventLogs({ abi: aprMonAbi, logs: (rc.logs ?? []) as any, eventName: 'Deposit' }).filter(e => getAddress((e.args as any).owner) === getAddress(d.account)).reduce((a, e) => a + ((e.args as any).shares as bigint), 0n);
          if (minted > 0n) updatePos(run.net, run.account, `apr:${run.account}`, x => (x.shares == null ? x : { ...x, shares: (BigInt(x.shares) + minted).toString() }));
        } catch { /* derived on read */ }
      } else addJournal(run.net, run.account, run.address!.toLowerCase(), { h: rc.transactionHash, dir: 'in', amt: amount.toString() });
    }
  }
}

export const describeAmount = (wei: bigint) => `${Number(formatEther(wei)).toLocaleString('en-GB', { maximumFractionDigits: 4 })} MON`;
