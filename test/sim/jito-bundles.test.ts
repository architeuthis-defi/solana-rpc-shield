import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BundleFailedError,
  MAX_BUNDLE_TXS,
  TransactionManager,
  type TransactionEvent,
} from '../../src/transaction/transaction-manager.js';
import type { RpcRequest, RpcTransport } from '../../src/types/index.js';

const noTransport: RpcTransport = (async (_req: RpcRequest) => {
  throw new Error('bundle paths must not touch the RPC transport');
});

const ENGINE = 'https://block-engine.example';
const TIP_ACCOUNTS = ['Tip111', 'Tip222', 'Tip333'];

type JitoHandler = (method: string, params: unknown[]) => unknown;

/** Stub global fetch with a block-engine that dispatches by JSON-RPC method. */
function stubEngine(handler: JitoHandler): { calls: Array<{ path: string; method: string; params: unknown[] }> } {
  const calls: Array<{ path: string; method: string; params: unknown[] }> = [];
  vi.stubGlobal(
    'fetch',
    async (url: string | URL, init?: { body?: string }): Promise<Response> => {
      const body = JSON.parse(init?.body ?? '{}') as { method: string; params: unknown[] };
      calls.push({ path: new URL(String(url)).pathname, method: body.method, params: body.params });
      const result = handler(body.method, body.params);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  );
  return { calls };
}

afterEach(() => vi.unstubAllGlobals());

function manager(onEvent?: (e: TransactionEvent) => void): TransactionManager {
  return new TransactionManager(noTransport, {
    jito: { blockEngineUrl: ENGINE },
    ...(onEvent ? { onEvent } : {}),
  });
}

describe('Jito tip accounts', () => {
  it('fetches tip accounts from the engine once and caches them', async () => {
    const { calls } = stubEngine((method) => {
      if (method === 'getTipAccounts') return TIP_ACCOUNTS;
      throw new Error(`unexpected ${method}`);
    });
    const tm = manager();
    expect(await tm.getTipAccounts()).toEqual(TIP_ACCOUNTS);
    expect(await tm.getTipAccounts()).toEqual(TIP_ACCOUNTS);
    expect(calls.filter((c) => c.method === 'getTipAccounts')).toHaveLength(1); // cached
    expect(calls[0]!.path).toBe('/api/v1/getTipAccounts');
  });

  it('pickTipAccount returns a member of the engine list', async () => {
    stubEngine(() => TIP_ACCOUNTS);
    const tm = manager();
    for (let i = 0; i < 20; i++) {
      expect(TIP_ACCOUNTS).toContain(await tm.pickTipAccount());
    }
  });
});

describe('submitBundle', () => {
  it('posts base64 bundles to /api/v1/bundles and returns the bundle id', async () => {
    const { calls } = stubEngine((method) => {
      if (method === 'sendBundle') return 'BUNDLE_ID_1';
      throw new Error(`unexpected ${method}`);
    });
    const events: TransactionEvent[] = [];
    const tm = manager((e) => events.push(e));
    const id = await tm.submitBundle(['tx1', 'tx2', 'tx3']);

    expect(id).toBe('BUNDLE_ID_1');
    expect(calls[0]!.path).toBe('/api/v1/bundles');
    expect(calls[0]!.params).toEqual([['tx1', 'tx2', 'tx3'], { encoding: 'base64' }]);
    expect(events).toContainEqual({ type: 'bundle_submitted', txCount: 3 });
  });

  it(`rejects bundles outside 1..${MAX_BUNDLE_TXS} txs before touching the network`, async () => {
    stubEngine(() => {
      throw new Error('must not be called');
    });
    const tm = manager();
    await expect(tm.submitBundle([])).rejects.toThrow(RangeError);
    await expect(tm.submitBundle(['1', '2', '3', '4', '5', '6'])).rejects.toThrow(RangeError);
  });
});

describe('confirmBundle', () => {
  it('polls until the bundle lands and treats {Ok:null} err as success', async () => {
    let polls = 0;
    stubEngine((method) => {
      if (method !== 'getBundleStatuses') throw new Error(`unexpected ${method}`);
      polls++;
      if (polls < 3) return { value: [null] }; // not yet visible
      return {
        value: [
          { bundle_id: 'B1', slot: 777, confirmation_status: 'confirmed', err: { Ok: null } },
        ],
      };
    });
    const events: TransactionEvent[] = [];
    const tm = manager((e) => events.push(e));
    const res = await tm.confirmBundle('B1', { pollIntervalMs: 1 });

    expect(res).toEqual({ bundleId: 'B1', slot: 777, confirmationStatus: 'confirmed' });
    expect(polls).toBeGreaterThanOrEqual(3);
    expect(events.some((e) => e.type === 'bundle_outcome' && e.outcome === 'landed')).toBe(true);
  });

  it('waits for the TARGET commitment, not just any status', async () => {
    let polls = 0;
    stubEngine(() => {
      polls++;
      return {
        value: [
          {
            bundle_id: 'B2',
            slot: 778,
            confirmation_status: polls < 3 ? 'processed' : 'finalized',
            err: { Ok: null },
          },
        ],
      };
    });
    const tm = manager();
    const res = await tm.confirmBundle('B2', { commitment: 'finalized', pollIntervalMs: 1 });
    expect(res).toMatchObject({ confirmationStatus: 'finalized' });
    expect(polls).toBeGreaterThanOrEqual(3);
  });

  it('throws BundleFailedError on a real engine error object', async () => {
    stubEngine(() => ({
      value: [{ bundle_id: 'B3', slot: 779, confirmation_status: 'processed', err: { InstructionError: [0, 'Custom'] } }],
    }));
    const events: TransactionEvent[] = [];
    const tm = manager((e) => events.push(e));
    await expect(tm.confirmBundle('B3', { pollIntervalMs: 1 })).rejects.toBeInstanceOf(BundleFailedError);
    expect(events.some((e) => e.type === 'bundle_outcome' && e.outcome === 'failed')).toBe(true);
  });

  it('returns { timedOut } when the bundle never lands', async () => {
    stubEngine(() => ({ value: [null] }));
    const events: TransactionEvent[] = [];
    const tm = manager((e) => events.push(e));
    const res = await tm.confirmBundle('B4', { timeoutMs: 15, pollIntervalMs: 1 });
    expect(res).toEqual({ timedOut: true });
    expect(events.some((e) => e.type === 'bundle_outcome' && e.outcome === 'timed_out')).toBe(true);
  });
});

describe('sendBundleAndConfirm', () => {
  it('composes submit + confirm and throws on timeout', async () => {
    stubEngine((method) => {
      if (method === 'sendBundle') return 'B5';
      if (method === 'getBundleStatuses') return { value: [null] };
      throw new Error(`unexpected ${method}`);
    });
    const tm = manager();
    await expect(
      tm.sendBundleAndConfirm(['tx'], { timeoutMs: 15, pollIntervalMs: 1 }),
    ).rejects.toThrow(/B5 not landed within 15ms/);
  });

  it('returns the landed status end-to-end', async () => {
    stubEngine((method) => {
      if (method === 'sendBundle') return 'B6';
      return { value: [{ bundle_id: 'B6', slot: 800, confirmation_status: 'confirmed', err: null }] };
    });
    const tm = manager();
    const res = await tm.sendBundleAndConfirm(['tx1', 'tx2']);
    expect(res).toEqual({ bundleId: 'B6', slot: 800, confirmationStatus: 'confirmed' });
  });
});
