import { describe, expect, it } from 'vitest';
import {
  fromLegacyAdapter,
  fromWalletStandard,
  type SerializableTransaction,
  type StandardWallet,
} from '../../src/wallet/signers.js';

const ACCOUNT = { address: 'Acc1111', chains: ['solana:devnet', 'solana:mainnet'] };

function standardWallet(overrides?: Partial<StandardWallet> & { onSign?: (input: unknown) => void }) {
  const calls: unknown[] = [];
  const wallet: StandardWallet = {
    name: 'Phantom',
    accounts: [ACCOUNT],
    features: {
      'solana:signTransaction': {
        signTransaction: async (...inputs: unknown[]) => {
          calls.push(...inputs);
          overrides?.onSign?.(inputs[0]);
          // "sign" by appending a marker byte
          const tx = (inputs[0] as { transaction: Uint8Array }).transaction;
          return [{ signedTransaction: Uint8Array.from([...tx, 0xff]) }];
        },
      },
    },
    ...overrides,
  };
  return { wallet, calls };
}

describe('fromWalletStandard', () => {
  it('signs through the solana:signTransaction feature', async () => {
    const { wallet, calls } = standardWallet();
    const signer = fromWalletStandard(wallet);
    const signed = await signer.signTransactionBytes(Uint8Array.from([1, 2, 3]));
    expect(signed).toEqual(Uint8Array.from([1, 2, 3, 0xff]));
    expect(signer.label).toBe('Phantom');
    const input = calls[0] as { account: typeof ACCOUNT; chain: string };
    expect(input.account).toBe(ACCOUNT);
    expect(input.chain).toBe('solana:devnet'); // first solana:* chain on the account
  });

  it('respects explicit account and chain options', async () => {
    const { wallet, calls } = standardWallet();
    const account = { address: 'Acc2222' };
    const signer = fromWalletStandard(wallet, { account, chain: 'solana:testnet' });
    await signer.signTransactionBytes(Uint8Array.from([9]));
    const input = calls[0] as { account: typeof account; chain: string };
    expect(input.account).toBe(account);
    expect(input.chain).toBe('solana:testnet');
  });

  it('rejects wallets without sign-only support (signAndSend would bypass the shield)', () => {
    const wallet: StandardWallet = {
      name: 'SendOnly',
      accounts: [ACCOUNT],
      features: { 'solana:signAndSendTransaction': { signAndSendTransaction: async () => [] } },
    };
    expect(() => fromWalletStandard(wallet)).toThrow(/solana:signTransaction/);
  });

  it('rejects wallets with no connected accounts', () => {
    const { wallet } = standardWallet({ accounts: [] });
    expect(() => fromWalletStandard(wallet)).toThrow(/no connected accounts/);
  });

  it('surfaces an empty signing response as an error', async () => {
    const wallet: StandardWallet = {
      name: 'Empty',
      accounts: [ACCOUNT],
      features: { 'solana:signTransaction': { signTransaction: async () => [] } },
    };
    const signer = fromWalletStandard(wallet);
    await expect(signer.signTransactionBytes(Uint8Array.from([1]))).rejects.toThrow(/no signed transaction/);
  });
});

class FakeLegacyTx implements SerializableTransaction {
  signed = false;
  constructor(readonly bytes: Uint8Array) {}
  serialize(): Uint8Array {
    return this.signed ? Uint8Array.from([...this.bytes, 0xee]) : this.bytes;
  }
}

describe('fromLegacyAdapter', () => {
  it('round-trips bytes through the adapter object API', async () => {
    const adapter = {
      name: 'Solflare',
      signTransaction: async (tx: FakeLegacyTx) => {
        tx.signed = true;
        return tx;
      },
    };
    const signer = fromLegacyAdapter(adapter, { deserialize: (bytes) => new FakeLegacyTx(bytes) });
    const signed = await signer.signTransactionBytes(Uint8Array.from([4, 5]));
    expect(signed).toEqual(Uint8Array.from([4, 5, 0xee]));
    expect(signer.label).toBe('Solflare');
  });

  it('rejects adapters without signTransaction', () => {
    expect(() => fromLegacyAdapter({ name: 'WatchOnly' }, { deserialize: (b) => new FakeLegacyTx(b) })).toThrow(
      /does not support signTransaction/,
    );
  });
});
