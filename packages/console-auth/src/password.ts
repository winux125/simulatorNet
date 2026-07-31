/**
 * Cross-runtime password verifiers built on PBKDF2-HMAC-SHA-256 via Web Crypto,
 * which is available both in the browser worker and in Node 24 (globalThis.crypto).
 * New passwords are never stored in the clear; only a salted verifier is kept.
 * Verification uses a constant-time comparison. This module has no dependency on
 * sim-core and never participates in packet determinism.
 */
import type { PasswordVerifier } from "@sim/contracts";

export const DEFAULT_PBKDF2_ITERATIONS = 120_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const WIRELESS_SALT_SCOPE = "SimulatorNet wireless credential\u0000";

const MANAGEMENT_SALT_SCOPE = "SimulatorNet management credential\u0000";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index]!;
    const b1 = bytes[index + 1];
    const b2 = bytes[index + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : B64[b2 & 63];
  }
  return out;
}

function fromBase64(value: string): Uint8Array {
  const clean = value.replace(/[^A-Za-z0-9+/]/gu, "");
  const output = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let outIndex = 0;
  for (let index = 0; index < clean.length; index += 4) {
    const c0 = B64.indexOf(clean[index]!);
    const c1 = B64.indexOf(clean[index + 1] ?? "A");
    const c2 = clean[index + 2] ? B64.indexOf(clean[index + 2]!) : -1;
    const c3 = clean[index + 3] ? B64.indexOf(clean[index + 3]!) : -1;
    output[outIndex++] = (c0 << 2) | (c1 >> 4);
    if (c2 >= 0) output[outIndex++] = ((c1 & 15) << 4) | (c2 >> 2);
    if (c3 >= 0) output[outIndex++] = ((c2 & 3) << 6) | c3;
  }
  return output.subarray(0, outIndex);
}

function webcrypto() {
  const value = globalThis.crypto;
  if (!value?.subtle) throw new Error("Web Crypto is not available in this runtime");
  return value;
}

/** Copy bytes into a fresh ArrayBuffer so the value is a strict BufferSource
 *  (never SharedArrayBuffer-backed) across both the DOM and Node lib types. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function deriveBits(password: string, salt: Uint8Array, iterations: number, bytes: number): Promise<Uint8Array> {
  const crypto = webcrypto();
  const key = await crypto.subtle.importKey("raw", toArrayBuffer(new TextEncoder().encode(password)), "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: toArrayBuffer(salt), iterations }, key, bytes * 8);
  return new Uint8Array(derived);
}

/** Hash a new password into a verifier. Rejects empty passwords. */
export async function createPasswordVerifier(password: string, iterations = DEFAULT_PBKDF2_ITERATIONS): Promise<PasswordVerifier> {
  if (password.length === 0) throw new Error("Password must not be empty");
  const salt = webcrypto().getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await deriveBits(password, salt, iterations, HASH_BYTES);
  return { algorithm: "pbkdf2-sha256", iterations, saltBase64: toBase64(salt), hashBase64: toBase64(hash) };
}

/**
 * Derive compatible AP/client material for the educational WPA2-PSK model.
 * The SSID-scoped salt is deterministic so independently configured peers
 * produce the same opaque verifier without keeping the passphrase. This is
 * authentication material only; it does not claim to implement 802.11
 * encryption or the real WPA2 four-way handshake.
 */
export async function createWirelessCredentialVerifier(
  ssid: string,
  passphrase: string,
  iterations = DEFAULT_PBKDF2_ITERATIONS,
): Promise<PasswordVerifier> {
  if (ssid.length < 1 || ssid.length > 32) {
    throw new Error("Wireless SSID must contain between 1 and 32 characters");
  }
  if (passphrase.length < 8 || passphrase.length > 63) {
    throw new Error("WPA2 passphrase must contain between 8 and 63 characters");
  }
  const scope = new TextEncoder().encode(`${WIRELESS_SALT_SCOPE}${ssid}`);
  const digest = await webcrypto().subtle.digest("SHA-256", toArrayBuffer(scope));
  const salt = new Uint8Array(digest).slice(0, SALT_BYTES);
  const hash = await deriveBits(passphrase, salt, iterations, HASH_BYTES);
  return {
    algorithm: "pbkdf2-sha256",
    iterations,
    saltBase64: toBase64(salt),
    hashBase64: toBase64(hash),
  };
}

/**
 * Deterministic, scope-bound credential fingerprint for the *management plane*.
 *
 * Remote CLI, AAA and SNMP credentials must be comparable **inside** the
 * deterministic engine, which is synchronous and must never see a plaintext
 * secret. So — exactly like the educational WPA2-PSK model — Web Crypto derives
 * an opaque verifier from a fixed, scope-derived salt *before* any packet or
 * event processing. The client host derives the same value from what the
 * learner typed and only the opaque fingerprint crosses the simulated wire.
 *
 * The scope binds a fingerprint to one credential slot (a username, a VTY line,
 * a RADIUS server key) so the same password never produces a value that is
 * valid somewhere it was not configured. This is authentication material, not
 * encryption: nothing here claims to implement SSH, RADIUS or SNMP security.
 */
