/**
 * TransactionManager — reliable submit + confirm.
 *
 * Correctness comes from four behaviours a naive `sendTransaction` skips:
 *   1. dynamic priority fee (delegated to PriorityFeeEstimator),
 *   2. Jito relay routing with automatic RPC fallback,
 *   3. retry that refreshes the blockhash instead of resubmitting a dead tx,
 *   4. confirmation tracking that surfaces the real revert reason — never an
 *      empty catch, never a blind skipPreflight.
 *
 * Signing is the caller's concern: `sendAndConfirm` takes a `buildSignedTx`
 * callback invoked with each fresh blockhash, so the manager owns the
 * submit/refresh lifecycle without ever touching private keys.
 */

import type { RpcTransport } from '../types/index.js';
import { PriorityFeeEstimator, type PriorityFeeConfig } from './priority-fee.js';

export type Commitment = 'processed' | 'confirmed' | 'finalized';

const COMMITMENT_RANK: Record<Commitment, number> = { processed: 0, confirmed: 1, finalized: 2 };

export interface LatestBlockhash {
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
}

export interface JitoConfig {
  /** Jito block-engine base URL, e.g. https://mainnet.block-engine.jito.wtf */
  readonly blockEngineUrl: string;
  /** Fall back to normal RPC submission when the Jito relay errors. Default true. */
  readonly fallbackToRpc?: boolean;
}

/** Submission lifecycle events — consumed by logging and the OpenTelemetry exporter. */
export type TransactionEvent =
  | { readonly type: 'submitted'; readonly route: 'jito' | 'rpc' }
  | { readonly type: 'jito_fallback' }
  | {
      readonly type: 'confirm_outcome';
      readonly outcome: 'confirmed' | 'expired' | 'timed_out' | 'reverted';
      readonly elapsedMs: number;
    }
  | { readonly type: 'bundle_submitted'; readonly txCount: number }
  | {
      readonly type: 'bundle_outcome';
      readonly outcome: 'landed' | 'failed' | 'timed_out';
      readonly elapsedMs: number;
    };

export interface TransactionManagerOptions {
  readonly jito?: JitoConfig;
  readonly priorityFee?: PriorityFeeConfig;
  /** Default commitment for blockhash + confirmation. Default 'confirmed'. */
  readonly commitment?: Commitment;
  /** Lifecycle event hook; must be cheap — fired on the submission hot path. */
  readonly onEvent?: (event: TransactionEvent) => void;
}

export interface SendAndConfirmOptions {
  /** Build + sign the base64 transaction for a given blockhash. Re-called on refresh. */
  readonly buildSignedTx: (blockhash: LatestBlockhash) => Promise<string>;
  readonly commitment?: Commitment;
  /** Max submit attempts; each attempt refreshes the blockhash. Default 3. */
  readonly maxAttempts?: number;
  /** Confirmation timeout per attempt (ms). Default 30_000. */
  readonly confirmTimeoutMs?: number;
  /** Status poll interval (ms). Default 2_000. */
  readonly pollIntervalMs?: number;
  /** Opt-in skipPreflight (default false — preflight catches bad txs before they cost a slot). */
  readonly skipPreflight?: boolean;
}

export interface ConfirmResult {
  readonly signature: string;
  readonly slot: number | undefined;
  readonly confirmationStatus: Commitment;
}

/** A genuine on-chain failure (revert) — carries the program error, not a node fault. */
export class TransactionFailedError extends Error {
  readonly signature: string;
  constructor(signature: string, cause: unknown) {
    super(`transaction ${signature} failed on-chain: ${JSON.stringify(cause)}`, { cause });
    this.name = 'TransactionFailedError';
    this.signature = signature;
  }
}

/** A bundle that landed with an error (or was rejected) — carries the engine's error object. */
export class BundleFailedError extends Error {
  readonly bundleId: string;
  constructor(bundleId: string, cause: unknown) {
    super(`bundle ${bundleId} failed: ${JSON.stringify(cause)}`, { cause });
    this.name = 'BundleFailedError';
    this.bundleId = bundleId;
  }
}

