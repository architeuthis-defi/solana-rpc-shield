/**
 * Cross-node CONSISTENCY simulations — real HTTP servers sharing one truth
 * ledger with diverging per-node views. Network simulations (drops, latency)
 * prove the shield survives an unreliable network; these prove it survives an
 * INCONSISTENT one: blockhash propagation lag, status-blind nodes, ahead
 * height counters, transactions landing inside the death-verification window.
 *
 * Assertions follow ledger TRUTH (how many transactions actually landed),
 * never just call counts — a double-send shows up as ledger().size === 2.
 *
 * (Caller-abort consistency is covered transport-level in
 * fetch-transport.e2e.test.ts — not duplicated here.)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TransactionManager } from '../../src/transaction/transaction-manager.js';
import { createResilientTransport } from '../../src/transport/resilient-transport.js';
import { createCluster, signatureFor, type ClusterSim } from '../helpers/cluster-sim.js';
import { startRpcServer, type LocalRpcServer } from '../helpers/rpc-server.js';

const FAST = { pollIntervalMs: 1, deathGraceMs: 5, rebroadcastIntervalMs: 50, confirmTimeoutMs: 2_000 };

let cluster: ClusterSim | undefined;
const extraServers: LocalRpcServer[] = [];
afterEach(async () => {
  await cluster?.close();
  cluster = undefined;
  await Promise.all(extraServers.splice(0).map((s) => s.close().catch(() => undefined)));
});

describe('cross-node consistency', () => {
  it('C1: submit node lags the blockhash — error surfaced, bounded retry lands it; exactly one tx in the ledger', async () => {
    cluster = createCluster();
    cluster.truth.registerBlockhash('BH1', 1_000);
    // The node learns the blockhash only after 100ms — first submit preflights
    // into "Blockhash not found", the 250ms retry lands on a caught-up bank.
    const lagging = await cluster.node({ knowsBlockhashAfterMs: 100, autoLandOnAccept: true });

    const transport = createResilientTransport({ endpoints: [lagging.url] });
    const tm = new TransactionManager(transport);
    const res = await tm.sendAndConfirm({
      buildSignedTx: async (bh) => `${bh.blockhash}|payload-C1`,
      ...FAST,
    });

    expect(res.signature).toBe(signatureFor('BH1|payload-C1'));
    expect(cluster.truth.ledger().size).toBe(1); // one logical send → one landed tx
    expect(lagging.hits()).toBeGreaterThanOrEqual(2); // the failed preflight + the retry
  });

  it('C2: status-blind hot polls + ahead height counter do NOT produce a false expiry', async () => {
    cluster = createCluster();
    cluster.truth.registerBlockhash('BH1', 100);
    // Node never shows the tx on hot polls (huge statusLag) AND its height
    // runs 5 blocks ahead — the exact recipe for a false "expired" verdict.
    const node = await cluster.node({ statusLagMs: 60_000, heightSkew: 5 });

    const transport = createResilientTransport({ endpoints: [node.url] });
    const tm = new TransactionManager(transport, {
      onEvent: (e) => {
        // land the tx the moment it is submitted — it IS on chain, the node just can't see it hot
        if (e.type === 'submitted') cluster!.truth.land(signatureFor('BH1|payload-C2'));
      },
    });
    cluster.truth.advance(98); // skewed node reports 103 > 100 → expiry suspected immediately

    let builds = 0;
    const res = await tm.sendAndConfirm({
      buildSignedTx: async (bh) => {
        builds++;
        return `${bh.blockhash}|payload-C2`;
      },
      ...FAST,
    });

    expect(res.signature).toBe(signatureFor('BH1|payload-C2'));
    expect(builds).toBe(1); // saved by the full-history sweep — no re-sign, no double-send
    expect(cluster.truth.ledger().size).toBe(1);
  });

  it('C3: tx lands INSIDE the death-verification window — returned; a second signature never exists', async () => {
    cluster = createCluster();
    cluster.truth.registerBlockhash('BH1', 100);
    const node = await cluster.node({ statusLagMs: 60_000 }); // hot polls stay blind

    const sig = signatureFor('BH1|payload-C3');
    const transport = createResilientTransport({ endpoints: [node.url] });
    const tm = new TransactionManager(transport, {
      onEvent: (e) => {
        // The first all-null sweep fires BETWEEN the two death sweeps —
        // landing here is the razor's edge the grace window exists for.
        if (e.type === 'death_sweep' && e.landed === null && !cluster!.truth.ledger().has(sig)) {
          cluster!.truth.land(sig);
        }
      },
    });
    cluster.truth.advance(110); // truly past the blockhash height + safety margin

    let builds = 0;
    const res = await tm.sendAndConfirm({
      buildSignedTx: async (bh) => {
        builds++;
        return `${bh.blockhash}|payload-C3`;
      },
      ...FAST,
      deathGraceMs: 20,
    });

    expect(res.signature).toBe(sig);
    expect(builds).toBe(1);
    expect(cluster.truth.ledger().size).toBe(1);
    expect(cluster.truth.accepted().size).toBe(1); // no second wire ever reached any node
  });

  it('C4: genuinely dead blockhash — epoch 2 re-signs and lands; the ledger still holds exactly ONE tx', async () => {
    cluster = createCluster();
    cluster.truth.registerBlockhash('BH1', 100);
    cluster.truth.advance(110); // BH1 is dead on arrival (past height + safety margin) — epoch 1 can never land
    const node = await cluster.node({ autoLandOnAccept: false });

    const transport = createResilientTransport({ endpoints: [node.url] });
    const tm = new TransactionManager(transport, {
      onEvent: (e) => {
        // After verified death, the engine asks for a fresh blockhash:
        // hand it a live one and let epoch 2's submission land.
        if (e.type === 'death_sweep') cluster!.truth.registerBlockhash('BH2', 10_000);
        if (e.type === 'submitted' && e.route === 'rpc') {
          const sig2 = signatureFor('BH2|payload-C4');
          if (cluster!.truth.accepted().has(sig2)) cluster!.truth.land(sig2);
        }
      },
    });

    let builds = 0;
    const res = await tm.sendAndConfirm({
      buildSignedTx: async (bh) => {
        builds++;
        return `${bh.blockhash}|payload-C4`;
      },
      maxAttempts: 2,
      ...FAST,
    });

    expect(res.signature).toBe(signatureFor('BH2|payload-C4'));
    expect(builds).toBe(2); // re-sign happened — but only after verified death
    expect(cluster.truth.ledger().size).toBe(1); // and still exactly one landed transaction
  });

  it('C6: hung Jito block engine — request times out and the RPC pool lands the tx', async () => {
    cluster = createCluster();
    cluster.truth.registerBlockhash('BH1', 1_000);
    const rpcNode = await cluster.node({ autoLandOnAccept: true });

    const hungEngine = await startRpcServer({ getSlot: () => 1 });
    hungEngine.setMode('hang');
    extraServers.push(hungEngine);

    const transport = createResilientTransport({ endpoints: [rpcNode.url] });
    const tm = new TransactionManager(transport, {
      jito: { blockEngineUrl: hungEngine.url, requestTimeoutMs: 50 },
    });

    const res = await tm.sendAndConfirm({
      buildSignedTx: async (bh) => `${bh.blockhash}|payload-C6`,
      ...FAST,
    });
    expect(res.signature).toBe(signatureFor('BH1|payload-C6'));
    expect(cluster.truth.ledger().size).toBe(1);
  });
});
