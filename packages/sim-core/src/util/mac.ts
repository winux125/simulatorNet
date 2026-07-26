/** A MAC address in canonical lowercase colon form: "aa:bb:cc:dd:ee:ff". */
export type Mac = string;

export const BROADCAST_MAC: Mac = "ff:ff:ff:ff:ff:ff";
export const ZERO_MAC: Mac = "00:00:00:00:00:00";

export function normalizeMac(mac: Mac): Mac {
  return mac.trim().toLowerCase();
}

/** IEEE 802.1D spanning-tree group address. */
export const STP_BPDU_MAC: Mac = "01:80:c2:00:00:00";
/** Cisco-like per-VLAN spanning-tree (PVST+) group address. */
export const PVST_BPDU_MAC: Mac = "01:00:0c:cc:cc:cd";

export function isBroadcastMac(mac: Mac): boolean {
  return normalizeMac(mac) === BROADCAST_MAC;
}

/** True for a group (multicast) address; the low bit of the first octet is set. */
export function isMulticastMac(mac: Mac): boolean {
  const first = Number.parseInt(normalizeMac(mac).slice(0, 2), 16);
  return Number.isFinite(first) && (first & 1) === 1;
}

export function macEquals(a: Mac, b: Mac): boolean {
  return normalizeMac(a) === normalizeMac(b);
}

/**
 * Deterministic, locally-administered unicast MAC from a small integer.
 * OUI 02:00:00 has the locally-administered bit set and the multicast bit
 * clear, so generated addresses never collide with real vendor OUIs.
 */
export function macFromIndex(index: number): Mac {
  const bytes = [0x02, 0x00, 0x00, (index >>> 16) & 0xff, (index >>> 8) & 0xff, index & 0xff];
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join(":");
}
