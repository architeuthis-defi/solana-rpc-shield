/**
 * ShieldTelemetry — OpenTelemetry metrics for every shield layer.
 *
 * Library rule: instrument against `@opentelemetry/api` ONLY. The dApp owns
 * the SDK — whichever `MeterProvider`/exporter it configures (OTLP collector,
 * Prometheus, Datadog Agent's OTLP intake) receives these metrics without this
 * package taking an exporter dependency. With no SDK registered, the API's
 * no-op provider makes every instrument free.
 *
 * Wiring is push for events, pull for state:
 *   - listeners (`transportListener` …) are passed as `onEvent` hooks and turn
 *     lifecycle events into counters/histograms on the hot path (O(1) adds);
 *   - endpoint health is observed lazily via observable gauges that read
 *     `getHealth()` snapshots only when the SDK collects.
 */

import {
  metrics,
  type Attributes,
  type BatchObservableResult,
  type Counter,
  type Histogram,
  type Meter,
  type MeterProvider,
  type Observable,
} from '@opentelemetry/api';
import type { HealthSnapshot, TransportEvent } from '../types/index.js';
import type { TransactionEvent } from '../transaction/transaction-manager.js';
import type { WalletPipelineEvent } from '../wallet/wallet-pipeline.js';

/** Anything exposing live endpoint health — `ResilientTransport` qualifies. */
export interface HealthSource {
  getHealth(): HealthSnapshot[];
}

export interface ShieldTelemetryOptions {
  /** Defaults to the globally registered provider (`metrics.getMeterProvider()`). */
  readonly meterProvider?: MeterProvider;
}

const METER_NAME = 'solana-rpc-shield';
const CIRCUIT_VALUE: Record<HealthSnapshot['circuit'], number> = {
  closed: 0,
  half_open: 0.5,
  open: 1,
};

export class ShieldTelemetry {
  private readonly meter: Meter;
  private readonly requests: Counter;
  private readonly requestDuration: Histogram;
  private readonly failovers: Counter;
  private readonly exhaustions: Counter;
  private readonly txSubmitted: Counter;
  private readonly txJitoFallbacks: Counter;
  private readonly txConfirmations: Counter;
  private readonly txConfirmDuration: Histogram;
  private readonly walletPrompts: Counter;
  private readonly walletRebroadcasts: Counter;

  private readonly gauges: {
    score: Observable;
    latency: Observable;
    errorRate: Observable;
    slotLag: Observable;
    circuit: Observable;
    inFlight: Observable;
  };
  private readonly healthSources = new Set<HealthSource>();
  private readonly healthCallback: (result: BatchObservableResult) => void;

