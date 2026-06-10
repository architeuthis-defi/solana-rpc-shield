# solana-rpc-shield

**Resilient RPC + transaction-reliability SDK for Solana dApps.** A drop-in layer over `@solana/web3.js` v2 that keeps dApps online when individual RPC nodes degrade, lag, or drop — and lands transactions reliably under congestion.

> Built for the Superteam Ukraine bounty *"Build SDK that improves RPC and transaction reliability for Solana dApps."* Targets the four judging axes directly: **Correctness · Resilience · Developer Experience · Tests.**

---

## The problem

Solana dApps that point at a single RPC endpoint inherit that endpoint's worst moment: a stalled slot, a rate-limit, a regional outage, a dropped websocket. Transaction submission compounds it — a stale blockhash, an under-priced fee, or a node that silently drops the send leaves users staring at a spinner. Most teams hand-roll ad-hoc retries that mask the failure mode instead of routing around it.

`solana-rpc-shield` makes resilience the default: requests are scored and routed across a pool of endpoints in real time, and transactions are submitted through a confirmation-aware pipeline with Jito relay routing and dynamic fees.

## Design: ride the v2 transport seam, don't fight it

`@solana/web3.js` v2 exposes a **pluggable RPC transport** — `createSolanaRpc({ transport })`. That seam is the whole design. The SDK is a *composite transport* that wraps N endpoint transports with health scoring and failover, so it composes cleanly with the standard `createSolanaRpc` API instead of replacing it. No fork of the RPC client, no monkey-patching.

```ts
import { createSolanaRpc } from '@solana/web3.js';
import { createResilientTransport } from 'solana-rpc-shield';

const transport = createResilientTransport({
  endpoints: [
    'https://your-primary.rpc',
    'https://your-secondary.rpc',
    'https://your-tertiary.rpc',
  ],
});

const rpc = createSolanaRpc({ transport });
// use `rpc` exactly like a normal v2 RPC — failover is transparent
```

## Architecture (→ judging axis)

| Module | Responsibility | Judging axis |
|---|---|---|
| `transport/` — `ResilientTransport` | Multi-endpoint pool, per-node health score (latency EWMA · slot-lag · error-rate), circuit-breaker, weighted routing + automatic failover | **Resilience** |
| `transaction/` — `TransactionManager` | Confirmation-aware submit: Jito bundle/relay routing with RPC fallback, dynamic priority-fee estimation, retry with blockhash refresh, status tracking | **Correctness** |
| `observability/` | OpenTelemetry metrics — request latency p50/p95/p99, failover/circuit-break events, tx success rate, per-endpoint health gauges | **Developer Experience** |
| `cli/` — `rpc-shield` | Diagnostics: `health` (live endpoint scoreboard), `bench` (latency/throughput compare), `simulate-drop` (inject failures, watch failover) | **Developer Experience** |
| `test/sim/` | Deterministic mock RPC injecting network-drop / latency / slot-lag; ≥90% coverage incl. failure paths | **Tests** |

## Health scoring (the core of Resilience)

Each endpoint carries a rolling score; the router prefers the healthiest live node and trips a circuit breaker on sustained failure, re-probing on a backoff.

- **Latency** — EWMA of round-trip time per request.
- **Slot lag** — distance of the node's latest slot behind the freshest seen across the pool (a node serving stale state is "up" but wrong).
- **Error rate** — windowed failure ratio (timeouts, 5xx, rate-limits classified distinctly).
- **Circuit breaker** — N consecutive failures → endpoint quarantined for a backoff interval, then half-open probe.

Slot-lag is the non-obvious one: a node can answer fast and still serve state seconds behind the cluster. Scoring on lag, not just liveness, is what separates this from a naive round-robin.

## Transaction reliability (the core of Correctness)

- **Jito relay routing** with RPC fallback — submit via Jito block-engine when configured; fall back to the resilient RPC pool on relay failure. (Never `skipPreflight` blindly; never a fixed fee.)
- **Dynamic priority fee** — estimate from recent prioritization fees, clamped to a floor/ceiling.
- **Retry with blockhash refresh** — re-fetch a fresh blockhash on expiry rather than resubmitting a dead transaction.
- **Confirmation tracking** — poll signature status to a target commitment with bounded timeout; surface the real revert reason on failure, never an empty catch.

## CLI

```
rpc-shield health   --endpoints <a,b,c>     # live per-node scoreboard
rpc-shield bench    --endpoints <a,b,c>     # latency / throughput compare
rpc-shield simulate-drop --endpoint <a>     # inject failure, observe failover
```

## Status & build plan (13-day, deadline 2026-06-23)

- [x] D1-2 — scaffold + `ResilientTransport` (pool + health scoring)  ← **in progress**
- [ ] D3-4 — failover + circuit-breaker + slot-lag health monitor
- [ ] D5-6 — `TransactionManager` (Jito routing + dynamic fee + retry/confirm)
- [ ] D7-8 — OpenTelemetry export + `rpc-shield` CLI
- [ ] D9-10 — simulation test harness, ≥90% coverage
- [ ] D11-12 — docs, runnable examples, polish
- [ ] D13 — buffer + final scope verification with sponsor

## Development

```bash
npm install
npm run dev        # watch build
npm test           # vitest
npm run test:cov   # coverage
npm run cli -- health --endpoints https://api.mainnet-beta.solana.com
```

## License

MIT
