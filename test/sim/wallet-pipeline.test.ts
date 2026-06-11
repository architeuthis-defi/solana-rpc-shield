import { describe, expect, it } from 'vitest';
import { TransactionManager } from '../../src/transaction/transaction-manager.js';
import {
  toBase64,
  WalletPipeline,
  WalletTransactionExpiredError,
  type WalletPipelineEvent,
} from '../../src/wallet/wallet-pipeline.js';
import type { WalletSigner } from '../../src/wallet/signers.js';
import type { RpcRequest, RpcTransport } from '../../src/types/index.js';

type Handler = (params: unknown) => unknown;

function mockRpc(handlers: Record<string, Handler>): RpcTransport {
  return (async (req: RpcRequest) => {
    const { method, params } = req.payload as { method: string; params: unknown };
    const h = handlers[method];
    if (!h) throw new Error(`unhandled method ${method}`);
    return h(params);
  }) as RpcTransport;
}

/** Wallet that "signs" by appending 0xff and counts prompts — popups are the UX cost under test. */
function countingWallet(): { signer: WalletSigner; prompts: () => number } {
  let prompts = 0;
  return {
    signer: {
      label: 'test-wallet',
      signTransactionBytes: async (tx) => {
        prompts++;
        return Uint8Array.from([...tx, 0xff]);
      },
    },
    prompts: () => prompts,
  };
}

const FAST = { rebroadcastIntervalMs: 5, pollIntervalMs: 1, confirmTimeoutMs: 500, deathGraceMs: 1 };

