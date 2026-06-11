import { describe, expect, it } from 'vitest';
import { getBase58Decoder } from '@solana/kit';
import { fromBase64, signatureOfWire, toBase58 } from '../../src/transaction/wire.js';

/**
 * Real mainnet transaction (vote tx, fetched 2026-06-12 via getTransaction
 * with base64 encoding). The expected signature is the node's own verdict —
 * the strongest possible fixture: if our derivation disagrees with the
 * ledger, this test fails.
 */
const MAINNET_WIRE =
  'AWsk6OfBzSGGKbfhhzUfk4fOegvT606jwpF0iJAT1VKbr1MVBs8EIB49o1gpsszL4A3v+dXsMYlAsGuovuUfGwUBAAEDiGRjzS5QS4jO5DoTcOWA7QwleNRdZ+j0/RqJk29BM4SIZGPfIzIBuaUBSn7RiDbQJSmnLCV/xghFRmxv7bBgUwdhSB01dHS7fE12JOvTvbPYNV5z0RBD/A2jU4AAAAAAEw520w1IYakMy2DCyDkDqisUex/l2i51dgGJF9WbAjMBAgIBAJQBDgAAANoMYhkAAAAAHwEfAR4BHQEcARsBGgEZARgBFwEWARUBFAETARIBEQEQAQ8BDgENAQwBCwEKAQkBCAEHAQYBBQEEAQMBAgEBd/jppzGducicZqjha6ZqjKWkR97dNCJONUIB45qDRYQBpzkragAAAAD2nnofv57YIycq0k6eb8kzcRCdu5coS2FdmMh712yumg==';
const MAINNET_SIGNATURE =
  '39FDD384c1SH5SkGr7ttWA3mzEmbtjukorZvdZyATyDM3sPnFWSefiZSNM5uKBvPnvxnH247vxfwZ93gbVBVzsAC';

describe('toBase58', () => {
  it('matches @solana/kit (an independent implementation) on random byte arrays', () => {
    const kitDecode = getBase58Decoder();
    // Deterministic pseudo-random bytes — includes leading-zero cases.
    let seed = 0x2f6e2b1;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % 256;
    };
    for (let round = 0; round < 50; round++) {
      const len = 1 + (next() % 80);
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = next();
      if (round % 5 === 0) bytes[0] = 0; // exercise the leading-zeros path
      expect(toBase58(bytes)).toBe(kitDecode.decode(bytes));
    }
  });

  it('encodes leading zeros as leading 1s', () => {
    expect(toBase58(Uint8Array.from([0, 0, 0]))).toBe('111');
    expect(toBase58(Uint8Array.from([]))).toBe('');
  });
});

describe('signatureOfWire', () => {
  it('derives the exact signature the ledger assigned to a real mainnet transaction', () => {
    expect(signatureOfWire(MAINNET_WIRE)).toBe(MAINNET_SIGNATURE);
  });

  it('uses the FIRST signature (fee payer) of a multi-signature wire', () => {
    const sigA = new Uint8Array(64).fill(0xaa);
    const sigB = new Uint8Array(64).fill(0xbb);
    const message = new Uint8Array(40).fill(7);
    const wireBytes = new Uint8Array(1 + 128 + message.length);
    wireBytes[0] = 2; // two signatures, single-byte shortvec
    wireBytes.set(sigA, 1);
    wireBytes.set(sigB, 65);
    wireBytes.set(message, 129);
    const wire = Buffer.from(wireBytes).toString('base64');

    expect(signatureOfWire(wire)).toBe(getBase58Decoder().decode(sigA));
  });

  it('refuses inputs that cannot be a transaction instead of guessing', () => {
    expect(signatureOfWire('')).toBeNull(); // empty
    expect(signatureOfWire('AQID')).toBeNull(); // 3 bytes — too short for any signature
    expect(signatureOfWire(Buffer.from(new Uint8Array(70).fill(1)).toString('base64'))).not.toBeNull();

    const zeroSigs = new Uint8Array(70);
    zeroSigs[0] = 0; // "zero signatures" — not a signed transaction
    expect(signatureOfWire(Buffer.from(zeroSigs).toString('base64'))).toBeNull();

    const multiByteShortvec = new Uint8Array(200);
    multiByteShortvec[0] = 0x80; // high bit: >127 signatures claimed — refuse
    expect(signatureOfWire(Buffer.from(multiByteShortvec).toString('base64'))).toBeNull();

    const truncated = new Uint8Array(80);
    truncated[0] = 2; // claims 2 signatures (needs ≥129 bytes) but only 80 long
    expect(signatureOfWire(Buffer.from(truncated).toString('base64'))).toBeNull();
  });

  it('round-trips through fromBase64 for both runtime paths', () => {
    const bytes = Uint8Array.from([1, 2, 3, 255, 0, 128]);
    const b64 = Buffer.from(bytes).toString('base64');
    expect(fromBase64(b64)).toEqual(bytes);
  });

  it('works in a browser runtime (no Buffer — the atob path)', () => {
    // The demo dApp ships this code to the browser: simulate it by removing
    // Buffer for the duration of the test.
    const realBuffer = globalThis.Buffer;
    // @ts-expect-error deliberately unsetting a Node global
    globalThis.Buffer = undefined;
    try {
      expect(fromBase64('AQID')).toEqual(Uint8Array.from([1, 2, 3]));
      expect(fromBase64('!!!not-base64!!!')).toBeNull(); // atob throws → null, never an exception
      expect(signatureOfWire(MAINNET_WIRE)).toBe(MAINNET_SIGNATURE); // the full derivation, browser-style
    } finally {
      globalThis.Buffer = realBuffer;
    }
  });
});
