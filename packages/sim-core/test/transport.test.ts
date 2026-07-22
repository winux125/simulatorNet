import {
  TcpState,
  TransportError,
  createSimulationEngine,
  macFromIndex,
  Pc,
  Router,
  type TcpApplicationPayload,
  type TraceEntry,
  type UdpApplicationPayload,
} from "@sim/sim-core";
import { describe, expect, it } from "vitest";
import { buildStarLan } from "./helpers";

const udpPayload = (data: unknown): UdpApplicationPayload => ({ kind: "udp-application", protocol: "test", data });
const tcpPayload = (data: unknown): TcpApplicationPayload => ({ kind: "tcp-application", protocol: "test", data });

describe("deterministic UDP sockets", () => {
  it("delivers an application datagram through IPv4 and Ethernet", () => {
    const { engine, pcs: [client, server] } = buildStarLan(2);
    const received: unknown[] = [];
    server!.bindUdp(9000, (message) => received.push(message.payload), "echo");
    client!.sendUdp({ destinationAddress: server!.ip!, destinationPort: 9000, sourcePort: 4000, payload: udpPayload("hello") });
    engine.runUntilIdle();
    expect(received).toEqual([udpPayload("hello")]);
  });

  it("rejects duplicate bindings with a typed domain error", () => {
    const { pcs: [pc] } = buildStarLan(1);
    pc!.bindUdp(53, () => undefined, "dns");
    expect(() => pc!.bindUdp(53, () => undefined, "other")).toThrowError(TransportError);
    try {
      pc!.bindUdp(53, () => undefined);
    } catch (error) {
      expect(error).toMatchObject({ code: "address-in-use" });
    }
  });

  it("unbinds a socket without affecting another host", () => {
    const { pcs: [a, b] } = buildStarLan(2);
    a!.bindUdp(7000, () => undefined, "a");
    b!.bindUdp(7000, () => undefined, "b");
    expect(a!.unbindUdp(7000)).toBe(true);
    expect(a!.transport.udp.inspect()).toEqual([]);
    expect(b!.transport.udp.inspect()).toHaveLength(1);
  });

  it("validates local and remote ports", () => {
    const { pcs: [pc] } = buildStarLan(1);
    expect(() => pc!.bindUdp(-1, () => undefined)).toThrow(/between 1 and 65535/);
    expect(() => pc!.sendUdp({ destinationAddress: "192.168.1.20", destinationPort: 65_536, payload: udpPayload(1) })).toThrow(/between 1 and 65535/);
  });

  it("allocates stable per-device ephemeral ports", () => {
    const run = (): number[] => {
      const { pcs: [pc] } = buildStarLan(1, 44);
      return [
        pc!.sendUdp({ destinationAddress: "255.255.255.255", destinationPort: 9000, payload: udpPayload(1) }),
        pc!.sendUdp({ destinationAddress: "255.255.255.255", destinationPort: 9000, payload: udpPayload(2) }),
      ];
    };
    expect(run()).toEqual([49_152, 49_153]);
    expect(run()).toEqual(run());
  });

  it("returns ICMP port unreachable for a closed unicast port", () => {
    const { engine, pcs: [client, server] } = buildStarLan(2);
    engine.enableTrace();
    client!.sendUdp({ destinationAddress: server!.ip!, destinationPort: 9999, payload: udpPayload("closed") });
    engine.runUntilIdle();
    expect(engine.traceLog.some((entry) => entry.type === "udp-port-unreachable" && entry.device === server!.id)).toBe(true);
    expect(engine.traceLog.some((entry) => entry.type === "icmp-port-unreachable" && entry.device === server!.id)).toBe(true);
  });

  it("does not create an ICMP storm for a closed broadcast port", () => {
    const { engine, pcs: [client] } = buildStarLan(3);
    engine.enableTrace();
    client!.sendUdp({ destinationAddress: "255.255.255.255", destinationPort: 9999, payload: udpPayload("broadcast") });
    engine.runUntilIdle();
    expect(engine.traceLog.filter((entry) => entry.type === "udp-port-unreachable")).toEqual([]);
  });

  it("reports local address, port, service, and state", () => {
    const { pcs: [pc] } = buildStarLan(1);
    pc!.bindUdp(123, () => undefined, "ntp");
    expect(pc!.transport.udp.inspect()).toEqual([{
      localAddress: "192.168.1.10",
      localPort: 123,
      service: "ntp",
      state: "listening",
    }]);
  });

  it("rejects an oversized structured application payload", () => {
    const { pcs: [pc] } = buildStarLan(1);
    expect(() => pc!.sendUdp({
      destinationAddress: "255.255.255.255",
      destinationPort: 9000,
      payload: udpPayload("x".repeat(70_000)),
    })).toThrowError(/payload exceeds/);
  });
});

