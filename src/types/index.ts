/**
 * Public types for solana-rpc-shield.
 *
 * The transport signature mirrors `@solana/web3.js` v2's `RpcTransport` so a
 * ResilientTransport can be passed straight into `createSolanaRpc({ transport })`.
 */

/** A single JSON-RPC call as the v2 RPC client hands it to a transport. */
export interface RpcRequest {
  readonly payload: unknown;
  readonly signal?: AbortSignal;
}

/** v2-compatible transport: takes a request, resolves the decoded response. */
export type RpcTransport = <TResponse>(request: RpcRequest) => Promise<TResponse>;

/** How a failed request is categorised — drives retry vs. quarantine decisions. */
export enum ErrorClass {
  /** Network timeout / abort — retryable on another endpoint. */
  Timeout = 'timeout',
  /** HTTP 429 / explicit rate-limit — retryable, but penalise the node. */
  RateLimited = 'rate_limited',
  /** HTTP 5xx — node-side fault, retryable elsewhere. */
  ServerError = 'server_error',
  /** Transport/connection refused or DNS — node likely down. */
  Network = 'network',
  /** Valid JSON-RPC error response (e.g. revert) — NOT an endpoint fault; do not failover. */
  RpcError = 'rpc_error',
  /** Anything unclassified. */
  Unknown = 'unknown',
}

export interface EndpointConfig {
  /** RPC HTTP URL. */
  readonly url: string;
  /** Optional static weight (1 = default); multiplies the dynamic health score. */
  readonly weight?: number;
  /** Optional per-endpoint headers (auth tokens etc). Never logged. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface HealthConfig {
  /** EWMA smoothing factor for latency, 0..1 (higher = more reactive). Default 0.3. */
  readonly latencyAlpha?: number;
  /** Rolling window size for the error-rate calculation. Default 20. */
  readonly errorWindow?: number;
  /** Consecutive failures before the circuit opens. Default 3. */
  readonly breakerThreshold?: number;
  /** Base quarantine (ms) when the circuit opens; grows on repeated trips. Default 5000. */
  readonly breakerCooldownMs?: number;
  /** Slot lag (vs. freshest node seen) above which a node is penalised. Default 150. */
  readonly maxSlotLag?: number;
}

/** Routing lifecycle events — consumed by logging and the OpenTelemetry exporter. */
export type TransportEvent =
  | {
      readonly type: 'request_success';
      readonly endpoint: string;
      readonly latencyMs: number;
      /** 0 = served by the first-choice node; >0 means a failover happened. */
      readonly attempt: number;
    }
  | {
      readonly type: 'request_fault';
      readonly endpoint: string;
      readonly errorClass: ErrorClass;
      readonly attempt: number;
    }
  | {
      /** Chain answered with a JSON-RPC error — surfaced to the caller, not a node fault. */
      readonly type: 'rpc_error_passthrough';
      readonly endpoint: string;
      readonly latencyMs: number;
    }
  | { readonly type: 'all_endpoints_failed'; readonly attempts: number };

export interface ResilientTransportConfig {
  /** Two or more endpoints. Order is irrelevant — routing is health-driven. */
  readonly endpoints: ReadonlyArray<string | EndpointConfig>;
  /** Per-request timeout (ms) before counting a Timeout and failing over. Default 10_000. */
  readonly requestTimeoutMs?: number;
  /** Max endpoints to try for one logical request before giving up. Default = all. */
  readonly maxAttempts?: number;
  /** Health-scoring tunables. */
  readonly health?: HealthConfig;
  /** Injected transport factory (for tests / custom fetch). Defaults to web3.js v2. */
  readonly transportFactory?: (endpoint: EndpointConfig) => RpcTransport;
  /** Lifecycle event hook; must be cheap — fired on the request hot path. */
  readonly onEvent?: (event: TransportEvent) => void;
}

export type CircuitState = 'closed' | 'open' | 'half_open';

/** Point-in-time view of one endpoint's health — surfaced by the CLI and OTel. */
export interface HealthSnapshot {
  readonly url: string;
  readonly circuit: CircuitState;
  readonly latencyMs: number;
  readonly errorRate: number;
  readonly slotLag: number;
  /** Composite score in [0,1]; higher is healthier. */
  readonly score: number;
  readonly inFlight: number;
}
