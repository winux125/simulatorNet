import { describe, expect, it } from "vitest";
import { TWOFISH_BLOCK_BYTES, twofishEncryptBlock, twofishExpandKey } from "../src/crypto/twofish";

const hex = (value: string): Uint8Array =>
  Uint8Array.from(value.match(/../gu)!.map((pair) => Number.parseInt(pair, 16)));

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();

function encrypt(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const output = new Uint8Array(TWOFISH_BLOCK_BYTES);
  twofishEncryptBlock(twofishExpandKey(key), plaintext, output);
  return output;
}

describe("twofish", () => {
  // Published single-block ECB vectors from the Twofish submission package
  // (ecb_ival.txt). These pin the q permutations, the MDS/RS matrices, the key
  // schedule and the round function together — an error in any one of them
  // moves the ciphertext.
  it("matches the published 128-bit key vector", () => {
    expect(toHex(encrypt(hex("00000000000000000000000000000000"), hex("00000000000000000000000000000000"))))
      .toBe("9F589F5CF6122C32B6BFEC2F2AE8C35A");
  });

  it("matches the published 192-bit key vector", () => {
    expect(toHex(encrypt(hex("0123456789ABCDEFFEDCBA98765432100011223344556677"), hex("00000000000000000000000000000000"))))
      .toBe("CFD1D2E5A9BE9CDF501F13B892BD2248");
  });

  it("matches the published 256-bit key vector", () => {
    expect(toHex(encrypt(hex("0123456789ABCDEFFEDCBA987654321000112233445566778899AABBCCDDEEFF"), hex("00000000000000000000000000000000"))))
      .toBe("37527BE0052334B89F0CFCCAE87CFA20");
  });

  it("rejects a key length the cipher does not define", () => {
    expect(() => twofishExpandKey(new Uint8Array(20))).toThrow(RangeError);
  });

  it("encrypts in place when output aliases the input block", () => {
    const key = twofishExpandKey(hex("00000000000000000000000000000000"));
    const buffer = new Uint8Array(TWOFISH_BLOCK_BYTES);
    twofishEncryptBlock(key, buffer, buffer);
    expect(toHex(buffer)).toBe("9F589F5CF6122C32B6BFEC2F2AE8C35A");
  });
});
