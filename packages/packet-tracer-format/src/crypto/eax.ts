/**
 * EAX authenticated encryption (Bellare, Rogaway, Wagner) over Twofish.
 *
 *   N = OMAC^0(nonce)
 *   H = OMAC^1(header)
 *   C = CTR_N(message)
 *   T = N ^ H ^ OMAC^2(C)
 *
 * The transmitted value is C || T. Decryption recomputes T and compares before
 * returning any plaintext, so a truncated or edited container is rejected
 * rather than half-decoded into plausible garbage.
 */
import { cmacSubkeys, omacTweaked } from "./cmac";
import { ctrCrypt } from "./ctr";
import { TWOFISH_BLOCK_BYTES, twofishExpandKey, type TwofishKey } from "./twofish";

export const EAX_TAG_BYTES = TWOFISH_BLOCK_BYTES;

const xorInto = (target: Uint8Array, source: Uint8Array): void => {
  for (let index = 0; index < target.length; index++) target[index] = target[index]! ^ source[index]!;
};

/** Constant-time equality. Length is public; the bytes are not compared early. */
function equalTags(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index]! ^ b[index]!;
  return difference === 0;
}

interface EaxContext {
  readonly key: TwofishKey;
  readonly nonceMac: Uint8Array;
  readonly headerMac: Uint8Array;
  readonly subkeys: ReturnType<typeof cmacSubkeys>;
}

function context(rawKey: Uint8Array, nonce: Uint8Array, header: Uint8Array): EaxContext {
  const key = twofishExpandKey(rawKey);
  const subkeys = cmacSubkeys(key);
  return {
    key,
    subkeys,
    nonceMac: omacTweaked(key, 0, nonce, subkeys),
    headerMac: omacTweaked(key, 1, header, subkeys),
  };
}

function tagFor(ctx: EaxContext, ciphertext: Uint8Array): Uint8Array {
  const tag = omacTweaked(ctx.key, 2, ciphertext, ctx.subkeys);
  xorInto(tag, ctx.nonceMac);
  xorInto(tag, ctx.headerMac);
  return tag;
}

/** Encrypt and authenticate, returning `ciphertext || tag`. */
export function eaxEncrypt(
  rawKey: Uint8Array,
  nonce: Uint8Array,
  message: Uint8Array,
  header: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const ctx = context(rawKey, nonce, header);
  const ciphertext = ctrCrypt(ctx.key, ctx.nonceMac, message);
  const output = new Uint8Array(ciphertext.length + EAX_TAG_BYTES);
  output.set(ciphertext);
  output.set(tagFor(ctx, ciphertext), ciphertext.length);
  return output;
}

/**
 * Verify and decrypt `ciphertext || tag`. Returns undefined when the tag does
 * not match or the input is too short to carry one — the caller turns that into
 * a typed authentication failure rather than guessing at a cause.
 */
export function eaxDecrypt(
  rawKey: Uint8Array,
  nonce: Uint8Array,
  sealed: Uint8Array,
  header: Uint8Array = new Uint8Array(0),
): Uint8Array | undefined {
  if (sealed.length < EAX_TAG_BYTES) return undefined;
  const ciphertext = sealed.subarray(0, sealed.length - EAX_TAG_BYTES);
  const receivedTag = sealed.subarray(sealed.length - EAX_TAG_BYTES);
  const ctx = context(rawKey, nonce, header);
  if (!equalTags(tagFor(ctx, ciphertext), receivedTag)) return undefined;
  return ctrCrypt(ctx.key, ctx.nonceMac, ciphertext);
}