  constructor(options?: ShieldTelemetryOptions) {
    this.meter = (options?.meterProvider ?? metrics.getMeterProvider()).getMeter(METER_NAME);

    this.requests = this.meter.createCounter('rpc_shield.requests', {
      description: 'RPC requests by endpoint and outcome (success | fault | rpc_error)',
    });
    this.requestDuration = this.meter.createHistogram('rpc_shield.request.duration', {
      unit: 'ms',
      description: 'Round-trip latency of successful RPC requests per endpoint',
    });
    this.failovers = this.meter.createCounter('rpc_shield.failovers', {
      description: 'Requests served by a non-first-choice endpoint',
    });
    this.exhaustions = this.meter.createCounter('rpc_shield.pool_exhaustions', {
      description: 'Requests that failed on every available endpoint',
    });
    this.txSubmitted = this.meter.createCounter('rpc_shield.tx.submitted', {
      description: 'Transaction submissions by route (jito | rpc)',
    });
    this.txJitoFallbacks = this.meter.createCounter('rpc_shield.tx.jito_fallbacks', {
      description: 'Jito relay failures that fell back to RPC submission',
    });
    this.txConfirmations = this.meter.createCounter('rpc_shield.tx.confirmations', {
      description: 'Confirmation outcomes (confirmed | expired | timed_out | reverted)',
    });
    this.txConfirmDuration = this.meter.createHistogram('rpc_shield.tx.confirm.duration', {
      unit: 'ms',
      description: 'Time from confirmation start to a terminal outcome',
    });
    this.walletPrompts = this.meter.createCounter('rpc_shield.wallet.prompts', {
      description: 'Wallet sign prompts shown to the user (the UX cost being minimised)',
    });
    this.walletRebroadcasts = this.meter.createCounter('rpc_shield.wallet.rebroadcasts', {
      description: 'Re-broadcasts of an already-signed wallet transaction',
    });

    this.gauges = {
      score: this.meter.createObservableGauge('rpc_shield.endpoint.score', {
        description: 'Composite endpoint health score in [0,1]',
      }),
      latency: this.meter.createObservableGauge('rpc_shield.endpoint.latency', {
        unit: 'ms',
        description: 'EWMA request latency per endpoint',
      }),
      errorRate: this.meter.createObservableGauge('rpc_shield.endpoint.error_rate', {
        description: 'Windowed error rate per endpoint in [0,1]',
      }),
      slotLag: this.meter.createObservableGauge('rpc_shield.endpoint.slot_lag', {
        description: 'Slots behind the freshest node in the pool',
      }),
      circuit: this.meter.createObservableGauge('rpc_shield.endpoint.circuit', {
        description: 'Circuit-breaker state (0 closed, 0.5 half-open, 1 open)',
      }),
      inFlight: this.meter.createObservableGauge('rpc_shield.endpoint.in_flight', {
        description: 'Requests currently in flight per endpoint',
      }),
    };
    this.healthCallback = (result) => {
      for (const source of this.healthSources) {
        for (const snap of source.getHealth()) {
          const attrs: Attributes = { endpoint: snap.url };
          result.observe(this.gauges.score, snap.score, attrs);
          result.observe(this.gauges.latency, snap.latencyMs, attrs);
          result.observe(this.gauges.errorRate, snap.errorRate, attrs);
          result.observe(this.gauges.slotLag, snap.slotLag, attrs);
          result.observe(this.gauges.circuit, CIRCUIT_VALUE[snap.circuit], attrs);
          result.observe(this.gauges.inFlight, snap.inFlight, attrs);
        }
      }
    };
    this.meter.addBatchObservableCallback(this.healthCallback, [
      this.gauges.score,
      this.gauges.latency,
      this.gauges.errorRate,
      this.gauges.slotLag,
      this.gauges.circuit,
      this.gauges.inFlight,
    ]);
  }

  /** Pass as `onEvent` to `createResilientTransport`. */
  readonly transportListener = (event: TransportEvent): void => {
    switch (event.type) {
      case 'request_success':
        this.requests.add(1, { endpoint: event.endpoint, outcome: 'success' });
        this.requestDuration.record(event.latencyMs, { endpoint: event.endpoint });
        if (event.attempt > 0) this.failovers.add(1, { endpoint: event.endpoint });
        break;
      case 'request_fault':
        this.requests.add(1, {
          endpoint: event.endpoint,
          outcome: 'fault',
          error_class: event.errorClass,
        });
        break;
      case 'rpc_error_passthrough':
        this.requests.add(1, { endpoint: event.endpoint, outcome: 'rpc_error' });
        this.requestDuration.record(event.latencyMs, { endpoint: event.endpoint });
        break;
      case 'all_endpoints_failed':
        this.exhaustions.add(1);
        break;
    }
  };

  /** Pass as `onEvent` to `new TransactionManager(...)`. */
  readonly transactionListener = (event: TransactionEvent): void => {
    switch (event.type) {
      case 'submitted':
        this.txSubmitted.add(1, { route: event.route });
        break;
      case 'jito_fallback':
        this.txJitoFallbacks.add(1);
        break;
      case 'confirm_outcome':
        this.txConfirmations.add(1, { outcome: event.outcome });
        this.txConfirmDuration.record(event.elapsedMs, { outcome: event.outcome });
        break;
    }
  };

  /** Pass as `onEvent` to `new WalletPipeline(...)`. */
  readonly walletListener = (event: WalletPipelineEvent): void => {
    switch (event.type) {
      case 'signed':
        this.walletPrompts.add(1, { wallet: event.wallet });
        break;
      case 'rebroadcast':
        this.walletRebroadcasts.add(1);
        break;
      default:
        break; // submitted/confirmed/expired are covered by transaction metrics
    }
  };

  /** Register a transport's live health for gauge collection. Returns an unobserve fn. */
  observeHealth(source: HealthSource): () => void {
    this.healthSources.add(source);
    return () => this.healthSources.delete(source);
  }

  /** Detach the batch callback — call on teardown when the meter outlives the shield. */
  dispose(): void {
    this.healthSources.clear();
    this.meter.removeBatchObservableCallback(this.healthCallback, [
      this.gauges.score,
      this.gauges.latency,
      this.gauges.errorRate,
      this.gauges.slotLag,
      this.gauges.circuit,
      this.gauges.inFlight,
    ]);
  }
}
