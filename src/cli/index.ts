/**
 * rpc-shield — diagnostics CLI over the SDK's own primitives.
 *
 * Every command builds the same `createResilientTransport` a dApp would use,
 * so what the CLI shows is what the shield actually does: `health`/`watch`
 * read the live scoreboard, `bench` compares raw endpoints against the
 * composite, `tx` checks a signature through the pool, and `simulate-drop`
 * wraps one endpoint's transport in an injected failure window to demonstrate
 * failover + circuit recovery against real nodes.
 */

import { Command } from 'commander';
import {
  createFetchTransport,
  createResilientTransport,
  type ResilientTransport,
} from '../transport/resilient-transport.js';
import type { Commitment } from '../transaction/transaction-manager.js';
import type { EndpointConfig, RpcTransport, TransportEvent } from '../types/index.js';
import { renderBenchTable, renderHealthTable, truncateUrl, type BenchRow } from './render.js';
import { summarize } from './stats.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const color = process.stdout.isTTY === true;
const int = (v: string): number => Number.parseInt(v, 10);

function parseEndpoints(opt: string | undefined): string[] {
  const raw = opt ?? process.env['RPC_SHIELD_ENDPOINTS'];
  const endpoints = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (endpoints.length === 0) {
    throw new Error('no endpoints: pass --endpoints <url,url,…> or set RPC_SHIELD_ENDPOINTS');
  }
  return endpoints;
}

/** One cheap composite request — feeds latency/error scoring between snapshots. */
async function probe(transport: ResilientTransport, commitment: Commitment = 'confirmed'): Promise<void> {
  try {
    await transport({
      payload: { jsonrpc: '2.0', id: 'rpc-shield-cli-probe', method: 'getSlot', params: [{ commitment }] },
    });
  } catch {
    // Probe outcomes are not the CLI's result — they land in the health table.
  }
}

function onSigint(handler: () => void): void {
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
}

const program = new Command('rpc-shield')
  .description('Diagnostics for solana-rpc-shield: endpoint health, failover, latency, tx status')
  .version('0.1.0');

program
  .command('health')
  .description('probe endpoints, print a one-shot per-node health scoreboard')
  .option('-e, --endpoints <list>', 'comma-separated RPC URLs (or RPC_SHIELD_ENDPOINTS)')
  .option('-r, --rounds <n>', 'probe rounds before the snapshot', int, 3)
  .option('-t, --timeout <ms>', 'per-request timeout', int, 5_000)
  .action(async (opts: { endpoints?: string; rounds: number; timeout: number }) => {
    const transport = createResilientTransport({
      endpoints: parseEndpoints(opts.endpoints),
      requestTimeoutMs: opts.timeout,
    });
    transport.startHealthMonitor({ intervalMs: 1_000 });
    for (let i = 0; i < opts.rounds; i++) {
      await probe(transport);
      await sleep(1_100); // let a slot-probe tick land between requests
    }
    transport.stopHealthMonitor();
    process.stdout.write(`${renderHealthTable(transport.getHealth(), { color })}\n`);
  });

program
  .command('watch')
  .description('live-refreshing health scoreboard (Ctrl-C to stop)')
  .option('-e, --endpoints <list>', 'comma-separated RPC URLs (or RPC_SHIELD_ENDPOINTS)')
  .option('-i, --interval <ms>', 'refresh interval', int, 2_000)
  .option('-t, --timeout <ms>', 'per-request timeout', int, 5_000)
  .action(async (opts: { endpoints?: string; interval: number; timeout: number }) => {
    const transport = createResilientTransport({
      endpoints: parseEndpoints(opts.endpoints),
      requestTimeoutMs: opts.timeout,
    });
    transport.startHealthMonitor({ intervalMs: Math.max(1_000, opts.interval) });
    let running = true;
    onSigint(() => {
      running = false;
    });
    while (running) {
      await probe(transport);
      const table = renderHealthTable(transport.getHealth(), { color });
      process.stdout.write(`\x1b[2J\x1b[H rpc-shield watch — ${new Date().toISOString()}\n\n${table}\n`);
      await sleep(opts.interval);
    }
    transport.stopHealthMonitor();
  });

program
  .command('bench')
  .description('latency/throughput per endpoint vs. the composite shield transport')
  .option('-e, --endpoints <list>', 'comma-separated RPC URLs (or RPC_SHIELD_ENDPOINTS)')
  .option('-n, --requests <n>', 'requests per target', int, 30)
  .option('-c, --concurrency <n>', 'parallel workers per target', int, 4)
  .option('-t, --timeout <ms>', 'per-request timeout', int, 5_000)
  .action(async (opts: { endpoints?: string; requests: number; concurrency: number; timeout: number }) => {
    const endpoints = parseEndpoints(opts.endpoints);

    async function run(transport: ResilientTransport, label: string): Promise<BenchRow> {
      const latencies: number[] = [];
      let errors = 0;
      let next = 0;
      const startedAt = Date.now();
      await Promise.all(
        Array.from({ length: Math.max(1, opts.concurrency) }, async () => {
          for (;;) {
            const k = next++;
            if (k >= opts.requests) return;
            const t0 = Date.now();
            try {
              await transport({
                payload: { jsonrpc: '2.0', id: `bench-${k}`, method: 'getSlot', params: [] },
              });
              latencies.push(Date.now() - t0);
            } catch {
              errors++; // counted and reported in the ERRS column
            }
          }
        }),
      );
      const elapsedMs = Math.max(1, Date.now() - startedAt);
      return { label, summary: summarize(latencies, errors), rps: (latencies.length / elapsedMs) * 1_000 };
    }

    const rows: BenchRow[] = [];
    for (const url of endpoints) {
      rows.push(
        await run(
          createResilientTransport({ endpoints: [url], requestTimeoutMs: opts.timeout }),
          url,
        ),
      );
    }
    rows.push(
      await run(
        createResilientTransport({ endpoints, requestTimeoutMs: opts.timeout }),
        `shield composite (${endpoints.length} endpoints)`,
      ),
    );
    process.stdout.write(`${renderBenchTable(rows, { color })}\n`);
  });

