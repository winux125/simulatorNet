/**
 * Twofish block cipher (128/192/256-bit keys, 128-bit blocks).
 *
 * Twofish is not in Web Crypto and the Packet Tracer container needs it, so it
 * is implemented here as a bounded, dependency-free module rather than by
 * pulling in a general-purpose crypto library for one algorithm. Only the
 * forward (encrypt) direction exists: EAX builds both confidentiality (CTR) and
 * authentication (CMAC) out of block *encryption* alone, so a decrypt path
 * would be dead code.
 *
 * The permutation tables are derived from the 4-bit t-boxes in the Twofish
 * specification instead of being pasted in as 512 magic bytes, so the
 * construction is auditable. Correctness is pinned by the published
 * all-zero-key/all-zero-plaintext vectors in `twofish.test.ts`.
 *
 * This is a faithful implementation of a public specification (Schneier et al.,
 * "Twofish: A 128-Bit Block Cipher"), informed by the MIT-licensed references
 * listed in THIRD_PARTY_NOTICES.md. It is deterministic and side-channel
 * naive — it protects nothing of ours, it only reads a documented file format.
 */

const MDS_POLY = 0x169;
const RS_POLY = 0x14d;

/** Multiply in GF(2^8) modulo `poly`. */
function gfMul(a: number, b: number, poly: number): number {
  let left = a;
  let right = b;
  let result = 0;
  while (right > 0) {
    if ((right & 1) !== 0) result ^= left;
    left <<= 1;
    if ((left & 0x100) !== 0) left ^= poly;
    right >>>= 1;
  }
  return result & 0xff;
}

/** Build one of the two 8-bit q permutations from its four 4-bit t-boxes. */
function buildQ(
  t0: readonly number[],
  t1: readonly number[],
  t2: readonly number[],
  t3: readonly number[],
): Uint8Array {
  const table = new Uint8Array(256);
  for (let x = 0; x < 256; x++) {
    let a = x >>> 4;
    let b = x & 0xf;
    // Each stage mixes the nibbles, rotates one of them, then substitutes.
    let na = a ^ b;
    let nb = (a ^ (((b >>> 1) | (b << 3)) & 0xf) ^ ((a << 3) & 0xf)) & 0xf;
    a = t0[na]!;
    b = t1[nb]!;
    na = a ^ b;
    nb = (a ^ (((b >>> 1) | (b << 3)) & 0xf) ^ ((a << 3) & 0xf)) & 0xf;
    a = t2[na]!;
    b = t3[nb]!;
    table[x] = ((b << 4) | a) & 0xff;
  }
  return table;
}

const Q0 = buildQ(
  [0x8, 0x1, 0x7, 0xd, 0x6, 0xf, 0x3, 0x2, 0x0, 0xb, 0x5, 0x9, 0xe, 0xc, 0xa, 0x4],
  [0xe, 0xc, 0xb, 0x8, 0x1, 0x2, 0x3, 0x5, 0xf, 0x4, 0xa, 0x6, 0x7, 0x0, 0x9, 0xd],
  [0xb, 0xa, 0x5, 0xe, 0x6, 0xd, 0x9, 0x0, 0xc, 0x8, 0xf, 0x3, 0x2, 0x4, 0x7, 0x1],
  [0xd, 0x7, 0xf, 0x4, 0x1, 0x2, 0x6, 0xe, 0x9, 0xb, 0x3, 0x0, 0x8, 0x5, 0xc, 0xa],
);

const Q1 = buildQ(
  [0x2, 0x8, 0xb, 0xd, 0xf, 0x7, 0x6, 0xe, 0x3, 0x1, 0x9, 0x4, 0x0, 0xa, 0xc, 0x5],
  [0x1, 0xe, 0x2, 0xb, 0x4, 0xc, 0x3, 0x7, 0x6, 0xd, 0xa, 0x5, 0xf, 0x9, 0x0, 0x8],
  [0x4, 0xc, 0x7, 0x5, 0x1, 0x6, 0x9, 0xa, 0x0, 0xe, 0xd, 0x8, 0x2, 0xb, 0x3, 0xf],
  [0xb, 0x9, 0x5, 0x1, 0xc, 0x3, 0xd, 0xe, 0x6, 0x4, 0x7, 0xf, 0x2, 0x0, 0x8, 0xa],
);

