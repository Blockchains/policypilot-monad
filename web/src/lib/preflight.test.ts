import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bufferedGas, cushion, isSimulationRevert, notSent, SimulationRevert, simulateGas } from './preflight.ts';

const FROM = '0x00000000000000000000000000000000000000A1' as const;
const TO = '0x00000000000000000000000000000000000000B2' as const;
const transport = (e: unknown) => (e as { transport?: boolean })?.transport === true;

describe('simulate-first preflight', () => {
  it('a creation gets estimate + 10%, never the wallet default', async () => {
    const g = await simulateGas({ estimateGas: async () => 2_615_413n } as any, FROM, { data: '0x60' }, transport);
    assert.equal(g, 2_615_413n + 261_541n);
    assert.ok(g > 900_000n);
  });
  it('light calls get the cushion, heavy calls 10%, a caller floor is kept', () => {
    assert.equal(bufferedGas(100_000n, false), cushion(100_000n));
    assert.equal(bufferedGas(600_000n, false), 660_000n);
    assert.equal(bufferedGas(145_000n, false, 160_000n), 160_000n);
  });
  it('a revert throws SimulationRevert with the revert data, so nothing is sent', async () => {
    const err = Object.assign(new Error('Execution reverted'), { shortMessage: 'Execution reverted', cause: { data: '0x3e8d1aeb' } });
    await assert.rejects(simulateGas({ estimateGas: async () => { throw err; } } as any, FROM, { to: TO }, transport), (e: unknown) => {
      assert.ok(isSimulationRevert(e)); assert.equal((e as SimulationRevert).data, '0x3e8d1aeb'); return true;
    });
  });
  it('an RPC outage keeps the caller limit, or rethrows when there is none', async () => {
    const down = { estimateGas: async () => { throw { transport: true }; } } as any;
    assert.equal(await simulateGas(down, FROM, { to: TO, gas: 90_000n }, transport), 90_000n);
    await assert.rejects(simulateGas(down, FROM, { to: TO }, transport), (e: any) => e.transport === true && !isSimulationRevert(e));
  });
  it('the message says plainly that nothing was sent', () => {
    assert.equal(notSent(new SimulationRevert(new Error('x')), 'This pool can still take 2 MON.'), 'Not sent: the simulation reverted (This pool can still take 2 MON). Nothing was signed and no gas was spent.');
    assert.equal(notSent(new Error('x'), 'Other.'), 'Other.');
  });
});
