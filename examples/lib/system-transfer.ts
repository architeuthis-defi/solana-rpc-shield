/**
 * Raw SystemProgram transfer instruction — built at the wire level so the
 * examples need zero packages beyond @solana/kit. Layout (bincode):
 *   u32 LE instruction index (2 = Transfer) ++ u64 LE lamports.
 */
import { AccountRole, address, type Address, type Instruction } from '@solana/kit';

export const SYSTEM_PROGRAM = address('11111111111111111111111111111111');

export function transferInstruction(from: Address, to: Address, lamports: bigint): Instruction {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true); // SystemInstruction::Transfer
  view.setBigUint64(4, lamports, true);
  return {
    programAddress: SYSTEM_PROGRAM,
    accounts: [
      { address: from, role: AccountRole.WRITABLE_SIGNER },
      { address: to, role: AccountRole.WRITABLE },
    ],
    data,
  };
}
