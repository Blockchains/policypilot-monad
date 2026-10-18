/** Passkey feature flag only (tiny, no crypto imports). See passkey.ts and docs/monadefi.md. */
export const PASSKEY_FLAG_ENV = 'NEXT_PUBLIC_MONADEFI_PASSKEY';
export const PASSKEY_FLAG_STORAGE = 'md.passkey.optin';

/** Build-time flag OR a per-device runtime opt-in (?passkey=1 to turn on, ?passkey=0 to turn off). */
export function passkeyEnabled(env: string | undefined = process.env.NEXT_PUBLIC_MONADEFI_PASSKEY): boolean {
  if (typeof window === 'undefined') return env === '1' || env === 'true';
  try {
    const q = new URLSearchParams(window.location.search).get('passkey');
    if (q === '1' || q === 'true') localStorage.setItem(PASSKEY_FLAG_STORAGE, '1');
    if (q === '0' || q === 'false') localStorage.setItem(PASSKEY_FLAG_STORAGE, '0');
    const local = localStorage.getItem(PASSKEY_FLAG_STORAGE);
    if (local === '0') return false;
    if (local === '1') return true;
  } catch { /* storage blocked */ }
  return env === '1' || env === 'true';
}

