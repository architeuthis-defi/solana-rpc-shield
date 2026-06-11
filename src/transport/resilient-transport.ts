/**
 * ResilientTransport — a v2-compatible composite RPC transport.
 *
 * Wraps N endpoint transports. For each logical request it routes to the
 * highest-scoring available endpoint, applies a per-request timeout, and fails
 * over to the next-best node on an *endpoint fault* — but never on a genuine
 * JSON-RPC error (a revert is the chain's answer, not a node problem).
 *
 * Drop straight into web3.js v2 / @solana/kit:
 *   createSolanaRpcFromTransport(createResilientTransport({ endpoints }))
 */

import type {
  EndpointConfig,
  HealthSnapshot,
  ResilientTransportConfig,
  RpcRequest,
  RpcTransport,
  TransportEvent,
} from '../types/index.js';
import { classifyError, EndpointHealth, isEndpointFault } from './health.js';
import { weightedOrder } from './routing.js';
import { SlotMonitor, type SlotMonitorOptions } from './slot-monitor.js';

function normalizeEndpoint(e: string | EndpointConfig): EndpointConfig {
  return typeof e === 'string' ? { url: e } : e;
}

/**
 * Default transport: a v2-shaped JSON-RPC POST over fetch (no kit-API coupling).
 * Exported so callers (and the CLI's drop simulator) can wrap a real endpoint
 * transport inside a custom `transportFactory`.
 */
export function createFetchTransport(endpoint: EndpointConfig): RpcTransport {
  const headers = { 'content-type': 'application/json', ...(endpoint.headers ?? {}) };
  return async <T>(request: RpcRequest): Promise<T> => {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(request.payload),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  };
}

/**
 * Combine the caller's signal with our timeout signal. Returns a cleanup that
 * detaches the listeners — without it, every attempt leaks a listener on a
 * long-lived caller signal (React Query/abortable fetch patterns).
 */
function combineSignals(signals: AbortSignal[]): { signal: AbortSignal; cleanup: () => void } {
  const ctrl = new AbortController();
  const onAbort = (): void => ctrl.abort();
  const attached: AbortSignal[] = [];
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort();
      break;
    }
    s.addEventListener('abort', onAbort, { once: true });
    attached.push(s);
  }
  return {
    signal: ctrl.signal,
    cleanup: () => {
      for (const s of attached) s.removeEventListener('abort', onAbort);
    },
  };
}

export interface ResilientTransport {
  <TResponse>(request: RpcRequest): Promise<TResponse>;
  /** Live per-endpoint health, for the CLI / OpenTelemetry exporter. */
  getHealth(): HealthSnapshot[];
  /** Begin background slot-lag probing. Idempotent. Caller must stop on teardown. */
  startHealthMonitor(options?: SlotMonitorOptions): void;
  /** Stop background probing and release the timer. */
  stopHealthMonitor(): void;
}

export function createResilientTransport(config: ResilientTransportConfig): ResilientTransport {
  const endpoints = config.endpoints.map(normalizeEndpoint);
  if (endpoints.length === 0) {
    throw new Error('createResilientTransport: at least one endpoint is required');
  }
  const factory = config.transportFactory ?? createFetchTransport;
  const timeoutMs = config.requestTimeoutMs ?? 10_000;
  const maxAttempts = config.maxAttempts ?? endpoints.length;
  const onEvent = config.onEvent;
  const emit = (event: TransportEvent): void => {
    if (!onEvent) return;
    try {
      onEvent(event);
    } catch {
      // A telemetry listener must never be able to break request routing.
    }
  };

  const pool = endpoints.map((cfg) => ({
    cfg,
    health: new EndpointHealth(cfg.url, config.health),
    transport: factory(cfg),
  }));

  type Node = (typeof pool)[number];

  const strategy = config.routing ?? 'weighted';
  const rng = config.rng ?? Math.random;

  /**
   * Sampling mass: health score × static weight, damped by in-flight load so
   * concurrent bursts spread across nodes instead of queueing on one.
   */
  function massOf(node: Node): number {
    return (node.health.score() * (node.cfg.weight ?? 1)) / (1 + node.health.inFlightCount());
  }

  function routingOrder(now: number): Node[] {
    const live = pool.filter((p) => p.health.isAvailable(now));
    const candidates = live.length > 0 ? live : pool; // all tripped → least-bad fallback
    if (strategy === 'best') {
      return [...candidates].sort((a, b) => massOf(b) - massOf(a));
    }
    return weightedOrder(
      candidates.map((node) => ({ item: node, mass: massOf(node) })),
      rng,
    );
  }

  const transport = async <T>(request: RpcRequest): Promise<T> => {
    const order = routingOrder(Date.now());
    const attempts = Math.min(maxAttempts, order.length);
    let lastErr: unknown;

    for (let i = 0; i < attempts; i++) {
      const node = order[i];
      if (!node) break;
      node.health.markStart();
      const start = Date.now();
      const timeoutCtrl = new AbortController();
      const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs);
      const combined = request.signal
        ? combineSignals([request.signal, timeoutCtrl.signal])
        : { signal: timeoutCtrl.signal, cleanup: (): void => undefined };
      try {
        const out = await node.transport<T>({ payload: request.payload, signal: combined.signal });
        const latencyMs = Date.now() - start;
        node.health.recordSuccess(latencyMs);
        emit({ type: 'request_success', endpoint: node.cfg.url, latencyMs, attempt: i });
        return out;
      } catch (err) {
        if (request.signal?.aborted) {
          // Caller cancellation (unmount, route change) — NOT an endpoint fault.
          // Penalising the pool for it lets three page navigations trip every
          // breaker. No failure recorded, no failover: surface the abort.
          node.health.markAbandoned();
          emit({ type: 'request_aborted', endpoint: node.cfg.url });
          throw err;
        }
        const errorClass = classifyError(err);
        if (!isEndpointFault(errorClass)) {
          // Genuine JSON-RPC error: surface it, do not penalise the node or fail over.
          const latencyMs = Date.now() - start;
          node.health.recordSuccess(latencyMs);
          emit({ type: 'rpc_error_passthrough', endpoint: node.cfg.url, latencyMs });
          throw err;
        }
        node.health.recordFailure(Date.now());
        emit({ type: 'request_fault', endpoint: node.cfg.url, errorClass, attempt: i });
        lastErr = err;
      } finally {
        clearTimeout(timer);
        combined.cleanup();
      }
    }
    emit({ type: 'all_endpoints_failed', attempts });
    throw new Error(`solana-rpc-shield: all ${attempts} endpoint attempt(s) failed`, {
      cause: lastErr,
    });
  };

  const slotTargets = pool.map((p) => ({
    url: p.cfg.url,
    transport: p.transport,
    recordSlot: (own: number, freshest: number) => p.health.recordSlot(own, freshest),
  }));
  let slotMonitor = new SlotMonitor(slotTargets);

  return Object.assign(transport, {
    getHealth: (): HealthSnapshot[] => pool.map((p) => p.health.snapshot()),
    startHealthMonitor: (options?: SlotMonitorOptions): void => {
      if (options) {
        slotMonitor.stop();
        slotMonitor = new SlotMonitor(slotTargets, options);
      }
      slotMonitor.start();
    },
    stopHealthMonitor: (): void => slotMonitor.stop(),
  });
}
