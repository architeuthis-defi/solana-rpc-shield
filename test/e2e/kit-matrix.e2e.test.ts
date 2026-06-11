/**
 * Compatibility matrix: the SAME composite transport drives a real RPC client
 * from BOTH `@solana/web3.js@2` (the listing's wording) and `@solana/kit`
 * (its renamed continuation) — against live local servers, through failover.
 *
 * Recommended integration (also asserted here): keep the shield as the
 * resilience layer and let the library's own `createDefaultRpcTransport`
 * own wire semantics (bigint-safe u64 parsing) via `transportFactory`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as kit from '@solana/kit';
import * as web3 from '@solana/web3.js';
import { createResilientTransport } from '../../src/transport/resilient-transport.js';
import type { EndpointConfig, RpcTransport } from '../../src/types/index.js';
import { startRpcServer, type LocalRpcServer } from '../helpers/rpc-server.js';

/** The structural slice of either library the matrix needs. */
interface SolanaRpcLib {
  createSolanaRpcFromTransport(transport: never): {
    getSlot(): { send(): Promise<bigint> };
    getBalance(address: never): { send(): Promise<{ value: bigint }> };
  };
  createDefaultRpcTransport(config: { url: string }): unknown;
}

const LIBS: ReadonlyArray<[name: string, lib: SolanaRpcLib]> = [
  ['@solana/web3.js v2', web3 as unknown as SolanaRpcLib],
  ['@solana/kit', kit as unknown as SolanaRpcLib],
];

const HANDLERS = {
  getSlot: () => 777,
  getBalance: () => ({ context: { slot: 777 }, value: 5_000_000_000 }),
};

const servers: LocalRpcServer[] = [];
async function server(handlers: Parameters<typeof startRpcServer>[0]): Promise<LocalRpcServer> {
  const s = await startRpcServer(handlers);
  servers.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close().catch(() => undefined)));
});

describe.each(LIBS)('%s over the resilient composite', (_name, lib) => {
  it('serves real RPC calls through failover using the library-native transport factory', async () => {
    const dead = await server(HANDLERS);
    const live = await server(HANDLERS);
    dead.setMode('destroy');

    const composite = createResilientTransport({
      // pin the first attempt to the dead node — the call must succeed anyway
      endpoints: [{ url: dead.url, weight: 100 }, live.url],
      routing: 'best',
      requestTimeoutMs: 1_000,
      // Recommended: the library's own transport keeps v2 wire semantics
      // (bigint-safe u64s); the shield only owns routing and health.
      transportFactory: (endpoint: EndpointConfig) =>
        lib.createDefaultRpcTransport({ url: endpoint.url }) as RpcTransport,
    });

    const rpc = lib.createSolanaRpcFromTransport(composite as never);
    const slot = await rpc.getSlot().send();

    expect(slot).toBe(777n); // bigint preserved end-to-end
    expect(dead.hits()).toBeGreaterThanOrEqual(1); // the dead node really was attempted
    expect(live.hits()).toBeGreaterThanOrEqual(1); // ...and failover served the call
  });

  it('returns u64 account values as bigint through the composite', async () => {
    const live = await server(HANDLERS);
    const composite = createResilientTransport({
      endpoints: [live.url],
      transportFactory: (endpoint: EndpointConfig) =>
        lib.createDefaultRpcTransport({ url: endpoint.url }) as RpcTransport,
    });
    const rpc = lib.createSolanaRpcFromTransport(composite as never);
    const balance = await rpc.getBalance('11111111111111111111111111111111' as never).send();
    expect(balance.value).toBe(5_000_000_000n);
  });

  it('also works over the zero-dependency fetch factory (plain JSON numbers)', async () => {
    const live = await server(HANDLERS);
    const composite = createResilientTransport({ endpoints: [live.url] });
    const rpc = lib.createSolanaRpcFromTransport(composite as never);
    const slot = await rpc.getSlot().send();
    expect(String(slot)).toBe('777'); // value correct; bigint fidelity needs the native factory
  });
});
