import { describe, expect, it } from 'vitest';
import { renderBenchTable, renderHealthTable, truncateUrl } from '../../src/cli/render.js';
import { percentile, summarize } from '../../src/cli/stats.js';
import type { HealthSnapshot } from '../../src/types/index.js';

const SNAP: HealthSnapshot = {
  url: 'https://api.mainnet-beta.solana.com',
  circuit: 'closed',
  latencyMs: 42.4,
  errorRate: 0.05,
  slotLag: 2,
  score: 0.91,
  inFlight: 1,
};

describe('stats', () => {
  it('computes nearest-rank percentiles', () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(sorted, 0.5)).toBe(50);
    expect(percentile(sorted, 0.95)).toBe(100);
    expect(percentile(sorted, 0.0)).toBe(10);
    expect(Number.isNaN(percentile([], 0.5))).toBe(true);
  });

  it('summarizes latencies with errors carried through', () => {
    const s = summarize([30, 10, 20], 2);
    expect(s).toMatchObject({ count: 3, errors: 2, min: 10, max: 30, p50: 20 });
    expect(s.mean).toBeCloseTo(20);
  });

  it('returns NaN markers for an empty run instead of fake zeros', () => {
    const s = summarize([], 5);
    expect(s.count).toBe(0);
    expect(s.errors).toBe(5);
    expect(Number.isNaN(s.p50)).toBe(true);
  });
});

describe('truncateUrl', () => {
  it('keeps short URLs intact and middle-truncates long ones', () => {
    expect(truncateUrl('https://a.io')).toBe('https://a.io');
    const long = 'https://solana-mainnet.rpc.extremely-long-provider-name.example.com/v2/abcdef';
    const out = truncateUrl(long, 44);
    expect(out.length).toBe(44);
    expect(out).toContain('…');
    expect(out.startsWith('https://')).toBe(true);
  });
});

describe('renderHealthTable', () => {
  it('renders one aligned row per endpoint without ANSI codes by default', () => {
    const out = renderHealthTable([SNAP, { ...SNAP, url: 'https://b.io', circuit: 'open', score: 0.1 }]);
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^ENDPOINT\s+CIRCUIT\s+SCORE\s+LATENCY\s+ERR-RATE\s+SLOT-LAG\s+IN-FLIGHT$/);
    expect(lines[1]).toContain('https://api.mainnet-beta.solana.com');
    expect(lines[1]).toContain('CLOSED');
    expect(lines[1]).toContain('0.91');
    expect(lines[1]).toContain('42ms');
    expect(lines[1]).toContain('5%');
    expect(lines[2]).toContain('OPEN');
    expect(out).not.toContain('\x1b[');
  });

  it('paints AFTER padding so colour never skews column alignment', () => {
    const plain = renderHealthTable([SNAP]);
    const colored = renderHealthTable([SNAP], { color: true });
    // eslint-disable-next-line no-control-regex
    const stripped = colored.replace(/\x1b\[[0-9;]*m/g, '');
    expect(stripped).toBe(plain);
    expect(colored).toContain('\x1b[32m'); // closed circuit + healthy score → green
  });
});

describe('renderBenchTable', () => {
  it('renders summaries with NaN shown as — and rps to one decimal', () => {
    const rows = [
      { label: 'https://a.io', summary: summarize([10, 20, 30], 0), rps: 12.345 },
      { label: 'https://down.io', summary: summarize([], 30), rps: 0 },
    ];
    const out = renderBenchTable(rows);
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^TARGET\s+REQS\s+ERRS\s+MIN\s+P50\s+P95\s+P99\s+MAX\s+RPS/);
    expect(lines[1]).toContain('12.3');
    expect(lines[2]).toContain('30'); // errors column
    expect(lines[2]).toContain('—'); // NaN latencies render as em-dash
  });
});