describe("deterministic simplified TCP", () => {
  it("performs SYN, SYN-ACK, ACK and establishes both endpoints", () => {
    const { engine, pcs: [client, server] } = buildStarLan(2);
    let acceptedState: string | undefined;
    server!.listenTcp(80, (connection) => { acceptedState = connection.state; }, "http");
    const connection = client!.connectTcp(server!.ip!, 80);
    engine.runUntilIdle();
    expect(acceptedState).toBe(TcpState.Established);
    expect(connection.state).toBe(TcpState.Established);
  });

  it("resets an active open to a closed port", () => {
    const { engine, pcs: [client, server] } = buildStarLan(2);
    let reset = false;
    const connection = client!.connectTcp(server!.ip!, 81, { onReset: () => { reset = true; } });
    engine.runUntilIdle();
    expect(reset).toBe(true);
    expect(connection.state).toBe(TcpState.Closed);
  });

  it("delivers queued application messages in order", () => {
    const { engine, pcs: [client, server] } = buildStarLan(2);
    const received: unknown[] = [];
    server!.listenTcp(8080, (connection) => {
      connection.setHandlers({ onMessage: (payload) => received.push(payload.data) });
    });
    client!.connectTcp(server!.ip!, 8080, {
      onEstablished: (connection) => {
        connection.send(tcpPayload("one"));
        connection.send(tcpPayload("two"));
        connection.send(tcpPayload("three"));
      },
    });
    engine.runUntilIdle();
    expect(received).toEqual(["one", "two", "three"]);
  });

  it("closes gracefully through FIN, LAST_ACK and TIME_WAIT", () => {
    const { engine, pcs: [client, server] } = buildStarLan(2);
    server!.listenTcp(8000, (connection) => connection.close());
    const connection = client!.connectTcp(server!.ip!, 8000, { onEstablished: (current) => current.close() });
    engine.runUntilIdle();
    expect(connection.state).toBe(TcpState.Closed);
    expect(client!.transport.tcp.inspect()).toEqual([]);
  });

  it("bounds retransmissions and terminates an unreachable open", () => {
    const { engine, pcs: [client] } = buildStarLan(1);
    engine.enableTrace();
    const connection = client!.connectTcp("192.168.1.250", 80);
    engine.runUntilIdle();
    expect(connection.state).toBe(TcpState.Closed);
    expect(engine.traceLog.filter((entry) => entry.type === "tcp-retransmission")).toHaveLength(3);
    expect(engine.traceLog.some((entry) => entry.type === "tcp-timeout")).toBe(true);
  });

  it("supports simultaneous connections distinguished by their four-tuples", () => {
    const { engine, pcs: [a, b, server] } = buildStarLan(3);
    let accepted = 0;
    server!.listenTcp(443, () => { accepted++; }, "https-test");
    a!.connectTcp(server!.ip!, 443);
    b!.connectTcp(server!.ip!, 443);
    engine.runUntilIdle();
    expect(accepted).toBe(2);
    expect(server!.transport.tcp.inspect().filter((row) => row.state === TcpState.Established)).toHaveLength(2);
  });

  it("allows the same server port to listen on separate devices", () => {
    const { pcs: [a, b] } = buildStarLan(2);
    a!.listenTcp(80, () => undefined, "http-a");
    b!.listenTcp(80, () => undefined, "http-b");
    expect(a!.transport.tcp.inspect()[0]?.service).toBe("http-a");
    expect(b!.transport.tcp.inspect()[0]?.service).toBe("http-b");
  });

  it("rejects duplicate listeners and sends on non-established connections", () => {
    const { pcs: [client, server] } = buildStarLan(2);
    server!.listenTcp(80, () => undefined);
    expect(() => server!.listenTcp(80, () => undefined)).toThrowError(TransportError);
    const connection = client!.connectTcp(server!.ip!, 80);
    expect(() => connection.send(tcpPayload("too early"))).toThrowError(/not ESTABLISHED/);
  });

  it("exposes LISTEN and established tuple inspection", () => {
    const { engine, pcs: [client, server] } = buildStarLan(2);
    server!.listenTcp(80, () => undefined, "http");
    client!.connectTcp(server!.ip!, 80, {}, "http-client");
    engine.runUntilIdle();
    expect(server!.transport.tcp.inspect()).toEqual(expect.arrayContaining([
      expect.objectContaining({ localPort: 80, state: TcpState.Listen, service: "http" }),
      expect.objectContaining({ localPort: 80, remoteAddress: client!.ip, state: TcpState.Established }),
    ]));
  });

  it("produces stable traces and deterministic initial sequence numbers", () => {
    const run = (): TraceEntry[] => {
      const { engine, pcs: [client, server] } = buildStarLan(2, 90210);
      engine.enableTrace();
      server!.listenTcp(80, () => undefined);
      client!.connectTcp(server!.ip!, 80);
      engine.runUntilIdle();
      return engine.traceLog.filter((entry) => entry.type.startsWith("tcp-"));
    };
    expect(run()).toEqual(run());
  });
});

