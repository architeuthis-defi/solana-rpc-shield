/**
 * Routing strategies for the composite transport.
 *
 * `weighted` (default) implements the listing's "distribute traffic
 * intelligently across healthy nodes": instead of always hammering the single
 * highest-scoring endpoint — which concentrates load and *provokes* the very
 * rate-limits the shield exists to avoid — each request draws a full failover
 * order by score-proportional sampling without replacement. Healthier nodes
 * still win more often; they just don't win every time.
 *
 * `best` preserves strict score ordering for callers that want deterministic
 * primary/backup semantics (e.g. a paid primary with free fallbacks).
 */

export interface WeightedItem<T> {
  readonly item: T;
  /** Non-negative sampling mass; 0 = only used when everything else is exhausted. */
  readonly mass: number;
}

/**
 * Draw a complete order by weighted sampling WITHOUT replacement.
 * Zero-mass items keep their relative input order and sort behind any
 * positive-mass item — a dead node is a last resort, never a coin-flip winner.
 */
export function weightedOrder<T>(items: ReadonlyArray<WeightedItem<T>>, rng: () => number): T[] {
  const pool = items.map((entry) => ({ item: entry.item, mass: Math.max(0, entry.mass) }));
  const order: T[] = [];
  while (pool.length > 0) {
    let total = 0;
    for (const p of pool) total += p.mass;
    let idx = 0;
    if (total > 0) {
      let r = rng() * total;
      idx = pool.findIndex((p) => {
        r -= p.mass;
        return p.mass > 0 && r <= 0;
      });
      if (idx < 0) idx = pool.length - 1; // float dust: clamp to the final candidate
    }
    // total === 0 → take the head: stable order among exhausted/zero-mass nodes.
    order.push(pool[idx]!.item);
    pool.splice(idx, 1);
  }
  return order;
}
