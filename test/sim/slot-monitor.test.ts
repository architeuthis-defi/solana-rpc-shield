import { describe, expect, it } from 'vitest';
import { SlotMonitor, type SlotProbeTarget } from '../../src/transport/slot-monitor.js';
import type { RpcRequest } from '../../src/types/index.js';

/** A mock probe target that answers getSlot/getGenesisHash (or throws). */
function mockTarget(
  url: string,
  slot: number | 'throw',
  genesis: string | null = 'G1', // null = the genesis probe itself fails
): SlotProbeTarget & { lags: number[] } {
  const lags: number[] = [];
  return {
    url,
    lags,
    transport: (async (req: RpcRequest) => {
      const { method } = req.payload as { method: string };
      if (method === 'getGenesisHash') {
        if (genesis === null) throw new Error('fetch failed: ECONNREFUSED');
        return { result: genesis };
      }
      if (slot === 'throw') throw new Error('fetch failed: ECONNREFUSED');
      return { result: slot };
    }) as SlotProbeTarget['transport'],
    recordSlot(own: number, freshest: number) {
      lags.push(freshest - own);
    },
  };
}

describe('SlotMonitor', () => {
  it('computes lag against the freshest node in the pool', async () => {
    const fresh = mockTarget('https://fresh', 1000);
    const lagging = mockTarget('https://lagging', 940);
    const monitor = new SlotMonitor([fresh, lagging]);

    await monitor.tick();

    expect(fresh.lags).toEqual([0]); // freshest node has zero lag
    expect(lagging.lags).toEqual([60]); // 1000 - 940
  });

  it('compares slots only WITHIN one chain — mixed-chain pools never poison lag', async () => {
    // mainnet slots are wildly different numbers from devnet slots; comparing
    // them produces a meaningless multi-million "lag" that zeroes the score.
    const mainnet = mockTarget('https://mainnet', 425_000_000, 'GENESIS_MAINNET');
    const devnet = mockTarget('https://devnet', 382_000_000, 'GENESIS_DEVNET');
    const monitor = new SlotMonitor([mainnet, devnet]);

    await monitor.tick();

    expect(mainnet.lags).toEqual([0]); // each is the freshest of its OWN chain
    expect(devnet.lags).toEqual([0]);
    const groups = monitor.genesisGroups();
    expect(groups.size).toBe(2); // the misconfiguration is detectable
    expect([...groups.values()].flat().sort()).toEqual(['https://devnet', 'https://mainnet']);
  });

  it('never compares a node whose chain is unknown (genesis probe failed)', async () => {
    const known = mockTarget('https://known', 500, 'G1');
    const unknown = mockTarget('https://unknown', 999_999, null);
    const monitor = new SlotMonitor([known, unknown]);

    await monitor.tick();

    expect(known.lags).toEqual([0]);
    expect(unknown.lags).toEqual([]); // no genesis → no lag verdict, no poisoning
  });

  it('skips a node that fails the probe without crashing the round', async () => {
    const ok = mockTarget('https://ok', 500);
    const dead = mockTarget('https://dead', 'throw');
    const monitor = new SlotMonitor([ok, dead]);

    await monitor.tick();

    expect(ok.lags).toEqual([0]); // ok node still scored
    expect(dead.lags).toEqual([]); // dead node skipped, no record, no throw
  });

  it('leaves lag untouched when the whole pool is unreachable', async () => {
    const a = mockTarget('https://a', 'throw');
    const b = mockTarget('https://b', 'throw');
    const monitor = new SlotMonitor([a, b]);

    await monitor.tick();

    expect(a.lags).toEqual([]);
    expect(b.lags).toEqual([]);
  });
});