describe('WalletPipeline.sendAndConfirm', () => {
  it('signs once and confirms on the happy path, submitting the base64 of the wallet-signed bytes', async () => {
    const { signer, prompts } = countingWallet();
    const sent: string[] = [];
    const tm = new TransactionManager(
      mockRpc({
        getLatestBlockhash: () => ({ result: { value: { blockhash: 'BH1', lastValidBlockHeight: 100 } } }),
        sendTransaction: (params) => {
          sent.push((params as [string])[0]);
          return { result: 'SIG1' };
        },
        getSignatureStatuses: () => ({ result: { value: [{ confirmationStatus: 'confirmed', err: null, slot: 5 }] } }),
      }),
    );
    const pipeline = new WalletPipeline(tm, signer, FAST);
    const unsigned = Uint8Array.from([1, 2, 3]);
    const res = await pipeline.sendAndConfirm({ buildTx: () => unsigned });

    expect(res.signature).toBe('SIG1');
    expect(prompts()).toBe(1);
    expect(sent).toEqual([toBase64(Uint8Array.from([1, 2, 3, 0xff]))]);
  });

  it('re-broadcasts the SAME signed bytes through a dead window without re-prompting the wallet', async () => {
    const { signer, prompts } = countingWallet();
    const sent: Array<{ wire: string; opts: { skipPreflight?: boolean } }> = [];
    const tm = new TransactionManager(
      mockRpc({
        getLatestBlockhash: () => ({ result: { value: { blockhash: 'BH1', lastValidBlockHeight: 100 } } }),
        sendTransaction: (params) => {
          const [wire, opts] = params as [string, { skipPreflight?: boolean }];
          sent.push({ wire, opts });
          return { result: 'SIG1' };
        },
        // status stays unseen until at least one rebroadcast happened
        getSignatureStatuses: () =>
          sent.length >= 2
            ? { result: { value: [{ confirmationStatus: 'confirmed', err: null, slot: 8 }] } }
            : { result: { value: [null] } },
        getBlockHeight: () => ({ result: 50 }), // < lastValidBlockHeight → not expired
      }),
    );
    const events: WalletPipelineEvent[] = [];
    const pipeline = new WalletPipeline(tm, signer, { ...FAST, onEvent: (e) => events.push(e) });
    const res = await pipeline.sendAndConfirm({ buildTx: () => Uint8Array.from([7]) });

    expect(res.signature).toBe('SIG1');
    expect(prompts()).toBe(1); // the whole point: dead network ≠ extra popups
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sent.map((s) => s.wire)).size).toBe(1); // identical bytes every time
    expect(sent[0]!.opts.skipPreflight).toBe(false); // first submit preflights
    expect(sent[1]!.opts.skipPreflight).toBe(true); // rebroadcasts never preflight
    expect(events.some((e) => e.type === 'rebroadcast')).toBe(true);
  });

  it('treats rebroadcast errors as non-authoritative ("already processed") and lets the poll confirm', async () => {
    const { signer } = countingWallet();
    let sends = 0;
    let rebroadcastFailed = false;
    const tm = new TransactionManager(
      mockRpc({
        getLatestBlockhash: () => ({ result: { value: { blockhash: 'BH1', lastValidBlockHeight: 100 } } }),
        sendTransaction: () => {
          sends++;
          if (sends > 1) {
            rebroadcastFailed = true;
            throw new Error('Transaction simulation failed: This transaction has already been processed');
          }
          return { result: 'SIG1' };
        },
        getSignatureStatuses: () =>
          rebroadcastFailed
            ? { result: { value: [{ confirmationStatus: 'confirmed', err: null, slot: 9 }] } }
            : { result: { value: [null] } },
        getBlockHeight: () => ({ result: 50 }),
      }),
    );
    const events: WalletPipelineEvent[] = [];
    const pipeline = new WalletPipeline(tm, signer, { ...FAST, onEvent: (e) => events.push(e) });
    const res = await pipeline.sendAndConfirm({ buildTx: () => Uint8Array.from([7]) });

    expect(res.signature).toBe('SIG1');
    expect(events.some((e) => e.type === 'rebroadcast_error')).toBe(true);
  });

  it('throws WalletTransactionExpiredError on expiry by default — extra popups are opt-in', async () => {
    const { signer, prompts } = countingWallet();
    const tm = new TransactionManager(
      mockRpc({
        getLatestBlockhash: () => ({ result: { value: { blockhash: 'BH1', lastValidBlockHeight: 100 } } }),
        sendTransaction: () => ({ result: 'SIG1' }),
        getSignatureStatuses: () => ({ result: { value: [null] } }),
        getBlockHeight: () => ({ result: 200 }), // > lastValidBlockHeight → expired
      }),
    );
    const pipeline = new WalletPipeline(tm, signer, FAST);
    await expect(pipeline.sendAndConfirm({ buildTx: () => Uint8Array.from([7]) })).rejects.toBeInstanceOf(
      WalletTransactionExpiredError,
    );
    expect(prompts()).toBe(1);
  });

  it('re-signs with a FRESH blockhash only after VERIFIED expiry when resignOnExpiry is set', async () => {
    const { signer, prompts } = countingWallet();
    let blockhashFetches = 0;
    let sends = 0;
    const seenBlockhashes: string[] = [];
    const historySweeps: string[][] = [];
    const tm = new TransactionManager(
      mockRpc({
        getLatestBlockhash: () => {
          blockhashFetches++;
          return { result: { value: { blockhash: `BH${blockhashFetches}`, lastValidBlockHeight: 100 } } };
        },
        sendTransaction: () => {
          sends++;
          return { result: `SIG${sends}` };
        },
        // Per-signature statuses, aligned with the request — only SIG2 ever confirms.
        getSignatureStatuses: (params) => {
          const [sigs, opts] = params as [string[], { searchTransactionHistory?: boolean }];
          if (opts?.searchTransactionHistory) historySweeps.push([...sigs]);
          return {
            result: {
              value: sigs.map((s) =>
                s === 'SIG2' && sends >= 2 ? { confirmationStatus: 'confirmed', err: null, slot: 11 } : null,
              ),
            },
          };
        },
        getBlockHeight: () => ({ result: sends >= 2 ? 50 : 200 }), // expired only for the first signed tx
      }),
    );
    const pipeline = new WalletPipeline(tm, signer, { ...FAST, resignOnExpiry: true });
    const res = await pipeline.sendAndConfirm({
      buildTx: (bh) => {
        seenBlockhashes.push(bh.blockhash);
        return Uint8Array.from([7]);
      },
    });

    expect(res.signature).toBe('SIG2');
    expect(prompts()).toBe(2); // exactly one extra prompt
    expect(seenBlockhashes).toEqual(['BH1', 'BH2']); // rebuilt against a fresh blockhash
    // death was VERIFIED before the re-prompt: ≥2 full-history sweeps over SIG1
    expect(historySweeps.filter((s) => s.length === 1 && s[0] === 'SIG1').length).toBeGreaterThanOrEqual(2);
  });

  it('gives up after maxResigns expirations', async () => {
    const { signer, prompts } = countingWallet();
    const tm = new TransactionManager(
      mockRpc({
        getLatestBlockhash: () => ({ result: { value: { blockhash: 'BH', lastValidBlockHeight: 100 } } }),
        sendTransaction: () => ({ result: 'SIG' }),
        getSignatureStatuses: () => ({ result: { value: [null] } }),
        getBlockHeight: () => ({ result: 200 }), // always expired
      }),
    );
    const pipeline = new WalletPipeline(tm, signer, { ...FAST, resignOnExpiry: true, maxResigns: 2 });
    await expect(pipeline.sendAndConfirm({ buildTx: () => Uint8Array.from([7]) })).rejects.toBeInstanceOf(
      WalletTransactionExpiredError,
    );
    expect(prompts()).toBe(3); // initial + 2 re-signs, then a hard stop
  });

  it('enforces the total confirmation budget for a signed tx', async () => {
    const { signer } = countingWallet();
    const tm = new TransactionManager(
      mockRpc({
        getLatestBlockhash: () => ({ result: { value: { blockhash: 'BH', lastValidBlockHeight: 100 } } }),
        sendTransaction: () => ({ result: 'SIG' }),
        getSignatureStatuses: () => ({ result: { value: [null] } }),
        getBlockHeight: () => ({ result: 50 }), // never expires, never confirms
      }),
    );
    const pipeline = new WalletPipeline(tm, signer, {
      rebroadcastIntervalMs: 5,
      pollIntervalMs: 1,
      confirmTimeoutMs: 20,
    });
    await expect(pipeline.sendAndConfirm({ buildTx: () => Uint8Array.from([7]) })).rejects.toThrow(
      /not confirmed within 20ms/,
    );
  });
});
