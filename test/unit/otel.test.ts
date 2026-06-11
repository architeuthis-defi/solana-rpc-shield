import { describe, expect, it } from 'vitest';
import {
  MeterProvider,
  MetricReader,
  type CollectionResult,
  type MetricData,
} from '@opentelemetry/sdk-metrics';
import { ShieldTelemetry } from '../../src/observability/otel.js';
import type { HealthSnapshot } from '../../src/types/index.js';

/** Minimal reader that lets tests collect on demand. */
class TestReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

function harness(): { telemetry: ShieldTelemetry; collect: () => Promise<Map<string, MetricData>> } {
  const reader = new TestReader();
  const provider = new MeterProvider({ readers: [reader] });
  const telemetry = new ShieldTelemetry({ meterProvider: provider });
  return {
    telemetry,
    collect: async () => {
      const { resourceMetrics }: CollectionResult = await reader.collect();
      const byName = new Map<string, MetricData>();
      for (const scope of resourceMetrics.scopeMetrics) {
        for (const metric of scope.metrics) byName.set(metric.descriptor.name, metric);
      }
      return byName;
    },
  };
}

function points(metric: MetricData | undefined): Array<{ value: unknown; attrs: Record<string, unknown> }> {
  return (metric?.dataPoints ?? []).map((dp) => ({
    value: dp.value,
    attrs: dp.attributes as Record<string, unknown>,
  }));
}

describe('ShieldTelemetry', () => {
  it('turns transport events into request counters, latency histogram and failover count', async () => {
    const { telemetry, collect } = harness();

    telemetry.transportListener({ type: 'request_success', endpoint: 'https://a', latencyMs: 12, attempt: 0 });
    telemetry.transportListener({ type: 'request_fault', endpoint: 'https://a', errorClass: 'timeout' as never, attempt: 0 });
    telemetry.transportListener({ type: 'request_success', endpoint: 'https://b', latencyMs: 30, attempt: 1 });
    telemetry.transportListener({ type: 'all_endpoints_failed', attempts: 2 });

    const metrics = await collect();
    const requests = points(metrics.get('rpc_shield.requests'));
    expect(requests).toContainEqual({ value: 1, attrs: { endpoint: 'https://a', outcome: 'success' } });
    expect(requests).toContainEqual({
      value: 1,
      attrs: { endpoint: 'https://a', outcome: 'fault', error_class: 'timeout' },
    });
    expect(requests).toContainEqual({ value: 1, attrs: { endpoint: 'https://b', outcome: 'success' } });

    // attempt=1 success is a failover; attempt=0 is not
    expect(points(metrics.get('rpc_shield.failovers'))).toEqual([
      { value: 1, attrs: { endpoint: 'https://b' } },
    ]);
    expect(points(metrics.get('rpc_shield.pool_exhaustions'))).toEqual([{ value: 1, attrs: {} }]);

    const duration = metrics.get('rpc_shield.request.duration');
    const histPoints = points(duration) as Array<{ value: { count: number; sum: number }; attrs: unknown }>;
    expect(histPoints.reduce((n, p) => n + p.value.count, 0)).toBe(2); // only successes record latency
  });

  it('turns transaction events into submit/fallback/confirmation metrics', async () => {
    const { telemetry, collect } = harness();

    telemetry.transactionListener({ type: 'submitted', route: 'jito' });
    telemetry.transactionListener({ type: 'jito_fallback' });
    telemetry.transactionListener({ type: 'submitted', route: 'rpc' });
    telemetry.transactionListener({ type: 'confirm_outcome', outcome: 'confirmed', elapsedMs: 420 });
    telemetry.transactionListener({ type: 'confirm_outcome', outcome: 'expired', elapsedMs: 60_000 });

    const metrics = await collect();
    const submitted = points(metrics.get('rpc_shield.tx.submitted'));
    expect(submitted).toContainEqual({ value: 1, attrs: { route: 'jito' } });
    expect(submitted).toContainEqual({ value: 1, attrs: { route: 'rpc' } });
    expect(points(metrics.get('rpc_shield.tx.jito_fallbacks'))).toEqual([{ value: 1, attrs: {} }]);

    const confirmations = points(metrics.get('rpc_shield.tx.confirmations'));
    expect(confirmations).toContainEqual({ value: 1, attrs: { outcome: 'confirmed' } });
    expect(confirmations).toContainEqual({ value: 1, attrs: { outcome: 'expired' } });
  });

  it('turns wallet events into prompt/rebroadcast counters', async () => {
    const { telemetry, collect } = harness();

    telemetry.walletListener({ type: 'signed', wallet: 'Phantom', prompt: 1 });
    telemetry.walletListener({ type: 'rebroadcast', signature: 'SIG', count: 1 });
    telemetry.walletListener({ type: 'confirmed', signature: 'SIG', slot: 1 }); // covered by tx metrics → ignored

    const metrics = await collect();
    expect(points(metrics.get('rpc_shield.wallet.prompts'))).toEqual([
      { value: 1, attrs: { wallet: 'Phantom' } },
    ]);
    expect(points(metrics.get('rpc_shield.wallet.rebroadcasts'))).toEqual([{ value: 1, attrs: {} }]);
  });

  it('observes registered health sources as per-endpoint gauges and stops reading after unobserve', async () => {
    const { telemetry, collect } = harness();
    const live = { score: 0.61 };
    const snapshot = (): HealthSnapshot => ({
      url: 'https://a',
      circuit: 'half_open',
      latencyMs: 42,
      errorRate: 0.25,
      slotLag: 3,
      score: live.score,
      inFlight: 2,
    });
    const unobserve = telemetry.observeHealth({ getHealth: () => [snapshot()] });

    let metrics = await collect();
    expect(points(metrics.get('rpc_shield.endpoint.score'))).toEqual([
      { value: 0.61, attrs: { endpoint: 'https://a' } },
    ]);
    expect(points(metrics.get('rpc_shield.endpoint.latency'))).toEqual([
      { value: 42, attrs: { endpoint: 'https://a' } },
    ]);
    expect(points(metrics.get('rpc_shield.endpoint.circuit'))).toEqual([
      { value: 0.5, attrs: { endpoint: 'https://a' } },
    ]);
    expect(points(metrics.get('rpc_shield.endpoint.slot_lag'))).toEqual([
      { value: 3, attrs: { endpoint: 'https://a' } },
    ]);

    // After unobserve the source is no longer read: a cumulative gauge re-exports
    // its last value (OTel SDK semantics), but fresh changes must not appear.
    unobserve();
    live.score = 0.99;
    metrics = await collect();
    expect(points(metrics.get('rpc_shield.endpoint.score'))).toEqual([
      { value: 0.61, attrs: { endpoint: 'https://a' } },
    ]);
  });
});
