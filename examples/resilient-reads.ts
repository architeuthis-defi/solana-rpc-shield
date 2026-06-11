/**
 * The README quickstart, runnable: reads through the resilient composite.
 * One endpoint in the pool is dead on purpose — requests keep landing, the
 * health scoreboard shows who paid for it. No keys, no funds, devnet-safe.
 *
 *   npx tsx examples/resilient-reads.ts
 */
import { createSolanaRpcFromTransport } from '@solana/kit';
import { createResilientTransport } from '../src/index.js';

async function main(): Promise<void> {
  // 1. The composite transport — the only line that changes in an existing dApp.
  //    The dead node gets a strong routing preference (same trick as the CLI's
  //    simulate-drop): every read demonstrably hits the failure FIRST, so the
  //    failover → circuit-open story below is deterministic, not a lucky draw.
  const transport = createResilientTransport({
    endpoints: [
      { url: 'http://127.0.0.1:9', weight: 1_000 }, // dead on purpose
      'https://api.devnet.solana.com',
      'https://api.testnet.solana.com',
    ],
    requestTimeoutMs: 8_000,
  });
  transport.startHealthMonitor({ intervalMs: 1_000 }); // slot-lag probes in the background

  // 2. Standard kit/web3.js v2 client on top — failover is invisible to it.
  const rpc = createSolanaRpcFromTransport(transport);

  const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
  const { value: blockhashInfo } = await rpc.getLatestBlockhash().send();
  console.log(`slot:                ${slot}`);
  console.log(`latest blockhash:    ${blockhashInfo.blockhash}`);
  console.log(`lastValidBlockHeight: ${blockhashInfo.lastValidBlockHeight}`);
  for (let i = 0; i < 6; i++) await rpc.getSlot().send(); // more traffic → the breaker has data

  // 3. What the shield did for those reads: per-endpoint health after traffic.
  //    The dead node ate the first faults, scored to zero and dropped out of
  //    the weighted draw — the circuit breaker never even needed to fire. The
  //    answers above never noticed.
  await new Promise((r) => setTimeout(r, 1_200)); // let a slot probe land
  console.log('\nendpoint health (the dead node took the hit, the reads did not):');
  for (const h of transport.getHealth()) {
    const state = h.circuit.toUpperCase().padEnd(9);
    console.log(`  ${state} score=${h.score.toFixed(2)} errors=${(h.errorRate * 100).toFixed(0)}% ${h.url}`);
  }

  transport.stopHealthMonitor();
}

main().catch((err: unknown) => {
  console.error('example failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
