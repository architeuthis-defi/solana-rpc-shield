/**
 * Jito atomic bundle with an in-transaction tip — SAFE BY DEFAULT: prints
 * usage and exits unless explicitly armed with real values.
 *
 *   KEYPAIR_PATH=~/.config/solana/id.json \
 *   JITO_ENGINE=https://mainnet.block-engine.jito.wtf \
 *   RPC_ENDPOINTS=https://your-rpc-1,https://your-rpc-2 \
 *   npx tsx examples/jito-bundle.ts
 *
 * The tip transfer is appended to the SAME transaction as the main logic, so
 * a failed bundle pays no tip (per docs.jito.wtf). Tip accounts come live
 * from the engine's getTipAccounts — never hardcoded.
 */
import { readFileSync } from 'node:fs';
import {
  address,
  appendTransactionMessageInstruction,
  createDefaultRpcTransport,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Blockhash,
} from '@solana/kit';
import { createResilientTransport, MIN_JITO_TIP_LAMPORTS, TransactionManager } from '../src/index.js';
import { transferInstruction } from './lib/system-transfer.js';

const KEYPAIR_PATH = process.env['KEYPAIR_PATH'];
const JITO_ENGINE = process.env['JITO_ENGINE'];
const RPC_ENDPOINTS = process.env['RPC_ENDPOINTS'];

async function main(): Promise<void> {
  if (!KEYPAIR_PATH || !JITO_ENGINE || !RPC_ENDPOINTS) {
    console.log('Safe-by-default: set KEYPAIR_PATH, JITO_ENGINE and RPC_ENDPOINTS to run.');
    console.log('See the header comment for the full invocation.');
    return;
  }

  const transport = createResilientTransport({
    endpoints: RPC_ENDPOINTS.split(','),
    transportFactory: ({ url }) => createDefaultRpcTransport({ url }),
  });
  const manager = new TransactionManager(transport, {
    jito: { blockEngineUrl: JITO_ENGINE },
    onEvent: (e) => console.log('[tx]', e),
  });

  const signer = await createKeyPairSignerFromBytes(
    Uint8Array.from(JSON.parse(readFileSync(KEYPAIR_PATH, 'utf8')) as number[]),
  );

  // Tip account fetched live from the engine; random pick spreads contention.
  const tipAccount = await manager.pickTipAccount();
  const tipLamports = BigInt(MIN_JITO_TIP_LAMPORTS) * 10n; // floor × headroom for demand
  console.log(`tipping ${tipLamports} lamports to ${tipAccount}`);

  const latest = await manager.getLatestBlockhash();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: latest.blockhash as Blockhash, lastValidBlockHeight: BigInt(latest.lastValidBlockHeight) },
        m,
      ),
    // main logic — here a minimal self-transfer; replace with your real instructions
    (m) => appendTransactionMessageInstruction(transferInstruction(signer.address, signer.address, 1_000n), m),
    // the tip rides in the SAME tx: bundle fails → no tip paid
    (m) => appendTransactionMessageInstruction(transferInstruction(signer.address, address(tipAccount), tipLamports), m),
  );
  const signed = await signTransactionMessageWithSigners(message);

  const status = await manager.sendBundleAndConfirm([getBase64EncodedWireTransaction(signed)], {
    commitment: 'confirmed',
    timeoutMs: 60_000,
  });
  console.log('bundle landed:', status);
}

main().catch((err: unknown) => {
  console.error('example failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
