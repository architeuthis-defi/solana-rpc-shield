/**
 * Landing-rate A/B: tutorial-grade naive client vs the shield, against the
 * same simulated failure modes — REAL HTTP servers from the test fixtures.
 *
 *   npm run sim:landing
 *
 * The naive client is implemented fairly: it is exactly what most guides
 * show — one endpoint, sendTransaction, poll for a while, and on timeout
 * "just retry" by signing a FRESH transaction. That last step is the
 * industry-default double-send bug; the DOUBLE-LANDS column exists because
 * the naive pattern actually produces them.
 *
 * Determinism: failure assignment is by intent index (not wall clock), so
 * the COUNT columns reproduce exactly run-to-run; latency medians carry
 * normal timer jitter (±a few ms).
 */
import { createFetchTransport, createResilientTransport, TransactionManager } from '../src/index.js';
import { createCluster, type ClusterSim, type NodeView } from '../test/helpers/cluster-sim.js';
import type { LocalRpcServer, ServerMode } from '../test/helpers/rpc-server.js';

const INTENTS = 50;
const CONCURRENCY = 8;
const NAIVE_POLL_BUDGET_MS = 350;

interface IntentResult {
  landedCount: number; // ledger entries for this intent (>1 = double-land!)
  confirmedByClient: boolean;
  signaturesProduced: number;
  ms: number;
}
interface ClientStats {
  landed: number;
  doubles: number;
  lost: number;
  resigns: number;
  medianMs: number;
}

interface Scenario {
  readonly name: string;
  readonly description: string;
  /** Configure per-intent node behavior. Return the two endpoints (primary, backup). */
  setup(cluster: ClusterSim, intent: number): Promise<{ primary: LocalRpcServer; backup: LocalRpcServer }>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function rpcCall<T>(url: string, method: string, params: unknown[], timeoutMs: number): Promise<T> {
  const transport = createFetchTransport({ url });
  return transport<T>({
    payload: { jsonrpc: '2.0', id: 1, method, params },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** The tutorial pattern, verbatim: single endpoint; on timeout, re-sign fresh. */
async function naiveSendAndConfirm(url: string, intent: number): Promise<Omit<IntentResult, 'landedCount'>> {
  const t0 = Date.now();
  let signatures = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const bh = await rpcCall<{ result?: { value?: { blockhash: string } } }>(
        url,
        'getLatestBlockhash',
        [{ commitment: 'confirmed' }],
        500,
      );
      const blockhash = bh.result?.value?.blockhash;
      if (!blockhash) throw new Error('no blockhash');
      const wire = `${blockhash}|naive-${intent}-attempt${attempt}`; // fresh signature each attempt
      const sent = await rpcCall<{ result?: string; error?: unknown }>(
        url,
        'sendTransaction',
        [wire, { encoding: 'base64' }],
        500,
      );
      if (typeof sent.result !== 'string') throw new Error('send failed');
      signatures++;
      const deadline = Date.now() + NAIVE_POLL_BUDGET_MS;
      while (Date.now() < deadline) {
        const st = await rpcCall<{ result?: { value?: Array<{ confirmationStatus?: string } | null> } }>(
          url,
          'getSignatureStatuses',
          [[sent.result], {}],
          500,
        );
        if (st.result?.value?.[0]?.confirmationStatus) {
          return { confirmedByClient: true, signaturesProduced: signatures, ms: Date.now() - t0 };
        }
        await sleep(15);
      }
      // timeout → "just try again" with a brand-new transaction (the canonical mistake)
    } catch {
      await sleep(20); // send/poll failed → tutorial says retry
    }
  }
  return { confirmedByClient: false, signaturesProduced: signatures, ms: Date.now() - t0 };
}

async function shieldSendAndConfirm(
  endpoints: string[],
  intent: number,
): Promise<Omit<IntentResult, 'landedCount'>> {
  const t0 = Date.now();
  let signatures = 0;
  const transport = createResilientTransport({ endpoints, requestTimeoutMs: 500 });
  const manager = new TransactionManager(transport);
  try {
    await manager.sendAndConfirm({
      buildSignedTx: (bh) => {
        signatures++;
        return Promise.resolve(`${bh.blockhash}|shield-${intent}-epoch${signatures}`);
      },
      maxAttempts: 2,
      confirmTimeoutMs: 1_200,
      pollIntervalMs: 15,
      rebroadcastIntervalMs: 60,
      deathGraceMs: 30,
      submitRetries: 2,
    });
    return { confirmedByClient: true, signaturesProduced: signatures, ms: Date.now() - t0 };
  } catch {
    return { confirmedByClient: false, signaturesProduced: signatures, ms: Date.now() - t0 };
  }
}

// ---------------------------------------------------------------------------

const scenarios: Scenario[] = [
  {
    name: 'endpoint outage (25% of intents)',
    description: 'primary refuses connections for a quarter of the traffic',
    setup: async (cluster, intent) => {
      const primary = await cluster.node({ autoLandOnAccept: true });
      const backup = await cluster.node({ autoLandOnAccept: true });
      if (intent % 4 === 0) primary.setMode('destroy' satisfies ServerMode);
      return { primary, backup };
    },
  },
  {
    name: 'latency spike (50% of intents)',
    description: 'primary answers, but slower than the naive poll budget',
    setup: async (cluster, intent) => {
      const primary = await cluster.node({ autoLandOnAccept: true });
      const backup = await cluster.node({ autoLandOnAccept: true });
      if (intent % 2 === 0) primary.setLatency(120);
      return { primary, backup };
    },
  },
  {
    name: 'status-blind node (hot polls lag 450ms)',
    description: 'txs land instantly but the node hides them from hot status polls',
    setup: async (cluster) => {
      const primary = await cluster.node({ autoLandOnAccept: true, statusLagMs: 450 } satisfies NodeView);
      const backup = await cluster.node({ autoLandOnAccept: true, statusLagMs: 450 });
      return { primary, backup };
    },
  },
  {
    name: 'rate-limit bursts (30% of intents)',
    description: 'primary returns HTTP 500 during bursts',
    setup: async (cluster, intent) => {
      const primary = await cluster.node({ autoLandOnAccept: true });
      const backup = await cluster.node({ autoLandOnAccept: true });
      if (intent % 10 < 3) primary.setMode('http500');
      return { primary, backup };
    },
  },
  {
    name: 'blackhole (20% of intents)',
    description: 'primary accepts connections and never answers',
    setup: async (cluster, intent) => {
      const primary = await cluster.node({ autoLandOnAccept: true });
      const backup = await cluster.node({ autoLandOnAccept: true });
      if (intent % 5 === 0) primary.setMode('hang');
      return { primary, backup };
    },
  },
];

async function runIntent(
  scenario: Scenario,
  intent: number,
  client: 'naive' | 'shield',
): Promise<IntentResult> {
  const cluster = createCluster();
  cluster.truth.registerBlockhash(`BH-${client}-${intent}`, 1_000_000);
  try {
    const { primary, backup } = await scenario.setup(cluster, intent);
    const partial =
      client === 'naive'
        ? await naiveSendAndConfirm(primary.url, intent)
        : await shieldSendAndConfirm([primary.url, backup.url], intent);
    return { ...partial, landedCount: cluster.truth.ledger().size };
  } finally {
    await cluster.close();
  }
}

async function runPool<T>(items: number, fn: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = new Array(items) as T[];
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items) return;
        out[i] = await fn(i);
      }
    }),
  );
  return out;
}

