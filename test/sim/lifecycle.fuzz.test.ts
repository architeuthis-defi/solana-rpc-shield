/**
 * Property-based fuzz of the transaction lifecycle engine.
 *
 * Hundreds of randomized cluster schedules (node lag, height skew, blockhash
 * propagation delay, landing delays, reverts, drops) run against an in-memory
 * model with a VIRTUAL clock — each run is milliseconds of wall time. The
 * model enforces Solana's inclusion rule: a transaction can only land while
 * the cluster's true height is within its blockhash validity.
 *
 * Invariants (the headline one is I1 — "never double-lands"):
 *   I1 NoDoubleLand           ≤1 err-free landed signature per lifecycle
 *   I2 TruthfulConfirm        resolved confirmed ⇒ it really landed err-free
 *   I3 TruthfulFailure        Expired ⇒ nothing ever lands (even later);
 *                             TimedOut ⇒ nothing had landed by throw time
 *   I4 ResignAfterDeathOnly   every epoch>0 start is preceded by ≥2 all-null
 *                             full-history sweeps
 *   I5 RevertIsReal           TransactionFailedError ⇒ ledger err is truthy
 *   I6 Termination            settles within the configured virtual budget
 *
 * Model honesty note: submit network errors are modeled PRE-acceptance (the
 * node never saw the wire). The accept-then-connection-drop ambiguity is a
 * known limitation documented in docs/design-notes.md — solving it requires
 * deriving the signature locally before submission (a future seam), since a
 * client cannot poll a signature it never learned.
 *
 * heightSkew (±2) intentionally matches the default expirySafetyBlocks=2:
 * the invariants are exercised AT the boundary where the safety margin is
 * fully consumed. The margin is not the defense — it only delays suspicion;
 * I4's two full-history sweeps are the independent layer that must hold.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  TransactionExpiredError,
  TransactionFailedError,
  TransactionTimedOutError,
} from '../../src/transaction/errors.js';
import {
  runTxLifecycle,
  type LifecycleDeps,
  type LifecycleEvent,
} from '../../src/transaction/lifecycle.js';
import { lcg } from '../helpers/rng.js';

const MS_PER_BLOCK = 400;

interface NodeSpec {
  statusLagMs: number;
  heightSkew: number;
  knowsBlockhashAfterMs: number;
}
interface LandSpec {
  landDelayMs: number;
  revert: boolean;
  drop: boolean;
}
interface Scenario {
  nodes: NodeSpec[];
  blockhashLifetimeBlocks: number;
  landPlan: LandSpec[];
  submitNetworkErrorPct: number; // 0..30 (% of pre-acceptance submit failures)
  routeSeed: number;
  /**
   * An external submitter (earlier run, wallet's own send, another process)
   * landed the epoch-0 bytes BEFORE our first submit: the node answers
   * "already been processed" instead of accepting. The engine must derive
   * the signature locally and confirm honestly — never report failure for
   * a landed transaction, never double-land.
   */
  externalPreSubmit?: boolean;
  engine: {
    maxEpochs: number;
    confirmTimeoutMs: number;
    rebroadcastIntervalMs: number;
    deathGraceMs: number;
    resignOnExpiry: boolean;
  };
}

const scenarioArb = (maxStatusLagMs: number): fc.Arbitrary<Scenario> =>
  fc.record({
    nodes: fc.array(
      fc.record({
        statusLagMs: fc.integer({ min: 0, max: maxStatusLagMs }),
        heightSkew: fc.integer({ min: -2, max: 2 }),
        knowsBlockhashAfterMs: fc.integer({ min: 0, max: 800 }),
      }),
      { minLength: 2, maxLength: 5 },
    ),
    blockhashLifetimeBlocks: fc.integer({ min: 120, max: 180 }),
    landPlan: fc.array(
      fc.record({
        landDelayMs: fc.integer({ min: 0, max: 70_000 }),
        revert: fc.constant(false), // assigned by the chained revert dice below (~10%)
        drop: fc.boolean(),
      }),
      { minLength: 1, maxLength: 24 },
    ),
    submitNetworkErrorPct: fc.integer({ min: 0, max: 30 }),
    routeSeed: fc.integer({ min: 1, max: 2 ** 31 - 1 }),
    engine: fc.record({
      maxEpochs: fc.integer({ min: 1, max: 3 }),
      confirmTimeoutMs: fc.constantFrom(30_000, 60_000, 90_000),
      rebroadcastIntervalMs: fc.constantFrom(1_000, 2_000, 4_000),
      deathGraceMs: fc.constantFrom(1_000, 2_000),
      resignOnExpiry: fc.boolean(),
    }),
  });

