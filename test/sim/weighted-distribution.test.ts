import { describe, expect, it } from 'vitest';
import { createResilientTransport } from '../../src/transport/resilient-transport.js';
import type { EndpointConfig, RpcRequest, RpcTransport } from '../../src/types/index.js';
import { lcg } from '../helpers/rng.js';

const REQ: RpcRequest = { payload: { jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] } };

/** Echo transport that counts hits per endpoint; "dead" URLs throw a network error. */
function countingFactory(hits: Record<string, number>, dead: ReadonlySet<string> = new Set()) {
  return (endpoint: EndpointConfig): RpcTransport => {
    return (async (_req: RpcRequest) => {
      hits[endpoint.url] = (hits[endpoint.url] ?? 0) + 1;
      if (dead.has(endpoint.url)) throw new Error('fetch failed: ECONNREFUSED');
      return { url: endpoint.url };
    }) as RpcTransport;
  };
}

describe('traffic distribution across healthy nodes', () => {
  it("'weighted' (default) spreads load over equally healthy endpoints — the anti-rate-limit behaviour", async () => {
    const hits: Record<string, number> = {};
    const t = createResilientTransport({
      endpoints: ['https://a', 'https://b', 'https://c'],
      transportFactory: countingFactory(hits),
      rng: lcg(2026),
    });
    const total = 600;
    for (let i = 0; i < total; i++) await t(REQ);

    // No winner-take-all: every healthy node carries a meaningful share.
    for (const url of ['https://a', 'https://b', 'https://c']) {
      expect(hits[url] ?? 0).toBeGreaterThan(total * 0.2);
      expect(hits[url] ?? 0).toBeLessThan(total * 0.5);
    }
  });

  it("'best' + static weight pins traffic to the preferred primary while it is healthy", async () => {
    const hits: Record<string, number> = {};
    const t = createResilientTransport({
      // weight 2 keeps the paid primary strictly above the free backup's score jitter
      endpoints: [{ url: 'https://paid-primary', weight: 2 }, 'https://free-backup'],
      transportFactory: countingFactory(hits),
      routing: 'best',
    });
    for (let i = 0; i < 100; i++) await t(REQ);
    expect(hits['https://paid-primary']).toBe(100); // strict primary/backup: zero spill
    expect(hits['https://free-backup'] ?? 0).toBe(0);
  });

  it("'weighted' starves a degraded endpoint as its score collapses but keeps serving", async () => {
    const hits: Record<string, number> = {};
    const t = createResilientTransport({
      endpoints: ['https://good', 'https://flaky'],
      transportFactory: countingFactory(hits, new Set(['https://flaky'])),
      rng: lcg(7),
      health: { breakerThreshold: 3, breakerCooldownMs: 60_000 },
    });
    const total = 200;
    for (let i = 0; i < total; i++) await t(REQ); // failover guarantees success every time

    // After the flaky node's failures accumulate (and its breaker opens), the
    // healthy node must dominate; the flaky one saw only early/probe traffic.
    expect(hits['https://good'] ?? 0).toBeGreaterThanOrEqual(total);
    expect(hits['https://flaky'] ?? 0).toBeLessThan(total * 0.2);
  });
});
