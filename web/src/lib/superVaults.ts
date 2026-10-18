import type { Address } from 'viem';
import { buildCreate } from './vault';

/** A playbook step the agent runs against the vault. `amount` in MON (string) or 'wmon-all' / 'each-payee'. */
export type PlaybookStep = { kind: string; amount: string; label: string };
export type SuperVault = {
  id: 'yield' | 'trader' | 'payments';
  name: string; emoji: string; tagline: string; value: string[];
  services: string[]; deposit: number; payees?: boolean;
  playbook: PlaybookStep[];
};

/** Curated, one-click vault templates. Each is created (+ deposited) in ONE transaction with your wallet as the agent,
 *  so the playbook below runs for real from the browser. v4 vaults have NO spending limits and NO allowlists: the agent
 *  can pay anyone and call any contract, and can move all of the vault's funds. `services` only says what the playbook uses.
 *  `deposit` is a suggestion; you can deposit any amount. */
export const SUPER_VAULTS: SuperVault[] = [
  { id: 'yield', name: 'Yield Super Vault', emoji: '🥩', tagline: 'Diversified liquid staking across Kintsu, aPriori and Magma.',
    value: ['Spreads stake over three live Monad LSTs (sMON, aprMON, gMON) in one tap', 'Receipt tokens land in the vault; you can withdraw them any time', 'No spending limits or allowlists: the agent can move all of the vault’s funds'],
    services: ['kintsu', 'apriori', 'magma', 'wmon'], deposit: 3,
    playbook: [{ kind: 'kintsu', amount: '1', label: 'Stake 1 MON → sMON (Kintsu)' }, { kind: 'apriori', amount: '1', label: 'Stake 1 MON → aprMON (aPriori)' }, { kind: 'magma', amount: '1', label: 'Stake 1 MON → gMON (Magma)' }] },
  { id: 'trader', name: 'Best-Execution Super Vault', emoji: '🎯', tagline: 'Quotes Uniswap v3, PancakeSwap v3 and Kuru, then swaps at the best price.',
    value: ['Every swap is quoted live on all three venues and routed to the best USDC out', 'The app sets minOut = best quote − 3% on each swap it sends', 'No spending limits, approval caps or allowlists: the agent can move all of the vault’s funds'],
    services: ['uniswap', 'pancake', 'kuru', 'wmon'], deposit: 3,
    playbook: [{ kind: 'bestswap', amount: '1.5', label: 'Swap 1.5 MON → USDC at the best of 3 venues' }, { kind: 'bestswap', amount: '1.5', label: 'Swap another 1.5 MON → USDC (re-quoted)' }, { kind: 'unwrap', amount: 'wmon-all', label: 'Unwrap any WMON back to MON' }] },
  { id: 'payments', name: 'Payments Super Vault', emoji: '💸', tagline: 'Payroll, tips and subscriptions to any address you list. No spending limits.',
    value: ['Pays any address, any amount: there is no payee allowlist and no per-payment cap', 'The payees you list are only who the playbook pays; the agent can pay anyone', 'Pause with one signature; withdraw everything any time'],
    services: ['pay'], deposit: 1, payees: true,
    playbook: [{ kind: 'pay-each', amount: '0.5', label: 'Pay 0.5 MON to every payee you listed' }] },
];

export const superById = (id: string) => SUPER_VAULTS.find(s => s.id === id);
/** createVault calldata for a template: executor = owner (your wallet). No limits are set (v4 has none). */
export const buildSuper = (t: SuperVault, owner: Address, _payees: Address[], deposit = t.deposit) => buildCreate(owner, owner, { deposit });
/** Remember which template a v4 vault was opened from (v4 vaults allow every service, so the rules can't tell). */
export const rememberSuper = (vault: string, id: SuperVault['id']) => { try { localStorage.setItem(`pp.super.${vault.toLowerCase()}`, id); } catch { /* private mode */ } };
export const rememberedSuper = (vault: string) => { try { return superById(localStorage.getItem(`pp.super.${vault.toLowerCase()}`) || ''); } catch { return undefined; } };
/** Which template a vault's enabled services correspond to (exact service set match), if any. */
export const matchSuper = (rules: string[]): SuperVault | undefined => {
  const set = [...rules].sort().join(',');
  return SUPER_VAULTS.find(t => [...t.services, ...(t.payees ? ['pay'] : [])].filter((x, i, a) => a.indexOf(x) === i).sort().join(',') === set);
};
