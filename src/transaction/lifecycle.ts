/**
 * Transaction lifecycle engine — the canonical Solana landing recipe as a
 * state machine, shared by TransactionManager (keypair path) and
 * WalletPipeline (wallet path).
 *
 * The recipe (Solana docs "Retrying Transactions" + Helius "How to Land
 * Transactions"): submit with `maxRetries: 0`, re-broadcast the SAME signed
 * bytes on a leader-rotation-scale cadence, and re-sign ONLY after the
 * blockhash's death has been *verified* — never on a wall-clock timeout.
 *
 * Core invariant: the only path to a new signature (epoch n+1) is two
 * all-null full-history status sweeps over EVERY signature this lifecycle
 * ever submitted, separated by `deathGraceMs`. A timeout is terminal — the
 * transaction may still land, so signing a replacement would risk both
 * landing (the classic double-send). Every poll covers ALL tracked
 * signatures, so an older epoch's transaction landing late is detected and
 * returned instead of being double-spent.
 *
 * The clock is injectable so property-based tests can drive thousands of
 * randomized schedules in virtual time.
 */

import {
  RpcSubmitError,
  TransactionExpiredError,
  TransactionFailedError,
  TransactionTimedOutError,
} from './errors.js';
import type { Commitment, ConfirmResult, LatestBlockhash } from './transaction-manager.js';

const COMMITMENT_RANK: Record<Commitment, number> = { processed: 0, confirmed: 1, finalized: 2 };

/** Injectable time source — real by default, virtual in fuzz tests. */
export interface LifecycleClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const REAL_CLOCK: LifecycleClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** One signature-status entry as the RPC reports it (aligned with the request order). */
export interface SignatureStatusEntry {
  readonly confirmationStatus?: Commitment;
  readonly err: unknown;
  readonly slot?: number;
}

/** What the engine needs from the outside world — implemented by TransactionManager. */
export interface LifecycleDeps {
  getLatestBlockhash(commitment: Commitment): Promise<LatestBlockhash>;
  /** Submit wire bytes (base64); resolves the signature. */
  submit(wire: string, skipPreflight: boolean): Promise<string>;
  /** Statuses for signatures, ALIGNED with the input order; null = not seen. */
  getStatuses(
    signatures: readonly string[],
    searchHistory: boolean,
  ): Promise<ReadonlyArray<SignatureStatusEntry | null>>;
  getBlockHeight(commitment: Commitment): Promise<number>;
  /**
   * Derive the transaction signature from the signed wire WITHOUT a node —
   * how the engine recovers when submit answers "already been processed"
   * (the ledger has these bytes; the error body has no signature). Optional:
   * without it the verdict surfaces verbatim, the pre-0.3.0 behavior.
   */
  deriveSignature?(wire: string): string | null;
  clock?: LifecycleClock;
}

export type LifecycleEvent =
  | { readonly type: 'epoch_started'; readonly epoch: number; readonly blockhash: string }
  | { readonly type: 'submitted'; readonly signature: string; readonly epoch: number }
  | { readonly type: 'already_processed'; readonly signature: string; readonly epoch: number }
  | {
      readonly type: 'submit_retry';
      readonly epoch: number;
      readonly attempt: number;
      readonly code: number | undefined;
      readonly message: string;
    }
  | { readonly type: 'rebroadcast'; readonly signature: string; readonly count: number }
  | { readonly type: 'rebroadcast_error'; readonly signature: string; readonly message: string }
  | { readonly type: 'expiry_suspected'; readonly signature: string; readonly blockHeight: number }
  | { readonly type: 'death_sweep'; readonly checked: number; readonly landed: string | null }
  | { readonly type: 'death_verified'; readonly epoch: number }
  | {
      readonly type: 'confirmed';
      readonly signature: string;
      readonly slot: number | undefined;
      readonly epoch: number;
      readonly viaSweep: boolean;
    }
  | { readonly type: 'reverted'; readonly signature: string }
  | { readonly type: 'expired_final'; readonly signatures: readonly string[] }
  | { readonly type: 'timed_out'; readonly signatures: readonly string[] };