// Which q permutation applies at each byte position, per stage of h. The two
// leading stages run only for longer keys; the trailing three always run and
// are interleaved with the l1/l0 key bytes:
//   y = C[ B[ A[x] ^ l1 ] ^ l0 ]
const STAGE_K4: readonly Uint8Array[] = [Q1, Q0, Q0, Q1];
const STAGE_K3: readonly Uint8Array[] = [Q1, Q1, Q0, Q0];
const STAGE_A: readonly Uint8Array[] = [Q0, Q1, Q0, Q1];
const STAGE_B: readonly Uint8Array[] = [Q0, Q0, Q1, Q1];
const STAGE_C: readonly Uint8Array[] = [Q1, Q0, Q1, Q0];

const byteAt = (word: number, index: number): number => (word >>> (8 * index)) & 0xff;

/**
 * The key-dependent S-box for one byte position: the q-permutation chain
 * folded with the key words `l`. `k` is the key length in 64-bit units.
 */
function sboxByte(index: number, input: number, l: readonly number[], k: number): number {
  let y = input & 0xff;
  if (k === 4) y = STAGE_K4[index]![y]! ^ byteAt(l[3]!, index);
  if (k >= 3) y = STAGE_K3[index]![y]! ^ byteAt(l[2]!, index);
  y = STAGE_A[index]![y]! ^ byteAt(l[1]!, index);
  y = STAGE_B[index]![y]! ^ byteAt(l[0]!, index);
  return STAGE_C[index]![y]!;
}

// Column `i` of the MDS matrix, precomputed for every byte value, as a word.
const MDS_COLUMNS: readonly Int32Array[] = (() => {
  const rows = [
    [0x01, 0xef, 0x5b, 0x5b],
    [0x5b, 0xef, 0xef, 0x01],
    [0xef, 0x5b, 0x01, 0xef],
    [0xef, 0x01, 0xef, 0x5b],
  ] as const;
  return [0, 1, 2, 3].map((column) => {
    const table = new Int32Array(256);
    for (let value = 0; value < 256; value++) {
      let word = 0;
      for (let row = 0; row < 4; row++) {
        word |= gfMul(rows[row]![column]!, value, MDS_POLY) << (8 * row);
      }
      table[value] = word;
    }
    return table;
  });
})();

/** The h function: key-dependent substitution followed by the MDS mix. */
function h(input: number, l: readonly number[], k: number): number {
  let word = 0;
  for (let index = 0; index < 4; index++) {
    word ^= MDS_COLUMNS[index]![sboxByte(index, byteAt(input, index), l, k)]!;
  }
  return word >>> 0;
}

/** Reed-Solomon reduce one 8-byte key half into a 32-bit word. */
function rsEncode(key: Uint8Array, offset: number): number {
  const rows = [
    [0x01, 0xa4, 0x55, 0x87, 0x5a, 0x58, 0xdb, 0x9e],
    [0xa4, 0x56, 0x82, 0xf3, 0x1e, 0xc6, 0x68, 0xe5],
    [0x02, 0xa1, 0xfc, 0xc1, 0x47, 0xae, 0x3d, 0x19],
    [0xa4, 0x55, 0x87, 0x5a, 0x58, 0xdb, 0x9e, 0x03],
  ] as const;
  let word = 0;
  for (let row = 0; row < 4; row++) {
    let sum = 0;
    for (let column = 0; column < 8; column++) {
      sum ^= gfMul(rows[row]![column]!, key[offset + column]!, RS_POLY);
    }
    word |= sum << (8 * row);
  }
  return word >>> 0;
}

const readWordLE = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0);

const writeWordLE = (bytes: Uint8Array, offset: number, word: number): void => {
  bytes[offset] = word & 0xff;
  bytes[offset + 1] = (word >>> 8) & 0xff;
  bytes[offset + 2] = (word >>> 16) & 0xff;
  bytes[offset + 3] = (word >>> 24) & 0xff;
};

const rotl = (word: number, bits: number): number => ((word << bits) | (word >>> (32 - bits))) >>> 0;
const rotr = (word: number, bits: number): number => ((word >>> bits) | (word << (32 - bits))) >>> 0;
const add = (a: number, b: number): number => (a + b) >>> 0;

