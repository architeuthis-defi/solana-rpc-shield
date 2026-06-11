# Superteam Ukraine bounty — submission map

> Companion to the [README](../README.md) for judges of
> *"Build SDK that improves RPC and transaction reliability for Solana dApps"*.
> The README is the product document; this page maps it onto the listing.

## Submission requirements → artifacts

| Listing requirement | Delivered as |
|---|---|
| web3.js v2.0 compatibility verified with tests | [`kit-matrix.e2e`](../test/e2e/kit-matrix.e2e.test.ts): identical matrix over `@solana/web3.js@2` **and** `@solana/kit`, through real failover, bigint fidelity asserted |
| Wallet adapter integration (≥1 major wallet) | [sign-once bridges](../src/wallet/signers.ts) (Wallet Standard: Phantom/Solflare/Backpack + legacy adapter) · runnable [demo dApp](../examples/demo-dapp/) |
| Jito/MEV routing implemented and documented | relay + atomic bundles + live tip accounts ([source](../src/transaction/transaction-manager.ts)) · [example](../examples/jito-bundle.ts) · verified against docs.jito.wtf |
| Observability exports working (OTel or Datadog) | [`ShieldTelemetry`](../src/observability/otel.ts) + [docs/observability.md](observability.md) (metric reference, collector + Datadog configs) · [live-verified example](../examples/otel-console.ts) |
| Diagnostics CLI functional | 5 commands, e2e-tested in-process, live-verified against mainnet |
| 90%+ coverage via network drop & latency simulations | **97.9% lines / 91.5% branches / 100% functions**, thresholds enforced in CI; simulations are real HTTP servers (drops, hangs, 5xx, latency) **plus cross-node consistency divergence** |
| Public GitHub repo | [architeuthis-defi/solana-rpc-shield](https://github.com/architeuthis-defi/solana-rpc-shield) |

## Judging criteria → proof

| Criterion | Weight | Where to look |
|---|---|---|
| Correctness | 40% | [lifecycle engine](../src/transaction/lifecycle.ts) + [property fuzz: never-double-lands](../test/sim/lifecycle.fuzz.test.ts) + [cross-node consistency tests](../test/sim/cross-node.test.ts) + [landing-rate A/B](../scripts/landing-sim.ts) — 142 tests |
| Resilience Quality | 25% | health-scored weighted routing, circuit breakers, slot-lag demotion; real socket-destroy / refused / blackhole / latency sims; `simulate-drop` vs live mainnet |
| Developer Experience | 20% | 30-second quickstart, 5-command CLI, OTel in 3 lines, 4 runnable examples + demo dApp, typed errors with verbatim node diagnostics |
| Tests & Simulation Quality | 15% | 97.9%/91.5% enforced in CI on node 20+22; unreliable-network AND inconsistent-cluster simulation classes; deterministic landing-rate table |

## Verify in 10 minutes

The README's [verification tour](../README.md#verify-it-yourself--10-minutes)
is a single copy-paste block: clone → `npm ci` → tests → coverage → `npm run sim:landing` →
live CLI against mainnet → wallet demo dApp.
