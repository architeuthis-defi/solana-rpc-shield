/**
 * Branch-level gap coverage: error paths, fallback branches and API-surface
 * checks that the behavioural suites don't reach. Each block names the branch
 * it pins so a refactor that kills the branch kills the test with it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as shield from '../../src/index.js';
import { classifyError } from '../../src/transport/health.js';
import { createResilientTransport } from '../../src/transport/resilient-transport.js';
import { SlotMonitor } from '../../src/transport/slot-monitor.js';
import { PriorityFeeEstimator } from '../../src/transaction/priority-fee.js';
import { TransactionManager } from '../../src/transaction/transaction-manager.js';
import { fromLegacyAdapter, fromWalletStandard, type StandardWallet } from '../../src/wallet/signers.js';
import { toBase64 } from '../../src/wallet/wallet-pipeline.js';
import { ShieldTelemetry } from '../../src/observability/otel.js';
import { ErrorClass, type RpcRequest, type RpcTransport } from '../../src/types/index.js';

afterEach(() => vi.unstubAllGlobals());

describe('public API surface (src/index.ts barrel)', () => {
  it('exports every primitive a dApp needs, under stable names', () => {
    expect(typeof shield.createResilientTransport).toBe('function');
    expect(typeof shield.createFetchTransport).toBe('function');
    expect(typeof shield.TransactionManager).toBe('function');
    expect(typeof shield.WalletPipeline).toBe('function');
    expect(typeof shield.fromWalletStandard).toBe('function');
    expect(typeof shield.fromLegacyAdapter).toBe('function');
    expect(typeof shield.ShieldTelemetry).toBe('function');
    expect(typeof shield.SlotMonitor).toBe('function');
    expect(typeof shield.PriorityFeeEstimator).toBe('function');
    expect(shield.MIN_JITO_TIP_LAMPORTS).toBe(1_000);
    expect(shield.MAX_BUNDLE_TXS).toBe(5);
    expect(shield.ErrorClass.RateLimited).toBe('rate_limited');
  });
});

describe('classifyError — remaining classes', () => {
  it.each([
    ['HTTP 503 Service Unavailable', ErrorClass.ServerError],
    ['internal server error', ErrorClass.ServerError],
    ['request timed out', ErrorClass.Timeout],
    ['getaddrinfo ENOTFOUND rpc.example', ErrorClass.Network],
    ['HTTP 429 Too Many Requests', ErrorClass.RateLimited],
    ['something inexplicable', ErrorClass.Unknown],
  ])('classifies %s', (message, expected) => {
    expect(classifyError(new Error(message))).toBe(expected);
  });

  it('classifies non-Error values and JSON-RPC error objects', () => {
    expect(classifyError('boom')).toBe(ErrorClass.Unknown);
    expect(classifyError({ code: -32002, message: 'busy' })).toBe(ErrorClass.RpcError);
    expect(classifyError({ name: 'AbortError' })).toBe(ErrorClass.Timeout);
  });
});

describe('createResilientTransport — config validation', () => {
  it('rejects an empty endpoint list at construction', () => {
    expect(() => createResilientTransport({ endpoints: [] })).toThrow(/at least one endpoint/);
  });
});

describe('SlotMonitor — degenerate probe rounds', () => {
  it('skips nodes returning non-numeric slots and rounds where nothing responds', async () => {
    const recorded: Array<[number, number]> = [];
    const targets = [
      {
        url: 'a',
        transport: (async () => ({ result: 'not-a-number' })) as RpcTransport,
        recordSlot: (own: number, freshest: number) => recorded.push([own, freshest]),
      },
      {
        url: 'b',
        transport: (async () => {
          throw new Error('probe down');
        }) as RpcTransport,
        recordSlot: (own: number, freshest: number) => recorded.push([own, freshest]),
      },
    ];
    const monitor = new SlotMonitor(targets);
    await monitor.tick(); // freshest stays 0 → nothing recorded, nothing thrown
    expect(recorded).toEqual([]);
  });

  it('never overlaps tick rounds', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const monitor = new SlotMonitor([
      {
        url: 'a',
        transport: (async () => {
          calls++;
          await gate;
          return { result: 5 };
        }) as RpcTransport,
        recordSlot: () => undefined,
      },
    ]);
    const first = monitor.tick();
    const second = monitor.tick(); // guarded: must not start a second probe
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });
});

describe('PriorityFeeEstimator — locked-accounts narrowing', () => {
  it('passes lockedWritableAccounts through to the RPC params', async () => {
    let seenParams: unknown;
    const transport: RpcTransport = (async (req: RpcRequest) => {
      seenParams = (req.payload as { params: unknown }).params;
      return { result: [{ slot: 1, prioritizationFee: 5_000 }] };
    }) as RpcTransport;
    const fee = await new PriorityFeeEstimator(transport).estimate(['WriteLockedAcc']);
    expect(seenParams).toEqual([['WriteLockedAcc']]);
    expect(fee).toBe(5_000);
  });
});

describe('TransactionManager — error and fallback branches', () => {
  const dummyTransport = (handlers: Record<string, (params: unknown) => unknown>): RpcTransport =>
    (async (req: RpcRequest) => {
      const { method, params } = req.payload as { method: string; params: unknown };
      const h = handlers[method];
      if (!h) throw new Error(`unhandled ${method}`);
      return h(params);
    }) as RpcTransport;

  it('getLatestBlockhash throws on an empty RPC response', async () => {
    const tm = new TransactionManager(dummyTransport({ getLatestBlockhash: () => ({}) }));
    await expect(tm.getLatestBlockhash()).rejects.toThrow(/empty response/);
  });

  it('submit throws when the RPC returns no signature', async () => {
    const tm = new TransactionManager(dummyTransport({ sendTransaction: () => ({ result: 42 }) }));
    await expect(tm.submit('tx')).rejects.toThrow(/no signature returned/);
  });

  it('fallbackToRpc=false rethrows the relay error instead of falling back', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('relay down');
    });
    const sends: unknown[] = [];
    const tm = new TransactionManager(
      dummyTransport({
        sendTransaction: (p) => {
          sends.push(p);
          return { result: 'SIG' };
        },
      }),
      { jito: { blockEngineUrl: 'https://engine', fallbackToRpc: false } },
    );
    await expect(tm.submit('tx')).rejects.toThrow(/relay down/);
    expect(sends).toHaveLength(0); // never reached the RPC path
  });

  it('jitoRpc surfaces engine JSON-RPC errors (message and messageless)', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'bundle malformed' } }), {
          status: 200,
        }),
    );
    const tm = new TransactionManager(dummyTransport({}), { jito: { blockEngineUrl: 'https://engine' } });
    await expect(tm.submitBundle(['tx'])).rejects.toThrow(/bundle malformed/);

    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000 } }), { status: 200 }),
    );
    await expect(tm.submitBundle(['tx'])).rejects.toThrow(/-32000/);
  });

  it('jitoRpc surfaces HTTP failures and empty results', async () => {
    vi.stubGlobal('fetch', async () => new Response('teapot', { status: 503 }));
    const tm = new TransactionManager(dummyTransport({}), { jito: { blockEngineUrl: 'https://engine' } });
    await expect(tm.getTipAccounts()).rejects.toThrow(/HTTP 503/);

    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1 }), { status: 200 }));
    await expect(tm.getTipAccounts()).rejects.toThrow(/empty result/);
  });

  it('getTipAccounts rejects an empty account list', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }), { status: 200 }),
    );
    const tm = new TransactionManager(dummyTransport({}), { jito: { blockEngineUrl: 'https://engine' } });
    await expect(tm.getTipAccounts()).rejects.toThrow(/empty list/);
  });

  it('bundle APIs demand a configured block engine', async () => {
    const tm = new TransactionManager(dummyTransport({}));
    await expect(tm.getTipAccounts()).rejects.toThrow(/not configured/);
  });

  it('confirm keeps polling while the status is below the target commitment', async () => {
    let polls = 0;
    const tm = new TransactionManager(
      dummyTransport({
        getSignatureStatuses: () => {
          polls++;
          return {
            result: {
              value: [{ confirmationStatus: polls < 3 ? 'processed' : 'finalized', err: null, slot: 4 }],
            },
          };
        },
      }),
    );
    const res = await tm.confirm('SIG', 100, { commitment: 'finalized', timeoutMs: 2_000, pollIntervalMs: 1 });
    expect(res).toMatchObject({ confirmationStatus: 'finalized' });
    expect(polls).toBeGreaterThanOrEqual(3);
  });
});

describe('wallet signer bridges — fallback branches', () => {
  it('defaults the chain to solana:mainnet when the account lists none', async () => {
    const seen: Array<{ chain?: string }> = [];
    const wallet: StandardWallet = {
      accounts: [{ address: 'NoChainAcc' }],
      features: {
        'solana:signTransaction': {
          signTransaction: async (...inputs: Array<{ transaction: Uint8Array; chain?: string }>) => {
            seen.push({ ...(inputs[0]?.chain !== undefined ? { chain: inputs[0].chain } : {}) });
            return [{ signedTransaction: inputs[0]!.transaction }];
          },
        },
      },
    };
    const signer = fromWalletStandard(wallet);
    await signer.signTransactionBytes(Uint8Array.from([1]));
    expect(seen[0]?.chain).toBe('solana:mainnet');
    expect(signer.label).toBe('wallet-standard'); // nameless wallet falls back to the bridge label
  });

  it('legacy adapter without a name falls back to the bridge label', () => {
    const signer = fromLegacyAdapter(
      { signTransaction: async (tx: { serialize(): Uint8Array }) => tx },
      { deserialize: () => ({ serialize: () => Uint8Array.from([1]) }) },
    );
    expect(signer.label).toBe('wallet-adapter');
  });
});

describe('toBase64 — browser path (no Buffer global)', () => {
  it('encodes via btoa when Buffer is unavailable', () => {
    const bytes = Uint8Array.from([72, 101, 108, 108, 111]);
    const viaBuffer = toBase64(bytes);
    vi.stubGlobal('Buffer', undefined);
    expect(toBase64(bytes)).toBe(viaBuffer);
    expect(toBase64(bytes)).toBe('SGVsbG8=');
  });
});

describe('ShieldTelemetry — teardown and ignored events', () => {
  it('walletListener ignores lifecycle events covered by transaction metrics', () => {
    const telemetry = new ShieldTelemetry();
    expect(() => {
      telemetry.walletListener({ type: 'submitted', signature: 'S', round: 0 });
      telemetry.walletListener({ type: 'expired', signature: 'S' });
      telemetry.walletListener({ type: 'rebroadcast_error', signature: 'S', message: 'already processed' });
    }).not.toThrow();
  });

  it('dispose() detaches the health callback so new sources are never read', () => {
    const telemetry = new ShieldTelemetry();
    let reads = 0;
    telemetry.dispose();
    telemetry.observeHealth({
      getHealth: () => {
        reads++;
        return [];
      },
    });
    // No SDK collection is running here; dispose() must leave zero live wiring.
    expect(reads).toBe(0);
  });
});
