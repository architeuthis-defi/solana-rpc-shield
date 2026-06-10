import { describe, expect, it } from 'vitest';
import { classifyError, EndpointHealth, isEndpointFault } from '../../src/transport/health.js';
import { ErrorClass } from '../../src/types/index.js';

describe('classifyError', () => {
  it('maps an aborted request to Timeout', () => {
    expect(classifyError({ name: 'AbortError' })).toBe(ErrorClass.Timeout);
  });
  it('treats a JSON-RPC error object as a non-faulting RpcError', () => {
    expect(classifyError({ code: -32003, message: 'Transaction reverted' })).toBe(ErrorClass.RpcError);
    expect(isEndpointFault(ErrorClass.RpcError)).toBe(false);
  });
  it('classifies rate limits, 5xx and network faults as endpoint faults', () => {
    expect(classifyError(new Error('429 Too Many Requests'))).toBe(ErrorClass.RateLimited);
    expect(classifyError(new Error('503 Service Unavailable'))).toBe(ErrorClass.ServerError);
    expect(classifyError(new Error('fetch failed: ECONNREFUSED'))).toBe(ErrorClass.Network);
    for (const c of [ErrorClass.RateLimited, ErrorClass.ServerError, ErrorClass.Network]) {
      expect(isEndpointFault(c)).toBe(true);
    }
  });
});

describe('EndpointHealth scoring', () => {
  it('starts healthy and degrades as latency rises', () => {
    const h = new EndpointHealth('https://a');
    h.markStart();
    h.recordSuccess(10);
    const fast = h.score();
    h.markStart();
    h.recordSuccess(2000);
    expect(h.score()).toBeLessThan(fast);
    expect(h.score()).toBeGreaterThan(0);
  });

  it('penalises slot lag independently of latency', () => {
    const h = new EndpointHealth('https://a', { maxSlotLag: 100 });
    h.markStart();
    h.recordSuccess(10);
    const fresh = h.score();
    h.recordSlot(900, 1000); // 100 slots behind freshest
    expect(h.score()).toBeLessThan(fresh);
  });

  it('opens the circuit after the failure threshold and reports score 0', () => {
    const h = new EndpointHealth('https://a', { breakerThreshold: 3, breakerCooldownMs: 50 });
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      h.markStart();
      h.recordFailure(now);
    }
    expect(h.snapshot().circuit).toBe('open');
    expect(h.score()).toBe(0);
    expect(h.isAvailable(now)).toBe(false);
  });

  it('half-opens after cooldown and closes on a successful probe', () => {
    const h = new EndpointHealth('https://a', { breakerThreshold: 2, breakerCooldownMs: 10 });
    const t0 = 1_000_000;
    h.markStart();
    h.recordFailure(t0);
    h.markStart();
    h.recordFailure(t0);
    expect(h.isAvailable(t0)).toBe(false);
    // after cooldown the breaker half-opens to allow one probe
    expect(h.isAvailable(t0 + 20)).toBe(true);
    h.markStart();
    h.recordSuccess(15);
    expect(h.snapshot().circuit).toBe('closed');
  });
});
