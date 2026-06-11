/**
 * Engine-level unit tests for branches the adapters don't reach:
 * durable-nonce lifetime semantics and submit-error normalization.
 */
import { describe, expect, it } from 'vitest';
import { RpcSubmitError, TransactionTimedOutError } from '../../src/transaction/errors.js';
import {
  normalizeSubmitError,
  runTxLifecycle,
  type LifecycleDeps,
  type LifecycleOptions,
} from '../../src/transaction/lifecycle.js';

const FAST: Omit<LifecycleOptions, 'getSignedTx' | 'lifetime'> = {
  commitment: 'confirmed',
  maxEpochs: 3,
  resignOnExpiry: true,
  confirmTimeoutMs: 30,
  pollIntervalMs: 1,
  rebroadcastIntervalMs: 5,
  skipPreflightFirstSend: false,
  submitRetries: 2,
  submitRetryDelayMs: 1,
  deathGraceMs: 1,
};

describe('normalizeSubmitError', () => {
  it('recognizes both wire shapes of BlockhashNotFound', () => {
    expect(
      normalizeSubmitError(
        new RpcSubmitError({ code: -32002, message: 'Blockhash not found', raw: {} }),
      ).isBlockhashNotFound,
    ).toBe(true);
    expect(normalizeSubmitError({ code: -32002, message: 'Blockhash not found' }).isBlockhashNotFound).toBe(true);
    expect(normalizeSubmitError({ message: 'x', data: { err: 'BlockhashNotFound' } }).isBlockhashNotFound).toBe(true);
    expect(normalizeSubmitError(new Error('connection refused')).isBlockhashNotFound).toBe(false);
  });

  it('recognizes already-processed and stringifies unknown shapes', () => {
    expect(normalizeSubmitError(new Error('This transaction has already been processed')).isAlreadyProcessed).toBe(
      true,
    );
    expect(normalizeSubmitError('boom').message).toBe('boom');
    expect(normalizeSubmitError({ weird: true }).message).toContain('weird');
  });
});

describe('durableNonce lifetime', () => {
  it('never checks block height and never re-signs — budget + final sweep only', async () => {
    let heightCalls = 0;
    let signs = 0;
    let finalSweep = false;
    const deps: LifecycleDeps = {
      getLatestBlockhash: async () => ({ blockhash: 'NONCE_PLACEHOLDER', lastValidBlockHeight: 0 }),
      submit: async () => 'SIG_NONCE',
      getStatuses: async (sigs, history) => {
        if (history) finalSweep = true;
        return sigs.map(() => null);
      },
      getBlockHeight: async () => {
        heightCalls++;
        return 1_000_000;
      },
    };
    const err: unknown = await runTxLifecycle(deps, {
      ...FAST,
      lifetime: 'durableNonce',
      getSignedTx: async () => {
        signs++;
        return 'nonce-wire';
      },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TransactionTimedOutError);
    expect(heightCalls).toBe(0); // a durable-nonce tx has no blockhash expiry
    expect(signs).toBe(1); // maxEpochs is irrelevant: nonce txs never re-sign
    expect(finalSweep).toBe(true);
  });

  it('confirms a durable-nonce tx through the same polling path', async () => {
    let polls = 0;
    const deps: LifecycleDeps = {
      getLatestBlockhash: async () => ({ blockhash: 'NONCE_PLACEHOLDER', lastValidBlockHeight: 0 }),
      submit: async () => 'SIG_NONCE_OK',
      getStatuses: async (sigs) => {
        polls++;
        return sigs.map(() => (polls >= 2 ? { confirmationStatus: 'confirmed' as const, err: null, slot: 1 } : null));
      },
      getBlockHeight: async () => 0,
    };
    const res = await runTxLifecycle(deps, {
      ...FAST,
      lifetime: 'durableNonce',
      getSignedTx: async () => 'nonce-wire',
    });
    expect(res.signature).toBe('SIG_NONCE_OK');
  });
});

describe('visible-below-target statuses', () => {
  it('a tx seen at processed keeps polling instead of being declared dead', async () => {
    let polls = 0;
    const deps: LifecycleDeps = {
      getLatestBlockhash: async () => ({ blockhash: 'BH', lastValidBlockHeight: 100 }),
      submit: async () => 'SIG_SLOW',
      getStatuses: async (sigs) => {
        polls++;
        return sigs.map(() =>
          polls < 3
            ? { confirmationStatus: 'processed' as const, err: null, slot: 2 }
            : { confirmationStatus: 'confirmed' as const, err: null, slot: 2 },
        );
      },
      getBlockHeight: async () => 200, // height says expired — but the tx is VISIBLE, so no death
    };
    const res = await runTxLifecycle(deps, {
      ...FAST,
      lifetime: 'blockhash',
      getSignedTx: async () => 'wire',
    });
    expect(res.signature).toBe('SIG_SLOW');
    expect(res.confirmationStatus).toBe('confirmed');
  });
});
