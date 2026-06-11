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
import { TransactionManager } from '../../src/transaction/transaction-manager.js';
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
  ['@solana/web3.js v2', web3],
  ['@solana/kit', kit],
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

  it('drives the FULL TransactionManager pipeline over the native transport (bigint boundary)', async () => {
    // The native factories parse every JSON number as bigint (u64 wire
    // semantics). The engine's height math, fee percentiles and slot probes
    // must normalize at the boundary — `height > lastValid + 2` over a raw
    // bigint throws "Cannot mix BigInt and other types". Caught live on
    // devnet by running the README example; this is the regression gate.
    let statusCalls = 0;
    const live = await server({
      getLatestBlockhash: () => ({
        context: { slot: 900 },
        value: { blockhash: 'BHKIT', lastValidBlockHeight: 1_000 },
      }),
      sendTransaction: () => 'SIG_KIT_E2E',
      // first poll: unseen → forces the expiry check (getBlockHeight math);
      // second poll: confirmed.
      getSignatureStatuses: () => ({
        context: { slot: 901 },
        value: [
          ++statusCalls < 2 ? null : { confirmationStatus: 'confirmed', confirmations: 1, slot: 901, err: null },
        ],
      }),
      getBlockHeight: () => 990, // below lastValid → not expired, keep polling
      getRecentPrioritizationFees: () => [
        { slot: 899, prioritizationFee: 12_345 },
        { slot: 900, prioritizationFee: 23_456 },
      ],
    });
    const composite = createResilientTransport({
      endpoints: [live.url],
      transportFactory: (endpoint: EndpointConfig) =>
        lib.createDefaultRpcTransport({ url: endpoint.url }) as RpcTransport,
    });

    const manager = new TransactionManager(composite);

    // Fee estimator: bigint samples must be USED, not silently filtered to the floor.
    const fee = await manager.fees.estimate();
    expect(fee).toBe(23_456); // p75 of the two samples — proves bigints weren't discarded

    // Full lifecycle: blockhash (bigint lastValid) → submit → unseen poll →
    // height check (the exact line that crashed) → confirmed.
    const res = await manager.sendAndConfirm({
      buildSignedTx: async () => 'kit-wire',
      pollIntervalMs: 5,
      confirmTimeoutMs: 5_000,
    });
    expect(res.signature).toBe('SIG_KIT_E2E');
    expect(res.confirmationStatus).toBe('confirmed');
    expect(res.slot).toBe(901); // normalized to number at the boundary
    expect(typeof res.slot).toBe('number');

    // Slot probe: a bigint getSlot answer must feed lag scoring, not fail silently.
    composite.startHealthMonitor({ intervalMs: 60_000 });
    await new Promise((r) => setTimeout(r, 150)); // let the immediate tick land
    composite.stopHealthMonitor();
    const health = composite.getHealth();
    expect(health[0]!.slotLag).toBe(0); // probe succeeded (single node = freshest); not frozen by a failed parse
  });
});
