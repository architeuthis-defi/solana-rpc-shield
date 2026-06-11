/**
 * Local JSON-RPC server fixture — the network-simulation backbone.
 *
 * Tests exercise the REAL fetch transport against a real HTTP server, then
 * inject the failure modes the listing asks to simulate:
 *   - latency:   `setLatency(ms)` delays every response
 *   - drop:      `setMode('destroy')` kills sockets mid-request;
 *                `close()` refuses connections entirely (true network drop)
 *   - 5xx:       `setMode('http500')` answers with a server error
 *   - blackhole: `setMode('hang')` accepts and never responds (timeout path)
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

export type RpcHandler = (params: unknown) => unknown;
export type ServerMode = 'ok' | 'http500' | 'destroy' | 'hang';

export interface LocalRpcServer {
  readonly url: string;
  /** Total requests that reached the server (any mode). */
  hits(): number;
  /** Headers seen on the most recent request. */
  lastHeaders(): Record<string, string | string[] | undefined>;
  setLatency(ms: number): void;
  setMode(mode: ServerMode): void;
  close(): Promise<void>;
}

export async function startRpcServer(handlers: Record<string, RpcHandler>): Promise<LocalRpcServer> {
  let latencyMs = 0;
  let mode: ServerMode = 'ok';
  let hits = 0;
  let lastHeaders: Record<string, string | string[] | undefined> = {};
  const sockets = new Set<Socket>();

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    hits++;
    lastHeaders = { ...req.headers };

    if (mode === 'destroy') {
      req.socket.destroy();
      return;
    }
    if (mode === 'hang') {
      return; // accept and never answer — client timeout territory
    }

    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const respond = (): void => {
        if (mode === 'http500') {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('Internal Server Error');
          return;
        }
        const parsed = JSON.parse(body) as { id: unknown; method: string; params?: unknown };
        const handler = handlers[parsed.method];
        if (!handler) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: parsed.id,
              error: { code: -32601, message: `Method not found: ${parsed.method}` },
            }),
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: handler(parsed.params) }));
      };
      if (latencyMs > 0) setTimeout(respond, latencyMs);
      else respond();
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind a port');

  return {
    url: `http://127.0.0.1:${address.port}`,
    hits: () => hits,
    lastHeaders: () => lastHeaders,
    setLatency: (ms) => (latencyMs = ms),
    setMode: (m) => (mode = m),
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const s of sockets) s.destroy(); // drop keep-alive connections so close() is immediate
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