function summarize(results: IntentResult[]): ClientStats {
  const landedMs = results.filter((r) => r.landedCount >= 1 && r.confirmedByClient).map((r) => r.ms);
  landedMs.sort((a, b) => a - b);
  return {
    landed: results.filter((r) => r.landedCount >= 1).length,
    doubles: results.filter((r) => r.landedCount > 1).length,
    lost: results.filter((r) => r.landedCount === 0).length,
    resigns: results.reduce((n, r) => n + Math.max(0, r.signaturesProduced - 1), 0),
    medianMs: landedMs[Math.floor(landedMs.length / 2)] ?? Number.NaN,
  };
}

function pct(n: number): string {
  return `${((n / INTENTS) * 100).toFixed(0)}%`;
}

async function main(): Promise<void> {
  console.log(`landing-rate simulation — ${INTENTS} intents per scenario per client\n`);
  const rows: string[] = [
    '| Scenario | Client | Landed | Lost | **Double-lands** | Extra signatures | Median confirm |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const scenario of scenarios) {
    const naive = summarize(await runPool(INTENTS, (i) => runIntent(scenario, i, 'naive')));
    const shield = summarize(await runPool(INTENTS, (i) => runIntent(scenario, i, 'shield')));
    rows.push(
      `| ${scenario.name} | naive | ${pct(naive.landed)} | ${pct(naive.lost)} | **${naive.doubles}** | ${naive.resigns} | ${Number.isNaN(naive.medianMs) ? '—' : `${naive.medianMs}ms`} |`,
      `| | **shield** | **${pct(shield.landed)}** | ${pct(shield.lost)} | **${shield.doubles}** | ${shield.resigns} | ${Number.isNaN(shield.medianMs) ? '—' : `${shield.medianMs}ms`} |`,
    );
    console.log(`✓ ${scenario.name} — ${scenario.description}`);
  }
  console.log(`\n${rows.join('\n')}\n`);
  console.log(
    'Counts are deterministic (failure assignment is by intent index); medians carry timer jitter.\n' +
      'naive = the tutorial pattern: one endpoint, poll, and on timeout re-sign a fresh transaction.\n' +
      'Double-lands = intents where MORE THAN ONE transaction landed on the ledger. Funds-loss class.',
  );
}

main().catch((err: unknown) => {
  console.error('landing-sim failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
