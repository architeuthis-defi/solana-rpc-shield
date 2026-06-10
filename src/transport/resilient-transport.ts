/**
 * ResilientTransport — a v2-compatible composite RPC transport.
 *
 * Wraps N endpoint transports. For each logical request it routes to the
 * highest-scoring available endpoint, applies a per-request timeout, and fails
 * over to the next-best node on an *endpoint fault* — but never on a genuine
 * JSON-RPC error (a revert is the chain's answer, not a node problem).
 *
 * Drop straight into web3.js v2 / @solana/kit:
 *   createSolanaRpc({ transport: createResilientTransport({ endpoints }) })
 */

import type {
  EndpointConfig,
  HealthSnapshot,
  ResilientTransportConfig,
  RpcRequest,
  RpcTransport,
} from '../types/index.js';
import { classifyError, EndpointHealth, isEndpointFault } from './health.js';

function normalizeEndpoint(e: string | EndpointConfig): EndpointConfig {
  return typeof e === 'string' ? { url: e } : e;
}

/** Default transport: a v2-shaped JSON-RPC POST over fetch (no kit-API coupling). */
function defaultTransportFactory(endpoint: EndpointConfig): RpcTransport {
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

/** Combine the caller's signal with our timeout signal. */
function combineSignals(signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort();
      break;
    }
    s.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}

export interface ResilientTransport {
  <TResponse>(request: RpcRequest): Promise<TResponse>;
  /** Live per-endpoint health, for the CLI / OpenTelemetry exporter. */
  getHealth(): HealthSnapshot[];
}

export function createResilientTransport(config: ResilientTransportConfig): ResilientTransport {
  const endpoints = config.endpoints.map(normalizeEndpoint);
  if (endpoints.length === 0) {
    throw new Error('createResilientTransport: at least one endpoint is required');
  }
  const factory = config.transportFactory ?? defaultTransportFactory;
  const timeoutMs = config.requestTimeoutMs ?? 10_000;
  const maxAttempts = config.maxAttempts ?? endpoints.length;

  const pool = endpoints.map((cfg) => ({
    cfg,
    health: new EndpointHealth(cfg.url, config.health),
    transport: factory(cfg),
  }));

  type Node = (typeof pool)[number];

  function routingOrder(now: number): Node[] {
    const live = pool.filter((p) => p.health.isAvailable(now));
    const candidates = live.length > 0 ? live : pool; // all tripped → least-bad fallback
    return [...candidates].sort(
      (a, b) => b.health.score() * (b.cfg.weight ?? 1) - a.health.score() * (a.cfg.weight ?? 1),
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
      const signal = request.signal
        ? combineSignals([request.signal, timeoutCtrl.signal])
        : timeoutCtrl.signal;
      try {
        const out = await node.transport<T>({ payload: request.payload, signal });
        node.health.recordSuccess(Date.now() - start);
        return out;
      } catch (err) {
        if (!isEndpointFault(classifyError(err))) {
          // Genuine JSON-RPC error: surface it, do not penalise the node or fail over.
          node.health.recordSuccess(Date.now() - start);
          throw err;
        }
        node.health.recordFailure(Date.now());
        lastErr = err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`solana-rpc-shield: all ${attempts} endpoint attempt(s) failed`, {
      cause: lastErr,
    });
  };

  return Object.assign(transport, {
    getHealth: (): HealthSnapshot[] => pool.map((p) => p.health.snapshot()),
  });
}
