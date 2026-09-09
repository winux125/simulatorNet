/**
 * CTR mode over Twofish. The counter is the full 128-bit block treated as a
 * big-endian integer, which is what EAX specifies (it seeds the counter with
 * the nonce MAC rather than with a nonce||counter split).
 */
import { TWOFISH_BLOCK_BYTES, twofishEncryptBlock, type TwofishKey } from "./twofish";

/** Increment a 128-bit big-endian counter in place, wrapping at the top. */
function increment(counter: Uint8Array): void {
  for (let index = TWOFISH_BLOCK_BYTES - 1; index >= 0; index--) {
    counter[index] = (counter[index]! + 1) & 0xff;
    if (counter[index] !== 0) return;
  }
}

/**
 * Apply the CTR keystream to `data`, returning a new array. CTR is its own
 * inverse, so this both encrypts and decrypts.
 */
export function ctrCrypt(key: TwofishKey, initialCounter: Uint8Array, data: Uint8Array): Uint8Array {
  if (initialCounter.length !== TWOFISH_BLOCK_BYTES) {
    throw new RangeError(`CTR counter must be ${TWOFISH_BLOCK_BYTES} bytes, received ${initialCounter.length}`);
  }
  const output = new Uint8Array(data.length);
  const counter = Uint8Array.from(initialCounter);
  const keystream = new Uint8Array(TWOFISH_BLOCK_BYTES);
  for (let offset = 0; offset < data.length; offset += TWOFISH_BLOCK_BYTES) {
    twofishEncryptBlock(key, counter, keystream);
    const span = Math.min(TWOFISH_BLOCK_BYTES, data.length - offset);
    for (let index = 0; index < span; index++) {
      output[offset + index] = data[offset + index]! ^ keystream[index]!;
    }
    increment(counter);
  }
  return output;
}
