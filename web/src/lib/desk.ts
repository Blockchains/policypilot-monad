import { encodeFunctionData, getAddress, parseAbi, parseEventLogs, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { preflightGas } from './fastPath';

/**
 * PolicyPilotDeskFactory (src/PolicyPilotDeskFactory.sol): opens Prime, Clip and Spread desk vaults with an ordinary contract
 * call. Some mobile wallets replace the dapp's gas limit on a contract-creation transaction with 900,000, far below the
 * ~2.6M these vaults need, so every direct deploy from those wallets ran out of gas and reverted (gas charged, value
 * refunded). Calls keep the dapp's limit. Only the three known bytecodes are accepted. The vault is created empty; the
 * deposit is a second ordinary call so the shares are yours.
 */
export const DESK_FACTORY: Partial<Record<number, Address>> = { 143: '0x223482EC33Eee63de621B3A3Fa56e1Fc96Cd420B' };
export const DESK_KIND = { prime: 0, clip: 1, spread: 2 } as const;
export const deskFactoryAbi = parseAbi([
  'function create(uint8 kind, bytes initcode) returns (address vault)',
  'function vaultsOf(address creator) view returns (address[])',
  'function creatorOf(address vault) view returns (address)',
  'function primeResumeTrading(address vault)',
  'function primeSetExecutor(address vault, address next)',
  'event DeskCreated(address indexed creator, address indexed vault, uint8 indexed kind)',
  'error UnknownKind()', 'error UnknownBytecode()', 'error DeployFailed()', 'error NotCreator()',
]);

type Send = (w: WalletClient, req: { to?: Address; data?: Hex; value?: bigint; gas?: bigint }) => Promise<{ transactionHash: Hex; contractAddress?: Address | null; logs?: readonly any[] }>;
export type DeskOpen = { vault: Address; openTx: Hex; depositTx: Hex | null; signatures: number };

/**
 * Open a desk vault and (optionally) deposit. With the factory: two signatures (open, then deposit), each simulated first.
 * Without one (testnet): the old single contract-creation transaction, simulated first and given estimate + 10%.
 * `onOpened` runs right after the open, so a failed deposit still leaves the vault remembered.
 */
export async function openDesk(o: {
  chainId: number; pub: PublicClient; account: Address; wallet: WalletClient; send: Send;
  kind: keyof typeof DESK_KIND; initcode: Hex; value: bigint; depositData: Hex; onOpened?: (vault: Address, tx: Hex) => void;
}): Promise<DeskOpen> {
  const f = DESK_FACTORY[o.chainId];
  if (!f) {
    const gas = await preflightGas(o.pub, o.account, { data: o.initcode, value: o.value });
    const rc = await o.send(o.wallet, { data: o.initcode, value: o.value, gas });
    if (!rc.contractAddress) throw new Error(`The transaction was included, but the vault address was not in the receipt. ${rc.transactionHash}`);
    o.onOpened?.(rc.contractAddress, rc.transactionHash);
    return { vault: rc.contractAddress, openTx: rc.transactionHash, depositTx: null, signatures: 1 };
  }
  const data = encodeFunctionData({ abi: deskFactoryAbi, functionName: 'create', args: [DESK_KIND[o.kind], o.initcode] });
  const gas = await preflightGas(o.pub, o.account, { to: f, data });
  const rc = await o.send(o.wallet, { to: f, data, gas });
  let vault: Address | null = null;
  try { const ev = parseEventLogs({ abi: deskFactoryAbi, logs: (rc.logs ?? []) as any, eventName: 'DeskCreated' }).find(x => x.args.creator.toLowerCase() === o.account.toLowerCase()); if (ev) vault = getAddress(ev.args.vault); } catch { /* read below */ }
  if (!vault) { const list = await o.pub.readContract({ address: f, abi: deskFactoryAbi, functionName: 'vaultsOf', args: [o.account] }); vault = list.length ? getAddress(list[list.length - 1]) : null; }
  if (!vault) throw new Error(`The vault was opened, but its address could not be read. ${rc.transactionHash}`);
  o.onOpened?.(vault, rc.transactionHash);
  if (o.value <= 0n) return { vault, openTx: rc.transactionHash, depositTx: null, signatures: 1 };
  const dGas = await preflightGas(o.pub, o.account, { to: vault, data: o.depositData, value: o.value });
  const d = await o.send(o.wallet, { to: vault, data: o.depositData, value: o.value, gas: dGas });
  return { vault, openTx: rc.transactionHash, depositTx: d.transactionHash, signatures: 2 };
}
