import { SIMULATORNET_MIB_OID, SNMP_LIMITS } from "@sim/contracts";

/**
 * The built-in, educational SimulatorNet MIB.
 *
 * It is a *fixed* tree: there is no dynamic MIB loading and no OID scripting.
 * Every value is read from state the engine genuinely models, so nothing here
 * invents CPU load, memory use or temperatures that no simulator can know.
 *
 * Standard system and interface objects keep their well-known OIDs so the
 * numbers a learner recognises still work; everything SimulatorNet-specific
 * lives under its own enterprise subtree.
 */
export const SNMP_OID = {
  sysDescr: "1.3.6.1.2.1.1.1.0",
  sysObjectID: "1.3.6.1.2.1.1.2.0",
  sysUpTime: "1.3.6.1.2.1.1.3.0",
  sysContact: "1.3.6.1.2.1.1.4.0",
  sysName: "1.3.6.1.2.1.1.5.0",
  sysLocation: "1.3.6.1.2.1.1.6.0",
  ifNumber: "1.3.6.1.2.1.2.1.0",
  ifDescr: "1.3.6.1.2.1.2.2.1.2",
  ifType: "1.3.6.1.2.1.2.2.1.3",
  ifAdminStatus: "1.3.6.1.2.1.2.2.1.7",
  ifOperStatus: "1.3.6.1.2.1.2.2.1.8",
  ifInDiscards: "1.3.6.1.2.1.2.2.1.13",
  ifOutDiscards: "1.3.6.1.2.1.2.2.1.19",
  ifInUcastPkts: "1.3.6.1.2.1.2.2.1.11",
  ifOutUcastPkts: "1.3.6.1.2.1.2.2.1.17",
  ipAddress: "1.3.6.1.2.1.4.20.1.1",
  ipv6Address: `${SIMULATORNET_MIB_OID}.4.1`,
  routeCount: `${SIMULATORNET_MIB_OID}.5.1.0`,
  neighborCount: `${SIMULATORNET_MIB_OID}.5.2.0`,
  stpRootId: `${SIMULATORNET_MIB_OID}.6.1.0`,
  stpPortStates: `${SIMULATORNET_MIB_OID}.6.2.0`,
  ospfNeighborCount: `${SIMULATORNET_MIB_OID}.7.1.0`,
  ospfv3NeighborCount: `${SIMULATORNET_MIB_OID}.7.2.0`,
  etherChannelCount: `${SIMULATORNET_MIB_OID}.8.1.0`,
  wirelessClientCount: `${SIMULATORNET_MIB_OID}.9.1.0`,
  firewallSessionCount: `${SIMULATORNET_MIB_OID}.10.1.0`,
  natTranslationCount: `${SIMULATORNET_MIB_OID}.10.2.0`,
} as const;

export type SnmpValueType = "OctetString" | "Integer" | "Counter32" | "Gauge32" | "TimeTicks" | "IpAddress" | "ObjectID";

export interface SnmpVarBind {
  readonly oid: string;
  readonly type: SnmpValueType;
  readonly value: string | number;
}

/**
 * Everything the MIB can read. Implemented by each SNMP-capable device so the
 * agent never reaches into device internals directly.
 */
export interface SnmpMibSource {
  readonly deviceId: string;
  description(): string;
  objectId(): string;
  hostname(): string;
  /** Virtual runtime in nanoseconds. */
  upTimeNs(): number;
  location(): string | undefined;
  contact(): string | undefined;
  interfaces(): readonly SnmpInterfaceRow[];
  ipv4Addresses(): readonly string[];
  ipv6Addresses(): readonly string[];
  routeCount(): number;
  neighborCount(): number;
  /** Protocol summaries; undefined when the device does not run the protocol. */
  spanningTree?(): { readonly rootId: string; readonly portStates: string } | undefined;
  ospfNeighborCount?(): number;
  ospfv3NeighborCount?(): number;
  etherChannelCount?(): number;
  wirelessClientCount?(): number;
  firewallSessionCount?(): number;
  natTranslationCount?(): number;
}

export interface SnmpInterfaceRow {
  readonly index: number;
  readonly name: string;
  /** ifType: 6 ethernetCsmacd, 71 ieee80211, 53 propVirtual (SVI/loopback). */
  readonly ifType: number;
  readonly adminUp: boolean;
  readonly operationalUp: boolean;
  readonly inUnicastPackets: number;
  readonly outUnicastPackets: number;
  readonly inDiscards: number;
  readonly outDiscards: number;
}

/** SNMP TimeTicks are hundredths of a second since the agent started. */
export function toTimeTicks(nanoseconds: number): number {
  return Math.floor(nanoseconds / 10_000_000);
}

