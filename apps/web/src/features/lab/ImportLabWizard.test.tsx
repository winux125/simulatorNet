// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LabDocument } from "@sim/contracts";
import { ImportLabWizard } from "./ImportLabWizard";

const CLAB = `name: office
topology:
  nodes:
    r1: { kind: vr-csr }
    sw1: { kind: bridge }
    srl1: { kind: srl }
  links:
    - endpoints: ["r1:eth1", "sw1:eth1"]
    - endpoints: ["sw1:eth2", "srl1:e1-1"]
`;

afterEach(cleanup);

describe("ImportLabWizard", () => {
  it("inspects a foreign lab, shows the mapping, and imports on confirm", async () => {
    const file = new File([CLAB], "office.clab.yml", { type: "text/yaml" });
    const onImported = vi.fn();
    render(<ImportLabWizard file={file} onCancel={() => undefined} onImported={onImported} onError={() => undefined} />);

    await screen.findByTestId("import-mapping");
    expect(screen.getByLabelText("Map r1")).toBeTruthy();
    expect(screen.getByLabelText("Map srl1")).toBeTruthy();

    fireEvent.click(screen.getByTestId("import-confirm"));
    await vi.waitFor(() => expect(onImported).toHaveBeenCalled());

    const document = onImported.mock.calls.at(-1)![0] as LabDocument;
    const kinds = new Map(document.topology.nodes.map((node) => [node.id, node.kind]));
    expect(kinds.get("r1")).toBe("router");
    expect(kinds.get("sw1")).toBe("l2-switch");
    expect(kinds.get("srl1")).toBe("external-appliance");
  });

  it("shows an honest diagnostic for a recognised-but-unsupported Packet Tracer file", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 3, 0])], "lab.pkt");
    const onImported = vi.fn();
    render(<ImportLabWizard file={file} onCancel={() => undefined} onImported={onImported} onError={() => undefined} />);
    const notice = await screen.findByTestId("import-unsupported");
    expect(notice.textContent).toMatch(/Packet Tracer/i);
    expect(onImported).not.toHaveBeenCalled();
  });
});
