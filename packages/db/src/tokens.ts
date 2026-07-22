import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface OpaqueToken {
  readonly value: string;
  readonly hash: string;
}

export function createOpaqueToken(): OpaqueToken {
  const value = randomBytes(32).toString("base64url");
  return { value, hash: hashOpaqueToken(value) };
}

export function hashOpaqueToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function tokenHashEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
