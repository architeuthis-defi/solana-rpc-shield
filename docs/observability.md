# Observability — OpenTelemetry / Datadog

The SDK instruments against **`@opentelemetry/api` only** (the standard library
pattern): your app owns the SDK and exporter, so the same wiring feeds Grafana,
Prometheus, Honeycomb or Datadog without this package taking an exporter
dependency. With no SDK registered, every instrument is a no-op — zero cost.

## Wiring (three lines per layer)

```ts
import { metrics } from '@opentelemetry/api';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { createResilientTransport, TransactionManager, WalletPipeline, ShieldTelemetry } from 'solana-rpc-shield';

// 1. Your app's OTel SDK (any exporter — OTLP shown)
metrics.setGlobalMeterProvider(
  new MeterProvider({
    readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })],
  }),
);

// 2. One telemetry object, three listeners, one gauge source
const telemetry = new ShieldTelemetry();
const transport = createResilientTransport({ endpoints, onEvent: telemetry.transportListener });
telemetry.observeHealth(transport); // pull-based per-endpoint gauges
const manager = new TransactionManager(transport, { onEvent: telemetry.transactionListener });
const pipeline = new WalletPipeline(manager, signer, { onEvent: telemetry.walletListener });
```

Runnable proof: `npx tsx examples/otel-console.ts` (console exporter, live devnet traffic).

## Metric reference

| Instrument | Type | Attributes | Meaning |
|---|---|---|---|
| `rpc_shield.requests` | counter | `endpoint`, `outcome` (`success`\|`fault`\|`rpc_error`), `error_class` on faults | every routed request |
| `rpc_shield.request.duration` | histogram (ms) | `endpoint` | round-trip latency of answered requests |
| `rpc_shield.failovers` | counter | `endpoint` (the node that finally served) | requests served by a non-first-choice node |
| `rpc_shield.pool_exhaustions` | counter | — | requests that failed on every available endpoint |
| `rpc_shield.endpoint.score` | gauge | `endpoint` | composite health score [0,1] |
| `rpc_shield.endpoint.latency` | gauge (ms) | `endpoint` | latency EWMA |
| `rpc_shield.endpoint.error_rate` | gauge | `endpoint` | windowed error rate [0,1] |
| `rpc_shield.endpoint.slot_lag` | gauge | `endpoint` | slots behind the freshest node |
| `rpc_shield.endpoint.circuit` | gauge | `endpoint` | 0 closed · 0.5 half-open · 1 open |
| `rpc_shield.endpoint.in_flight` | gauge | `endpoint` | requests currently in flight |
| `rpc_shield.tx.submitted` | counter | `route` (`jito`\|`rpc`) | transaction submissions |
| `rpc_shield.tx.jito_fallbacks` | counter | — | relay failures that fell back to RPC |
| `rpc_shield.tx.confirmations` | counter | `outcome` (`confirmed`\|`expired`\|`timed_out`\|`reverted`) | confirmation outcomes |
| `rpc_shield.tx.confirm.duration` | histogram (ms) | `outcome` | time to a terminal outcome |
| `rpc_shield.tx.bundles_submitted` | counter | — | Jito bundles submitted |
| `rpc_shield.tx.bundle_outcomes` | counter | `outcome` (`landed`\|`failed`\|`timed_out`) | bundle terminal outcomes |
| `rpc_shield.wallet.prompts` | counter | `wallet` | sign prompts shown to the user — the UX cost the pipeline minimises |
| `rpc_shield.wallet.rebroadcasts` | counter | — | re-broadcasts of already-signed bytes (no prompt) |

**Alerts that matter:** `pool_exhaustions > 0` (user-visible failures),
`endpoint.circuit == 1` for > 2 min (a node is gone, pool is thinner),
`tx.confirmations{outcome="expired"}` rising (fee or congestion problem),
`wallet.prompts / tx.submitted` rising above ~1 (users being re-prompted).

## Collector → anywhere

Standard OTLP collector config that fans the same metrics out to Prometheus
**and** Datadog (the Datadog exporter ships with the collector-contrib build):

```yaml
receivers:
  otlp:
    protocols: { http: {}, grpc: {} }
exporters:
  prometheus:
    endpoint: 0.0.0.0:8889
  datadog:
    api: { key: ${DD_API_KEY} }
service:
  pipelines:
    metrics:
      receivers: [otlp]
      exporters: [prometheus, datadog]
```

Datadog also ingests OTLP directly through the Datadog Agent
(`otlp_config` in `datadog.yaml`) — point `OTEL_EXPORTER_OTLP_ENDPOINT` at the
agent and skip the collector entirely.
