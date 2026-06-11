/**
 * Network-drop / latency simulations against a REAL local HTTP JSON-RPC server —
 * the fetch transport, composite routing, timeouts and the slot monitor all run
 * the same code paths they run in production, with failures injected server-side.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFetchTransport,
  createResilientTransport,
} from '../../src/transport/resilient-transport.js';
import type { RpcRequest, TransportEvent } from '../../src/types/index.js';
import { startRpcServer, type LocalRpcServer } from '../helpers/rpc-server.js';

const REQ: RpcRequest = { payload: { jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] } };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const servers: LocalRpcServer[] = [];
async function server(handlers: Parameters<typeof startRpcServer>[0]): Promise<LocalRpcServer> {
  const s = await startRpcServer(handlers);
  servers.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close().catch(() => undefined)));
});

describe('createFetchTransport against a real server', () => {
  it('round-trips JSON-RPC and sends per-endpoint headers', async () => {
    const s = await server({ getSlot: () => 1234 });
    const transport = createFetchTransport({ url: s.url, headers: { 'x-api-key': 'secret-key-1' } });
    const resp = await transport<{ result?: number }>(REQ);
    expect(resp.result).toBe(1234);
    expect(s.lastHeaders()['x-api-key']).toBe('secret-key-1');
    expect(s.hits()).toBe(1);
  });

  it('surfaces HTTP 5xx as a typed error message', async () => {
    const s = await server({ getSlot: () => 1 });
    s.setMode('http500');
    const transport = createFetchTransport({ url: s.url });
    await expect(transport(REQ)).rejects.toThrow(/HTTP 500/);
  });
});

describe('composite transport under injected network failure', () => {
  it('fails over from a socket-destroying endpoint to a healthy one (real connections)', async () => {
    const bad = await server({ getSlot: () => 1 });
    const good = await server({ getSlot: () => 2 });
    bad.setMode('destroy');

    const events: TransportEvent[] = [];
    const t = createResilientTransport({
      // pin the first attempt to the destroyer so the failover path is exercised deterministically
      endpoints: [{ url: bad.url, weight: 100 }, good.url],
      routing: 'best',
      requestTimeoutMs: 1_000,
      onEvent: (e) => events.push(e),
    });
    const out = await t<{ result?: number }>(REQ);
    expect(out.result).toBe(2);

    const fault = events.find((e) => e.type === 'request_fault');
    expect(fault).toMatchObject({ endpoint: bad.url, errorClass: 'network' });
  });

  it('treats a CLOSED server (connection refused) as a network fault and keeps serving', async () => {
    const dying = await server({ getSlot: () => 1 });
    const good = await server({ getSlot: () => 7 });
    const deadUrl = dying.url;
    await dying.close(); // true network drop: nothing listens on that port any more

    const t = createResilientTransport({
      // pin the first attempt to the closed port — refusal must be classified, not skipped
      endpoints: [{ url: deadUrl, weight: 100 }, good.url],
      routing: 'best',
      requestTimeoutMs: 1_000,
    });
    for (let i = 0; i < 3; i++) {
      const out = await t<{ result?: number }>(REQ);
      expect(out.result).toBe(7);
    }
    const dead = t.getHealth().find((h) => h.url === deadUrl);
    expect(dead?.errorRate ?? 0).toBeGreaterThan(0);
  });

  it('classifies a hanging endpoint as timeout and fails the request when it is the only node', async () => {
    const s = await server({ getSlot: () => 1 });
    s.setMode('hang');
    const events: TransportEvent[] = [];
    const t = createResilientTransport({
      endpoints: [s.url],
      requestTimeoutMs: 50,
      onEvent: (e) => events.push(e),
    });
    await expect(t(REQ)).rejects.toThrow(/all 1 endpoint attempt/);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'request_fault', errorClass: 'timeout' }),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: 'all_endpoints_failed' }));
  });

  it('latency injection: a slow node still answers within a generous timeout', async () => {
    const slow = await server({ getSlot: () => 11 });
    slow.setLatency(60);
    const t = createResilientTransport({ endpoints: [slow.url], requestTimeoutMs: 1_000 });
    const started = Date.now();
    const out = await t<{ result?: number }>(REQ);
    expect(out.result).toBe(11);
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    expect(t.getHealth()[0]!.latencyMs).toBeGreaterThanOrEqual(50);
  });

  it('honours an already-aborted caller signal', async () => {
    const s = await server({ getSlot: () => 1 });
    const ctrl = new AbortController();
    ctrl.abort();
    const t = createResilientTransport({ endpoints: [s.url], requestTimeoutMs: 1_000 });
    await expect(t({ ...REQ, signal: ctrl.signal })).rejects.toThrow();
  });

  it('caller abort mid-flight surfaces the abort and does NOT poison pool health', async () => {
    const s = await server({ getSlot: () => 1 });
    s.setMode('hang');
    const ctrl = new AbortController();
    const events: TransportEvent[] = [];
    const t = createResilientTransport({
      endpoints: [s.url],
      requestTimeoutMs: 5_000,
      onEvent: (e) => events.push(e),
    });
    setTimeout(() => ctrl.abort(), 30);
    // The abort itself propagates — NOT an "all endpoints failed" wrapper.
    await expect(t({ ...REQ, signal: ctrl.signal })).rejects.toThrow(/abort/i);

    // Cancellation must not count against the endpoint: no error recorded,
    // no in-flight leak (a leak would skew load-damped routing forever).
    const health = t.getHealth()[0]!;
    expect(health.errorRate).toBe(0);
    expect(health.inFlight).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ type: 'request_aborted' }));
  });

  it('respects maxAttempts: gives up before reaching later endpoints', async () => {
    const bad = await server({ getSlot: () => 1 });
    const never = await server({ getSlot: () => 2 });
    bad.setMode('destroy');
    const t = createResilientTransport({
      endpoints: [{ url: bad.url, weight: 100 }, never.url], // weight pins first attempt to `bad`
      routing: 'best',
      maxAttempts: 1,
      requestTimeoutMs: 500,
    });
    await expect(t(REQ)).rejects.toThrow(/all 1 endpoint attempt/);
    expect(never.hits()).toBe(0);
  });
});

describe('slot monitor against real servers', () => {
  it('records real slot lag from getSlot probes and survives restarts', async () => {
    const fresh = await server({ getSlot: () => 1_000, getGenesisHash: () => 'G1' });
    const stale = await server({ getSlot: () => 963, getGenesisHash: () => 'G1' });
    const t = createResilientTransport({ endpoints: [fresh.url, stale.url] });

    t.startHealthMonitor({ intervalMs: 5_000 }); // immediate first tick
    t.startHealthMonitor(); // idempotent second start must not double-tick
    await sleep(80);
    t.startHealthMonitor({ intervalMs: 4_000 }); // restart-with-options branch
    await sleep(80);
    t.stopHealthMonitor();

    const staleHealth = t.getHealth().find((h) => h.url === stale.url);
    expect(staleHealth?.slotLag).toBe(37);
  });
});
