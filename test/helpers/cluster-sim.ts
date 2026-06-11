/**
 * Cluster simulator — cross-node STATE DIVERGENCE on top of real HTTP servers.
 *
 * `rpc-server.ts` simulates an unreliable network (drops, latency, 5xx).
 * This helper simulates an INCONSISTENT cluster: a shared ground-truth ledger
 * with per-node views that lag it — a node that doesn't know a fresh
 * blockhash yet, a node that answers status=null for a transaction that has
 * already landed, a node whose block height runs ahead. Solana's hard
 * failure modes are consistency failures; this is what they look like.
 */
import { startRpcServer, type LocalRpcServer } from './rpc-server.js';

export type ClusterCommitment = 'processed' | 'confirmed' | 'finalized';

export interface LandedEntry {
  readonly err: unknown;
  readonly status: ClusterCommitment;
  readonly landedAtMs: number;
}

export interface NodeView {
  /** Landed txs stay invisible to HOT status polls for this long (history search always sees them). */
  readonly statusLagMs?: number;
  /** getBlockHeight = truth + skew (node runs ahead/behind the cluster). */
  readonly heightSkew?: number;
  /** sendTransaction answers -32002 "Blockhash not found" until the blockhash is this old. */
  readonly knowsBlockhashAfterMs?: number;
  /** Land every accepted wire immediately (convenience for happy paths). */
  readonly autoLandOnAccept?: boolean;
}

export interface ClusterSim {
  truth: {
    blockHeight(): number;
    advance(blocks: number): void;
    /** Create a new "latest" blockhash valid until the given height. */
    registerBlockhash(name: string, lastValidBlockHeight: number): void;
    land(signature: string, opts?: { err?: unknown; status?: ClusterCommitment }): void;
    ledger(): ReadonlyMap<string, LandedEntry>;
    /** Every accepted submission across all nodes: signature → distinct wires seen. */
    accepted(): ReadonlyMap<string, ReadonlySet<string>>;
  };
  node(view?: NodeView): Promise<LocalRpcServer>;
  close(): Promise<void>;
}

/** Deterministic signature for a wire — same bytes, same signature, like ed25519. */
export function signatureFor(wire: string): string {
  let h = 2166136261;
  for (let i = 0; i < wire.length; i++) {
    h ^= wire.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `SIGC${(h >>> 0).toString(16)}`;
}

export function createCluster(): ClusterSim {
  let height = 0;
  let latest: { name: string; lastValidBlockHeight: number; registeredAt: number } | undefined;
  const known = new Map<string, { lastValidBlockHeight: number; registeredAt: number }>();
  const ledger = new Map<string, LandedEntry>();
  const accepted = new Map<string, Set<string>>();
  const servers: LocalRpcServer[] = [];

  const truth: ClusterSim['truth'] = {
    blockHeight: () => height,
    advance: (blocks) => {
      height += blocks;
    },
    registerBlockhash: (name, lastValidBlockHeight) => {
      latest = { name, lastValidBlockHeight, registeredAt: Date.now() };
      known.set(name, { lastValidBlockHeight, registeredAt: Date.now() });
    },
    land: (signature, opts) => {
      ledger.set(signature, {
        err: opts?.err ?? null,
        status: opts?.status ?? 'confirmed',
        landedAtMs: Date.now(),
      });
    },
    ledger: () => ledger,
    accepted: () => accepted,
  };

  async function node(view?: NodeView): Promise<LocalRpcServer> {
    const statusLagMs = view?.statusLagMs ?? 0;
    const heightSkew = view?.heightSkew ?? 0;
    const knowsAfterMs = view?.knowsBlockhashAfterMs ?? 0;

    const server = await startRpcServer({
      getLatestBlockhash: () => {
        if (!latest) throw new Error('cluster-sim: registerBlockhash first');
        return {
          context: { slot: height },
          value: { blockhash: latest.name, lastValidBlockHeight: latest.lastValidBlockHeight },
        };
      },
      getBlockHeight: () => height + heightSkew,
      sendTransaction: (params) => {
        const [wire] = params as [string, unknown];
        // wire convention for cluster tests: "<blockhash>|<payload>"
        const blockhashName = wire.split('|')[0] ?? '';
        const bh = known.get(blockhashName);
        if (!bh || Date.now() - bh.registeredAt < knowsAfterMs) {
          // The node's bank doesn't know this blockhash (propagation lag):
          // exactly the wire shape a real lagging node produces on preflight.
          return {
            __jsonRpcError: {
              code: -32002,
              message: 'Transaction simulation failed: Blockhash not found',
              data: { err: 'BlockhashNotFound', logs: [] },
            },
          };
        }
        const sig = signatureFor(wire);
        const wires = accepted.get(sig) ?? new Set<string>();
        wires.add(wire);
        accepted.set(sig, wires);
        if (view?.autoLandOnAccept && !ledger.has(sig)) truth.land(sig);
        return sig;
      },
      getSignatureStatuses: (params) => {
        const [sigs, opts] = params as [string[], { searchTransactionHistory?: boolean } | undefined];
        const history = opts?.searchTransactionHistory ?? false;
        return {
          context: { slot: height },
          value: sigs.map((sig) => {
            const entry = ledger.get(sig);
            if (!entry) return null;
            const hotVisible = Date.now() - entry.landedAtMs >= statusLagMs;
            if (!history && !hotVisible) return null; // the hot-poll blind spot
            return { confirmationStatus: entry.status, err: entry.err, slot: height };
          }),
        };
      },
    });
    servers.push(server);
    return server;
  }

  return {
    truth,
    node,
    close: async () => {
      await Promise.all(servers.splice(0).map((s) => s.close().catch(() => undefined)));
    },
  };
}
