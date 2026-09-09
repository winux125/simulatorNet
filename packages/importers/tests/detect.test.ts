import { describe, expect, it } from "vitest";
import { detectLabImportFormat, type ImportSource } from "@sim/importers";
import { buildZip } from "./helpers/zip";

const encoder = new TextEncoder();
const source = (text: string, filename?: string): ImportSource => ({ filename, bytes: encoder.encode(text) });
const bytesSource = (bytes: Uint8Array, filename?: string): ImportSource => ({ filename, bytes });

const NATIVE = '{"schemaVersion":1,"id":"lab","title":"Lab","simulation":{"seed":1},"topology":{"schemaVersion":1,"nodes":[],"links":[]}}';
const GNS3 = '{"name":"proj","revision":9,"project_id":"abc","topology":{"nodes":[],"links":[]}}';
const CLAB = "name: office\ntopology:\n  nodes:\n    r1:\n      kind: linux\n  links: []\n";
const CML = "lab:\n  title: Campus\nnodes:\n  - id: n0\n    node_definition: iosv\nlinks: []\n";
const UNL = '<?xml version="1.0"?><lab name="Lab" id="1"><topology><nodes/></topology></lab>';
const VIRL = '<?xml version="1.0"?><topology xmlns="http://www.cisco.com/VIRL"><node name="r1"/></topology>';

describe("content-based format detection", () => {
  it("recognises each supported format from its content", () => {
    expect(detectLabImportFormat(source(NATIVE)).format).toBe("simulatornet");
    expect(detectLabImportFormat(source(GNS3)).format).toBe("gns3-project");
    expect(detectLabImportFormat(source(CLAB)).format).toBe("containerlab-yaml");
    expect(detectLabImportFormat(source(CML)).format).toBe("cml-yaml");
    expect(detectLabImportFormat(source(UNL)).format).toBe("pnetlab-unl");
    expect(detectLabImportFormat(source(VIRL)).format).toBe("virl-xml");
  });

  it("detects GNS3 portable and PNETLab archives by their entries, not extension", () => {
    const gns3 = buildZip([{ name: "project.gns3", data: encoder.encode(GNS3) }]);
    const pnet = buildZip([{ name: "lab/topology.unl", data: encoder.encode(UNL) }]);
    expect(detectLabImportFormat(bytesSource(gns3, "export.dat")).format).toBe("gns3-portable");
    expect(detectLabImportFormat(bytesSource(pnet, "export.dat")).format).toBe("pnetlab-unl");
  });

  it("does not let a misleading extension override the content", () => {
    const detection = detectLabImportFormat(source(NATIVE, "topology.gns3"));
    expect(detection.format).toBe("simulatornet");
    expect(detection.confidence).toBe("content");
    expect(detectLabImportFormat(source(CLAB, "notes.txt")).format).toBe("containerlab-yaml");
  });

  it("rejects unknown content safely", () => {
    const detection = detectLabImportFormat(source("just some notes", "notes.bin"));
    expect(detection.format).toBe("unknown");
    expect(detection.supported).toBe(false);
    expect(detectLabImportFormat({ bytes: new Uint8Array(0) }).format).toBe("unknown");
  });

  it("recognises Packet Tracer .pkt and .pka as supported", () => {
    // Supported natively since M10.17.4. Detection stays extension-led here
    // because the container is ciphertext: only the decoder can confirm it, and
    // it reports an unreadable or unsupported container as a typed failure.
    const pkt = bytesSource(Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x00]), "lab.pkt");
    const pka = bytesSource(Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x00]), "activity.pka");
    const dPkt = detectLabImportFormat(pkt);
    const dPka = detectLabImportFormat(pka);
    expect(dPkt.format).toBe("packet-tracer-pkt");
    expect(dPkt.supported).toBe(true);
    expect(dPka.format).toBe("packet-tracer-pka");
    expect(dPka.supported).toBe(true);
  });
});
