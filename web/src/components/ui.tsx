'use client';
import { useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { haptic } from '@/lib/wallets';

/** Green when included, amber when the wallet submitted and the block is still coming, red when it failed. */
export const receiptClass = (line: { ok: boolean; pending?: boolean }) => line.pending
  ? 'border-amber-500/40 bg-amber-500/10 text-amber-100'
  : line.ok
    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100'
    : 'border-red-500/40 bg-red-500/10 text-red-100';
export function Card({ children, className = '', ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={`min-w-0 rounded-3xl border border-white/10 bg-white/[0.045] p-4 shadow-[0_0_60px_-30px_#836EF9] backdrop-blur-xl sm:p-5 ${className}`}>{children}</div>;
}
export function Btn({ children, kind = 'ghost', className = '', ...rest }: { children: ReactNode; kind?: 'pri' | 'ghost' | 'danger' | 'soft' } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const k = { pri: 'bg-monad text-white shadow-[0_8px_30px_-8px_#836EF9] hover:brightness-110', ghost: 'border border-white/15 bg-white/[0.03] text-zinc-100 hover:border-monad/60', danger: 'border border-red-500/40 bg-red-500/10 text-red-200 hover:bg-red-500/20', soft: 'bg-monad/15 text-violet-200 hover:bg-monad/25' }[kind];
  return <button {...rest} onClick={e => { haptic(); rest.onClick?.(e); }} className={`inline-flex min-h-11 w-auto min-w-0 max-w-full select-none items-center justify-center gap-2 whitespace-normal break-words rounded-2xl px-4 text-center text-sm font-medium transition active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 ${k} ${className}`}>{children}</button>;
}
export function Switch({ on, onChange, label, sub, disabled, testid }: { on: boolean; onChange: (v: boolean) => void; label: ReactNode; sub?: ReactNode; disabled?: boolean; testid?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled} data-testid={testid} onClick={() => { haptic(10); onChange(!on); }}
      className="flex min-h-14 w-full min-w-0 items-center gap-3 rounded-2xl px-3 py-2 text-left transition hover:bg-white/[0.04] active:scale-[0.99] disabled:opacity-50">
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-zinc-100">{label}</span>{sub && <span className="block text-xs text-zinc-400">{sub}</span>}</span>
      <span className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${on ? 'bg-monad shadow-[0_0_16px_#836EF9]' : 'bg-zinc-700'}`}>
        <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all duration-200 ${on ? 'left-[22px]' : 'left-0.5'}`} />
      </span>
    </button>
  );
}
export function Slider({ value, min, max, step, onChange, testid, label }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; testid?: string; label: string }) {
  return <input aria-label={label} data-testid={testid} type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} className="h-11 w-full cursor-pointer accent-[#836EF9]" />;
}
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode }) {
  useEffect(() => { if (!open) return; const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center" onClick={e => e.target === e.currentTarget && onClose()} data-testid="sheet">
      <div className="max-h-[88dvh] w-full max-w-lg animate-[sheet_.22s_ease-out] overflow-y-auto overscroll-contain rounded-t-3xl border border-white/10 bg-zinc-950 p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:rounded-3xl">
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-white/20 sm:hidden" />
        <div className="mb-4 flex items-center gap-3"><h2 className="min-w-0 flex-1 truncate text-lg font-semibold text-zinc-50">{title}</h2><button aria-label="Close" onClick={onClose} className="grid h-11 w-11 shrink-0 place-items-center rounded-full hover:bg-white/10"><X className="h-5 w-5" /></button></div>
        {children}
      </div>
    </div>
  );
}
export type Toast = { id: number; text: ReactNode; kind: 'ok' | 'bad' | 'info' };
export function useToasts() {
  const [list, setList] = useState<Toast[]>([]);
  const push = (text: ReactNode, kind: Toast['kind'] = 'info') => { const id = Date.now() + Math.random(); setList(l => [...l, { id, text, kind }]); setTimeout(() => setList(l => l.filter(t => t.id !== id)), 6000); haptic(kind === 'bad' ? [20, 40, 20] as any : 12); };
  const view = (
    <div className="pointer-events-none fixed inset-x-0 top-[calc(4.5rem+env(safe-area-inset-top))] z-[60] flex flex-col items-center gap-2 px-3">
      {list.map(t => <div key={t.id} role="status" className={`pointer-events-auto w-full max-w-md animate-[pop_.2s_ease-out] break-words rounded-2xl border px-4 py-3 text-sm shadow-xl backdrop-blur-xl ${t.kind === 'ok' ? 'border-emerald-500/40 bg-emerald-950/80 text-emerald-100' : t.kind === 'bad' ? 'border-red-500/40 bg-red-950/80 text-red-100' : 'border-white/15 bg-zinc-900/90 text-zinc-100'}`}>{t.text}</div>)}
    </div>
  );
  return { push, view };
}
export const Pill = ({ children, tone = 'zinc' }: { children: ReactNode; tone?: 'ok' | 'bad' | 'warn' | 'zinc' | 'monad' }) => (
  <span className={`inline-flex min-w-0 max-w-full items-center gap-1 truncate rounded-full px-2.5 py-1 text-[11px] font-medium ${{ ok: 'bg-emerald-500/15 text-emerald-300', bad: 'bg-red-500/15 text-red-300', warn: 'bg-amber-500/15 text-amber-300', zinc: 'bg-white/10 text-zinc-300', monad: 'bg-monad/20 text-violet-200' }[tone]}`}>{children}</span>
);

/** Amount fields: start empty with a placeholder (never a real 0 the user has to delete), keep the text as typed
 *  (a string), parse on submit. Decimal keypad, no spinner arrows, 16px+ text so iOS does not zoom. */
export const AMOUNT_INPUT = { type: 'text', inputMode: 'decimal', pattern: '[0-9]*[.,]?[0-9]*', autoComplete: 'off', autoCorrect: 'off', spellCheck: false, enterKeyHint: 'done' } as const;
/** Keep digits and one decimal point; a comma counts as the decimal point. */
export const cleanAmount = (s: string) => s.replace(/,/g, '.').replace(/[^0-9.]/g, '').replace(/^(\d*\.\d*)\..*$/, '$1');
/** True when the field is still empty (show a friendly hint, not an error). */
export const blankAmount = (s: string | null | undefined) => !String(s ?? '').trim();
/** Text for a value the app fills in (Max, presets): never '0', so the field stays empty instead. */
export const fillAmount = (s: string) => (Number(s) > 0 ? s : '');
export function AmountHint({ children, testid = 'amount-hint' }: { children?: ReactNode; testid?: string }) {
  return <p className="text-xs text-zinc-400" data-testid={testid}>{children ?? 'Type an amount to continue.'}</p>;
}
/** A numeric setting with a real default: the text stays as typed, so clearing it leaves the field empty (no '0'
 *  snapping back). A valid number applies as you type; an empty field keeps the last value and shows it again on blur.
 *  A value of 0 shows as an empty field with a '0' placeholder. */
export function NumText({ v, set, onEmpty, ...rest }: { v: number; set: (n: number) => void; onEmpty?: (empty: boolean) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'>) {
  const show = (n: number) => (Number.isFinite(n) && n ? String(n) : '');
  const [txt, setTxt] = useState(show(v)); const focused = useRef(false);
  useEffect(() => { if (!focused.current) setTxt(show(v)); }, [v]);
  return <input {...AMOUNT_INPUT} placeholder={show(v) || '0'} {...rest} value={txt}
    onFocus={e => { focused.current = true; rest.onFocus?.(e); }}
    onBlur={e => { focused.current = false; setTxt(show(v)); onEmpty?.(false); rest.onBlur?.(e); }}
    onChange={e => { const t = cleanAmount(e.target.value); setTxt(t); onEmpty?.(t === ''); const n = Number(t); if (t !== '' && Number.isFinite(n) && n >= 0) set(n); }} />;
}