export interface LifecycleOptions {
  /** Build + sign the wire (base64) for a blockhash. Called once per epoch. */
  getSignedTx(blockhash: LatestBlockhash, epoch: number): Promise<string>;
  readonly commitment: Commitment;
  /** Max blockhash epochs (distinct signatures). Ignored for durableNonce. */
  readonly maxEpochs: number;
  /** Allow a fresh signature after VERIFIED death. False = throw instead. */
  readonly resignOnExpiry: boolean;
  /** Per-epoch budget (ms), including rebroadcasts. Should exceed blockhash lifetime. */
  readonly confirmTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly rebroadcastIntervalMs: number;
  readonly skipPreflightFirstSend: boolean;
  /** Extra submit attempts when preflight reports BlockhashNotFound. */
  readonly submitRetries: number;
  readonly submitRetryDelayMs: number;
  /** Gap between the two death-verification sweeps. */
  readonly deathGraceMs: number;
  /**
   * Extra blocks past lastValidBlockHeight before expiry is even SUSPECTED.
   * Nodes skew a few blocks apart; trusting a single ahead-running node's
   * height invites a premature death verdict while the inclusion window is
   * still open cluster-wide. Default 2 (~0.8s of insurance).
   */
  readonly expirySafetyBlocks?: number;
  /**
   * 'blockhash': height-based expiry applies. 'durableNonce': the tx never
   * expires — no expiry checks, no re-sign; budget + final sweep only.
   */
  readonly lifetime: 'blockhash' | 'durableNonce';
  readonly onEvent?: (event: LifecycleEvent) => void;
}

/** Normalized view over both submit-error shapes (our fetch transport's error body via RpcSubmitError, or a kit-style thrown decoded error). */
export function normalizeSubmitError(err: unknown): {
  code: number | undefined;
  message: string;
  isBlockhashNotFound: boolean;
  isAlreadyProcessed: boolean;
} {
  let code: number | undefined;
  let message: string;
  let dataErr: unknown;
  if (err instanceof RpcSubmitError) {
    code = err.code;
    message = err.message;
    dataErr = (err.data as { err?: unknown } | undefined)?.err;
  } else if (typeof err === 'object' && err !== null) {
    const o = err as { code?: unknown; message?: unknown; data?: { err?: unknown } };
    code = typeof o.code === 'number' ? o.code : undefined;
    message = typeof o.message === 'string' ? o.message : JSON.stringify(err);
    dataErr = o.data?.err;
  } else {
    message = String(err);
  }
  const text = message.toLowerCase();
  return {
    code,
    message,
    isBlockhashNotFound: text.includes('blockhash not found') || dataErr === 'BlockhashNotFound',
    isAlreadyProcessed: text.includes('already been processed') || text.includes('alreadyprocessed'),
  };
}

interface Tracked {
  readonly signature: string;
  readonly epoch: number;
  readonly wire: string;
  readonly lastValidBlockHeight: number;
}

type PollOutcome =
  | { kind: 'confirmed'; result: ConfirmResult; viaSweep: boolean }
  | { kind: 'reverted'; signature: string; err: unknown }
  | { kind: 'visible' } // seen on-chain below target commitment — keep polling, do NOT declare death
  | { kind: 'none' };

