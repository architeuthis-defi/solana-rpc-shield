/**
 * Per-endpoint health tracking + scoring.
 *
 * Each endpoint owns one EndpointHealth. The router asks every live endpoint
 * for its score() and prefers the highest. Scoring blends three independent
 * failure modes — latency, error-rate, and slot-lag — because a node can be
 * fast and up while still serving stale state (slot-lag), which a naive
 * round-robin would never catch.
 */

import { type CircuitState, ErrorClass, type HealthConfig, type HealthSnapshot } from '../types/index.js';

const DEFAULTS = {
  latencyAlpha: 0.3,
  errorWindow: 20,
  breakerThreshold: 3,
  breakerCooldownMs: 5_000,
  maxSlotLag: 150,
} as const;

/** Classify a thrown error into an ErrorClass. Conservative: unknown → Unknown. */
export function classifyError(err: unknown): ErrorClass {
  // Aborted fetch surfaces as an AbortError; match by name to stay env-agnostic
  // (no dependency on the DOMException global, which is absent in some runtimes).
  if (typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError') {
    return ErrorClass.Timeout;
  }
  // A decoded JSON-RPC error carries `code`/`message` and is NOT an endpoint fault.
  if (typeof err === 'object' && err !== null && 'code' in err && 'message' in err) {
    return ErrorClass.RpcError;
  }
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) {
    return ErrorClass.RateLimited;
  }
  if (/\b5\d\d\b/.test(msg) || msg.includes('internal server error')) return ErrorClass.ServerError;
  if (msg.includes('timeout') || msg.includes('timed out')) return ErrorClass.Timeout;
  if (msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('fetch failed') || msg.includes('network')) {
    return ErrorClass.Network;
  }
  return ErrorClass.Unknown;
}

/** True when this error means the endpoint is at fault and we should fail over. */
export function isEndpointFault(cls: ErrorClass): boolean {
  return cls !== ErrorClass.RpcError;
}

export class EndpointHealth {
  readonly url: string;
  private readonly cfg: Required<HealthConfig>;

  private latencyMs = 0;
  private readonly outcomes: boolean[] = []; // rolling success/failure window
  private consecutiveFailures = 0;
  private circuit: CircuitState = 'closed';
  private openedAt = 0;
  private cooldownMs: number;
  private slotLag = 0;
  private inFlight = 0;

  constructor(url: string, cfg?: HealthConfig) {
    this.url = url;
    this.cfg = { ...DEFAULTS, ...cfg };
    this.cooldownMs = this.cfg.breakerCooldownMs;
  }

  /** Can the router route to this endpoint right now? Half-opens an expired breaker. */
  isAvailable(now: number): boolean {
    if (this.circuit === 'open') {
      if (now - this.openedAt >= this.cooldownMs) {
        this.circuit = 'half_open';
        return true; // allow a single probe
      }
      return false;
    }
    return true;
  }

  markStart(): void {
    this.inFlight += 1;
  }

  /** Requests currently in flight — read by the router's load-aware mass, so no snapshot() allocation. */
  inFlightCount(): number {
    return this.inFlight;
  }

  recordSuccess(latencyMs: number): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const a = this.cfg.latencyAlpha;
    this.latencyMs = this.latencyMs === 0 ? latencyMs : a * latencyMs + (1 - a) * this.latencyMs;
    this.pushOutcome(true);
    this.consecutiveFailures = 0;
    if (this.circuit !== 'closed') {
      this.circuit = 'closed';
      this.cooldownMs = this.cfg.breakerCooldownMs; // reset backoff on recovery
    }
  }

  recordFailure(now: number): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.pushOutcome(false);
    this.consecutiveFailures += 1;
    if (this.circuit === 'half_open' || this.consecutiveFailures >= this.cfg.breakerThreshold) {
      this.trip(now);
    }
  }

  /** Update slot lag = freshest slot across the pool minus this node's latest slot. */
  recordSlot(ownSlot: number, freshestSlot: number): void {
    this.slotLag = Math.max(0, freshestSlot - ownSlot);
  }

  private trip(now: number): void {
    this.circuit = 'open';
    this.openedAt = now;
    // Exponential backoff, capped at 30s, so a flapping node isn't re-probed every 5s.
    this.cooldownMs = Math.min(this.cooldownMs * 2, 30_000);
  }

  private pushOutcome(ok: boolean): void {
    this.outcomes.push(ok);
    if (this.outcomes.length > this.cfg.errorWindow) this.outcomes.shift();
  }

  private errorRate(): number {
    if (this.outcomes.length === 0) return 0;
    const failures = this.outcomes.reduce((n, ok) => (ok ? n : n + 1), 0);
    return failures / this.outcomes.length;
  }

  /**
   * Composite health score in [0,1]. Three penalties multiply, so any single
   * dimension going bad pulls the score down hard (an unhealthy node should
   * lose, not be averaged into mediocrity).
   */
  score(): number {
    if (this.circuit === 'open') return 0;
    // Latency penalty: ~1.0 at 0ms, ~0.5 at 400ms, asymptotic to 0.
    const latencyScore = 1 / (1 + this.latencyMs / 400);
    const errorScore = 1 - this.errorRate();
    const lagScore = this.slotLag <= 0 ? 1 : Math.max(0, 1 - this.slotLag / this.cfg.maxSlotLag);
    return latencyScore * errorScore * lagScore;
  }

  snapshot(): HealthSnapshot {
    return {
      url: this.url,
      circuit: this.circuit,
      latencyMs: Math.round(this.latencyMs),
      errorRate: Number(this.errorRate().toFixed(3)),
      slotLag: this.slotLag,
      score: Number(this.score().toFixed(3)),
      inFlight: this.inFlight,
    };
  }
}
