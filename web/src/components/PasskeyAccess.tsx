'use client';
/** MonaDefi passkey accounts (Mera). Rendered only when the passkey flag is on; see lib/passkeyFlag.ts and docs/monadefi.md. */
import { useEffect, useState } from 'react';
import { KeyRound, Lock } from 'lucide-react';
import { Btn, Pill } from './ui';
import { chainOf, type Net } from '@/lib/vault';
import type { Discovered } from '@/lib/wallets';
import { passkeyEnabled } from '@/lib/passkeyFlag';

type Active = { address: string; lock: () => void } | null;
let active: Active = null;
const listeners = new Set<() => void>();
const setActive = (a: Active) => { active = a; listeners.forEach(f => f()); };

export function usePasskeyFlag() {
  const [on, setOn] = useState(false);
  useEffect(() => { setOn(passkeyEnabled()); }, []);
  return on;
}

/** Shown on the dashboard while a passkey session is unlocked in this tab. */
export function PasskeyBadge() {
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick(n => n + 1); listeners.add(f); return () => { listeners.delete(f); }; }, []);
  if (!active) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-violet-400/30 bg-violet-500/10 px-3 py-2 text-xs text-violet-100" data-testid="md-passkey-active">
      <KeyRound className="h-4 w-4" /><span className="min-w-0 flex-1">Passkey account (experimental). Its signing key is held in this tab&apos;s memory only and every transaction asks you first. Locking or closing the tab clears it.</span>
      <button className="inline-flex min-h-9 items-center gap-1 rounded-xl border border-white/15 px-3" data-testid="md-passkey-lock" onClick={() => { active?.lock(); setActive(null); localStorage.removeItem('pp.wallet'); location.reload(); }}><Lock className="h-3 w-3" />Lock</button>
    </div>
  );
}

export function PasskeyAccess({ net, connect, toast }: { net: Net; connect?: (d: Discovered) => Promise<boolean>; toast: (m: React.ReactNode, k?: 'ok' | 'bad' | 'info') => void }) {
  const on = usePasskeyFlag();
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState<'' | 'create' | 'signin'>('');
  const [known, setKnown] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  useEffect(() => {
    if (!on) return;
    setSupported(typeof window !== 'undefined' && !!window.PublicKeyCredential && window.isSecureContext);
    import('@/lib/passkey').then(m => setKnown(m.loadCredential()?.address ?? null)).catch(() => {});
  }, [on]);

  if (!on || !connect) {
    return <Btn kind="ghost" data-testid="md-passkey" disabled title="Passkey accounts coming soon"><KeyRound className="h-4 w-4" />Create account with a passkey · Passkey accounts coming soon</Btn>;
  }

  const go = async (kind: 'create' | 'signin') => {
    setBusy(kind);
    try {
      const m = await import('@/lib/passkey');
      const { session, address } = kind === 'create' ? await m.createPasskeyAccount() : await m.signInWithPasskey();
      const pk = m.passkeyProvider({ session, chain: chainOf(net) as any, rpc: net.rpc, approve: m.domApprover, explorer: net.exp });
      const ok = await connect({ info: { uuid: 'monadefi-passkey', name: 'Passkey account', icon: '', rdns: m.PASSKEY_RDNS }, provider: pk.provider as any });
      if (!ok) { pk.lock(); return; }
      localStorage.removeItem('pp.wallet'); // never auto-reconnect: unlocking always needs the passkey
      setActive({ address, lock: pk.lock });
      toast(kind === 'create' ? 'Passkey account created. It holds no funds yet and nothing can move without your approval.' : 'Signed in with your passkey.', 'ok');
    } catch (e) {
      const m = await import('@/lib/passkey');
      toast(m.meraError(e), 'bad');
    } finally { setBusy(''); }
  };

  return (
    <div className="space-y-2 sm:col-span-2 rounded-2xl border border-white/10 bg-black/20 p-3" data-testid="md-passkey-panel">
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-zinc-100"><KeyRound className="h-4 w-4" />Passkey account <Pill tone="warn">Experimental · opt-in</Pill></p>
      <ul className="list-disc space-y-1 pl-5 text-xs text-zinc-400" data-testid="md-passkey-explain">
        <li>How it works: your device creates a passkey for <b>{typeof location !== 'undefined' ? location.hostname : 'this site'}</b>. Mera (free, open-source, by Category Labs) turns the passkey&apos;s secret PRF output into a normal Monad wallet <b>private key inside this browser</b>. The key is never stored or sent anywhere, it lives only in this tab&apos;s memory while unlocked, and MonaDefi never sees it leave the page.</li>
        <li>Creating an account is not permission to move funds. It starts empty. Every deployment, withdrawal or signature opens an approval screen and nothing is sent unless you press Approve.</li>
        <li>Access: sign in again on this site with the same passkey to get the same address. The passkey belongs to this domain: the same passkey on a different domain gives a different, empty account.</li>
        <li>Recovery: the account is only as recoverable as the passkey. If your passkey provider syncs it (iCloud Keychain, Google Password Manager, 1Password) you can recover it on a new device; if you delete the passkey or it was device-only, the funds in this account are lost. Recovery-phrase export is not available yet, so keep only small amounts here.</li>
        <li>Your passkey provider must support WebAuthn PRF. Existing wallets keep working exactly as before.</li>
      </ul>
      {!supported && <p className="text-xs text-amber-200">This browser can&apos;t use passkeys here (needs WebAuthn on a secure https page).</p>}
      <label className="flex min-h-11 items-start gap-2 text-xs text-zinc-300"><input type="checkbox" className="mt-1" data-testid="md-passkey-ack" checked={ack} onChange={e => setAck(e.target.checked)} />I understand a private key will be created in this browser from my passkey, that this is an unaudited alpha, and that losing the passkey means losing this account.</label>
      <div className="grid gap-2 sm:grid-cols-2">
        <Btn kind="ghost" data-testid="md-passkey" disabled={!ack || !!busy || !supported} onClick={() => go('create')}><KeyRound className="h-4 w-4" />{busy === 'create' ? 'Waiting for your passkey…' : 'Create account with a passkey'}</Btn>
        <Btn kind="ghost" data-testid="md-passkey-signin" disabled={!ack || !!busy || !supported} onClick={() => go('signin')}>{busy === 'signin' ? 'Waiting for your passkey…' : known ? `Sign in with passkey (${known.slice(0, 6)}…${known.slice(-4)})` : 'Sign in with an existing passkey'}</Btn>
      </div>
      <p className="text-[11px] text-zinc-500">Turn this off on this device with <code>?passkey=0</code>.</p>
    </div>
  );
}
