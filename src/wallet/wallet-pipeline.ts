/**
 * WalletPipeline — resilient submission for wallet-signed transactions.
 *
 * Wallet transactions need a different retry primitive than local-key ones.
 * `TransactionManager.sendAndConfirm` refreshes the blockhash and REBUILDS the
 * tx each attempt — correct when re-signing is free, but every rebuild of a
 * wallet tx is another approval popup. The pipeline inverts the strategy:
 *
 *   1. the wallet signs ONCE,
 *   2. the same signed bytes are re-broadcast on an interval while the
 *      blockhash is still valid (status polling stays authoritative),
 *   3. only on expiry — and only with explicit `resignOnExpiry` opt-in — is
 *      the user prompted again with a freshly built transaction.
 *
 * Re-broadcasting an already-landed tx surfaces "already processed" errors
 * from preflight; those are expected and non-authoritative, so rebroadcasts
 * always skip preflight and their failures are reported via events, never
 * thrown — the status poll decides the truth.
 */

import type {
  Commitment,
  ConfirmResult,
  LatestBlockhash,
  TransactionManager,
} from '../transaction/transaction-manager.js';
import type { WalletSigner } from './signers.js';

/** Encode signed transaction bytes for `sendTransaction` (Node + browser). */
export function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

/** Emitted at every lifecycle step — feeds logging and the OTel exporter. */
export type WalletPipelineEvent =
  | { readonly type: 'signed'; readonly wallet: string; readonly prompt: number }
  | { readonly type: 'submitted'; readonly signature: string; readonly round: number }
  | { readonly type: 'rebroadcast'; readonly signature: string; readonly count: number }
  | { readonly type: 'rebroadcast_error'; readonly signature: string; readonly message: string }
  | { readonly type: 'expired'; readonly signature: string }
  | { readonly type: 'confirmed'; readonly signature: string; readonly slot: number | undefined };

export interface WalletPipelineOptions {
  /** Commitment for blockhash + confirmation. Default 'confirmed'. */
  readonly commitment?: Commitment;
  /** Prompt the wallet again with a fresh blockhash after expiry. Default false — extra popups are opt-in. */
  readonly resignOnExpiry?: boolean;
  /** Max additional sign prompts when `resignOnExpiry`. Default 1. */
  readonly maxResigns?: number;
  /** Status-poll window between rebroadcasts of the same signed tx (ms). Default 4_000. */
  readonly rebroadcastIntervalMs?: number;
  /** Total confirmation budget per signed tx (ms). Default 60_000. */
  readonly confirmTimeoutMs?: number;
  /** Poll interval inside each status window (ms). Default 2_000. */
  readonly pollIntervalMs?: number;
  /** Preflight opt-out for the FIRST submit (rebroadcasts always skip). Default false. */
  readonly skipPreflight?: boolean;
  readonly onEvent?: (event: WalletPipelineEvent) => void;
}

export interface WalletSendOptions extends WalletPipelineOptions {
  /**
   * Build the UNSIGNED serialized transaction for a blockhash. Called once up
   * front, and again only on an opted-in re-sign round.
   */
  readonly buildTx: (blockhash: LatestBlockhash) => Uint8Array | Promise<Uint8Array>;
}

/** The signed tx outlived its blockhash without confirming — caller decides whether to re-prompt. */
export class WalletTransactionExpiredError extends Error {
  readonly signature: string;
  constructor(signature: string, prompts: number) {
    super(
      `wallet transaction ${signature} expired before confirmation after ${prompts} sign prompt(s); ` +
        'pass resignOnExpiry to allow a fresh prompt',
    );
    this.name = 'WalletTransactionExpiredError';
    this.signature = signature;
  }
}

export class WalletPipeline {
  private readonly manager: TransactionManager;
  private readonly signer: WalletSigner;
  private readonly defaults: WalletPipelineOptions;

  constructor(manager: TransactionManager, signer: WalletSigner, defaults?: WalletPipelineOptions) {
    this.manager = manager;
    this.signer = signer;
    this.defaults = defaults ?? {};
  }

  /** Sign via the wallet, then submit/rebroadcast/confirm. Throws `WalletTransactionExpiredError` or `TransactionFailedError`. */
  async sendAndConfirm(opts: WalletSendOptions): Promise<ConfirmResult> {
    const commitment = opts.commitment ?? this.defaults.commitment ?? 'confirmed';
    const resignOnExpiry = opts.resignOnExpiry ?? this.defaults.resignOnExpiry ?? false;
    const maxResigns = opts.maxResigns ?? this.defaults.maxResigns ?? 1;
    const rebroadcastMs = opts.rebroadcastIntervalMs ?? this.defaults.rebroadcastIntervalMs ?? 4_000;
    const confirmTimeoutMs = opts.confirmTimeoutMs ?? this.defaults.confirmTimeoutMs ?? 60_000;
    const pollIntervalMs = opts.pollIntervalMs ?? this.defaults.pollIntervalMs ?? 2_000;
    const skipPreflight = opts.skipPreflight ?? this.defaults.skipPreflight ?? false;
    const emit = (event: WalletPipelineEvent): void => {
      (opts.onEvent ?? this.defaults.onEvent)?.(event);
    };

    let prompts = 0;
    for (let round = 0; ; round++) {
      const blockhash = await this.manager.getLatestBlockhash(commitment);
      const unsigned = await opts.buildTx(blockhash);
      const signed = await this.signer.signTransactionBytes(unsigned);
      prompts++;
      emit({ type: 'signed', wallet: this.signer.label, prompt: prompts });

      const wire = toBase64(signed);
      const signature = await this.manager.submit(wire, skipPreflight);
      emit({ type: 'submitted', signature, round });

      const deadline = Date.now() + confirmTimeoutMs;
      let rebroadcasts = 0;
      let expired = false;
      while (!expired) {
        const result = await this.manager.confirm(signature, blockhash.lastValidBlockHeight, {
          commitment,
          timeoutMs: rebroadcastMs,
          pollIntervalMs,
        });
        if ('confirmationStatus' in result) {
          emit({ type: 'confirmed', signature, slot: result.slot });
          return result;
        }
        if ('expired' in result) {
          emit({ type: 'expired', signature });
          expired = true;
          break;
        }
        // timedOut within this window — same blockhash still valid, re-broadcast the same bytes.
        if (Date.now() >= deadline) {
          throw new Error(`wallet transaction ${signature} not confirmed within ${confirmTimeoutMs}ms`);
        }
        try {
          await this.manager.submit(wire, true);
          rebroadcasts++;
          emit({ type: 'rebroadcast', signature, count: rebroadcasts });
        } catch (err) {
          // Expected for landed-but-not-yet-polled txs ("already processed").
          // The status poll on the next iteration is the source of truth.
          emit({ type: 'rebroadcast_error', signature, message: err instanceof Error ? err.message : String(err) });
        }
      }

      if (!resignOnExpiry || round >= maxResigns) {
        throw new WalletTransactionExpiredError(signature, prompts);
      }
      // loop: fresh blockhash → rebuild → one more wallet prompt
    }
  }
}