export async function runTxLifecycle(deps: LifecycleDeps, opts: LifecycleOptions): Promise<ConfirmResult> {
  const clock = deps.clock ?? REAL_CLOCK;
  const emit = (event: LifecycleEvent): void => {
    try {
      opts.onEvent?.(event);
    } catch {
      // Listeners must never break the lifecycle.
    }
  };

  const tracked: Tracked[] = [];
  const allSignatures = (): string[] => tracked.map((t) => t.signature);

  async function pollAll(searchHistory: boolean): Promise<PollOutcome> {
    const sigs = allSignatures();
    const statuses = await deps.getStatuses(sigs, searchHistory);
    let visible = false;
    for (let i = 0; i < sigs.length; i++) {
      const st = statuses[i];
      if (!st) continue;
      if (st.err) return { kind: 'reverted', signature: sigs[i]!, err: st.err };
      const status = st.confirmationStatus;
      if (status && COMMITMENT_RANK[status] >= COMMITMENT_RANK[opts.commitment]) {
        return {
          kind: 'confirmed',
          viaSweep: searchHistory,
          result: { signature: sigs[i]!, slot: st.slot, confirmationStatus: status },
        };
      }
      visible = true;
    }
    return visible ? { kind: 'visible' } : { kind: 'none' };
  }

  /** Terminal handling shared by every sweep site. Returns null when nothing landed. */
  function settleFromPoll(outcome: PollOutcome, epoch: number): ConfirmResult | null {
    if (outcome.kind === 'confirmed') {
      emit({
        type: 'confirmed',
        signature: outcome.result.signature,
        slot: outcome.result.slot,
        epoch,
        viaSweep: outcome.viaSweep,
      });
      return outcome.result;
    }
    if (outcome.kind === 'reverted') {
      emit({ type: 'reverted', signature: outcome.signature });
      throw new TransactionFailedError(outcome.signature, outcome.err);
    }
    return null;
  }

  async function submitWithRetry(wire: string, epoch: number): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await deps.submit(wire, opts.skipPreflightFirstSend);
      } catch (err) {
        const n = normalizeSubmitError(err);
        if (n.isAlreadyProcessed) {
          // "Already been processed" is a SUCCESS signal, not a failure: the
          // ledger has these exact bytes (an earlier run, another process, a
          // wallet's own send, or our own request whose response was lost).
          // The error body carries no signature, so derive it locally and let
          // the poll loop confirm honestly — throwing here would report
          // failure for a transaction that LANDED.
          const sig = deps.deriveSignature?.(wire) ?? null;
          if (sig !== null) {
            emit({ type: 'already_processed', signature: sig, epoch });
            return sig;
          }
          // No derivation available (exotic wire shape) — surface the node's
          // verdict verbatim rather than guess.
        }
        if (!n.isBlockhashNotFound || attempt >= opts.submitRetries) throw err;
        // A lagging node preflighted against a bank that doesn't know this
        // blockhash yet — retry routes through (likely) another node.
        emit({ type: 'submit_retry', epoch, attempt: attempt + 1, code: n.code, message: n.message });
        await clock.sleep(opts.submitRetryDelayMs);
      }
    }
  }

  const maxEpochs = opts.lifetime === 'durableNonce' ? 1 : Math.max(1, opts.maxEpochs);

  for (let epoch = 0; epoch < maxEpochs; epoch++) {
    const blockhash = await deps.getLatestBlockhash(opts.commitment);
    emit({ type: 'epoch_started', epoch, blockhash: blockhash.blockhash });
    const wire = await opts.getSignedTx(blockhash, epoch);
    const signature = await submitWithRetry(wire, epoch);
    tracked.push({ signature, epoch, wire, lastValidBlockHeight: blockhash.lastValidBlockHeight });
    emit({ type: 'submitted', signature, epoch });

    const epochDeadline = clock.now() + opts.confirmTimeoutMs;
    let lastSendAt = clock.now();
    let rebroadcasts = 0;
    let deathVerified = false;

    epochLoop: while (!deathVerified && clock.now() < epochDeadline) {
      const polled = await pollAll(false);
      const settled = settleFromPoll(polled, epoch);
      if (settled) return settled;

      // Expiry is only *suspected* here: the status node may simply not have
      // seen the tx, and the height node may run ahead (different nodes under
      // weighted routing). Death must be verified before anything destructive.
      if (polled.kind === 'none' && opts.lifetime === 'blockhash') {
        const height = await deps.getBlockHeight(opts.commitment);
        if (height > blockhash.lastValidBlockHeight + (opts.expirySafetyBlocks ?? 2)) {
          emit({ type: 'expiry_suspected', signature, blockHeight: height });
          for (let sweep = 0; sweep < 2; sweep++) {
            if (sweep > 0) await clock.sleep(opts.deathGraceMs);
            const swept = await pollAll(true);
            const result = settleFromPoll(swept, epoch);
            if (result) return result;
            if (swept.kind === 'visible') continue epochLoop; // landed below target — keep confirming
            emit({ type: 'death_sweep', checked: tracked.length, landed: null });
          }
          emit({ type: 'death_verified', epoch });
          deathVerified = true;
          break;
        }
      }

      if (clock.now() - lastSendAt >= opts.rebroadcastIntervalMs) {
        // Same signed bytes — signature-idempotent, so duplicates are impossible.
        // Errors here are non-authoritative ("already processed" is expected
        // once landed); the status poll above is the source of truth.
        try {
          await deps.submit(wire, true);
          rebroadcasts++;
          emit({ type: 'rebroadcast', signature, count: rebroadcasts });
        } catch (err) {
          emit({
            type: 'rebroadcast_error',
            signature,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        lastSendAt = clock.now();
      }

      await clock.sleep(opts.pollIntervalMs);
    }

    if (!deathVerified) {
      // Budget exhausted while the blockhash may still be valid: TERMINAL.
      // A final full-history sweep catches a landed-but-not-yet-polled tx;
      // beyond that, re-signing would risk a double-send.
      const final = await pollAll(true);
      const result = settleFromPoll(final, epoch);
      if (result) return result;
      emit({ type: 'timed_out', signatures: allSignatures() });
      throw new TransactionTimedOutError(allSignatures(), opts.confirmTimeoutMs);
    }

    if (!opts.resignOnExpiry || epoch + 1 >= maxEpochs) {
      emit({ type: 'expired_final', signatures: allSignatures() });
      throw new TransactionExpiredError(allSignatures(), epoch + 1);
    }
    // verified death + resign allowed → next epoch builds against a fresh blockhash
  }

  // Unreachable: every epoch either returns or throws above.
  throw new TransactionExpiredError(allSignatures(), maxEpochs);
}
