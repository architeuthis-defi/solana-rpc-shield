# Changelog

## 0.3.1 — 2026-06-12

### Fixed

- **The engine now survives kit/web3.js v2 native transports (bigint
  boundary).** The README-recommended setup — `transportFactory:
  createDefaultRpcTransport` — parses every JSON number as `bigint` (u64
  wire semantics), and three things quietly assumed `number`:
  the lifecycle's expiry math crashed mid-confirm with `Cannot mix BigInt
  and other types` (caught by running the keypair example against live
  devnet); the fee estimator silently discarded every bigint sample
  (`Number.isFinite(bigint)` is `false`) and always returned the floor; the
  slot monitor silently failed every probe and froze slot-lag scoring at
  zero. All numeric RPC fields are now normalized at the transport boundary
  (`rpcNumber`) — slots, heights and per-CU fees sit far below 2^53, so the
  conversion is lossless. Regression-gated by a full
  TransactionManager-over-native-transport e2e in the kit/web3.js matrix,
  and verified live: a devnet transfer through the full pipeline confirms
  in ~2s.

## 0.3.0 — 2026-06-12

### Added

- **"Already been processed" is now a success signal, not a failure.** When
  a submit answers that the ledger already has these exact bytes (an earlier
  run, another process, a wallet's own send), the engine derives the
  signature locally — `signatureOfWire`, base58 of bytes [1..65) of the
  signed wire; the node's error body carries no signature — tracks it, and
  lets the poll loop confirm the landed transaction honestly. Previously
  this threw `RpcSubmitError` *for a transaction that landed*: the exact
  lie-to-the-user class this engine exists to kill, and the push that makes
  users retry and double-spend. Both paths (keypair + wallet) get it via the
  shared engine; the wallet user is never re-prompted.
- `signatureOfWire` / `toBase58` exported — derive a transaction's signature
  from its signed bytes without asking a node (works in Node and browsers,
  cross-checked against `@solana/kit`'s base58 on a real mainnet wire).
- New fuzz property: an external pre-submitter racing our first send
  ("already been processed") can produce neither a false failure nor a
  double-land — ~650 randomized cluster schedules per CI run now.
- `LifecycleDeps.deriveSignature` seam + `already_processed` lifecycle event
  (observable in telemetry).

## 0.2.1 — 2026-06-11

### Changed

- **`confirmTimeoutMs` default 60s → 120s.** The per-epoch budget must
  *exceed* the blockhash lifetime (~60-90s) or expiry can never be verified
  inside the budget — 60s contradicted the field's own documentation and
  turned slow-landing epochs into terminal timeouts instead of
  verified-expiry re-signs. Worst-case wall-clock at defaults grows
  accordingly; a timeout remains terminal.

### Fixed

- **CLI `tx` is now chain-aware.** In a mixed-chain pool (mainnet + devnet —
  the misconfiguration class the chain-mismatch detector warns about) a
  single routed read could land on the wrong chain and return an
  authoritative-looking `NOT FOUND` for a transaction finalized on the other
  one; the node answered successfully, so no failover fired. `tx` now groups
  endpoints by genesis hash and checks the signature on **every** chain:
  found → status plus chain attribution, missing → `NOT FOUND on any of N
  chains`, with fully-dead chain groups reported as unreachable instead of
  silenced. Caught by running the README examples against live nodes.
- **The `tx` genesis probe and per-chain lookups are time-bounded (5s).**
  The probe was the only node-facing fetch in the codebase without an abort
  signal — a connected-but-stalling node would hang the command forever
  (a hang is not a rejection: try/catch can't save you, a bound can).
- CLI `--version` reported 0.1.0.

### Added

- The W3 chain-mismatch additions and the standalone `confirm()` verdicts
  arrive covered: SlotMonitor genesis caching/malformed-response/hung-probe
  branches, the weighted-routing float-dust clamp (reproduced with honest
  numbers, no synthetic rng), throwing-listener safety in `WalletPipeline`,
  `confirm()` expired/timed-out verdicts, and the cross-chain + stalling-node
  `tx` scenarios — 158 tests, 98.2% lines / 92.4% branches.

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
