import { describe, expect, it } from 'vitest';
import { weightedOrder, type WeightedItem } from '../../src/transport/routing.js';
import { lcg } from '../helpers/rng.js';

const items = (masses: number[]): Array<WeightedItem<string>> =>
  masses.map((mass, i) => ({ item: `n${i}`, mass }));

describe('weightedOrder', () => {
  it('always returns a full permutation of the input', () => {
    const rng = lcg(7);
    for (let round = 0; round < 50; round++) {
      const order = weightedOrder(items([5, 0, 1, 2.5]), rng);
      expect([...order].sort()).toEqual(['n0', 'n1', 'n2', 'n3']);
    }
  });

  it('never ranks a zero-mass item ahead of any positive-mass item', () => {
    const rng = lcg(1234);
    for (let round = 0; round < 200; round++) {
      const order = weightedOrder(items([1, 0, 3, 0]), rng);
      const zeroPositions = [order.indexOf('n1'), order.indexOf('n3')];
      const positivePositions = [order.indexOf('n0'), order.indexOf('n2')];
      expect(Math.min(...zeroPositions)).toBeGreaterThan(Math.max(...positivePositions));
    }
  });

  it('keeps input order among zero-mass items (stable last resorts)', () => {
    const order = weightedOrder(items([0, 0, 0]), lcg(9));
    expect(order).toEqual(['n0', 'n1', 'n2']);
  });

  it('rng()=0 selects the first positive-mass item', () => {
    const order = weightedOrder(items([0, 2, 5]), () => 0);
    expect(order[0]).toBe('n1');
  });

  it('distributes first picks proportionally to mass (3:1 → ~75/25)', () => {
    const rng = lcg(42);
    let firstA = 0;
    const n = 4_000;
    for (let i = 0; i < n; i++) {
      if (weightedOrder(items([3, 1]), rng)[0] === 'n0') firstA++;
    }
    const share = firstA / n;
    expect(share).toBeGreaterThan(0.71);
    expect(share).toBeLessThan(0.79);
  });

  it('clamps the float-dust miss to the final candidate instead of crashing', () => {
    // 0.1 + 0.2 === 0.30000000000000004: with rng() at the top of its range the
    // cursor lands a hair PAST the last mass (r stays ~2.8e-17 > 0), findIndex
    // misses every candidate, and the clamp must hand the draw to the final one.
    const order = weightedOrder(items([0.1, 0.2]), () => 1);
    expect(order).toEqual(['n1', 'n0']); // clamp → last candidate wins the draw
  });
});
