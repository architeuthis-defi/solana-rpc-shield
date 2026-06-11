/**
 * Transaction error vocabulary — one module so the lifecycle engine and the
 * TransactionManager can share classes without a runtime import cycle.
 * (`transaction-manager.ts` re-exports everything here for backward compat.)
 */

/** A genuine on-chain failure (revert) — carries the program error, not a node fault. */
export class TransactionFailedError extends Error {
  readonly signature: string;
  constructor(signature: string, cause: unknown) {
    super(`transaction ${signature} failed on-chain: ${JSON.stringify(cause)}`, { cause });
    this.name = 'TransactionFailedError';
    this.signature = signature;
  }
}

/**
 * `sendTransaction` answered with a JSON-RPC error body — surfaced VERBATIM
 * (code, message, simulation logs) instead of a generic "no signature" string.
 * The single most common shape is preflight failure, e.g. code -32002
 * "Blockhash not found" from a node that lags the blockhash source.
 */
export class RpcSubmitError extends Error {
  readonly code: number | undefined;
  readonly logs: readonly string[] | undefined;
  readonly data: unknown;
  /** The raw JSON-RPC error object, untouched. */
  readonly raw: unknown;
  constructor(args: { code?: number; message: string; data?: unknown; raw: unknown }) {
    super(`sendTransaction failed${args.code !== undefined ? ` (${args.code})` : ''}: ${args.message}`);
    this.name = 'RpcSubmitError';
    this.code = args.code;
    this.data = args.data;
    this.raw = args.raw;
    const logs = (args.data as { logs?: unknown } | undefined)?.logs;
    this.logs = Array.isArray(logs) ? (logs as string[]) : undefined;
  }
}

/**
 * Every submitted signature's blockhash provably expired without landing —
 * verified by repeated full-history sweeps, never by a wall-clock guess.
 * Carries ALL signatures this lifecycle ever submitted so callers can keep
 * watching them out-of-band if they choose.
 */
export class TransactionExpiredError extends Error {
  readonly signatures: readonly string[];
  constructor(signatures: readonly string[], attempts: number) {
    super(
      `transaction not confirmed after ${attempts} attempt(s) (last: expired); ` +
        `submitted signature(s): ${signatures.join(', ')}`,
    );
    this.name = 'TransactionExpiredError';
    this.signatures = signatures;
  }
}

/**
 * The confirmation budget ran out while the blockhash was still valid.
 * Deliberately terminal: re-signing on a timeout is how double-sends happen —
 * the transaction may still land. All submitted signatures are attached.
 */
export class TransactionTimedOutError extends Error {
  readonly signatures: readonly string[];
  constructor(signatures: readonly string[], timeoutMs: number) {
    super(
      `transaction not confirmed within ${timeoutMs}ms (blockhash still valid — it may yet land); ` +
        `submitted signature(s): ${signatures.join(', ')}`,
    );
    this.name = 'TransactionTimedOutError';
    this.signatures = signatures;
  }
}