describe("transport integration regressions", () => {
  it("keeps DHCP DORA on the shared UDP path", () => {
    const engine = createSimulationEngine({ seed: 72 });
    const router = engine.add(new Router("r1", "R1"));
    const pc = engine.add(new Pc("pc1", "PC1"));
    router.addInterface("Gi0/0", macFromIndex(100));
    router.configureInterface("Gi0/0", { ip: "10.0.0.1", mask: 24 });
    router.addDhcpPool({ network: "10.0.0.0", mask: 24, gateway: "10.0.0.1", rangeStart: "10.0.0.10", rangeEnd: "10.0.0.20" });
    pc.addInterface("eth0", macFromIndex(1));
    engine.connect(pc.id, "eth0", router.id, "Gi0/0");
    engine.enableTrace();
    pc.requestDhcp();
    engine.runUntilIdle();
    expect(pc.ip).toBe("10.0.0.10");
    expect(engine.traceLog.some((entry) => entry.type === "udp-datagram-sent" && entry.device === pc.id)).toBe(true);
    expect(engine.traceLog.some((entry) => entry.type === "udp-datagram-received" && entry.device === pc.id)).toBe(true);
  });

  it("gives equivalent deterministic outcomes to two independent runtimes", () => {
    const run = (): { messages: unknown[]; trace: TraceEntry[] } => {
      const { engine, pcs: [client, server] } = buildStarLan(2, 12345);
      const messages: unknown[] = [];
      engine.enableTrace();
      server!.bindUdp(5000, (message) => messages.push(message.payload));
      client!.sendUdp({ destinationAddress: server!.ip!, destinationPort: 5000, payload: udpPayload({ answer: 42 }) });
      engine.runUntilIdle();
      return { messages, trace: engine.traceLog };
    };
    expect(run()).toEqual(run());
  });
});
