export type TransportErrorCode =
  | "invalid-port"
  | "invalid-address"
  | "address-in-use"
  | "socket-limit"
  | "connection-limit"
  | "not-connected"
  | "payload-too-large"
  | "message-queue-limit";

/** Stable domain error surfaced by transport APIs and worker serialization. */
export class TransportError extends Error {
  constructor(
    readonly code: TransportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

export function validateTransportPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TransportError("invalid-port", `Port must be an integer between 1 and 65535; received ${port}`);
  }
}

export function payloadByteLength(payload: unknown): number {
  const text = JSON.stringify(payload);
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}