/** An expanded Twofish key: 40 round subkeys plus the key-dependent S-boxes. */
export interface TwofishKey {
  readonly subkeys: Int32Array;
  /** g(X) as four fully-keyed 256-entry tables, one per byte position. */
  readonly sboxes: readonly Int32Array[];
}

export const TWOFISH_BLOCK_BYTES = 16;

/**
 * Expand a 16/24/32-byte key. Throws on any other length: silently padding a
 * short key would decode a file into plausible-looking garbage.
 */
export function twofishExpandKey(key: Uint8Array): TwofishKey {
  if (key.length !== 16 && key.length !== 24 && key.length !== 32) {
    throw new RangeError(`Twofish key must be 16, 24 or 32 bytes, received ${key.length}`);
  }
  const k = key.length / 8;
  const even: number[] = [];
  const odd: number[] = [];
  for (let index = 0; index < k; index++) {
    even.push(readWordLE(key, 8 * index));
    odd.push(readWordLE(key, 8 * index + 4));
  }
  // S words are the RS reduction of each 8-byte half, in reverse order.
  const s: number[] = [];
  for (let index = k - 1; index >= 0; index--) s.push(rsEncode(key, 8 * index));

  const subkeys = new Int32Array(40);
  for (let index = 0; index < 20; index++) {
    const a = h((2 * index) * 0x01010101, even, k);
    const b = rotl(h((2 * index + 1) * 0x01010101, odd, k), 8);
    subkeys[2 * index] = add(a, b);
    subkeys[2 * index + 1] = rotl(add(add(a, b), b), 9);
  }

  // Fully key the S-boxes so the round function is four lookups and three XORs.
  const sboxes = [0, 1, 2, 3].map((index) => {
    const table = new Int32Array(256);
    for (let value = 0; value < 256; value++) {
      table[value] = MDS_COLUMNS[index]![sboxByte(index, value, s, k)]!;
    }
    return table;
  });

  return { subkeys, sboxes };
}

/** g(X) for an expanded key. */
function g(key: TwofishKey, word: number): number {
  const [s0, s1, s2, s3] = key.sboxes as [Int32Array, Int32Array, Int32Array, Int32Array];
  return (s0[word & 0xff]! ^ s1[(word >>> 8) & 0xff]! ^ s2[(word >>> 16) & 0xff]! ^ s3[(word >>> 24) & 0xff]!) >>> 0;
}

/**
 * Encrypt one 16-byte block. `output` may alias `block`; both must be at least
 * 16 bytes from their offsets.
 */
export function twofishEncryptBlock(
  key: TwofishKey,
  block: Uint8Array,
  output: Uint8Array,
  blockOffset = 0,
  outputOffset = 0,
): void {
  const { subkeys } = key;
  // Input whitening.
  let r0 = (readWordLE(block, blockOffset) ^ subkeys[0]!) >>> 0;
  let r1 = (readWordLE(block, blockOffset + 4) ^ subkeys[1]!) >>> 0;
  let r2 = (readWordLE(block, blockOffset + 8) ^ subkeys[2]!) >>> 0;
  let r3 = (readWordLE(block, blockOffset + 12) ^ subkeys[3]!) >>> 0;

  for (let round = 0; round < 16; round++) {
    const t0 = g(key, r0);
    const t1 = g(key, rotl(r1, 8));
    r2 = rotr((r2 ^ add(add(t0, t1), subkeys[2 * round + 8]!)) >>> 0, 1);
    r3 = (rotl(r3, 1) ^ add(add(t0, add(t1, t1)), subkeys[2 * round + 9]!)) >>> 0;
    // Swap halves for the next round.
    const swap0 = r0;
    const swap1 = r1;
    r0 = r2;
    r1 = r3;
    r2 = swap0;
    r3 = swap1;
  }

  // Undo the final swap, then output whitening.
  writeWordLE(output, outputOffset, (r2 ^ subkeys[4]!) >>> 0);
  writeWordLE(output, outputOffset + 4, (r3 ^ subkeys[5]!) >>> 0);
  writeWordLE(output, outputOffset + 8, (r0 ^ subkeys[6]!) >>> 0);
  writeWordLE(output, outputOffset + 12, (r1 ^ subkeys[7]!) >>> 0);
}
