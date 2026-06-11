/**
 * End-to-end on devnet: resilient transport + TransactionManager with a local
 * keypair signer. Run with:
 *
 *   npx tsx examples/keypair-send.ts
 *
 * Generates an ephemeral keypair, requests a devnet airdrop, then sends a
 * self-transfer through the full shield pipeline (dynamic priority fee →
 * submit → confirm with blockhash-refresh retry), logging every lifecycle
 * event. A dead endpoint is included on purpose so failover is visible.
 */
import { readFileSync } from 'node:fs';
import {
  appendTransactionMessageInstruction,
  createSolanaRpcFromTransport,
  createDefaultRpcTransport,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Blockhash,
  type KeyPairSigner,
} from '@solana/kit';
import { createResilientTransport, TransactionManager } from '../src/index.js';
import { transferInstruction } from './lib/system-transfer.js';

const ENDPOINTS = [
  'https://api.devnet.solana.com',
  'http://127.0.0.1:9', // intentionally dead — watch the shield route around it
];

async function main(): Promise<void> {
  const transport = createResilientTransport({
    endpoints: ENDPOINTS,
    requestTimeoutMs: 8_000,
    // The library-native transport keeps v2 wire semantics (bigint u64s).
    transportFactory: ({ url }) => createDefaultRpcTransport({ url }),
    onEvent: (e) => console.log('[transport]', e),
  });
  const rpc = createSolanaRpcFromTransport(transport);
  const manager = new TransactionManager(transport, { onEvent: (e) => console.log('[tx]', e) });

  // Bring your own funded devnet key via KEYPAIR_PATH, or run on an ephemeral one.
  const keypairPath = process.env['KEYPAIR_PATH'];
  const signer: KeyPairSigner = keypairPath
    ? await createKeyPairSignerFromBytes(
        Uint8Array.from(JSON.parse(readFileSync(keypairPath, 'utf8')) as number[]),
      )
    : await generateKeyPairSigner();
  console.log('signer:', signer.address, keypairPath ? '(from KEYPAIR_PATH)' : '(ephemeral)');

  let balance = (await rpc.getBalance(signer.address).send()).value;
  if (balance === 0n) {
    // The public devnet faucet is heavily rate-limited — retry, then bail with guidance.
    for (let attempt = 1; attempt <= 3 && balance === 0n; attempt++) {
      try {
        console.log(`requesting devnet airdrop (attempt ${attempt})…`);
        await rpc.requestAirdrop(signer.address, lamports(1_000_000_000n)).send();
        for (let i = 0; i < 10 && balance === 0n; i++) {
          await new Promise((r) => setTimeout(r, 1_000));
          balance = (await rpc.getBalance(signer.address).send()).value;
        }
      } catch (err) {
        console.log(`  faucet refused: ${err instanceof Error ? err.message : String(err)}`);
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
    if (balance === 0n) {
      console.log('\nDevnet faucet is dry from this IP. Fund the address above at https://faucet.solana.com');
      console.log('or pass a funded key: KEYPAIR_PATH=~/.config/solana/id.json npx tsx examples/keypair-send.ts');
      return; // environment limitation, not an example failure
    }
  }
  console.log(`balance: ${balance} lamports`);

  const microLamports = await manager.fees.estimate();
  console.log(`dynamic priority fee: ${microLamports} micro-lamports/CU`);

  const result = await manager.sendAndConfirm({
    buildSignedTx: async (latest) => {
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(signer, m),
        (m) =>
          setTransactionMessageLifetimeUsingBlockhash(
            {
              blockhash: latest.blockhash as Blockhash,
              lastValidBlockHeight: BigInt(latest.lastValidBlockHeight),
            },
            m,
          ),
        (m) => appendTransactionMessageInstruction(transferInstruction(signer.address, signer.address, 1_000n), m),
      );
      const signed = await signTransactionMessageWithSigners(message);
      return getBase64EncodedWireTransaction(signed);
    },
  });

  console.log('confirmed:', result);
  console.log('final endpoint health:', transport.getHealth());
}

main().catch((err: unknown) => {
  console.error('example failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
