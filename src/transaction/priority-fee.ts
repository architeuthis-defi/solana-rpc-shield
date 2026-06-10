/**
 * Dynamic priority-fee estimation.
 *
 * Reads `getRecentPrioritizationFees` and picks a percentile of the recent
 * non-zero fees, clamped to a floor/ceiling. A fixed fee either overpays in
 * calm conditions or underpays (and drops) under congestion — the whole point
 * of this module is to never hardcode a fee, while never letting a fee spike
 * blow past a sane ceiling.
 */

import type { RpcTransport } from '../types/index.js';

export interface PrioritizationFee {
  readonly slot: number;
  readonly prioritizationFee: number; // micro-lamports per compute unit
}

export interface PriorityFeeConfig {
  /** Percentile of recent non-zero fees to target, 0..1. Default 0.75. */
  readonly percentile?: number;
  /** Hard floor in micro-lamports/CU (never bid below). Default 1000. */
  readonly floorMicroLamports?: number;
  /** Hard ceiling in micro-lamports/CU (never overpay above). Default 1_000_000. */
  readonly ceilingMicroLamports?: number;
}

const DEFAULTS = {
  percentile: 0.75,
  floorMicroLamports: 1_000,
  ceilingMicroLamports: 1_000_000,
} as const;

/**
 * Pure fee computation — separated from I/O so it is exhaustively testable.
 * Empty / all-zero input falls back to the floor (a live network with no
 * recent priority fees needs only the floor to land).
 */
export function computePriorityFee(
  fees: ReadonlyArray<PrioritizationFee>,
  config?: PriorityFeeConfig,
): number {
  const percentile = clamp01(config?.percentile ?? DEFAULTS.percentile);
  const floor = config?.floorMicroLamports ?? DEFAULTS.floorMicroLamports;
  const ceiling = config?.ceilingMicroLamports ?? DEFAULTS.ceilingMicroLamports;

  const sorted = fees
    .map((f) => f.prioritizationFee)
    .filter((f) => Number.isFinite(f) && f > 0)
    .sort((a, b) => a - b);

  if (sorted.length === 0) return floor;

  const index = Math.min(sorted.length - 1, Math.floor(percentile * sorted.length));
  const target = sorted[index] ?? floor;
  return Math.max(floor, Math.min(ceiling, Math.round(target)));
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export class PriorityFeeEstimator {
  private readonly transport: RpcTransport;
  private readonly config: PriorityFeeConfig | undefined;

  constructor(transport: RpcTransport, config?: PriorityFeeConfig) {
    this.transport = transport;
    this.config = config;
  }

  /**
   * Fetch recent prioritization fees and compute a fee.
   * @param lockedWritableAccounts optional accounts the tx writes — narrows the
   *   estimate to contention on exactly those accounts.
   */
  async estimate(lockedWritableAccounts?: ReadonlyArray<string>): Promise<number> {
    const params = lockedWritableAccounts && lockedWritableAccounts.length > 0
      ? [lockedWritableAccounts]
      : [[]];
    const resp = await this.transport<{ result?: PrioritizationFee[]; error?: unknown }>({
      payload: { jsonrpc: '2.0', id: 'rpc-shield-fee', method: 'getRecentPrioritizationFees', params },
    });
    return computePriorityFee(resp.result ?? [], this.config);
  }
}
