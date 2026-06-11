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

  it('a slot-0 chain in a mixed pool is scored against itself, not poisoned or dropped', async () => {
    // slot 0 never wins the freshest-by-chain race (`0 > 0` is false), so that
    // chain has no entry in the freshest map and the recording falls back to
    // the node's own slot — lag 0, not a skip and not a cross-chain compare.
    const mainnet = mockTarget('https://mainnet', 500, 'G_MAIN');
    const freshChain = mockTarget('https://localnet', 0, 'G_LOCAL');
    const monitor = new SlotMonitor([mainnet, freshChain]);

    await monitor.tick();

    expect(mainnet.lags).toEqual([0]);
    expect(freshChain.lags).toEqual([0]); // scored via the own-slot fallback
  });

  it('resolves genesis once and serves later ticks from the cache', async () => {
    let genesisCalls = 0;
    const target = mockTarget('https://cached', 500);
    const inner = target.transport;
    (target as { transport: SlotProbeTarget['transport'] }).transport = async (req: RpcRequest) => {
      if ((req.payload as { method: string }).method === 'getGenesisHash') genesisCalls++;
      return inner(req);
    };
    const monitor = new SlotMonitor([target]);

    await monitor.tick();
    await monitor.tick();

    expect(genesisCalls).toBe(1); // second round hits the cache
    expect(target.lags).toEqual([0, 0]); // both rounds still scored
  });

  it('treats a malformed genesis response (non-string) as chain-unknown', async () => {
    const malformed = mockTarget('https://malformed', 500);
    const inner = malformed.transport;
    (malformed as { transport: SlotProbeTarget['transport'] }).transport = (async (req: RpcRequest) => {
      if ((req.payload as { method: string }).method === 'getGenesisHash') {
        return { result: 42 }; // node answered, but not with a hash
      }
      return inner(req);
    }) as SlotProbeTarget['transport'];
    const monitor = new SlotMonitor([malformed]);

    await monitor.tick();

    expect(malformed.lags).toEqual([]); // never compared, never poisons the pool
  });

  it('treats a malformed getSlot response (non-number) as a failed probe', async () => {
    const malformed = mockTarget('https://bad-slot', 0);
    const inner = malformed.transport;
    (malformed as { transport: SlotProbeTarget['transport'] }).transport = (async (req: RpcRequest) => {
      const { method } = req.payload as { method: string };
      if (method === 'getSlot') return { result: 'not-a-slot' };
      return inner(req);
    }) as SlotProbeTarget['transport'];
    const monitor = new SlotMonitor([malformed]);

    await monitor.tick();

    expect(malformed.lags).toEqual([]);
  });

  it('aborts a hung probe after probeTimeoutMs and skips the node for the round', async () => {
    // The hung node's transport resolves only via its abort signal — exactly
    // how a black-holed HTTP request dies under AbortController in production.
    const hung: SlotProbeTarget & { lags: number[] } = {
      url: 'https://hung',
      lags: [],
      transport: (async (req: RpcRequest) => {
        const { method } = req.payload as { method: string };
        if (method === 'getGenesisHash') return { result: 'G1' };
        return new Promise((_, reject) => {
          req.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }) as SlotProbeTarget['transport'],
      recordSlot(own: number, freshest: number) {
        this.lags.push(freshest - own);
      },
    };
    const healthy = mockTarget('https://healthy', 700);
    const monitor = new SlotMonitor([hung, healthy], { probeTimeoutMs: 20 });

    await monitor.tick();

    expect(hung.lags).toEqual([]); // timed out → skipped, not crashed
    expect(healthy.lags).toEqual([0]); // the round still completes for the rest
  });
});
