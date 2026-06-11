/**
 * Wallet signer bridges — connect the resilience layer to user wallets.
 *
 * Design rule: the SDK asks wallets to SIGN ONLY and never to send. A wallet's
 * own `signAndSendTransaction` submits through the wallet's internal RPC — a
 * single opaque endpoint with no failover, no fee strategy and no confirmation
 * tracking, which is exactly the failure mode this SDK exists to remove. So the
 * bridge extracts a sign-only capability and the WalletPipeline owns submission.
 *
 * Both bridges are structurally typed — no dependency on `@wallet-standard/*`
 * or `@solana/wallet-adapter-*` packages. Any object with the right shape works.
 */

/** The one capability the pipeline needs from a wallet. */
export interface WalletSigner {
  /** Sign a serialized (unsigned) transaction; resolve the serialized signed transaction. */
  signTransactionBytes(tx: Uint8Array): Promise<Uint8Array>;
  /** Identifier for logs/metrics (wallet name) — never key material. */
  readonly label: string;
}

// ---------------------------------------------------------------------------
// Wallet Standard (Phantom, Solflare, Backpack — all register this natively)
// ---------------------------------------------------------------------------

/** Minimal structural view of a Wallet Standard account. */
export interface StandardWalletAccount {
  readonly address: string;
  readonly chains?: readonly string[];
}

interface SolanaSignTransactionInput {
  readonly account: StandardWalletAccount;
  readonly transaction: Uint8Array;
  readonly chain?: string;
}

interface SolanaSignTransactionFeature {
  signTransaction(
    ...inputs: SolanaSignTransactionInput[]
  ): Promise<ReadonlyArray<{ readonly signedTransaction: Uint8Array }>>;
}

/** Minimal structural view of a Wallet Standard wallet (`getWallets()` output). */
export interface StandardWallet {
  readonly name?: string;
  readonly accounts: ReadonlyArray<StandardWalletAccount>;
  readonly features: Readonly<Record<string, unknown>>;
}

export interface WalletStandardOptions {
  /** Account to sign with. Default: first connected account. */
  readonly account?: StandardWalletAccount;
  /** Chain identifier passed to the wallet. Default: first `solana:*` chain on the account, else `solana:mainnet`. */
  readonly chain?: string;
}

const SIGN_TRANSACTION = 'solana:signTransaction';

function isSignTransactionFeature(f: unknown): f is SolanaSignTransactionFeature {
  return typeof (f as SolanaSignTransactionFeature | undefined)?.signTransaction === 'function';
}

/**
 * Bridge a Wallet Standard wallet (what every major Solana wallet exposes via
 * the `@wallet-standard` registry) into a `WalletSigner`.
 *
 * Throws when the wallet lacks `solana:signTransaction` — a wallet exposing
 * only `signAndSendTransaction` cannot participate in resilient submission,
 * and silently falling back to it would bypass the entire shield.
 */
export function fromWalletStandard(wallet: StandardWallet, options?: WalletStandardOptions): WalletSigner {
  const feature = wallet.features[SIGN_TRANSACTION];
  if (!isSignTransactionFeature(feature)) {
    throw new Error(
      `wallet "${wallet.name ?? 'unknown'}" does not expose the "${SIGN_TRANSACTION}" feature; ` +
        'sign-only access is required — signAndSendTransaction would bypass resilient submission',
    );
  }
  const account = options?.account ?? wallet.accounts[0];
  if (!account) {
    throw new Error(`wallet "${wallet.name ?? 'unknown'}" has no connected accounts — connect before signing`);
  }
  const chain = options?.chain ?? account.chains?.find((c) => c.startsWith('solana:')) ?? 'solana:mainnet';

  return {
    label: wallet.name ?? 'wallet-standard',
    async signTransactionBytes(tx: Uint8Array): Promise<Uint8Array> {
      const outputs = await feature.signTransaction({ account, transaction: tx, chain });
      const signed = outputs[0]?.signedTransaction;
      if (!signed) throw new Error(`wallet "${wallet.name ?? 'unknown'}" returned no signed transaction`);
      return signed;
    },
  };
}

// ---------------------------------------------------------------------------
// Legacy @solana/wallet-adapter (React dApps on web3.js v1 types)
// ---------------------------------------------------------------------------

/** Anything with the legacy `VersionedTransaction` surface the adapter signs. */
export interface SerializableTransaction {
  serialize(): Uint8Array;
}

/** Minimal structural view of a legacy wallet-adapter with sign-only support. */
export interface LegacySignerAdapter<T extends SerializableTransaction = SerializableTransaction> {
  readonly name?: string;
  signTransaction?(tx: T): Promise<T>;
}

export interface LegacyAdapterOptions<T extends SerializableTransaction> {
  /**
   * Decode wire bytes into the transaction object the adapter signs — pass
   * `VersionedTransaction.deserialize` from the dApp's existing web3.js v1
   * install. Taking it as a parameter keeps this SDK free of v1 dependencies.
   */
  readonly deserialize: (bytes: Uint8Array) => T;
}

/**
 * Bridge a legacy `@solana/wallet-adapter` adapter into a `WalletSigner`.
 * Only adapters that support sign-only (`signTransaction`) qualify, for the
 * same bypass reason as the Wallet Standard bridge.
 */
export function fromLegacyAdapter<T extends SerializableTransaction>(
  adapter: LegacySignerAdapter<T>,
  options: LegacyAdapterOptions<T>,
): WalletSigner {
  const sign = adapter.signTransaction?.bind(adapter);
  if (!sign) {
    throw new Error(
      `adapter "${adapter.name ?? 'unknown'}" does not support signTransaction; ` +
        'sign-only access is required for resilient submission',
    );
  }
  return {
    label: adapter.name ?? 'wallet-adapter',
    async signTransactionBytes(tx: Uint8Array): Promise<Uint8Array> {
      const signed = await sign(options.deserialize(tx));
      return signed.serialize();
    },
  };
}