export async function createManagementCredentialVerifier(
  scope: string,
  secret: string,
): Promise<PasswordVerifier> {
  if (scope.length === 0) throw new Error("Management credential scope must not be empty");
  if (secret.length === 0) throw new Error("Management credential must not be empty");
  const scoped = new TextEncoder().encode(`${MANAGEMENT_SALT_SCOPE}${scope}`);
  const digest = await webcrypto().subtle.digest("SHA-256", toArrayBuffer(scoped));
  const salt = new Uint8Array(digest).slice(0, SALT_BYTES);
  const hash = await deriveBits(secret, salt, DEFAULT_PBKDF2_ITERATIONS, HASH_BYTES);
  return {
    algorithm: "pbkdf2-sha256",
    iterations: DEFAULT_PBKDF2_ITERATIONS,
    saltBase64: toBase64(salt),
    hashBase64: toBase64(hash),
  };
}

/** The comparable fingerprint alone, for a client that only sends the token. */
export async function managementCredentialFingerprint(scope: string, secret: string): Promise<string> {
  return (await createManagementCredentialVerifier(scope, secret)).hashBase64;
}

/**
 * Deterministic verifier for a site-to-site VPN pre-shared key.
 *
 * Two independently configured peers must derive the *same* opaque value from
 * the same key — exactly like the educational WPA2-PSK model — so the salt is a
 * fixed constant rather than a per-device random value. That also makes the
 * verifier reconstructible from its fingerprint alone, which is what lets the
 * CLI accept a key at a no-echo prompt without a plaintext secret ever reaching
 * the worker, the engine, a trace, `show running-config` or a grading result.
 *
 * This is authentication material only. It is not encryption, and nothing here
 * claims to implement IKEv2 or ESP cryptography.
 */
export const VPN_PRE_SHARED_KEY_SCOPE = "vpn:pre-shared-key";
const VPN_PRE_SHARED_KEY_SALT_BYTES = Uint8Array.from(
  "SimulatorNetVPNv1",
  (character) => character.charCodeAt(0),
).subarray(0, SALT_BYTES);
export const VPN_PRE_SHARED_KEY_SALT_BASE64 = toBase64(VPN_PRE_SHARED_KEY_SALT_BYTES);

export const MINIMUM_PRE_SHARED_KEY_LENGTH = 8;
export const MAXIMUM_PRE_SHARED_KEY_LENGTH = 128;

export async function createVpnPreSharedKeyVerifier(preSharedKey: string): Promise<PasswordVerifier> {
  if (
    preSharedKey.length < MINIMUM_PRE_SHARED_KEY_LENGTH
    || preSharedKey.length > MAXIMUM_PRE_SHARED_KEY_LENGTH
  ) {
    throw new Error(
      `Pre-shared key must contain between ${MINIMUM_PRE_SHARED_KEY_LENGTH} and ${MAXIMUM_PRE_SHARED_KEY_LENGTH} characters`,
    );
  }
  const hash = await deriveBits(
    preSharedKey,
    VPN_PRE_SHARED_KEY_SALT_BYTES,
    DEFAULT_PBKDF2_ITERATIONS,
    HASH_BYTES,
  );
  return {
    algorithm: "pbkdf2-sha256",
    iterations: DEFAULT_PBKDF2_ITERATIONS,
    saltBase64: VPN_PRE_SHARED_KEY_SALT_BASE64,
    hashBase64: toBase64(hash),
  };
}

/** The comparable fingerprint alone, for the terminal's no-echo credential path. */
export async function vpnPreSharedKeyFingerprint(preSharedKey: string): Promise<string> {
  return (await createVpnPreSharedKeyVerifier(preSharedKey)).hashBase64;
}

/**
 * Rebuild the stored verifier from a fingerprint the terminal already derived.
 * The salt and iteration count are fixed for this scope, so no plaintext key is
 * needed to persist an equivalent verifier.
 */
export function vpnPreSharedKeyVerifierFromFingerprint(fingerprint: string): PasswordVerifier {
  if (fingerprint.length < 4) throw new Error("Pre-shared key fingerprint is malformed");
  return {
    algorithm: "pbkdf2-sha256",
    iterations: DEFAULT_PBKDF2_ITERATIONS,
    saltBase64: VPN_PRE_SHARED_KEY_SALT_BASE64,
    hashBase64: fingerprint,
  };
}

/** Canonical credential scopes. Every management secret belongs to exactly one. */
export const managementCredentialScope = {
  /** A local user in the shared device user database. */
  user: (username: string): string => `user:${username.trim().toLowerCase()}`,
  /** The `password` configured directly under a `line vty` block. */
  line: (kind: "vty" | "console"): string => `line:${kind}`,
  /** The device `enable secret`. */
  enable: (): string => "enable",
  /** A RADIUS/TACACS+ shared key, bound to the configured server name. */
  sharedKey: (serverName: string): string => `key:${serverName.trim().toLowerCase()}`,
  /** An SNMP community string, bound to the agent's own device id. */
  community: (deviceId: string): string => `snmp:${deviceId}`,
} as const;

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a[index]! ^ b[index]!;
  return diff === 0;
}

/** Verify a candidate password against a stored verifier. */
export async function verifyPassword(password: string, verifier: PasswordVerifier): Promise<boolean> {
  if (verifier.algorithm !== "pbkdf2-sha256") return false;
  const expected = fromBase64(verifier.hashBase64);
  const actual = await deriveBits(password, fromBase64(verifier.saltBase64), verifier.iterations, expected.length);
  return constantTimeEqual(actual, expected);
}
