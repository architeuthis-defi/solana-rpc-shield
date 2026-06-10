/**
 * SlotMonitor — background liveness/freshness probe.
 *
 * Periodically calls `getSlot` on every endpoint, finds the freshest slot
 * across the pool, and feeds each node its lag. This is what lets the router
 * demote a node that is up and fast but serving state seconds behind the
 * cluster — a failure mode pure latency/error scoring cannot see.
 *
 * Lifecycle is explicit (start/stop) so the SDK never leaks a timer: a dApp
 * owns when probing begins and must stop it on teardown.
 */

import type { RpcTransport } from '../types/index.js';

/** Minimal surface the monitor needs from each pooled endpoint. */
export interface SlotProbeTarget {
  readonly url: string;
  readonly transport: RpcTransport;
  recordSlot(ownSlot: number, freshestSlot: number): void;
}

interface GetSlotResponse {
  readonly result?: number;
  readonly error?: unknown;
}

export interface SlotMonitorOptions {
  /** Probe interval in ms. Default 5000. */
  readonly intervalMs?: number;
  /** Commitment for the getSlot probe. Default 'confirmed'. */
  readonly commitment?: 'processed' | 'confirmed' | 'finalized';
  /** Per-probe timeout in ms. Default 4000. */
  readonly probeTimeoutMs?: number;
}

export class SlotMonitor {
  private readonly targets: ReadonlyArray<SlotProbeTarget>;
  private readonly intervalMs: number;
  private readonly commitment: 'processed' | 'confirmed' | 'finalized';
  private readonly probeTimeoutMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(targets: ReadonlyArray<SlotProbeTarget>, options?: SlotMonitorOptions) {
    this.targets = targets;
    this.intervalMs = options?.intervalMs ?? 5_000;
    this.commitment = options?.commitment ?? 'confirmed';
    this.probeTimeoutMs = options?.probeTimeoutMs ?? 4_000;
  }

  /** Begin periodic probing. Idempotent. Fires one immediate tick. */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // Allow the process to exit even while the monitor is running (Node only).
    (this.timer as { unref?: () => void }).unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Run one probe round. Exposed for deterministic testing. */
  async tick(): Promise<void> {
    if (this.ticking) return; // never overlap rounds
    this.ticking = true;
    try {
      const slots = await Promise.all(this.targets.map((t) => this.probe(t)));
      let freshest = 0;
      for (const s of slots) {
        if (s !== null && s > freshest) freshest = s;
      }
      if (freshest === 0) return; // nothing responded; leave lag untouched
      this.targets.forEach((t, i) => {
        const s = slots[i];
        if (s !== null && s !== undefined) t.recordSlot(s, freshest);
      });
    } finally {
      this.ticking = false;
    }
  }

  private async probe(target: SlotProbeTarget): Promise<number | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.probeTimeoutMs);
    try {
      const resp = await target.transport<GetSlotResponse>({
        payload: {
          jsonrpc: '2.0',
          id: 'rpc-shield-slot-probe',
          method: 'getSlot',
          params: [{ commitment: this.commitment }],
        },
        signal: ctrl.signal,
      });
      return typeof resp.result === 'number' ? resp.result : null;
    } catch {
      return null; // probe failure: skip this node this round, don't crash the monitor
    } finally {
      clearTimeout(timer);
    }
  }
}
