export function normalizeDnsName(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(normalized)) {
    throw new Error(`Invalid DNS name '${name}'`);
  }
  return normalized;
}

export function normalizeHttpPath(path: string): string {
  const normalized = path.trim();
  if (!normalized.startsWith("/") || normalized.includes("\\") || normalized.includes("..")) {
    throw new Error(`Invalid HTTP path '${path}'`);
  }
  return normalized;
}

export function normalizeTftpFilename(filename: string): string {
  const normalized = filename.trim().toLowerCase();
  if (!normalized || normalized.includes("/") || normalized.includes("\\") || normalized.includes("..")) {
    throw new Error(`Invalid TFTP filename '${filename}'`);
  }
  return normalized;
}

export function stringByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}