// `revert` above must come from fc, not Math.random — rebuild it cleanly:
const scenario = (maxStatusLagMs: number): fc.Arbitrary<Scenario> =>
  scenarioArb(maxStatusLagMs).chain((s) =>
    fc
      .array(fc.integer({ min: 0, max: 9 }), { minLength: s.landPlan.length, maxLength: s.landPlan.length })
      .map((revertDice) => ({
        ...s,
        landPlan: s.landPlan.map((p, i) => ({ ...p, revert: revertDice[i]! === 0 })), // ~10% reverts
      })),
  );

interface RunOutcome {
  resolved: { signature: string } | undefined;
  thrown: unknown;
  events: LifecycleEvent[];
  /** signature → {acceptedAtVt, plan, lastValidBlockHeight} for every ACCEPTED distinct signature */
  acceptedSigs: Map<string, { acceptedAtVt: number; plan: LandSpec; lastValid: number }>;
  vtAtSettle: number;
  landedErrFreeAt(vt: number): string[];
}

async function runScenario(s: Scenario): Promise<RunOutcome> {
  let vt = 0;
  const clock = {
    now: () => vt,
    sleep: async (ms: number) => {
      vt += Math.max(1, ms);
      await Promise.resolve();
    },
  };
  const route = lcg(s.routeSeed);
  const pickNode = (): NodeSpec => s.nodes[Math.floor(route() * s.nodes.length)]!;
  const trueHeight = (at: number): number => Math.floor(at / MS_PER_BLOCK);

  let epochCounter = 0;
  let acceptCounter = 0;
  let sigCounter = 0;
  const wireToSig = new Map<string, string>();
  const acceptedSigs: RunOutcome['acceptedSigs'] = new Map();
  const blockhashes = new Map<string, { registeredAtVt: number; lastValid: number }>();
  const events: LifecycleEvent[] = [];

  /** A signature's tx is LANDED at vt iff accepted, not dropped, delay passed, and inclusion was legal. */
  const landedEntry = (sig: string, at: number): { err: unknown } | null => {
    const acc = acceptedSigs.get(sig);
    if (!acc || acc.plan.drop) return null;
    const landVt = acc.acceptedAtVt + acc.plan.landDelayMs;
    if (at < landVt) return null;
    if (trueHeight(landVt) > acc.lastValid) return null; // inclusion window closed — can never land
    return { err: acc.plan.revert ? { InstructionError: [0, 'Custom'] } : null };
  };

  const deps: LifecycleDeps = {
    clock,
    getLatestBlockhash: async () => {
      const name = `BH${++epochCounter}`;
      const lastValid = trueHeight(vt) + s.blockhashLifetimeBlocks;
      blockhashes.set(name, { registeredAtVt: vt, lastValid });
      return { blockhash: name, lastValidBlockHeight: lastValid };
    },
    submit: async (wire) => {
      const node = pickNode();
      const bhName = wire.split('|')[0]!;
      const bh = blockhashes.get(bhName)!;
      if (vt - bh.registeredAtVt < node.knowsBlockhashAfterMs) {
        throw { code: -32002, message: 'Blockhash not found' };
      }
      if (route() * 100 < s.submitNetworkErrorPct) {
        throw new Error('fetch failed: simulated network error'); // pre-acceptance: node never saw it
      }
      let sig = wireToSig.get(wire);
      if (!sig) {
        sig = `FSIG${++sigCounter}`;
        wireToSig.set(wire, sig);
      }
      if (s.externalPreSubmit && wire.endsWith('|payload-0') && !acceptedSigs.has(sig)) {
        // The external submitter won the race: the ledger accepted these
        // exact bytes before our first submit ever reached a node.
        const plan = s.landPlan[acceptCounter % s.landPlan.length]!;
        acceptCounter++;
        acceptedSigs.set(sig, { acceptedAtVt: vt, plan, lastValid: bh.lastValid });
        throw { code: -32002, message: 'Transaction simulation failed: This transaction has already been processed' };
      }
      if (!acceptedSigs.has(sig)) {
        const plan = s.landPlan[acceptCounter % s.landPlan.length]!;
        acceptCounter++;
        acceptedSigs.set(sig, { acceptedAtVt: vt, plan, lastValid: bh.lastValid });
      }
      return sig;
    },
    // Mirrors production exactly: the signature is a pure function of the
    // wire (signatureOfWire over real bytes; the model's wire→sig map here).
    deriveSignature: (wire) => wireToSig.get(wire) ?? null,
    getStatuses: async (sigs, history) => {
      const node = pickNode();
      return sigs.map((sig) => {
        const entry = landedEntry(sig, vt);
        if (!entry) return null;
        const acc = acceptedSigs.get(sig)!;
        const landVt = acc.acceptedAtVt + acc.plan.landDelayMs;
        if (!history && vt - landVt < node.statusLagMs) return null; // hot-poll blind spot
        return { confirmationStatus: 'confirmed' as const, err: entry.err, slot: trueHeight(vt) };
      });
    },
    getBlockHeight: async () => trueHeight(vt) + pickNode().heightSkew,
  };

  let resolved: { signature: string } | undefined;
  let thrown: unknown;
  try {
    resolved = await runTxLifecycle(deps, {
      getSignedTx: async (bh, epoch) => `${bh.blockhash}|payload-${epoch}`,
      commitment: 'confirmed',
      maxEpochs: s.engine.maxEpochs,
      resignOnExpiry: s.engine.resignOnExpiry,
      confirmTimeoutMs: s.engine.confirmTimeoutMs,
      pollIntervalMs: 1_000,
      rebroadcastIntervalMs: s.engine.rebroadcastIntervalMs,
      skipPreflightFirstSend: false,
      submitRetries: 2,
      submitRetryDelayMs: 250,
      deathGraceMs: s.engine.deathGraceMs,
      lifetime: 'blockhash',
      onEvent: (e) => events.push(e),
    });
  } catch (err) {
    thrown = err;
  }

  return {
    resolved,
    thrown,
    events,
    acceptedSigs,
    vtAtSettle: vt,
    landedErrFreeAt: (at) =>
      [...acceptedSigs.keys()].filter((sig) => {
        const e = landedEntry(sig, at);
        return e !== null && !e.err;
      }),
  };
}

