import { describe, expect, it } from 'vitest';
import {
  computePriorityFee,
  PriorityFeeEstimator,
  type PrioritizationFee,
} from '../../src/transaction/priority-fee.js';
import type { RpcRequest } from '../../src/types/index.js';

const fee = (prioritizationFee: number, slot = 1): PrioritizationFee => ({ slot, prioritizationFee });

describe('computePriorityFee', () => {
  it('falls back to the floor on empty input', () => {
    expect(computePriorityFee([], { floorMicroLamports: 1500 })).toBe(1500);
  });

  it('falls back to the floor when all recent fees are zero', () => {
    expect(computePriorityFee([fee(0), fee(0)], { floorMicroLamports: 1000 })).toBe(1000);
  });

  it('picks the requested percentile of non-zero fees', () => {
    const fees = [fee(1000), fee(2000), fee(3000), fee(4000)];
    // floor(0.75 * 4) = index 3 → 4000
    expect(computePriorityFee(fees, { percentile: 0.75, ceilingMicroLamports: 1_000_000 })).toBe(4000);
    // median-ish at 0.5 → index 2 → 3000
    expect(computePriorityFee(fees, { percentile: 0.5 })).toBe(3000);
  });

  it('clamps to the ceiling on a fee spike', () => {
    expect(computePriorityFee([fee(50_000_000)], { ceilingMicroLamports: 1_000_000 })).toBe(1_000_000);
  });

  it('clamps up to the floor when recent fees are tiny', () => {
    expect(computePriorityFee([fee(5), fee(10)], { floorMicroLamports: 1000 })).toBe(1000);
  });
});

describe('PriorityFeeEstimator', () => {
  it('fetches recent fees and returns a computed estimate', async () => {
    const transport = (async (_req: RpcRequest) => ({
      result: [fee(2000), fee(3000), fee(4000), fee(5000)],
    })) as never;
    const est = new PriorityFeeEstimator(transport, { percentile: 0.5 });
    await expect(est.estimate()).resolves.toBe(4000); // floor(0.5*4)=2 → 4000
  });
});
