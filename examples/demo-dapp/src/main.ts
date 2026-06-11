/**
 * Wallet demo wired exactly like a production dApp:
 *   - Wallet Standard discovery implemented inline (the registration protocol
 *     is two window events — no discovery package needed),
 *   - the wallet only ever SIGNS; the shield submits through a health-scored
 *     pool (one endpoint is intentionally dead to make failover visible),
 *   - WalletPipeline re-broadcasts the same signed bytes — no re-prompts.
 */
import {
  appendTransactionMessageInstruction,
  compileTransaction,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  createTransactionMessage,
  getTransactionEncoder,
  lamports,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
} from '@solana/kit';
import {
  createResilientTransport,
  fromWalletStandard,
  TransactionManager,
  WalletPipeline,
  type StandardWallet,
  type WalletSigner,
} from 'solana-rpc-shield';
import { transferInstruction } from './transfer.js';

// --- Wallet Standard discovery (the whole protocol is two events) ----------

interface ConnectFeature {
  connect(): Promise<{ accounts: ReadonlyArray<{ address: string; chains?: readonly string[] }> }>;
}

const discovered: StandardWallet[] = [];
const registrationApi = {
  register: (...wallets: StandardWallet[]): void => {
    discovered.push(...wallets);
  },
};
window.addEventListener('wallet-standard:register-wallet', (event) => {
  (event as CustomEvent<(api: typeof registrationApi) => void>).detail(registrationApi);
});
window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: registrationApi }));

// --- Shield wiring ----------------------------------------------------------

const log = (line: string): void => {
  const el = document.querySelector('#log')!;
  el.textContent = `${new Date().toISOString().slice(11, 19)} ${line}\n${el.textContent ?? ''}`;
};

const transport = createResilientTransport({
  endpoints: [
    'https://api.devnet.solana.com',
    'http://127.0.0.1:9', // intentionally dead — failover stays visible in the log
  ],
  requestTimeoutMs: 8_000,
  transportFactory: ({ url }) => createDefaultRpcTransport({ url }),
  onEvent: (e) => log(`transport ${JSON.stringify(e)}`),
});
transport.startHealthMonitor({ intervalMs: 2_000 });

const rpc = createSolanaRpcFromTransport(transport);
const manager = new TransactionManager(transport, { onEvent: (e) => log(`tx ${JSON.stringify(e)}`) });

// --- Live health panel -------------------------------------------------------

const healthBody = document.querySelector('#health')!;
setInterval(() => {
  healthBody.innerHTML = transport
    .getHealth()
    .map(
      (h) => `
      <tr>
        <td>${h.url}</td>
        <td class="${h.circuit}">${h.circuit.toUpperCase()}</td>
        <td>${h.score.toFixed(2)}</td>
        <td>${Math.round(h.latencyMs)}ms</td>
        <td>${(h.errorRate * 100).toFixed(0)}%</td>
        <td>${h.slotLag}</td>
      </tr>`,
    )
    .join('');
}, 1_000);

// --- Buttons -----------------------------------------------------------------

const connectBtn = document.querySelector<HTMLButtonElement>('#connect')!;
const airdropBtn = document.querySelector<HTMLButtonElement>('#airdrop')!;
const sendBtn = document.querySelector<HTMLButtonElement>('#send')!;
const status = document.querySelector('#status')!;
const balanceEl = document.querySelector('#balance')!;

let signer: WalletSigner | undefined;
let account: Address | undefined;

async function refreshBalance(): Promise<void> {
  if (!account) return;
  const { value } = await rpc.getBalance(account).send();
  balanceEl.textContent = `${value} lamports`;
}

connectBtn.addEventListener('click', () => {
  void (async () => {
    const wallet = discovered.find((w) => 'solana:signTransaction' in w.features);
    if (!wallet) {
      log('no Wallet Standard wallet with sign-only support found — install Phantom/Solflare/Backpack');
      return;
    }
    const connect = wallet.features['standard:connect'] as ConnectFeature | undefined;
    if (!connect) {
      log(`wallet "${wallet.name ?? 'unknown'}" lacks standard:connect`);
      return;
    }
    const { accounts } = await connect.connect();
    const connected = accounts[0];
    if (!connected) {
      log('wallet returned no accounts');
      return;
    }
    account = connected.address as Address;
    signer = fromWalletStandard(wallet, { account: connected, chain: 'solana:devnet' });
    status.textContent = `${wallet.name ?? 'wallet'} · ${account.slice(0, 4)}…${account.slice(-4)}`;
    status.classList.add('ok');
    airdropBtn.disabled = false;
    sendBtn.disabled = false;
    log(`connected ${wallet.name ?? 'wallet'} (${account})`);
    await refreshBalance();
  })();
});

airdropBtn.addEventListener('click', () => {
  void (async () => {
    if (!account) return;
    try {
      log('requesting devnet airdrop…');
      await rpc.requestAirdrop(account, lamports(1_000_000_000n)).send();
      await new Promise((r) => setTimeout(r, 2_000));
      await refreshBalance();
    } catch (err) {
      log(`airdrop refused (public faucet limits): ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
});

sendBtn.addEventListener('click', () => {
  void (async () => {
    if (!signer || !account) return;
    const from = account;
    const pipeline = new WalletPipeline(manager, signer, {
      onEvent: (e) => log(`wallet ${JSON.stringify(e)}`),
    });
    try {
      sendBtn.disabled = true;
      const result = await pipeline.sendAndConfirm({
        buildTx: (latest) => {
          const message = pipe(
            createTransactionMessage({ version: 0 }),
            (m) => setTransactionMessageFeePayer(from, m),
            (m) =>
              setTransactionMessageLifetimeUsingBlockhash(
                {
                  blockhash: latest.blockhash as Blockhash,
                  lastValidBlockHeight: BigInt(latest.lastValidBlockHeight),
                },
                m,
              ),
            (m) => appendTransactionMessageInstruction(transferInstruction(from, from, 1_000n), m),
          );
          return new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
        },
      });
      log(`✓ confirmed ${result.signature} in slot ${result.slot ?? '?'}`);
      await refreshBalance();
    } catch (err) {
      log(`send failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      sendBtn.disabled = false;
    }
  })();
});
