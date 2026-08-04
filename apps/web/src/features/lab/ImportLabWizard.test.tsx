// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

async function waitForInspection() {
  await screen.findByText(/Inspection complete/i);
}

function continueStep() {
  fireEvent.click(screen.getByTestId("import-continue"));
}

function largePnetlabFixture(count: number): string {
  const nodes = Array.from({ length: count }, (_, index) => (
    `<node id="${index + 1}" name="PC${index + 1}" type="qemu" template="vpcs" left="${(index % 10) * 90}" top="${Math.floor(index / 10) * 70}"><interface id="0" name="e0" network_id="${index + 1}"/></node>`
  )).join("");
  const networks = Array.from({ length: count }, (_, index) => `<network id="${index + 1}" type="bridge" name="Net${index + 1}"/>`).join("");
  return `<?xml version="1.0"?><lab name="Large PNETLab" version="1"><topology><nodes>${nodes}</nodes><networks>${networks}</networks></topology></lab>`;
}

describe("ImportLabWizard", () => {
  it("uses the complete five-step flow and opens only from the result step", async () => {
    const file = new File([CLAB], "office.clab.yml", { type: "text/yaml" });
    const onImported = vi.fn();
    render(<ImportLabWizard file={file} onCancel={() => undefined} onImported={onImported} onError={() => undefined} />);

    await waitForInspection();
    expect(screen.getByLabelText("Import progress").textContent).toContain("Select File");
    expect(screen.getByLabelText("Import progress").textContent).toContain("Import Result");
    expect(screen.getByTestId("import-wizard-footer")).toBeTruthy();

    continueStep();
    expect(screen.getByRole("heading", { name: "Review detected content" })).toBeTruthy();
    continueStep();

    const mapping = screen.getByTestId("import-mapping");
    expect(screen.getByLabelText("Map r1")).toBeTruthy();
    expect(screen.getByLabelText("Map srl1")).toBeTruthy();
    expect(within(mapping).getAllByRole("row")).toHaveLength(4);

    continueStep();
    expect(screen.getByText("Device Mapping Warnings")).toBeTruthy();
    fireEvent.click(screen.getByTestId("import-confirm"));
    await screen.findByRole("heading", { name: /Imported|Partially Imported/ });
    expect(onImported).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("import-open"));
    expect(onImported).toHaveBeenCalledOnce();

    const document = onImported.mock.calls.at(-1)![0] as LabDocument;
    const kinds = new Map(document.topology.nodes.map((node) => [node.id, node.kind]));
    expect(kinds.get("r1")).toBe("router");
    expect(kinds.get("sw1")).toBe("l2-switch");
    expect(kinds.get("srl1")).toBe("external-appliance");
  });

  it("keeps a 100-node PNETLab mapping accessible and filterable", async () => {
    const file = new File([largePnetlabFixture(100)], "large.unl", { type: "application/xml" });
    render(<ImportLabWizard file={file} onCancel={() => undefined} onImported={() => undefined} onError={() => undefined} />);
    await waitForInspection();
    continueStep();
    continueStep();

    const mapping = screen.getByTestId("import-mapping");
    expect(within(mapping).getAllByRole("row")).toHaveLength(101);
    expect(screen.getByLabelText("Map PC100")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search source devices"), { target: { value: "PC100" } });
    expect(within(mapping).getAllByRole("row")).toHaveLength(2);
    expect(screen.getByLabelText("Map PC100")).toBeTruthy();
  });

  it("closes on Escape and keeps the body as the wizard scroll owner", async () => {
    const onCancel = vi.fn();
    const file = new File([CLAB], "office.clab.yml", { type: "text/yaml" });
    render(<ImportLabWizard file={file} onCancel={onCancel} onImported={() => undefined} onError={() => undefined} />);
    await waitForInspection();
    expect(document.querySelector('[data-scroll-owner="import-wizard-body"]')).toBeTruthy();
    const close = screen.getByRole("button", { name: "Close import wizard" });
    const continueButton = screen.getByTestId("import-continue");
    close.focus();
    fireEvent.keyDown(screen.getByTestId("import-wizard"), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(continueButton);
    fireEvent.keyDown(screen.getByTestId("import-wizard"), { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(screen.getByTestId("import-wizard"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("never renders source credential material", async () => {
    const credentialFixture = `<?xml version="1.0"?><lab name="Credentials" version="1"><topology><nodes><node id="1" name="R1" type="qemu" template="iosv"><config><![CDATA[username admin password 0 NeverRenderThisSecret
enable secret NeverRenderThisHash]]></config></node></nodes><networks/></topology></lab>`;
    const file = new File([credentialFixture], "credentials.unl", { type: "application/xml" });
    render(<ImportLabWizard file={file} onCancel={() => undefined} onImported={() => undefined} onError={() => undefined} />);
    await waitForInspection();
    expect(document.body.textContent).not.toContain("NeverRenderThisSecret");
    expect(document.body.textContent).not.toContain("NeverRenderThisHash");
  });

  it("shows one honest Packet Tracer boundary card with migration actions and no direct Continue", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 3, 0])], "lab.pkt");
    const onImported = vi.fn();
    render(<ImportLabWizard file={file} onCancel={() => undefined} onImported={onImported} onError={() => undefined} />);
    const notice = await screen.findByTestId("packet-tracer-migration");
    expect(notice.textContent).toContain("Packet Tracer file recognised");
    expect(notice.textContent).toContain("does not have a supported public parser");
    expect(screen.getByText("Packet Tracer · Recognised, unsupported for direct conversion")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Migration Guide" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconstruct Lab from Companion Files" })).toBeTruthy();
    expect(screen.queryByTestId("import-unsupported")).toBeNull();
    expect(screen.queryByTestId("import-continue")).toBeNull();
    expect(onImported).not.toHaveBeenCalled();
  });

  it("reconstructs only from selected companion files and exposes the mapping review", async () => {
    const source = new File([new Uint8Array([0, 1, 2, 3, 0])], "classroom.pkt");
    const onImported = vi.fn();
    render(<ImportLabWizard file={source} onCancel={() => undefined} onImported={onImported} onError={() => undefined} />);
    await screen.findByTestId("packet-tracer-migration");
    fireEvent.click(screen.getByRole("button", { name: "Reconstruct Lab from Companion Files" }));
    const devices = new File(["hostname,type,x,y\nR1,router,100,100\nPC1,pc,300,100\n"], "devices.csv", { type: "text/csv" });
    const interfaces = new File(["device,interface,address,mask,gateway\nR1,Gi0/0,192.168.1.1,255.255.255.0,\nPC1,eth0,192.168.1.10,255.255.255.0,192.168.1.1\n"], "interfaces.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("Choose Packet Tracer companion files"), { target: { files: [devices, interfaces] } });
    fireEvent.click(screen.getByRole("button", { name: "Build Reconstruction Plan" }));

    await screen.findByRole("heading", { name: "Review detected content" });
    continueStep();
    expect(screen.getByLabelText("Map R1")).toBeTruthy();
    expect(screen.getByLabelText("Map PC1")).toBeTruthy();
    continueStep();
    fireEvent.click(screen.getByTestId("import-confirm"));
    expect(await screen.findByText("Reconstructed from user-provided companion data; PKT content was not parsed.")).toBeTruthy();
    fireEvent.click(screen.getByTestId("import-open"));
    const document = onImported.mock.calls[0]![0] as LabDocument;
    expect(document.sourceImport).toMatchObject({ platform: "packet-tracer-companion", originalFilename: "classroom.pkt" });
    expect(document.topology.links).toEqual([]);
  });
});
