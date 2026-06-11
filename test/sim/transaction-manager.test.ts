import { describe, expect, it } from 'vitest';
import {
  TransactionExpiredError,
  TransactionFailedError,
  TransactionManager,
  TransactionTimedOutError,
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

  it('re-signs ONLY after death is verified by full-history sweeps, then reports every signature', async () => {
    let blockhashFetches = 0;
    let builds = 0;
    let sends = 0;
    const statusCalls: Array<{ sigs: string[]; history: boolean }> = [];
    const tm = new TransactionManager(
      mockRpc({
        getLatestBlockhash: () => {
          blockhashFetches++;
          return BLOCKHASH;
        },
        sendTransaction: () => ({ result: `SIG${++sends}` }),
        // never seen anywhere → every sweep comes back empty
        getSignatureStatuses: (params) => {
          const [sigs, opts] = params as [string[], { searchTransactionHistory?: boolean }];
          statusCalls.push({ sigs: [...sigs], history: opts?.searchTransactionHistory ?? false });
          return { result: { value: sigs.map(() => null) } };
        },
        getBlockHeight: () => ({ result: 200 }), // > lastValidBlockHeight (100) → expiry suspected
      }),
    );
    const err: unknown = await tm
      .sendAndConfirm({
        buildSignedTx: async () => {
          builds++;
          return 'tx';
        },
        maxAttempts: 2,
        pollIntervalMs: 1,
        deathGraceMs: 1,
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TransactionExpiredError);
    expect((err as TransactionExpiredError).signatures).toEqual(['SIG1', 'SIG2']); // every submitted signature reported
    expect((err as Error).message).toMatch(/not confirmed after 2 attempt/);
    expect(blockhashFetches).toBe(2);
    expect(builds).toBe(2);

    // The destructive step (epoch 2) only happened after ≥2 full-history
    // sweeps over SIG1; the final epoch swept ALL signatures.
    const sweeps = statusCalls.filter((c) => c.history);
    expect(sweeps.length).toBeGreaterThanOrEqual(4); // 2 sweeps × 2 epochs
    expect(sweeps[0]!.sigs).toEqual(['SIG1']);
    expect(sweeps[sweeps.length - 1]!.sigs).toEqual(['SIG1', 'SIG2']);
  });

  it('a timeout is TERMINAL: never re-signs while the blockhash may still be valid', async () => {
    let builds = 0;
    let finalSweepSeen = false;
    const tm = new TransactionManager(
      mockRpc({
        getLatestBlockhash: () => BLOCKHASH,
        sendTransaction: () => ({ result: 'SIG_HANGING' }),
        getSignatureStatuses: (params) => {
          const [, opts] = params as [string[], { searchTransactionHistory?: boolean }];
          if (opts?.searchTransactionHistory) finalSweepSeen = true;
          return { result: { value: [null] } };
        },
        getBlockHeight: () => ({ result: 50 }), // < lastValidBlockHeight → never expires
      }),
    );
    const err: unknown = await tm
      .sendAndConfirm({
        buildSignedTx: async () => {
          builds++;
          return 'tx';
        },
        maxAttempts: 3,
        confirmTimeoutMs: 25,
        pollIntervalMs: 1,
        rebroadcastIntervalMs: 5,
        deathGraceMs: 1,
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TransactionTimedOutError);
    expect((err as TransactionTimedOutError).signatures).toEqual(['SIG_HANGING']);
    expect((err as Error).message).toMatch(/not confirmed within 25ms/);
    expect(builds).toBe(1); // the whole point: a timed-out tx may still land — no second signature
    expect(finalSweepSeen).toBe(true); // one last full-history look before giving up
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
