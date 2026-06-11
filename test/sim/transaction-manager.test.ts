import { describe, expect, it } from 'vitest';
import {
  RpcSubmitError,
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

  it('T-H1a: a death sweep that finds the tx landed returns it — never builds a second signature', async () => {
    let builds = 0;
    const tm = new TransactionManager(
      mockRpc({
        getLatestBlockhash: () => BLOCKHASH,
        sendTransaction: () => ({ result: 'SIG_LATE' }),
        getSignatureStatuses: (params) => {
          const [, opts] = params as [string[], { searchTransactionHistory?: boolean }];
          // invisible to the hot poll; visible the moment history is searched
          return opts?.searchTransactionHistory
            ? { result: { value: [{ confirmationStatus: 'confirmed', err: null, slot: 77 }] } }
            : { result: { value: [null] } };
        },
        getBlockHeight: () => ({ result: 200 }), // expiry suspected immediately
      }),
    );
    const res = await tm.sendAndConfirm({
      buildSignedTx: async () => {
        builds++;
        return 'tx';
      },
      pollIntervalMs: 1,
      deathGraceMs: 1,
    });
    expect(res.signature).toBe('SIG_LATE');
    expect(res.slot).toBe(77);
    expect(builds).toBe(1); // landed-late tx returned instead of double-signed
  });

  it('T-H1b: an OLDER epoch signature landing while epoch 2 is in flight is detected and returned', async () => {
    let sends = 0;
    let builds = 0;
    const tm = new TransactionManager(
      mockRpc({
        getLatestBlockhash: () => BLOCKHASH,
        sendTransaction: () => ({ result: `SIG${++sends}` }),
        getSignatureStatuses: (params) => {
          const [sigs] = params as [string[], unknown];
          // SIG1 becomes visible only after epoch 2 started (sends>=2) — the
          // engine polls ALL tracked signatures, so it must catch this.
          return {
            result: {
              value: sigs.map((s) =>
                s === 'SIG1' && sends >= 2 ? { confirmationStatus: 'confirmed', err: null, slot: 5 } : null,
              ),
            },
          };
        },
        getBlockHeight: () => ({ result: sends >= 2 ? 50 : 200 }),
      }),
    );
    const res = await tm.sendAndConfirm({
      buildSignedTx: async () => {
        builds++;
        return `tx${builds}`;
      },
      maxAttempts: 2,
      pollIntervalMs: 1,
      deathGraceMs: 1,
    });
    expect(res.signature).toBe('SIG1'); // the old epoch's tx — exactly one transfer happened
    expect(builds).toBe(2);
  });

  it('T-H3a: sendTransaction error bodies surface VERBATIM as RpcSubmitError (code + logs)', async () => {
    const tm = new TransactionManager(
      mockRpc({
        getLatestBlockhash: () => BLOCKHASH,
        sendTransaction: () => ({
          error: {
            code: -32002,
            message: 'Transaction simulation failed: Blockhash not found',
            data: { logs: ['Program log: preflight'] },
          },
        }),
      }),
    );
    const err: unknown = await tm
      .sendAndConfirm({
        buildSignedTx: async () => 'tx',
        pollIntervalMs: 1,
        deathGraceMs: 1,
        submitRetries: 1,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcSubmitError);
    expect((err as RpcSubmitError).code).toBe(-32002);
    expect((err as RpcSubmitError).logs).toEqual(['Program log: preflight']);
    expect((err as Error).message).toContain('Blockhash not found');
  });

  it('T-H3b: bounded retry on Blockhash-not-found, then success on a (likely different) node', async () => {
    let sendCalls = 0;
    const tm = new TransactionManager(
      mockRpc({
        getLatestBlockhash: () => BLOCKHASH,
        sendTransaction: () => {
          sendCalls++;
          if (sendCalls < 3) {
            return { error: { code: -32002, message: 'Blockhash not found' } };
          }
          return { result: 'SIG_OK' };
        },
        getSignatureStatuses: () => ({
          result: { value: [{ confirmationStatus: 'confirmed', err: null, slot: 9 }] },
        }),
      }),
    );
    const res = await tm.sendAndConfirm({
      buildSignedTx: async () => 'tx',
      pollIntervalMs: 1,
      deathGraceMs: 1,
      submitRetries: 2,
    });
    expect(res.signature).toBe('SIG_OK');
    expect(sendCalls).toBe(3); // 1 + 2 retries
  });

  it('T-H3c: a THROWN decoded RPC error (kit-style transport) gets the same retry treatment', async () => {
    let sendCalls = 0;
    const tm = new TransactionManager(
      mockRpc({
        getLatestBlockhash: () => BLOCKHASH,
        sendTransaction: () => {
          sendCalls++;
          // kit's createDefaultRpcTransport THROWS decoded errors instead of
          // resolving { error } bodies — the engine must normalize both.
          if (sendCalls === 1) throw { code: -32002, message: 'Blockhash not found' };
          return { result: 'SIG_KIT' };
        },
        getSignatureStatuses: () => ({
          result: { value: [{ confirmationStatus: 'confirmed', err: null, slot: 3 }] },
        }),
      }),
    );
    const res = await tm.sendAndConfirm({
      buildSignedTx: async () => 'tx',
      pollIntervalMs: 1,
      deathGraceMs: 1,
    });
    expect(res.signature).toBe('SIG_KIT');
    expect(sendCalls).toBe(2);
  });

  it('T-RB: re-broadcasts the SAME wire with skipPreflight=true while waiting', async () => {
    const sent: Array<{ wire: string; skipPreflight?: boolean }> = [];
    const tm = new TransactionManager(
      mockRpc({
        getLatestBlockhash: () => BLOCKHASH,
        sendTransaction: (params) => {
          const [wire, opts] = params as [string, { skipPreflight?: boolean }];
          sent.push({ wire, ...(opts?.skipPreflight !== undefined ? { skipPreflight: opts.skipPreflight } : {}) });
          return { result: 'SIG_RB' };
        },
        getSignatureStatuses: () =>
          sent.length >= 2
            ? { result: { value: [{ confirmationStatus: 'confirmed', err: null, slot: 8 }] } }
            : { result: { value: [null] } },
        getBlockHeight: () => ({ result: 50 }), // never expires
      }),
    );
    const res = await tm.sendAndConfirm({
      buildSignedTx: async () => 'same-wire',
      pollIntervalMs: 1,
      rebroadcastIntervalMs: 3,
      confirmTimeoutMs: 2_000,
      deathGraceMs: 1,
    });
    expect(res.signature).toBe('SIG_RB');
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sent.map((s) => s.wire)).size).toBe(1); // identical bytes every time
    expect(sent[0]!.skipPreflight).toBe(false);
    expect(sent[1]!.skipPreflight).toBe(true); // rebroadcasts never preflight
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
