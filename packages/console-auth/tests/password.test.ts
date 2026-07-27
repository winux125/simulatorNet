import { describe, expect, it } from "vitest";
import {
  createPasswordVerifier,
  createWirelessCredentialVerifier,
  verifyPassword,
} from "@sim/console-auth";

describe("password verifier", () => {
  it("creates a salted PBKDF2 verifier that never contains the plaintext", async () => {
    const verifier = await createPasswordVerifier("cisco123", 2_000);
    expect(verifier.algorithm).toBe("pbkdf2-sha256");
    expect(verifier.iterations).toBe(2_000);
    expect(verifier.saltBase64.length).toBeGreaterThan(0);
    expect(verifier.hashBase64.length).toBeGreaterThan(0);
    expect(JSON.stringify(verifier)).not.toContain("cisco123");
  });

  it("verifies the correct password and rejects wrong ones", async () => {
    const verifier = await createPasswordVerifier("s3cr3t", 2_000);
    expect(await verifyPassword("s3cr3t", verifier)).toBe(true);
    expect(await verifyPassword("wrong", verifier)).toBe(false);
    expect(await verifyPassword("", verifier)).toBe(false);
  });

  it("uses a random salt so identical passwords produce different verifiers", async () => {
    const a = await createPasswordVerifier("same", 2_000);
    const b = await createPasswordVerifier("same", 2_000);
    expect(a.saltBase64).not.toBe(b.saltBase64);
    expect(a.hashBase64).not.toBe(b.hashBase64);
    expect(await verifyPassword("same", a)).toBe(true);
    expect(await verifyPassword("same", b)).toBe(true);
  });

  it("rejects an empty new password", async () => {
    await expect(createPasswordVerifier("")).rejects.toThrow();
  });

  it("derives compatible SSID-scoped wireless verifiers without plaintext", async () => {
    const accessPoint = await createWirelessCredentialVerifier("Lab WLAN", "correct-horse", 2_000);
    const station = await createWirelessCredentialVerifier("Lab WLAN", "correct-horse", 2_000);
    const otherSsid = await createWirelessCredentialVerifier("Other WLAN", "correct-horse", 2_000);

    expect(station).toEqual(accessPoint);
    expect(otherSsid.hashBase64).not.toBe(accessPoint.hashBase64);
    expect(JSON.stringify(accessPoint)).not.toContain("correct-horse");
  });

  it.each([
    ["", "correct-horse", "SSID"],
    ["Lab WLAN", "short", "passphrase"],
    ["Lab WLAN", "x".repeat(64), "passphrase"],
  ])("rejects invalid wireless credentials", async (ssid, passphrase, message) => {
    await expect(createWirelessCredentialVerifier(ssid, passphrase, 2_000))
      .rejects.toThrow(message);
  });
});