/**
 * Jito tip floor (lamports), per docs.jito.wtf (verified 2026-06-11). High-demand
 * periods need more — treat as a floor, not a recommendation.
 */
export const MIN_JITO_TIP_LAMPORTS = 1_000;
/** Block-engine hard limit per bundle (docs.jito.wtf, verified 2026-06-11). */
export const MAX_BUNDLE_TXS = 5;

/** A landed bundle's terminal status. */
export interface BundleStatus {
  readonly bundleId: string;
  readonly slot: number | undefined;
  readonly confirmationStatus: Commitment;
}

/** Raw getBundleStatuses entry (snake_case per the block-engine API). */
interface RawBundleStatus {
  readonly bundle_id?: string;
  readonly slot?: number;
  readonly confirmation_status?: Commitment;
  readonly err?: unknown;
}

/** The engine encodes success as `{ Ok: null }` (or no err at all). */
function bundleErrIsOk(err: unknown): boolean {
  if (err === null || err === undefined) return true;
  return typeof err === 'object' && 'Ok' in err && (err as { Ok: unknown }).Ok === null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class TransactionManager {
  private readonly transport: RpcTransport;
  private readonly options: TransactionManagerOptions;
  private readonly defaultCommitment: Commitment;
  private tipAccounts: readonly string[] | undefined;
  readonly fees: PriorityFeeEstimator;

  constructor(transport: RpcTransport, options?: TransactionManagerOptions) {
    this.transport = transport;
    this.options = options ?? {};
    this.defaultCommitment = options?.commitment ?? 'confirmed';
    this.fees = new PriorityFeeEstimator(transport, options?.priorityFee);
  }

  async getLatestBlockhash(commitment?: Commitment): Promise<LatestBlockhash> {
    const resp = await this.transport<{
      result?: { value?: { blockhash: string; lastValidBlockHeight: number } };
    }>({
      payload: {
        jsonrpc: '2.0',
        id: 'rpc-shield-blockhash',
        method: 'getLatestBlockhash',
        params: [{ commitment: commitment ?? this.defaultCommitment }],
      },
    });
    const value = resp.result?.value;
    if (!value) throw new Error('getLatestBlockhash: empty response');
    return { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight };
  }

  private emit(event: TransactionEvent): void {
    if (!this.options.onEvent) return;
    try {
      this.options.onEvent(event);
    } catch {
      // A telemetry listener must never be able to break submission.
    }
  }

  /** Submit a signed base64 tx, routing via Jito when configured, else RPC. */
  async submit(signedTxBase64: string, skipPreflight = false): Promise<string> {
    if (this.options.jito) {
      try {
        const signature = await this.submitViaJito(signedTxBase64);
        this.emit({ type: 'submitted', route: 'jito' });
        return signature;
      } catch (err) {
        if (this.options.jito.fallbackToRpc === false) throw err;
        this.emit({ type: 'jito_fallback' });
        // fall through to RPC submission
      }
    }
    const signature = await this.submitViaRpc(signedTxBase64, skipPreflight);
    this.emit({ type: 'submitted', route: 'rpc' });
    return signature;
  }

  private async submitViaRpc(signedTxBase64: string, skipPreflight: boolean): Promise<string> {
    const resp = await this.transport<{ result?: string; error?: unknown }>({
      payload: {
        jsonrpc: '2.0',
        id: 'rpc-shield-send',
        method: 'sendTransaction',
        params: [
          signedTxBase64,
          { encoding: 'base64', skipPreflight, preflightCommitment: this.defaultCommitment, maxRetries: 0 },
        ],
      },
    });
    if (typeof resp.result !== 'string') throw new Error('sendTransaction: no signature returned');
    return resp.result;
  }

  /** POST a JSON-RPC call to the configured block engine. */
  private async jitoRpc<T>(path: string, method: string, params: unknown[]): Promise<T> {
    const cfg = this.options.jito;
    if (!cfg) throw new Error(`jito ${method}: options.jito.blockEngineUrl is not configured`);
    const res = await fetch(`${cfg.blockEngineUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`jito ${method}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw new Error(`jito ${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
    if (body.result === undefined) throw new Error(`jito ${method}: empty result`);
    return body.result;
  }

  /**
   * Submit through the Jito block-engine relay (`/api/v1/transactions`).
   * The relay always runs with skip_preflight on its side; revert detection
   * still happens in confirm() via signature status.
   */
  private async submitViaJito(signedTxBase64: string): Promise<string> {
    return this.jitoRpc<string>('/api/v1/transactions', 'sendTransaction', [
      signedTxBase64,
      { encoding: 'base64' },
    ]);
  }

  /**
   * Tip accounts straight from the block engine (`getTipAccounts`) — fetched
   * once and cached. Dynamic fetch instead of a hardcoded list: tip accounts
   * are operational data owned by Jito, and a stale hardcode misroutes tips.
   */
  async getTipAccounts(): Promise<readonly string[]> {
    if (!this.tipAccounts) {
      const accounts = await this.jitoRpc<string[]>('/api/v1/getTipAccounts', 'getTipAccounts', []);
      if (accounts.length === 0) throw new Error('jito getTipAccounts: empty list');
      this.tipAccounts = accounts;
    }
    return this.tipAccounts;
  }

  /** Random tip account per docs guidance — spreads write-lock contention. */
  async pickTipAccount(): Promise<string> {
    const accounts = await this.getTipAccounts();
    return accounts[Math.floor(Math.random() * accounts.length)]!;
  }

  /**
   * Submit an atomic bundle (1..5 signed txs, executed in order, all-or-nothing).
   * The tip transfer (≥ MIN_JITO_TIP_LAMPORTS to pickTipAccount()) belongs INSIDE
   * one of the transactions — same-tx placement means a failed bundle pays no tip.
   * Returns the engine's bundle id.
   */
  async submitBundle(signedTxsBase64: ReadonlyArray<string>): Promise<string> {
    if (signedTxsBase64.length < 1 || signedTxsBase64.length > MAX_BUNDLE_TXS) {
      throw new RangeError(`bundle must contain 1..${MAX_BUNDLE_TXS} transactions, got ${signedTxsBase64.length}`);
    }
    const bundleId = await this.jitoRpc<string>('/api/v1/bundles', 'sendBundle', [
      signedTxsBase64,
      { encoding: 'base64' },
    ]);
    this.emit({ type: 'bundle_submitted', txCount: signedTxsBase64.length });
    return bundleId;
  }

  /** Poll getBundleStatuses until the target commitment, an error, or timeout. */
  async confirmBundle(
    bundleId: string,
    opts?: { commitment?: Commitment; timeoutMs?: number; pollIntervalMs?: number },
  ): Promise<BundleStatus | { timedOut: true }> {
    const target = opts?.commitment ?? this.defaultCommitment;
    const startedAt = Date.now();
    const deadline = startedAt + (opts?.timeoutMs ?? 30_000);
    const pollMs = opts?.pollIntervalMs ?? 1_000;

    while (Date.now() < deadline) {
      const value = await this.jitoRpc<{ value?: Array<RawBundleStatus | null> }>(
        '/api/v1/getBundleStatuses',
        'getBundleStatuses',
        [[bundleId]],
      );
      const st = value.value?.[0];
      if (st) {
        if (!bundleErrIsOk(st.err)) {
          this.emit({ type: 'bundle_outcome', outcome: 'failed', elapsedMs: Date.now() - startedAt });
          throw new BundleFailedError(bundleId, st.err);
        }
        const status = st.confirmation_status;
        if (status && COMMITMENT_RANK[status] >= COMMITMENT_RANK[target]) {
          this.emit({ type: 'bundle_outcome', outcome: 'landed', elapsedMs: Date.now() - startedAt });
          return { bundleId, slot: st.slot, confirmationStatus: status };
        }
      }
      await sleep(pollMs);
    }
    this.emit({ type: 'bundle_outcome', outcome: 'timed_out', elapsedMs: Date.now() - startedAt });
    return { timedOut: true };
  }

  /** submitBundle + confirmBundle; throws on failure or timeout. */
  async sendBundleAndConfirm(
    signedTxsBase64: ReadonlyArray<string>,
    opts?: { commitment?: Commitment; timeoutMs?: number; pollIntervalMs?: number },
  ): Promise<BundleStatus> {
    const bundleId = await this.submitBundle(signedTxsBase64);
    const result = await this.confirmBundle(bundleId, opts);
    if ('timedOut' in result) {
      throw new Error(`bundle ${bundleId} not landed within ${opts?.timeoutMs ?? 30_000}ms`);
    }
    return result;
  }

  /** Poll signature status until target commitment, blockhash expiry, or timeout. */
  async confirm(
    signature: string,
    lastValidBlockHeight: number,
    opts?: { commitment?: Commitment; timeoutMs?: number; pollIntervalMs?: number },
  ): Promise<ConfirmResult | { expired: true } | { timedOut: true }> {
    const target = opts?.commitment ?? this.defaultCommitment;
    const startedAt = Date.now();
    const deadline = startedAt + (opts?.timeoutMs ?? 30_000);
    const pollMs = opts?.pollIntervalMs ?? 2_000;

    while (Date.now() < deadline) {
      const statuses = await this.transport<{
        result?: { value?: Array<{ confirmationStatus?: Commitment; err: unknown; slot?: number } | null> };
      }>({
        payload: {
          jsonrpc: '2.0',
          id: 'rpc-shield-status',
          method: 'getSignatureStatuses',
          params: [[signature], { searchTransactionHistory: false }],
        },
      });
      const st = statuses.result?.value?.[0];
      if (st) {
        if (st.err) {
          this.emit({ type: 'confirm_outcome', outcome: 'reverted', elapsedMs: Date.now() - startedAt });
          throw new TransactionFailedError(signature, st.err);
        }
        const status = st.confirmationStatus;
        if (status && COMMITMENT_RANK[status] >= COMMITMENT_RANK[target]) {
          this.emit({ type: 'confirm_outcome', outcome: 'confirmed', elapsedMs: Date.now() - startedAt });
          return { signature, slot: st.slot, confirmationStatus: status };
        }
      } else {
        // not yet seen — check whether the blockhash has expired
        const height = await this.getBlockHeight(target);
        if (height > lastValidBlockHeight) {
          this.emit({ type: 'confirm_outcome', outcome: 'expired', elapsedMs: Date.now() - startedAt });
          return { expired: true };
        }
      }
      await sleep(pollMs);
    }
    this.emit({ type: 'confirm_outcome', outcome: 'timed_out', elapsedMs: Date.now() - startedAt });
    return { timedOut: true };
  }

  private async getBlockHeight(commitment: Commitment): Promise<number> {
    const resp = await this.transport<{ result?: number }>({
      payload: { jsonrpc: '2.0', id: 'rpc-shield-height', method: 'getBlockHeight', params: [{ commitment }] },
    });
    return resp.result ?? 0;
  }

  /**
   * Full lifecycle: build → submit → confirm, refreshing the blockhash and
   * rebuilding the tx on expiry. Throws TransactionFailedError on a real revert.
   */
  async sendAndConfirm(opts: SendAndConfirmOptions): Promise<ConfirmResult> {
    const commitment = opts.commitment ?? this.defaultCommitment;
    const maxAttempts = opts.maxAttempts ?? 3;
    let lastOutcome: 'expired' | 'timedOut' | 'none' = 'none';

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const blockhash = await this.getLatestBlockhash(commitment);
      const signedTx = await opts.buildSignedTx(blockhash);
      const signature = await this.submit(signedTx, opts.skipPreflight ?? false);
      const result = await this.confirm(signature, blockhash.lastValidBlockHeight, {
        commitment,
        ...(opts.confirmTimeoutMs !== undefined ? { timeoutMs: opts.confirmTimeoutMs } : {}),
        ...(opts.pollIntervalMs !== undefined ? { pollIntervalMs: opts.pollIntervalMs } : {}),
      });

      if ('confirmationStatus' in result) return result;
      lastOutcome = 'expired' in result ? 'expired' : 'timedOut';
      // expired or timed out → loop refreshes blockhash and rebuilds the tx
    }
    throw new Error(`sendAndConfirm: not confirmed after ${maxAttempts} attempt(s) (last: ${lastOutcome})`);
  }
}
