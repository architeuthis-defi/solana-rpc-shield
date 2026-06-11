/**
 * Terminal rendering for the diagnostics CLI — pure string builders, no
 * process access, so every layout/colour decision is unit-testable.
 * ANSI colour is applied AFTER padding so escape codes never skew widths.
 */

import type { CircuitState, HealthSnapshot } from '../types/index.js';
import type { LatencySummary } from './stats.js';

export interface RenderOptions {
  /** Emit ANSI colour codes. Default false — caller decides from isTTY. */
  readonly color?: boolean;
}

const RESET = '\x1b[0m';
const paint = (code: string, s: string, on: boolean): string => (on ? `\x1b[${code}m${s}${RESET}` : s);

const CIRCUIT_COLOR: Record<CircuitState, string> = { closed: '32', half_open: '33', open: '31' };
const CIRCUIT_LABEL: Record<CircuitState, string> = { closed: 'CLOSED', half_open: 'HALF-OPEN', open: 'OPEN' };

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

/** Keep scheme+host head and path tail visible for long endpoint URLs. */
export function truncateUrl(url: string, max = 44): string {
  if (url.length <= max) return url;
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return `${url.slice(0, head)}…${url.slice(url.length - tail)}`;
}

const fmtMs = (v: number): string => (Number.isNaN(v) ? '—' : `${Math.round(v)}ms`);

export function renderHealthTable(snapshots: ReadonlyArray<HealthSnapshot>, options?: RenderOptions): string {
  const color = options?.color ?? false;
  const cols = [46, 11, 7, 9, 9, 10, 9] as const;
  const header = ['ENDPOINT', 'CIRCUIT', 'SCORE', 'LATENCY', 'ERR-RATE', 'SLOT-LAG', 'IN-FLIGHT']
    .map((h, i) => pad(h, cols[i] ?? 10))
    .join('');
  const rows = snapshots.map((s) => {
    const scoreCode = s.score >= 0.8 ? '32' : s.score >= 0.4 ? '33' : '31';
    return [
      pad(truncateUrl(s.url), cols[0]),
      paint(CIRCUIT_COLOR[s.circuit], pad(CIRCUIT_LABEL[s.circuit], cols[1]), color),
      paint(scoreCode, pad(s.score.toFixed(2), cols[2]), color),
      pad(fmtMs(s.latencyMs), cols[3]),
      pad(`${(s.errorRate * 100).toFixed(0)}%`, cols[4]),
      pad(String(s.slotLag), cols[5]),
      pad(String(s.inFlight), cols[6]),
    ].join('');
  });
  return [paint('2', header, color), ...rows].join('\n');
}

export interface BenchRow {
  readonly label: string;
  readonly summary: LatencySummary;
  /** Successful requests per second over the wall-clock run. */
  readonly rps: number;
}

export function renderBenchTable(rows: ReadonlyArray<BenchRow>, options?: RenderOptions): string {
  const color = options?.color ?? false;
  const cols = [46, 6, 6, 8, 8, 8, 8, 8, 8] as const;
  const header = ['TARGET', 'REQS', 'ERRS', 'MIN', 'P50', 'P95', 'P99', 'MAX', 'RPS']
    .map((h, i) => pad(h, cols[i] ?? 8))
    .join('');
  const body = rows.map((r) => {
    const errCode = r.summary.errors === 0 ? '32' : '31';
    return [
      pad(truncateUrl(r.label), cols[0]),
      pad(String(r.summary.count), cols[1]),
      paint(errCode, pad(String(r.summary.errors), cols[2]), color),
      pad(fmtMs(r.summary.min), cols[3]),
      pad(fmtMs(r.summary.p50), cols[4]),
      pad(fmtMs(r.summary.p95), cols[5]),
      pad(fmtMs(r.summary.p99), cols[6]),
      pad(fmtMs(r.summary.max), cols[7]),
      pad(Number.isFinite(r.rps) ? r.rps.toFixed(1) : '—', cols[8]),
    ].join('');
  });
  return [paint('2', header, color), ...body].join('\n');
}