/**
 * Materialize the whole readable tree in canonical OID order.
 *
 * Building the full list keeps GET, GETNEXT and WALK trivially consistent and
 * bounded: the tree is small and fixed, so there is no risk of an unbounded or
 * order-dependent traversal.
 */
export function mibVarBinds(source: SnmpMibSource): SnmpVarBind[] {
  const binds: SnmpVarBind[] = [
    { oid: SNMP_OID.sysDescr, type: "OctetString", value: source.description() },
    { oid: SNMP_OID.sysObjectID, type: "ObjectID", value: source.objectId() },
    { oid: SNMP_OID.sysUpTime, type: "TimeTicks", value: toTimeTicks(source.upTimeNs()) },
    { oid: SNMP_OID.sysContact, type: "OctetString", value: source.contact() ?? "" },
    { oid: SNMP_OID.sysName, type: "OctetString", value: source.hostname() },
    { oid: SNMP_OID.sysLocation, type: "OctetString", value: source.location() ?? "" },
  ];
  const interfaces = [...source.interfaces()].sort((a, b) => a.index - b.index);
  binds.push({ oid: SNMP_OID.ifNumber, type: "Integer", value: interfaces.length });
  for (const column of [
    [SNMP_OID.ifDescr, "OctetString", (row: SnmpInterfaceRow) => row.name],
    [SNMP_OID.ifType, "Integer", (row: SnmpInterfaceRow) => row.ifType],
    [SNMP_OID.ifAdminStatus, "Integer", (row: SnmpInterfaceRow) => (row.adminUp ? 1 : 2)],
    [SNMP_OID.ifOperStatus, "Integer", (row: SnmpInterfaceRow) => (row.operationalUp ? 1 : 2)],
    [SNMP_OID.ifInUcastPkts, "Counter32", (row: SnmpInterfaceRow) => row.inUnicastPackets],
    [SNMP_OID.ifOutUcastPkts, "Counter32", (row: SnmpInterfaceRow) => row.outUnicastPackets],
    [SNMP_OID.ifInDiscards, "Counter32", (row: SnmpInterfaceRow) => row.inDiscards],
    [SNMP_OID.ifOutDiscards, "Counter32", (row: SnmpInterfaceRow) => row.outDiscards],
  ] as const) {
    const [prefix, type, read] = column;
    for (const row of interfaces) {
      binds.push({ oid: `${prefix}.${row.index}`, type, value: read(row) });
    }
  }
  source.ipv4Addresses().forEach((address, index) => {
    binds.push({ oid: `${SNMP_OID.ipAddress}.${index + 1}`, type: "IpAddress", value: address });
  });
  source.ipv6Addresses().forEach((address, index) => {
    binds.push({ oid: `${SNMP_OID.ipv6Address}.${index + 1}`, type: "OctetString", value: address });
  });
  binds.push({ oid: SNMP_OID.routeCount, type: "Gauge32", value: source.routeCount() });
  binds.push({ oid: SNMP_OID.neighborCount, type: "Gauge32", value: source.neighborCount() });

  const stp = source.spanningTree?.();
  if (stp) {
    binds.push({ oid: SNMP_OID.stpRootId, type: "OctetString", value: stp.rootId });
    binds.push({ oid: SNMP_OID.stpPortStates, type: "OctetString", value: stp.portStates });
  }
  pushOptional(binds, SNMP_OID.ospfNeighborCount, source.ospfNeighborCount?.());
  pushOptional(binds, SNMP_OID.ospfv3NeighborCount, source.ospfv3NeighborCount?.());
  pushOptional(binds, SNMP_OID.etherChannelCount, source.etherChannelCount?.());
  pushOptional(binds, SNMP_OID.wirelessClientCount, source.wirelessClientCount?.());
  pushOptional(binds, SNMP_OID.firewallSessionCount, source.firewallSessionCount?.());
  pushOptional(binds, SNMP_OID.natTranslationCount, source.natTranslationCount?.());

  return binds.sort((a, b) => compareOids(a.oid, b.oid));
}

function pushOptional(binds: SnmpVarBind[], oid: string, value: number | undefined): void {
  if (value === undefined) return;
  binds.push({ oid, type: "Gauge32", value });
}

/** Numeric, component-wise OID ordering — never a string comparison. */
export function compareOids(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? -1) - (b[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function isValidOid(oid: string): boolean {
  return oid.length > 0
    && oid.length <= SNMP_LIMITS.maximumOidLength
    && /^\d+(?:\.\d+)*$/u.test(oid);
}

/** True when `oid` is `prefix` itself or sits under it. */
export function oidStartsWith(oid: string, prefix: string): boolean {
  return oid === prefix || oid.startsWith(`${prefix}.`);
}
