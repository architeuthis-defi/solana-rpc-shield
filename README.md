# solana-rpc-shield

[![CI](https://github.com/architeuthis-defi/solana-rpc-shield/actions/workflows/ci.yml/badge.svg)](https://github.com/architeuthis-defi/solana-rpc-shield/actions/workflows/ci.yml)

**Resilient RPC + transaction-reliability SDK for Solana dApps.** A drop-in layer over `@solana/web3.js` v2 that keeps dApps online when individual RPC nodes degrade, lag, or drop — and lands transactions reliably under congestion.

> Built for the Superteam Ukraine bounty *"Build SDK that improves RPC and transaction reliability for Solana dApps."* Targets the four judging axes directly: **Correctness · Resilience · Developer Experience · Tests.**

---

## The problem

Solana dApps that point at a single RPC endpoint inherit that endpoint's worst moment: a stalled slot, a rate-limit, a regional outage, a dropped websocket. Transaction submission compounds it — a stale blockhash, an under-priced fee, or a node that silently drops the send leaves users staring at a spinner. Most teams hand-roll ad-hoc retries that mask the failure mode instead of routing around it.

`solana-rpc-shield` makes resilience the default: requests are scored and routed across a pool of endpoints in real time, and transactions are submitted through a confirmation-aware pipeline with Jito relay routing and dynamic fees.

## Design: ride the v2 transport seam, don't fight it

`@solana/web3.js` v2 exposes a **pluggable RPC transport** — `createSolanaRpcFromTransport(transport)`. That seam is the whole design. The SDK is a *composite transport* that wraps N endpoint transports with health scoring and failover, so it composes cleanly with the standard RPC client instead of replacing it. No fork, no monkey-patching.

```ts
import { createSolanaRpcFromTransport, createDefaultRpcTransport } from '@solana/web3.js'; // or '@solana/kit'
import { createResilientTransport } from 'solana-rpc-shield';

const transport = createResilientTransport({
  endpoints: [
    'https://your-primary.rpc',
    'https://your-secondary.rpc',
    'https://your-tertiary.rpc',
  ],
  // Recommended: let the library's own transport keep v2 wire semantics
  // (bigint-safe u64 parsing); the shield owns routing, health and failover.
  transportFactory: ({ url }) => createDefaultRpcTransport({ url }),
});

const rpc = createSolanaRpcFromTransport(transport);
// use `rpc` exactly like a normal v2 RPC — failover is transparent
```

**Works with both package names.** `@solana/web3.js@2` and `@solana/kit` (its renamed
continuation) expose the same transport seam — the test suite runs an identical
compatibility matrix against both, through real failover (`test/e2e/kit-matrix.e2e.test.ts`).
Omitting `transportFactory` falls back to a zero-dependency `fetch` transport: values stay
correct, but u64s arrive as JS numbers — use the native factory when you need bigint fidelity.

## Architecture (→ judging axis)

| Module | Responsibility | Judging axis |
|---|---|---|
| `transport/` — `ResilientTransport` | Multi-endpoint pool, per-node health score (latency EWMA · slot-lag · error-rate), circuit-breaker, weighted routing + automatic failover | **Resilience** |
| `transaction/` — `TransactionManager` | Confirmation-aware submit: Jito bundle/relay routing with RPC fallback, dynamic priority-fee estimation, retry with blockhash refresh, status tracking | **Correctness** |
| `wallet/` — `WalletPipeline` + signer bridges | Resilient submission for **wallet-signed** txs: sign once, re-broadcast the same bytes while the blockhash lives, re-prompt only on opted-in expiry. Bridges for Wallet Standard (Phantom/Solflare/Backpack) and legacy `@solana/wallet-adapter` | **Correctness / DX** |
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

### Traffic distribution (anti-rate-limit by design)

A router that always picks the single best node concentrates 100% of load on it — and
*provokes* the rate-limits it is supposed to avoid. The default `routing: 'weighted'`
draws each request's failover order by **score-proportional sampling without
replacement**, damped by in-flight load: healthier nodes win more often, but every
healthy node carries a share, so no endpoint sees your full request rate. Zero-score
nodes are last resorts, never coin-flip winners. `routing: 'best'` opts back into
strict score ordering for paid-primary/free-backup setups (combine with per-endpoint
`weight`).

## Transaction reliability (the core of Correctness)

- **Jito relay routing** with RPC fallback — submit via Jito block-engine when configured; fall back to the resilient RPC pool on relay failure. (Never `skipPreflight` blindly; never a fixed fee.)
- **Jito atomic bundles + tips** — `submitBundle` / `confirmBundle` / `sendBundleAndConfirm`
  over `/api/v1/bundles` (1–5 txs, all-or-nothing, private until landed = no public-mempool
  frontrunning surface). Tip accounts are fetched live from the engine's `getTipAccounts`
  and picked at random to spread write-lock contention — never a hardcoded list that goes
  stale. The tip transfer (≥ `MIN_JITO_TIP_LAMPORTS`) goes **inside** one of your
  transactions, so a failed bundle pays no tip. See `examples/jito-bundle.ts`.
- **Dynamic priority fee** — estimate from recent prioritization fees, clamped to a floor/ceiling.
- **Retry with blockhash refresh** — re-fetch a fresh blockhash on expiry rather than resubmitting a dead transaction.
- **Confirmation tracking** — poll signature status to a target commitment with bounded timeout; surface the real revert reason on failure, never an empty catch.

## Wallet integration (the dApp-facing path)

Wallets sign — the shield submits. Calling a wallet's `signAndSendTransaction` hands the
send to the wallet's single internal RPC: no failover, no fee strategy, no confirmation
tracking. The `WalletPipeline` instead asks the wallet to **sign only**, then owns the
submit/confirm lifecycle through the resilient transport.

The retry primitive is wallet-aware: a naive integration that "retries" by rebuilding the
transaction re-prompts the user with a popup on every attempt. The pipeline signs **once**
and re-broadcasts the *same signed bytes* while the blockhash is still valid — the status
poll stays authoritative. A fresh prompt happens only after expiry, and only when the dApp
opts in with `resignOnExpiry`.

```ts
import { TransactionManager, WalletPipeline, fromWalletStandard } from 'solana-rpc-shield';

// any Wallet Standard wallet — Phantom, Solflare, Backpack…
const signer = fromWalletStandard(wallet); // sign-only; throws if the wallet can't sign without sending

const pipeline = new WalletPipeline(new TransactionManager(transport), signer);

const result = await pipeline.sendAndConfirm({
  buildTx: (blockhash) => buildMyTransferTx(blockhash), // unsigned serialized tx
  resignOnExpiry: false, // extra popups are opt-in, never a surprise
});
```

Legacy `@solana/wallet-adapter` dApps bridge with one extra line (the SDK itself stays
free of web3.js v1 dependencies):

```ts
import { VersionedTransaction } from '@solana/web3.js'; // the dApp's existing v1 install
const signer = fromLegacyAdapter(adapter, { deserialize: VersionedTransaction.deserialize });
```

## CLI

```
rpc-shield health   -e <a,b,c>               # one-shot per-node health scoreboard
rpc-shield watch    -e <a,b,c> [-i 2000]     # live-refreshing scoreboard (real-time monitor)
rpc-shield bench    -e <a,b,c> [-n 30 -c 4]  # raw endpoints vs. shield composite: p50/p95/p99, errors, rps
rpc-shield tx <sig> -e <a,b,c>               # signature status through the resilient pool
rpc-shield simulate-drop -e <a,b> -d <a> \
    --after 2 --duration 4 -n 20             # inject a failure window, watch failover + circuit recovery
```

Endpoints can also come from `RPC_SHIELD_ENDPOINTS`. Sample `simulate-drop` output —
the victim endpoint starts failing, the router classifies the faults, the circuit opens,
and requests keep landing through the survivors:

```
#  3 ok via https://api.mainnet-beta.solana.com 29ms
--- DROP WINDOW OPEN: https://api.mainnet-beta.solana.com now failing ---
#  5 ok via https://backup-node.example.com 41ms  (failed over past: https://api.ma…ta.solana.com:network)
...
final health:
ENDPOINT                                      CIRCUIT    SCORE  LATENCY  ERR-RATE SLOT-LAG  IN-FLIGHT
https://api.mainnet-beta.solana.com           OPEN       0.00   52ms     67%      0         0
https://backup-node.example.com               CLOSED     0.86   44ms     0%       0         0
```

## Status & build plan (submission 2026-06-16)

- [x] Scaffold + `ResilientTransport` (pool + health scoring)
- [x] Failover + circuit-breaker + slot-lag health monitor
- [x] `TransactionManager` (Jito routing + dynamic fee + retry/confirm)
- [x] Wallet integration — `WalletPipeline` + Wallet Standard / legacy adapter bridges
- [x] OpenTelemetry export (`ShieldTelemetry`) + `rpc-shield` CLI (health/watch/bench/tx/simulate-drop)
- [ ] Simulation test harness, ≥90% coverage
- [ ] Docs, runnable examples, polish

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
