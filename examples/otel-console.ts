/**
 * Observability proof: ShieldTelemetry → OpenTelemetry SDK → console exporter.
 * Swap ConsoleMetricExporter for an OTLP exporter and the SAME wiring feeds
 * Grafana, Prometheus or Datadog (OTLP intake) — see docs/observability.md.
 *
 *   npx tsx examples/otel-console.ts
 */
import { metrics } from '@opentelemetry/api';
import { ConsoleMetricExporter, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { createResilientTransport, ShieldTelemetry, TransactionManager } from '../src/index.js';

async function main(): Promise<void> {
  // 1. Standard OTel SDK setup — owned by the dApp, not by the SDK.
  const provider = new MeterProvider({
    readers: [new PeriodicExportingMetricReader({ exporter: new ConsoleMetricExporter(), exportIntervalMillis: 2_000 })],
  });
  metrics.setGlobalMeterProvider(provider);

  // 2. Wire the shield into it: listeners push counters, gauges pull health.
  const telemetry = new ShieldTelemetry();
  const transport = createResilientTransport({
    endpoints: [
      'https://api.devnet.solana.com',
      'http://127.0.0.1:9', // dead on purpose: failover + fault metrics show up
    ],
    requestTimeoutMs: 8_000,
    onEvent: telemetry.transportListener,
  });
  const unobserve = telemetry.observeHealth(transport);
  const manager = new TransactionManager(transport, { onEvent: telemetry.transactionListener });

  // 3. Generate some traffic.
  transport.startHealthMonitor({ intervalMs: 1_000 });
  for (let i = 0; i < 5; i++) {
    await transport({ payload: { jsonrpc: '2.0', id: i, method: 'getSlot', params: [] } }).catch(() => undefined);
  }
  await manager.getLatestBlockhash().catch(() => undefined);

  // 4. Let one export cycle run, then tear down cleanly.
  await new Promise((r) => setTimeout(r, 2_500));
  transport.stopHealthMonitor();
  unobserve();
  telemetry.dispose();
  await provider.shutdown();
  console.log('\nDone — the dumps above are rpc_shield.* counters, histograms and per-endpoint gauges.');
}

main().catch((err: unknown) => {
  console.error('example failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
