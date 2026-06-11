# Changelog

## 0.2.0 — 2026-06-11

The correctness release: the transaction lifecycle now implements the
canonical Solana landing recipe end-to-end, with the double-send class of
bugs eliminated and proven by property-based fuzzing.

### Breaking (behavioral)

- **`sendAndConfirm` never re-signs without verified death.** Previously a
  30s confirm timeout triggered a rebuild with a fresh blockhash while the
  old transaction (~60-90s blockhash lifetime) could still land — the classic
  double-send. Now: re-signing requires two all-null full-history status
  sweeps (separated by `deathGraceMs`) over **every** signature the call ever
  submitted. A timeout is terminal (`TransactionTimedOutError`) — worst-case
  latency ceiling at defaults is ~3.1 min instead of 90s, in exchange for the
  funds-loss class being gone.
- `confirmTimeoutMs` default 30s → **60s** and now means the per-epoch budget
  (it must exceed the blockhash lifetime for expiry to be verifiable).
- Submit failures with a JSON-RPC error body now throw **`RpcSubmitError`**
  (code, message, simulation logs — verbatim) instead of a generic
  `'no signature returned'` string.
- Terminal failures are typed: **`TransactionExpiredError`** /
  **`TransactionTimedOutError`**, both carrying all submitted signatures.
  Messages keep the old regex-matchable phrasing.
- A caller's `AbortSignal` firing now surfaces the abort directly (no
  failover, no `all N endpoint attempt(s) failed` wrapper) and **does not
  penalise endpoint health** — three page navigations no longer trip every
  circuit breaker.
- The keypair path now **re-broadcasts the same signed bytes** every
  `rebroadcastIntervalMs` (default 2s — leader-rotation scale). Expect more
  `sendTransaction` calls on slow confirmations.

### Added

- `src/transaction/lifecycle.ts` — shared lifecycle engine (signature-set
  tracking, verified-death state machine, bounded submit retry on
  `Blockhash not found` in both wire shapes, injectable clock,
  `expirySafetyBlocks` guard against ahead-running height counters,
  `durableNonce` lifetime mode at the engine level).
- `TransactionManager.getSignatureStatuses(sigs, { searchTransactionHistory })`
  and `getBlockHeight(commitment)` are now public.
- `SendAndConfirmOptions`: `rebroadcastIntervalMs`, `resignOnExpiry`,
  `submitRetries`, `deathGraceMs`.
- `JitoConfig.requestTimeoutMs` — a hung block engine can no longer hang
  `submit()` (AbortSignal.timeout on every engine call).
- `PriorityFeeConfig.source` — pluggable **external fee source** (provider
  percentile APIs); result still clamped to floor/ceiling.
- `WalletPipelineOptions.deathGraceMs`; `WalletTransactionExpiredError.signatures`.
- Events: `rebroadcast`, `death_sweep` (manager); `request_aborted` (transport).
- Test infrastructure: cross-node consistency cluster simulator,
  property-based lifecycle fuzz (fast-check, ~500 randomized schedules/run,
  invariant: never double-lands), deterministic landing-rate A/B
  (`npm run sim:landing`).

### Fixed

- False-expiry verdicts assembled from two diverging nodes (status-blind +
  ahead height counter) no longer kill live transactions.
- `combineSignals` listener leak on long-lived caller signals.
- Wallet path: a transaction that lands during death verification is
  returned — the user is never re-prompted for a landed transfer.

## 0.1.0 — 2026-06-11

Initial release: health-scored composite transport (weighted routing,
circuit breakers, slot-lag demotion), TransactionManager (Jito relay +
atomic bundles + dynamic tips, dynamic priority fees), wallet sign-once
pipeline, OpenTelemetry exporter, 5-command diagnostics CLI, real-server
network simulations at 98%+ coverage.
