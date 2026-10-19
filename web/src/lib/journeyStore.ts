/**
 * What the Start wizard created, on this device: positions, run progress (for resume) and agent-loop switches.
 * Agent keys use the same `pp.agentkey.<address>` entries as the rest of the app (so Positions/close-all sees them).
 * Nothing secret is ever logged; keys never leave localStorage.
 */
import type { Address, Hex } from 'viem';
import type { StrategyId } from './journey';

/** amt: MON moved, read on-chain (the deposit tx value, or the drop in the position's on-chain value for a withdrawal). */
export type JournalEntry = { h: Hex; dir: 'in' | 'out' | 'act'; at: number; amt?: string; label?: string };
/** Entries whose label ends in "on resume)" were found on-chain after a lost record; their h is not a tx hash. */
export const isSynthetic = (e: JournalEntry) => /on resume\)$/.test(e.label ?? '');
export type JourneyPos = {
  id: string; net: number; account: string; strategy: StrategyId;
  /** The vault / pool address, or the aprMON contract for Earn · Low. */
  address: Address; agent?: Address; createdAt: number;
  loop?: boolean; payees?: { to: string; amount: string }[];
  journal: JournalEntry[];
  /** Earn · Low: aprMON shares this position holds (from its Deposit / RedeemRequest events), and its own queued request ids. */
  shares?: string; reqIds?: string[];
};
export type StepStatus = 'todo' | 'sending' | 'done' | 'failed';
export type RunStep = { id: string; label: string; who: 'wallet' | 'agent'; status: StepStatus; hash?: Hex; error?: string; pre?: string };
export type Run = {
  id: string; net: number; account: string; strategy: StrategyId; amount: string; agentGas: string;
  agent?: Address; address?: Address; payees?: { to: string; amount: string }[];
  steps: RunStep[]; startedAt: number; finished?: boolean;
};

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const mem = new Map<string, string>();
const fallback: Store = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v), removeItem: k => void mem.delete(k) };
let store: Store | null = null;
const S = (): Store => { if (store) return store; try { if (typeof localStorage !== 'undefined') return (store = localStorage); } catch { /* private mode */ } return fallback; };
export const useStore = (s: Store) => { store = s; };

const posKey = (net: number, account: string) => `pp.journey.pos.${net}.${account.toLowerCase()}`;
const runKey = (net: number, account: string) => `pp.journey.run.${net}.${account.toLowerCase()}`;
const read = <T>(k: string, d: T): T => { try { const v = S().getItem(k); return v ? JSON.parse(v) as T : d; } catch { return d; } };
const write = (k: string, v: unknown) => { try { S().setItem(k, JSON.stringify(v)); } catch { /* full */ } };

export const positions = (net: number, account: string | null): JourneyPos[] => (account ? read<JourneyPos[]>(posKey(net, account), []) : []);
export function savePos(p: JourneyPos) {
  const all = positions(p.net, p.account).filter(x => x.id !== p.id);
  write(posKey(p.net, p.account), [p, ...all]);
  emit();
}
/** Add a position, keeping the journal (and loop switch) of one that is already there. */
export function ensurePos(p: JourneyPos) {
  const old = positions(p.net, p.account).find(x => x.id === p.id);
  savePos(old ? { ...p, journal: old.journal, loop: old.loop ?? p.loop, createdAt: old.createdAt } : p);
}
export function updatePos(net: number, account: string, id: string, f: (p: JourneyPos) => JourneyPos) {
  const all = positions(net, account); const i = all.findIndex(x => x.id === id); if (i < 0) return;
  all[i] = f(all[i]); write(posKey(net, account), all); emit();
}
export const addJournal = (net: number, account: string, id: string, e: Omit<JournalEntry, 'at'>) =>
  updatePos(net, account, id, p => (p.journal.some(x => x.h === e.h) ? p : { ...p, journal: [...p.journal, { ...e, at: Date.now() }] }));

export const currentRun = (net: number, account: string | null): Run | null => (account ? read<Run | null>(runKey(net, account), null) : null);
export const saveRun = (r: Run) => { write(runKey(r.net, r.account), r); emit(); };
export const clearRun = (net: number, account: string) => { try { S().removeItem(runKey(net, account)); } catch { /* */ } emit(); };

export const agentKey = (a?: string | null): Hex | null => { if (!a) return null; try { const v = S().getItem(`pp.agentkey.${a.toLowerCase()}`); return v && /^0x[0-9a-fA-F]{64}$/.test(v) ? v as Hex : null; } catch { return null; } };
export const saveAgentKey = (a: string, k: Hex) => { try { S().setItem(`pp.agentkey.${a.toLowerCase()}`, k); } catch { /* */ } };

// Tiny change feed so My money / Start re-render when a run or the loop updates the store.
const subs = new Set<() => void>();
export const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const emit = () => subs.forEach(f => { try { f(); } catch { /* */ } });