program
  .command('tx <signature>')
  .description('look up a transaction signature through the resilient pool')
  .option('-e, --endpoints <list>', 'comma-separated RPC URLs (or RPC_SHIELD_ENDPOINTS)')
  .action(async (signature: string, opts: { endpoints?: string }) => {
    const transport = createResilientTransport({ endpoints: parseEndpoints(opts.endpoints) });
    const resp = await transport<{
      result?: {
        value?: Array<{ confirmationStatus?: string; confirmations?: number | null; slot?: number; err: unknown } | null>;
      };
    }>({
      payload: {
        jsonrpc: '2.0',
        id: 'rpc-shield-cli-tx',
        method: 'getSignatureStatuses',
        params: [[signature], { searchTransactionHistory: true }],
      },
    });
    const st = resp.result?.value?.[0];
    if (!st) {
      process.stdout.write(`${signature}\n  status: NOT FOUND (never landed, or pruned beyond history)\n`);
      return;
    }
    process.stdout.write(
      `${signature}\n` +
        `  status: ${st.confirmationStatus ?? 'processed?'}\n` +
        `  slot:   ${st.slot ?? '—'}\n` +
        `  error:  ${st.err === null || st.err === undefined ? 'none' : JSON.stringify(st.err)}\n`,
    );
  });

program
  .command('simulate-drop')
  .description('inject a failure window on one endpoint and watch routing + circuit recovery')
  .option('-e, --endpoints <list>', 'comma-separated RPC URLs (or RPC_SHIELD_ENDPOINTS)')
  .requiredOption('-d, --drop <url>', 'endpoint to fail (must be one of --endpoints)')
  .option('--after <s>', 'seconds before the drop starts', int, 2)
  .option('--duration <s>', 'drop window length in seconds', int, 8)
  .option('-n, --requests <n>', 'total requests to send', int, 30)
  .option('-i, --interval <ms>', 'gap between requests', int, 500)
  .action(
    async (opts: {
      endpoints?: string;
      drop: string;
      after: number;
      duration: number;
      requests: number;
      interval: number;
    }) => {
      const endpoints = parseEndpoints(opts.endpoints);
      if (!endpoints.includes(opts.drop)) {
        throw new Error(`--drop ${opts.drop} is not in --endpoints`);
      }
      const t0 = Date.now();
      const dropStart = opts.after * 1_000;
      const dropEnd = dropStart + opts.duration * 1_000;
      const inWindow = (): boolean => {
        const t = Date.now() - t0;
        return t >= dropStart && t < dropEnd;
      };

      // Wrap only the victim's real transport; the shield can't tell the difference.
      const transportFactory = (endpoint: EndpointConfig): RpcTransport => {
        const real = createFetchTransport(endpoint);
        if (endpoint.url !== opts.drop) return real;
        return async <T>(req: { payload: unknown; signal?: AbortSignal }): Promise<T> => {
          if (inWindow()) throw new Error('simulated network drop');
          return real(req);
        };
      };

      let served = '';
      let faults: string[] = [];
      const transport = createResilientTransport({
        endpoints,
        transportFactory,
        requestTimeoutMs: 4_000,
        onEvent: (event: TransportEvent) => {
          if (event.type === 'request_success') served = event.endpoint;
          if (event.type === 'request_fault') faults.push(`${truncateUrl(event.endpoint, 28)}:${event.errorClass}`);
        },
      });
      transport.startHealthMonitor({ intervalMs: 1_000 });

      let wasInWindow = false;
      for (let i = 1; i <= opts.requests; i++) {
        const nowIn = inWindow();
        if (nowIn !== wasInWindow) {
          process.stdout.write(nowIn ? `--- DROP WINDOW OPEN: ${opts.drop} now failing ---\n` : '--- DROP WINDOW CLOSED: endpoint healthy again ---\n');
          wasInWindow = nowIn;
        }
        served = '';
        faults = [];
        const t1 = Date.now();
        try {
          await transport({ payload: { jsonrpc: '2.0', id: `drop-${i}`, method: 'getSlot', params: [] } });
          const failovers = faults.length > 0 ? `  (failed over past: ${faults.join(', ')})` : '';
          process.stdout.write(`#${String(i).padStart(3)} ok via ${truncateUrl(served, 40)} ${Date.now() - t1}ms${failovers}\n`);
        } catch {
          process.stdout.write(`#${String(i).padStart(3)} FAILED on every endpoint (${faults.join(', ')})\n`);
        }
        await sleep(opts.interval);
      }
      transport.stopHealthMonitor();
      process.stdout.write(`\nfinal health:\n${renderHealthTable(transport.getHealth(), { color })}\n`);
    },
  );

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`rpc-shield: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
