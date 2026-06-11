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

## Ambiguous submit failures (known limit)

A network error on `sendTransaction` is ambiguous: the node may have received
and forwarded the transaction before the connection died. The engine
currently treats a first-submit failure as "not submitted" — which is exactly
right only for pre-acceptance failures.

The complete fix is to **derive the signature locally before submitting**
(the signature is the first 64 bytes of the signed wire — a client never
needs the node's reply to know it) and track it regardless of the submit
outcome. That requires a `signatureOf(wire)` dependency on the engine; the
fuzz model documents the boundary today (network errors are modeled
pre-acceptance). Planned for 0.3.0.

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
