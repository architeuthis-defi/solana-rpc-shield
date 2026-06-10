import { describe, expect, it } from 'vitest';
import {
  TransactionFailedError,
  TransactionManager,
} from '../../src/transaction/transaction-manager.js';
import type { RpcRequest, RpcTransport } from '../../src/types/index.js';

type Handler = (params: unknown) => unknown;

/** Build a mock RPC transport that dispatches by JSON-RPC method. */
function mockRpc(handlers: Record<string, Handler>): RpcTransport {
  return (async (req: RpcRequest) => {
    const { method, params } = req.payload as { method: string; params: unknown };
    const h = handlers[method];
    if (!h) throw new Error(`unhandled method ${method}`);
    return h(params);
  }) as RpcTransport;
}

const BLOCKHASH = { result: { value: { blockhash: 'Bh11111', lastValidBlockHeight: 100 } } };

describe('TransactionManager.sendAndConfirm', () => {
  it('builds, submits and confirms a transaction', async () => {
    const tm = new TransactionManager(
      mockRpc({
        getLatestBlockhash: () => BLOCKHASH,
        sendTransaction: () => ({ result: 'SIG_OK' }),
        getSignatureStatuses: () => ({ result: { value: [{ confirmationStatus: 'confirmed', err: null, slot: 42 }] } }),
      }),
    );
    const res = await tm.sendAndConfirm({
      buildSignedTx: async (bh) => `tx-for-${bh.blockhash}`,
      pollIntervalMs: 1,
    });
    expect(res.signature).toBe('SIG_OK');
    expect(res.confirmationStatus).toBe('confirmed');
    expect(res.slot).toBe(42);
  });

  it('surfaces a real on-chain revert as TransactionFailedError (no failover)', async () => {
    const tm = new TransactionManager(
      mockRpc({
        getLatestBlockhash: () => BLOCKHASH,
        sendTransaction: () => ({ result: 'SIG_REVERT' }),
        getSignatureStatuses: () => ({
          result: { value: [{ confirmationStatus: 'confirmed', err: { InstructionError: [0, 'Custom'] }, slot: 7 }] },
        }),
      }),
    );
    await expect(
      tm.sendAndConfirm({ buildSignedTx: async () => 'tx', pollIntervalMs: 1 }),
    ).rejects.toBeInstanceOf(TransactionFailedError);
  });

  it('rebuilds with a fresh blockhash on expiry and gives up after maxAttempts', async () => {
    let blockhashFetches = 0;
    let builds = 0;
    const tm = new TransactionManager(
      mockRpc({
        getLatestBlockhash: () => {
          blockhashFetches++;
          return BLOCKHASH;
        },
        sendTransaction: () => ({ result: 'SIG' }),
        // never seen → triggers blockhash-height expiry check
        getSignatureStatuses: () => ({ result: { value: [null] } }),
        getBlockHeight: () => ({ result: 200 }), // > lastValidBlockHeight (100) → expired
      }),
    );
    await expect(
      tm.sendAndConfirm({
        buildSignedTx: async () => {
          builds++;
          return 'tx';
        },
        maxAttempts: 2,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow(/not confirmed after 2 attempt/);
    expect(blockhashFetches).toBe(2); // refreshed each attempt
    expect(builds).toBe(2); // rebuilt each attempt
  });

  it('falls back to RPC submission when the Jito relay is unreachable', async () => {
    const tm = new TransactionManager(
      mockRpc({
        getLatestBlockhash: () => BLOCKHASH,
        sendTransaction: () => ({ result: 'SIG_RPC_FALLBACK' }),
        getSignatureStatuses: () => ({ result: { value: [{ confirmationStatus: 'confirmed', err: null, slot: 9 }] } }),
      }),
      { jito: { blockEngineUrl: 'https://127.0.0.1:1', fallbackToRpc: true } },
    );
    // Jito fetch to an unroutable host throws → fallback path returns the RPC signature.
    const res = await tm.sendAndConfirm({ buildSignedTx: async () => 'tx', pollIntervalMs: 1 });
    expect(res.signature).toBe('SIG_RPC_FALLBACK');
  });
});
