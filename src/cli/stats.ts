/** Latency statistics for `rpc-shield bench` — pure and unit-tested. */

export interface LatencySummary {
  readonly count: number;
  readonly errors: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

/** Nearest-rank percentile over an ASCENDING-sorted array. q in [0,1]. */
export function percentile(sortedAsc: readonly number[], q: number): number {
  if (sortedAsc.length === 0) return Number.NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(q * sortedAsc.length) - 1));
  return sortedAsc[idx]!;
}

export function summarize(latencies: readonly number[], errors = 0): LatencySummary {
  if (latencies.length === 0) {
    return { count: 0, errors, min: Number.NaN, max: Number.NaN, mean: Number.NaN, p50: Number.NaN, p95: Number.NaN, p99: Number.NaN };
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    errors,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean: sum / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}
