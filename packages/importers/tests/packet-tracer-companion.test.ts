import { describe, expect, it } from "vitest";
import { executeLabImport, inspectPacketTracerCompanions } from "../src/index";

const bytes = (text: string) => new TextEncoder().encode(text);
const file = (name: string, text: string) => ({ name, bytes: bytes(text) });

function png(width = 320, height = 180): Uint8Array {
  const value = new Uint8Array(24);
  value.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  value.set([0x49, 0x48, 0x44, 0x52], 12);
  value.set([(width >>> 24) & 255, (width >>> 16) & 255, (width >>> 8) & 255, width & 255], 16);
  value.set([(height >>> 24) & 255, (height >>> 16) & 255, (height >>> 8) & 255, height & 255], 20);
  return value;
}

describe("Packet Tracer companion reconstruction", () => {
  it("builds a reviewable plan from explicit inventory, addressing, configs, links and screenshots", () => {
    const plan = inspectPacketTracerCompanions({
      referenceFilename: "campus.pkt",
      files: [
        file("devices.csv", "hostname,type,x,y\nR1,router,100,120\nSW1,l2-switch,280,120\nPC1,pc,280,260\n"),
        file("interfaces.csv", "device,interface,address,mask,gateway\nR1,Gi0/0,192.168.10.1,255.255.255.0,\nSW1,Gi0/1,,,\nSW1,Gi0/2,,,\nPC1,eth0,192.168.10.10,255.255.255.0,192.168.10.1\n"),
        file("connections.csv", "deviceA,interfaceA,deviceB,interfaceB\nR1,Gi0/0,SW1,Gi0/1\nSW1,Gi0/2,PC1,eth0\n"),
        file("R1.cfg", "hostname R1\n"),
        { name: "topology.png", bytes: png() },
      ],
    });

    expect(plan).toMatchObject({ format: "packet-tracer-companion", platform: "packet-tracer-companion", originalFilename: "campus.pkt", importable: true });
    expect(plan.parsed.nodes).toHaveLength(3);
    expect(plan.parsed.links).toHaveLength(2);
    expect(plan.parsed.assets).toHaveLength(1);
    expect(plan.parsed.annotations[0]).toMatchObject({ type: "image", locked: true });
    expect(plan.proposals.find((proposal) => proposal.label === "R1")?.suggestedDeviceType).toBe("router");
    expect(plan.proposals.find((proposal) => proposal.label === "PC1")?.suggestedDeviceType).toBe("pc");

    const result = executeLabImport(plan);
    expect(result.document.sourceImport).toMatchObject({ platform: "packet-tracer-companion", originalFilename: "campus.pkt" });
    expect(result.document.topology.links).toHaveLength(2);
    expect(result.document.configurations.pc1).toMatchObject({ kind: "pc", ipv4: { address: "192.168.10.10", prefixLength: 24, defaultGateway: "192.168.10.1" } });
    expect(result.report.entries).toContainEqual(expect.objectContaining({
      code: "packet-tracer-companion-reconstruction",
      message: "Reconstructed from user-provided companion data; PKT content was not parsed.",
    }));
  });

  it("never infers connectivity from screenshots", () => {
    const plan = inspectPacketTracerCompanions({
      referenceFilename: "visual.pka",
      files: [
        file("devices.csv", "hostname,type,x,y\nPC1,pc,10,20\nPC2,pc,300,20\n"),
        { name: "visual.png", bytes: png() },
      ],
    });
    expect(plan.parsed.links).toEqual([]);
    expect(plan.report.entries).toContainEqual(expect.objectContaining({ code: "companion-connections-not-provided" }));
  });

  it("rejects malformed CSV structure and does not accept the PKT bytes as a companion parser input", () => {
    expect(() => inspectPacketTracerCompanions({
      referenceFilename: "source.pkt",
      files: [file("devices.csv", "name,kind\nR1,router\n")],
    })).toThrow(/hostname column/u);
  });
});
