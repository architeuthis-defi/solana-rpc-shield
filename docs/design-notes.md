# Design notes — deliberate seams and known limits

Decisions made consciously, with the seam left where the future
implementation plugs in. Declared limits beat discovered ones.

## Fan-out submission (seam, not yet implemented)

Racing the same signed bytes across K endpoints (and optional extra sender
URLs — Helius Sender, Nozomi-style services) is signature-idempotent and
safe **only** now that the lifecycle tracks every submitted signature. The
planned seam:

- `ResilientTransport.requestMany<T>(request, k)` — capability method racing
  K distinct healthy endpoints via `Promise.any`, feature-detected by the
  lifecycle engine (`'requestMany' in transport`).
- `extraSenders?: string[]` on the manager — bare `sendTransaction` POST
  targets raced alongside the pool for the rebroadcast path only.

Deferred from 0.2.0: expanding the duplicate-submission surface in the same
release that introduces signature tracking would have coupled two risks.

## Ambiguous submit failures (partially closed in 0.3.0)

A first-submit failure used to be treated wholesale as "not submitted". Two
distinct cases hide in there:

- **"Already been processed" — CLOSED (0.3.0).** The node's answer proves the
  ledger has these exact bytes; the error body just doesn't say which
  signature. `signatureOfWire` (src/transaction/wire.ts) derives it locally —
  base58 of bytes [1..65) of the signed wire — the engine tracks it and the
  poll loop confirms the landed transaction honestly. Property-fuzzed: an
  external pre-submitter racing us can no longer produce a false failure or
  a double-land.
- **Silent network drop — still a known limit.** A connection that dies
  mid-`sendTransaction` is ambiguous: the node may have received and
  forwarded the wire before the socket closed, and there is no node verdict
  at all to react to. The complete fix is to track the locally-derived
  signature on EVERY submit regardless of outcome; the machinery now exists,
  but widening the tracked set on ambiguous paths interacts with death
  verification (every tracked signature must be swept) and deserves its own
  release with its own fuzz scenarios. The model documents this boundary
  (network errors are modeled pre-acceptance).

## Durable nonces (modeled in the engine; public surface ships blockhash-first)

The lifecycle engine treats transaction lifetime as a first-class parameter —
`lifetime: 'blockhash' | 'durableNonce'` (src/transaction/lifecycle.ts). Under a
nonce lifetime the rules change shape, and the engine refuses to fake it as
"blockhash with a long deadline": the transaction never expires, so there is no
height-based expiry check, no re-sign path, and exactly one signature ever
exists (`maxEpochs` is forced to 1) — budget and final sweep only. The
double-send class this library exists to kill is eliminated *by construction*
under a durable nonce.

`TransactionManager` pins `lifetime: 'blockhash'` and does not expose the nonce
path publicly yet, deliberately:

- A durable nonce needs an on-chain nonce account: rent, a setup transaction,
  an `AdvanceNonceAccount` instruction that must be instruction zero, and
  strictly serialized use — one in-flight transaction per nonce account.
  Racing two spends of the same nonce is its own double-send class, just
  relocated. A consumer-wallet dApp cannot manage any of that silently on a
  user's behalf.
- Upstream guidance positions durable nonces for offline/custodial signing
  flows, not the interactive dApp path this SDK targets first.
- Exposing the option is an API commitment: nonce-account helpers, fuzz
  scenarios of its own (nonce advanced elsewhere, account closed mid-flight),
  and wallet-path semantics. That deserves its own release, not a flag quietly
  bolted onto `sendAndConfirm`.

So: the engine models it (and the type system keeps the two lifetimes from
blurring); the public surface ships the lifetime that interactive dApps
actually use. The nonce surface is a seam, in the same sense as fan-out above.

## WebSocket subscriptions (out of scope by design)

Two different things hide under "WS support" — they deserve different verdicts:

- **Confirmation truth — never WS, by argument.** `signatureSubscribe`-based
  confirmation has a documented history of lying (solana-labs/solana#23949,
  #25955: subscribe-after-processed races, silent WS drops, missed
  notifications). For a *reliability* library, polling `getSignatureStatuses`
  at 1-2s against a health-scored pool is the docs-recommended,
  strictly-more-robust path — WS would add a second failure domain to the one
  decision that must not be wrong.
- **Data push UX (`accountSubscribe`, slot streams) — out of scope, layerable.**
  A resilient-WS layer (reconnect, resubscribe, failover) is a real dApp need
  and a legitimate future surface; it is orthogonal to landing transactions.
  Layer it on top — the shield's confirmation truth stays poll-based either way.

## SWQoS (stated precisely)

Stake-weighted QoS is a validator/infrastructure property — a client SDK
cannot create it. What the shield does: your endpoint list IS the routing
policy, so pointing an entry at a staked-connection endpoint (or a sender
service) routes submissions through SWQoS that already exists. No overclaim.

## Fee estimation limits

`getRecentPrioritizationFees` returns per-slot **minimums** of landed fees —
a floor heuristic, systematically below the clearing price under congestion.
That is why `PriorityFeeConfig.source` exists: plug a provider percentile API
(e.g. Helius `getPriorityFeeEstimate`) when latency-critical; the result is
still clamped to floor/ceiling so an API outage can't produce a zero or
runaway bid. Compute-unit *limits* are transaction-construction concerns —
use your library's simulation-based estimator (`@solana/kit`'s
`estimateComputeUnitLimitFactory`) when building the tx.
