/**
 * Wire-format helpers — derive a transaction's signature from its signed
 * bytes WITHOUT asking a node.
 *
 * A serialized Solana transaction is: shortvec(signature count) ++
 * signatures (64 bytes each) ++ message. The first signature (fee payer) IS
 * the transaction signature — base58 of bytes [1..65) for any transaction
 * with ≤127 signatures (a single-byte shortvec; more can't physically fit in
 * a 1232-byte packet anyway).
 *
 * Why this exists: when a node answers "already been processed", the ledger
 * has these exact bytes but the error body carries no signature — the only
 * way to confirm the landed transaction honestly is to derive its signature
 * locally and poll it.
 */

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58-encode (Bitcoin/Solana alphabet). Digit-array method — no BigInt. */
export function toBase58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = []; // little-endian base-58 accumulator
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]!];
  return out;
}

/** Decode base64 (Node + browser). Returns null on malformed input. */
export function fromBase64(s: string): Uint8Array | null {
  try {
    if (typeof Buffer !== 'undefined') {
      // Buffer.from silently tolerates some garbage; the length checks in
      // signatureOfWire are the real gate — this only needs to not throw.
      return new Uint8Array(Buffer.from(s, 'base64'));
    }
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * The transaction signature of a signed wire (base64), derived locally.
 * Returns null when the input can't be a single-byte-shortvec transaction —
 * callers fall back to whatever the node said.
 */
export function signatureOfWire(wire: string): string | null {
  const bytes = fromBase64(wire);
  if (bytes === null) return null;
  if (bytes.length < 1 + 64) return null; // can't even hold one signature
  const sigCount = bytes[0]!;
  // High bit set = multi-byte shortvec (>127 signatures) — not a real-world
  // transaction shape; zero signatures = not signed. Refuse to guess.
  if (sigCount === 0 || (sigCount & 0x80) !== 0) return null;
  if (bytes.length < 1 + sigCount * 64) return null; // truncated wire
  return toBase58(bytes.subarray(1, 65)); // first signature = fee payer = THE signature
}
