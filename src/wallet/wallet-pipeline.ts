/**
 * WalletPipeline — resilient submission for wallet-signed transactions.
 *
 * Wallet transactions need a different retry posture than local-key ones:
 * every re-sign is a user-facing approval popup. The pipeline runs the shared
 * transaction lifecycle engine (`../transaction/lifecycle.js`) with re-signing
 * DISABLED by default:
 *
 *   1. the wallet signs ONCE,
 *   2. the same signed bytes are re-broadcast on an interval while the
 *      blockhash is still valid (status polling stays authoritative),
 *   3. a fresh prompt happens only with explicit `resignOnExpiry` opt-in —
 *      and only after the engine VERIFIES death with two full-history status
 *      sweeps over every signature it ever submitted. A transaction that
 *      landed late is returned, never re-prompted for.
 *
 * Re-broadcasting an already-landed tx surfaces "already processed" errors
 * from preflight; those are expected and non-authoritative, so rebroadcasts
 * always skip preflight and their failures are reported via events, never
 * thrown — the status poll decides the truth.
 */

import {
  TransactionExpiredError,
  type Commitment,
  type ConfirmResult,
  type LatestBlockhash,
  type TransactionManager,
} from '../transaction/transaction-manager.js';
import { runTxLifecycle, type LifecycleEvent } from '../transaction/lifecycle.js';
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
  /** Prompt the wallet again after VERIFIED expiry. Default false — extra popups are opt-in. */
  readonly resignOnExpiry?: boolean;
  /** Max additional sign prompts when `resignOnExpiry`. Default 1. */
  readonly maxResigns?: number;
  /** Re-broadcast cadence for the same signed tx (ms). Default 4_000. */
  readonly rebroadcastIntervalMs?: number;
  /** Total confirmation budget per signed tx (ms). Default 60_000. */
  readonly confirmTimeoutMs?: number;
  /** Status poll interval (ms). Default 2_000. */
  readonly pollIntervalMs?: number;
  /** Preflight opt-out for the FIRST submit (rebroadcasts always skip). Default false. */
  readonly skipPreflight?: boolean;
  /** Gap between the two death-verification sweeps (ms). Default 2_000. */
  readonly deathGraceMs?: number;
  readonly onEvent?: (event: WalletPipelineEvent) => void;
}

export interface WalletSendOptions extends WalletPipelineOptions {
  /**
   * Build the UNSIGNED serialized transaction for a blockhash. Called once up
   * front, and again only on an opted-in re-sign round after verified expiry.
   */
  readonly buildTx: (blockhash: LatestBlockhash) => Uint8Array | Promise<Uint8Array>;
}

/** Every signed tx provably expired before confirming — caller decides whether to re-prompt. */
export class WalletTransactionExpiredError extends Error {
  readonly signature: string;
  /** All signatures this pipeline submitted, oldest first. */
  readonly signatures: readonly string[];
  constructor(signature: string, prompts: number, signatures: readonly string[] = [signature]) {
    super(
      `wallet transaction ${signature} expired before confirmation after ${prompts} sign prompt(s); ` +
        'pass resignOnExpiry to allow a fresh prompt',
    );
    this.name = 'WalletTransactionExpiredError';
    this.signature = signature;
    this.signatures = signatures;
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

  /**
   * Sign via the wallet, then submit/rebroadcast/confirm through the shared
   * lifecycle engine. Throws `WalletTransactionExpiredError` after verified
   * expiry, `TransactionTimedOutError` on budget exhaustion (the tx may still
   * land — signatures attached), `TransactionFailedError` on a real revert.
   */
  async sendAndConfirm(opts: WalletSendOptions): Promise<ConfirmResult> {
    const resignOnExpiry = opts.resignOnExpiry ?? this.defaults.resignOnExpiry ?? false;
    const maxResigns = opts.maxResigns ?? this.defaults.maxResigns ?? 1;
    const emit = (event: WalletPipelineEvent): void => {
      try {
        (opts.onEvent ?? this.defaults.onEvent)?.(event);
      } catch {
        // Listeners must never break submission.
      }
    };

    let prompts = 0;
    try {
      return await runTxLifecycle(
        {
          getLatestBlockhash: (c) => this.manager.getLatestBlockhash(c),
          submit: (wire, skipPreflight) => this.manager.submit(wire, skipPreflight),
          getStatuses: (sigs, searchHistory) =>
            this.manager.getSignatureStatuses(sigs, { searchTransactionHistory: searchHistory }),
          getBlockHeight: (c) => this.manager.getBlockHeight(c),
        },
        {
          getSignedTx: async (blockhash) => {
            const unsigned = await opts.buildTx(blockhash);
            const signed = await this.signer.signTransactionBytes(unsigned);
            prompts++;
            emit({ type: 'signed', wallet: this.signer.label, prompt: prompts });
            return toBase64(signed);
          },
          commitment: opts.commitment ?? this.defaults.commitment ?? 'confirmed',
          maxEpochs: 1 + (resignOnExpiry ? maxResigns : 0),
          resignOnExpiry,
          confirmTimeoutMs: opts.confirmTimeoutMs ?? this.defaults.confirmTimeoutMs ?? 60_000,
          pollIntervalMs: opts.pollIntervalMs ?? this.defaults.pollIntervalMs ?? 2_000,
          rebroadcastIntervalMs: opts.rebroadcastIntervalMs ?? this.defaults.rebroadcastIntervalMs ?? 4_000,
          skipPreflightFirstSend: opts.skipPreflight ?? this.defaults.skipPreflight ?? false,
          submitRetries: 2,
          submitRetryDelayMs: 250,
          deathGraceMs: opts.deathGraceMs ?? this.defaults.deathGraceMs ?? 2_000,
          lifetime: 'blockhash',
          onEvent: (event) => this.translate(event, emit),
        },
      );
    } catch (err) {
      if (err instanceof TransactionExpiredError) {
        const last = err.signatures[err.signatures.length - 1] ?? 'unknown';
        throw new WalletTransactionExpiredError(last, prompts, err.signatures);
      }
      throw err; // timeout keeps the engine's "not confirmed within Xms" phrasing; reverts pass verbatim
    }
  }

  /** Engine events → the pipeline's public event vocabulary (frozen for OTel/test consumers). */
  private translate(event: LifecycleEvent, emit: (e: WalletPipelineEvent) => void): void {
    switch (event.type) {
      case 'submitted':
        emit({ type: 'submitted', signature: event.signature, round: event.epoch });
        break;
      case 'rebroadcast':
        emit({ type: 'rebroadcast', signature: event.signature, count: event.count });
        break;
      case 'rebroadcast_error':
        emit({ type: 'rebroadcast_error', signature: event.signature, message: event.message });
        break;
      case 'expiry_suspected':
        emit({ type: 'expired', signature: event.signature });
        break;
      case 'confirmed':
        emit({ type: 'confirmed', signature: event.signature, slot: event.slot });
        break;
      default:
        break; // signed is emitted from the signing closure; terminals become thrown errors
    }
  }
}
