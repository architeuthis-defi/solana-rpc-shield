import { describe, expect, it } from 'vitest';
import { createResilientTransport } from '../../src/transport/resilient-transport.js';
import type { EndpointConfig, RpcRequest, RpcTransport } from '../../src/types/index.js';

interface Probe {
  url: string;
}

/** Factory that fails any endpoint whose url contains "dead", else echoes the url. */
function mockFactory(behaviour: Record<string, 'ok' | 'network' | 'ratelimit' | 'revert'>) {
  return (endpoint: EndpointConfig): RpcTransport => {
    return (async (_req: RpcRequest) => {
      const mode = behaviour[endpoint.url] ?? 'ok';
      if (mode === 'network') throw new Error('fetch failed: ECONNREFUSED');
      if (mode === 'ratelimit') throw new Error('429 Too Many Requests');
      if (mode === 'revert') throw { code: -32003, message: 'Transaction simulation failed' };
      return { url: endpoint.url };
    }) as RpcTransport;
  };
}

const REQ: RpcRequest = { payload: { jsonrpc: '2.0', id: 1, method: 'getHealth', params: [] } };

describe('ResilientTransport failover', () => {
  it('routes around a dead endpoint to a healthy one', async () => {
    const t = createResilientTransport({
      endpoints: ['https://dead', 'https://live'],
      transportFactory: mockFactory({ 'https://dead': 'network', 'https://live': 'ok' }),
    });
    const out = await t<Probe>(REQ);
    expect(out.url).toBe('https://live');
  });

  it('penalises the failing endpoint in its health snapshot', async () => {
    const t = createResilientTransport({
      endpoints: ['https://dead', 'https://live'],
      transportFactory: mockFactory({ 'https://dead': 'network', 'https://live': 'ok' }),
    });
    // Drive a few requests so the dead node accrues failures.
    for (let i = 0; i < 5; i++) await t<Probe>(REQ);
    const dead = t.getHealth().find((h) => h.url === 'https://dead');
    const live = t.getHealth().find((h) => h.url === 'https://live');
    expect(dead?.errorRate).toBeGreaterThan(0);
    expect(live?.score ?? 0).toBeGreaterThan(dead?.score ?? 1);
  });

  it('does NOT fail over on a genuine JSON-RPC error (a revert is the answer)', async () => {
    const t = createResilientTransport({
      endpoints: ['https://a', 'https://b'],
      transportFactory: mockFactory({ 'https://a': 'revert', 'https://b': 'revert' }),
      maxAttempts: 2,
    });
    await expect(t<Probe>(REQ)).rejects.toMatchObject({ code: -32003 });
  });

  it('throws a clear aggregate error when every endpoint is down', async () => {
    const t = createResilientTransport({
      endpoints: ['https://x', 'https://y'],
      transportFactory: mockFactory({ 'https://x': 'network', 'https://y': 'ratelimit' }),
    });
    await expect(t<Probe>(REQ)).rejects.toThrow(/all \d+ endpoint attempt/);
  });
});
