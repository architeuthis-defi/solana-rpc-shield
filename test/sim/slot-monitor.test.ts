import { describe, expect, it } from 'vitest';
import { SlotMonitor, type SlotProbeTarget } from '../../src/transport/slot-monitor.js';
import type { RpcRequest } from '../../src/types/index.js';

/** A mock probe target that answers getSlot with a fixed slot (or throws). */
function mockTarget(url: string, slot: number | 'throw'): SlotProbeTarget & { lags: number[] } {
  const lags: number[] = [];
  return {
    url,
    lags,
    transport: (async (_req: RpcRequest) => {
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