const HORIZON_AFTER_SETTLE = 200_000; // virtual ms — long past any landing delay

describe('lifecycle property fuzz', () => {
  it('I1/I2/I4/I5/I6 hold across randomized cluster schedules (unrestricted lag)', async () => {
    await fc.assert(
      fc.asyncProperty(scenario(1_500), async (s) => {
        const run = await runScenario(s);

        // I6 Termination — settled within the virtual budget.
        const budget = s.engine.maxEpochs * (s.engine.confirmTimeoutMs + s.engine.deathGraceMs + 10_000) + 10_000;
        expect(run.vtAtSettle).toBeLessThanOrEqual(budget);

        // I1 NoDoubleLand — even at the far horizon, at most one err-free landed tx.
        const landedFinal = run.landedErrFreeAt(run.vtAtSettle + HORIZON_AFTER_SETTLE);
        expect(landedFinal.length).toBeLessThanOrEqual(1);

        // I2 TruthfulConfirm
        if (run.resolved) {
          expect(run.landedErrFreeAt(run.vtAtSettle)).toContain(run.resolved.signature);
        }

        // I5 RevertIsReal
        if (run.thrown instanceof TransactionFailedError) {
          const acc = run.acceptedSigs.get(run.thrown.signature);
          expect(acc?.plan.revert).toBe(true);
        }

        // I4 ResignAfterDeathOnly — epoch>0 requires ≥2 prior all-null sweeps.
        let sweepsSinceEpochStart = 0;
        for (const e of run.events) {
          if (e.type === 'death_sweep' && e.landed === null) sweepsSinceEpochStart++;
          if (e.type === 'epoch_started' && e.epoch > 0) {
            expect(sweepsSinceEpochStart).toBeGreaterThanOrEqual(2);
            sweepsSinceEpochStart = 0;
          }
        }
      }),
      { numRuns: 300, verbose: 1 },
    );
  });

  it('I3 TruthfulFailure holds when status lag is bounded by the grace window', async () => {
    await fc.assert(
      fc.asyncProperty(scenario(900), async (s) => {
        // bound: every node's lag fits inside the smallest grace window we generate
        fc.pre(s.nodes.every((n) => n.statusLagMs <= s.engine.deathGraceMs));
        const run = await runScenario(s);

        if (run.thrown instanceof TransactionExpiredError) {
          // verified death: nothing may EVER land, even at the horizon
          expect(run.landedErrFreeAt(run.vtAtSettle + HORIZON_AFTER_SETTLE)).toHaveLength(0);
        }
        if (run.thrown instanceof TransactionTimedOutError) {
          // truthful at throw time: nothing HAD landed (it may still land later — that's the point)
          expect(run.landedErrFreeAt(run.vtAtSettle)).toHaveLength(0);
        }
      }),
      { numRuns: 200, verbose: 1 },
    );
  });

  it('an external pre-submitter ("already been processed") never produces a lie or a double-land', async () => {
    await fc.assert(
      fc.asyncProperty(scenario(1_500), async (raw) => {
        // Isolate the already-processed path from UNRELATED first-submit
        // failures: random network errors and exhausted Blockhash-not-found
        // retries terminate the run before the node can say "already
        // processed" — those races are property #1's territory. Submit
        // retries cover ≤500 virtual ms of propagation, so clamp below it.
        const s: Scenario = {
          ...raw,
          externalPreSubmit: true,
          submitNetworkErrorPct: 0,
          nodes: raw.nodes.map((n) => ({ ...n, knowsBlockhashAfterMs: Math.min(n.knowsBlockhashAfterMs, 450) })),
        };
        const run = await runScenario(s);

        // Non-vacuous: the engine actually hit the already-processed path.
        const ap = run.events.find((e) => e.type === 'already_processed');
        expect(ap).toBeDefined();
        const externalSig = (ap as { signature: string }).signature;

        // I1 still holds with a third-party racing us.
        const landedFinal = run.landedErrFreeAt(run.vtAtSettle + HORIZON_AFTER_SETTLE);
        expect(landedFinal.length).toBeLessThanOrEqual(1);

        // I2: a resolved signature really landed.
        if (run.resolved) {
          expect(run.landedErrFreeAt(run.vtAtSettle)).toContain(run.resolved.signature);
        }

        // The headline of this scenario: when the externally-landed tx is
        // err-free on the ledger and the engine resolved, it resolved to THAT
        // transaction — it cannot have signed and landed a second one.
        if (run.resolved && run.landedErrFreeAt(run.vtAtSettle).includes(externalSig)) {
          expect(run.resolved.signature).toBe(externalSig);
        }

        // And the engine never reported a submit FAILURE for the landed tx:
        // a thrown RpcSubmitError mentioning "already" would be the old bug.
        if (run.thrown) {
          expect(String((run.thrown as Error).message ?? run.thrown)).not.toMatch(/already been processed/i);
        }
      }),
      { numRuns: 150, verbose: 1 },
    );
  });
});
