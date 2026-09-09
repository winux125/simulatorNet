/**
 * CMAC (OMAC1, NIST SP 800-38B) over Twofish, plus the tweaked OMAC^t variant
 * EAX is defined in terms of. Encrypt-only: CMAC never needs the inverse
 * cipher.
 */
import { TWOFISH_BLOCK_BYTES, twofishEncryptBlock, type TwofishKey } from "./twofish";

/** Reduction constant for a 128-bit block. */
const RB = 0x87;

/** Double a block in GF(2^128): left shift, conditionally XOR the constant. */
function double(block: Uint8Array): Uint8Array {
  const out = new Uint8Array(TWOFISH_BLOCK_BYTES);
  let carry = 0;
  for (let index = TWOFISH_BLOCK_BYTES - 1; index >= 0; index--) {
    const value = (block[index]! << 1) | carry;
    out[index] = value & 0xff;
    carry = (value >>> 8) & 1;
  }
  if (carry !== 0 || (block[0]! & 0x80) !== 0) {
    out[TWOFISH_BLOCK_BYTES - 1] = out[TWOFISH_BLOCK_BYTES - 1]! ^ RB;
  }
  return out;
}

export interface CmacSubkeys {
  readonly k1: Uint8Array;
  readonly k2: Uint8Array;
}

/** Derive the two CMAC subkeys from E(K, 0^128). */
export function cmacSubkeys(key: TwofishKey): CmacSubkeys {
  const l = new Uint8Array(TWOFISH_BLOCK_BYTES);
  twofishEncryptBlock(key, l, l);
  const k1 = double(l);
  return { k1, k2: double(k1) };
}

/**
 * CMAC over `message`. `subkeys` is accepted so a caller computing several MACs
 * with one key (EAX computes three) does not redo the subkey derivation.
 */
export function cmac(key: TwofishKey, message: Uint8Array, subkeys = cmacSubkeys(key)): Uint8Array {
  const state = new Uint8Array(TWOFISH_BLOCK_BYTES);
  const complete = message.length > 0 && message.length % TWOFISH_BLOCK_BYTES === 0;
  const fullBlocks = complete
    ? message.length / TWOFISH_BLOCK_BYTES - 1
    : Math.floor(message.length / TWOFISH_BLOCK_BYTES);

  for (let block = 0; block < fullBlocks; block++) {
    const offset = block * TWOFISH_BLOCK_BYTES;
    for (let index = 0; index < TWOFISH_BLOCK_BYTES; index++) {
      state[index] = state[index]! ^ message[offset + index]!;
    }
    twofishEncryptBlock(key, state, state);
  }

  // The final block is XORed with K1 when it is whole, or padded with a single
  // 1 bit and XORed with K2 when it is short (which includes an empty message).
  const last = new Uint8Array(TWOFISH_BLOCK_BYTES);
  const tailOffset = fullBlocks * TWOFISH_BLOCK_BYTES;
  const tailLength = message.length - tailOffset;
  last.set(message.subarray(tailOffset, tailOffset + tailLength));
  const pad = complete ? subkeys.k1 : subkeys.k2;
  if (!complete) last[tailLength] = 0x80;
  for (let index = 0; index < TWOFISH_BLOCK_BYTES; index++) {
    state[index] = state[index]! ^ last[index]! ^ pad[index]!;
  }
  twofishEncryptBlock(key, state, state);
  return state;
}

/**
 * OMAC^t: CMAC over the 16-byte big-endian encoding of `tweak` followed by the
 * message. EAX uses t=0 for the nonce, t=1 for the header and t=2 for the
 * ciphertext, which is what keeps those three MACs from colliding.
 */
export function omacTweaked(
  key: TwofishKey,
  tweak: number,
  message: Uint8Array,
  subkeys = cmacSubkeys(key),
): Uint8Array {
  const input = new Uint8Array(TWOFISH_BLOCK_BYTES + message.length);
  input[TWOFISH_BLOCK_BYTES - 1] = tweak & 0xff;
  input.set(message, TWOFISH_BLOCK_BYTES);
  return cmac(key, input, subkeys);
}
