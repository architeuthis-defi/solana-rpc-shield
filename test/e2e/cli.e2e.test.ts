/**
 * CLI end-to-end: buildProgram() runs in-process against real local JSON-RPC
 * servers, stdout is captured, and every command's happy + failure path is
 * asserted on actual rendered output.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';
import { startRpcServer, type LocalRpcServer } from '../helpers/rpc-server.js';

const servers: LocalRpcServer[] = [];
async function server(handlers: Parameters<typeof startRpcServer>[0]): Promise<LocalRpcServer> {
  const s = await startRpcServer(handlers);
  servers.push(s);
  return s;
}

let writes: string[] = [];
let stdoutSpy: MockInstance;

beforeEach(() => {
  writes = [];
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  delete process.env['RPC_SHIELD_ENDPOINTS'];
});

afterEach(async () => {
  stdoutSpy.mockRestore();
  process.removeAllListeners('SIGTERM'); // watch leaves a paired once-listener behind
  await Promise.all(servers.splice(0).map((s) => s.close().catch(() => undefined)));
});

const run = (...args: string[]): Promise<unknown> =>
  buildProgram({ exitOverride: true }).parseAsync(['node', 'rpc-shield', ...args]);

const output = (): string => writes.join('');

describe('rpc-shield health', () => {
  it('prints a per-endpoint scoreboard with real slot lag', async () => {
    const fresh = await server({ getSlot: () => 500, getGenesisHash: () => 'G1' });
    const stale = await server({ getSlot: () => 463, getGenesisHash: () => 'G1' });
    await run('health', '-e', `${fresh.url},${stale.url}`, '-r', '2', '--probe-interval', '40', '-t', '500');

    const out = output();
    expect(out).toContain('ENDPOINT');
    expect(out).toContain(fresh.url);
    expect(out).toContain(stale.url);
    expect(out).toContain('CLOSED');
    expect(out).toMatch(/\b37\b/); // stale node's real measured slot lag
  });

  it('reads endpoints from RPC_SHIELD_ENDPOINTS when --endpoints is omitted', async () => {
    const s = await server({ getSlot: () => 1 });
    process.env['RPC_SHIELD_ENDPOINTS'] = s.url;
    await run('health', '-r', '1', '--probe-interval', '20', '-t', '500');
    expect(output()).toContain(s.url);
  });

  it('fails fast with a clear message when no endpoints are configured', async () => {
    await expect(run('health', '-r', '1')).rejects.toThrow(/no endpoints/);
  });
});

describe('rpc-shield bench', () => {
  it('renders per-endpoint rows plus the shield composite row', async () => {
    const fast = await server({ getSlot: () => 1 });
    const slow = await server({ getSlot: () => 2 });
    slow.setLatency(25);
    await run('bench', '-e', `${fast.url},${slow.url}`, '-n', '6', '-c', '2', '-t', '500');

    const out = output();
    expect(out).toContain('TARGET');
    expect(out).toContain(fast.url);
    expect(out).toContain(slow.url);
    expect(out).toContain('shield composite (2 endpoints)');
    expect(out).toMatch(/P95/);
  });

  it('counts errors per target instead of aborting the run', async () => {
    const dead = await server({ getSlot: () => 1 });
    dead.setMode('destroy');
    await run('bench', '-e', dead.url, '-n', '4', '-c', '2', '-t', '300');
    const lines = output().split('\n');
    const row = lines.find((l) => l.includes(dead.url));
    expect(row).toMatch(/\b4\b/); // all 4 requests in the ERRS column
  });
});

describe('rpc-shield tx', () => {
  it('prints status, slot and error=none for a confirmed signature', async () => {
    const s = await server({
      getSignatureStatuses: () => ({
        context: { slot: 900 },
        value: [{ confirmationStatus: 'confirmed', confirmations: 3, slot: 891, err: null }],
      }),
    });
    await run('tx', 'SIG_E2E_1', '-e', s.url);
    const out = output();
    expect(out).toContain('SIG_E2E_1');
    expect(out).toContain('status: confirmed');
    expect(out).toContain('slot:   891');
    expect(out).toContain('error:  none');
  });

  it('reports NOT FOUND for an unknown signature', async () => {
    const s = await server({ getSignatureStatuses: () => ({ context: { slot: 1 }, value: [null] }) });
    await run('tx', 'SIG_MISSING', '-e', s.url);
    expect(output()).toContain('NOT FOUND');
  });

  it('prints the decoded on-chain error for a reverted transaction', async () => {
    const s = await server({
      getSignatureStatuses: () => ({
        context: { slot: 2 },
        value: [{ confirmationStatus: 'finalized', slot: 880, err: { InstructionError: [0, 'Custom'] } }],
      }),
    });
    await run('tx', 'SIG_REVERTED', '-e', s.url);
    expect(output()).toContain('InstructionError');
  });
});

describe('rpc-shield simulate-drop', () => {
  it('opens the drop window, fails over to the survivor and prints final health', async () => {
    const victim = await server({ getSlot: () => 1 });
    const survivor = await server({ getSlot: () => 2 });
    await run(
      'simulate-drop',
      '-e', `${victim.url},${survivor.url}`,
      '-d', victim.url,
      '--after', '0',
      '--duration', '5',
      '-n', '3',
      '-i', '15',
    );

    const out = output();
    expect(out).toContain('DROP WINDOW OPEN');
    expect(out).toContain(`ok via ${survivor.url}`);
    expect(out).toContain('failed over past');
    expect(out).toContain('final health:');
    expect(victim.hits()).toBe(0); // the wrapper throws before any real request leaves
  });

  it('rejects a --drop URL that is not in --endpoints', async () => {
    const s = await server({ getSlot: () => 1 });
    await expect(
      run('simulate-drop', '-e', s.url, '-d', 'https://elsewhere.example'),
    ).rejects.toThrow(/not in --endpoints/);
  });
});

describe('rpc-shield watch', () => {
  it('refreshes until SIGINT and then stops cleanly', async () => {
    const s = await server({ getSlot: () => 123 });
    const done = run('watch', '-e', s.url, '-i', '30', '-t', '300');
    await new Promise((r) => setTimeout(r, 120));
    process.emit('SIGINT');
    await done;

    const out = output();
    expect(out).toContain('rpc-shield watch —');
    expect(out).toContain(s.url);
  });
});
