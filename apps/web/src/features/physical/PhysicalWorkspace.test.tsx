// @vitest-environment jsdom

import type { LabDocument } from "@sim/contracts";
import type { LabUiNode } from "@sim/sim-worker";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HUB_ETHERNET_DEMO } from "../../fixtures/m10-demo-labs";
import type { LabChangeImpact } from "../lab/change-impact";
import { PhysicalWorkspace } from "./PhysicalWorkspace";
import { addPhysicalRack, physicalViewOf } from "./physical-layout";

afterEach(cleanup);

/** A running lab: every device reports "up", exactly as the worker snapshot would. */
const RUNNING_NODES: LabUiNode[] = HUB_ETHERNET_DEMO.topology.nodes.map((node) => ({
  id: node.id,
  type: node.kind,
  hostname: node.name ?? node.id,
  position: node.position ?? { x: 0, y: 0 },
  status: "up",
  interfaces: node.interfaces.map((iface) => ({ id: iface.id, adminUp: true, operationalUp: true })),
}));

function labWithRack(): LabDocument {
  return addPhysicalRack(HUB_ETHERNET_DEMO, "room-default", "Rack A", 8);
}

/**
 * Drives the workspace like the app does: it owns the draft and records every
 * change request, so a test can assert the declared impact.
 */
function Harness({
  initial,
  onChange,
}: {
  initial: LabDocument;
  onChange(document: LabDocument, impact: LabChangeImpact): void;
}) {
  const [document, setDocument] = useState(initial);
  return (
    <PhysicalWorkspace
      document={document}
      nodes={RUNNING_NODES}
      onChange={(next, impact) => { onChange(next, impact); setDocument(next); }}
      onOpenDevice={() => undefined}
      onError={() => undefined}
    />
  );
}

describe("PhysicalWorkspace", () => {
  it("places a device from the Unplaced tray while the lab is running, as a presentation change", async () => {
    const user = userEvent.setup();
    const changes = vi.fn<(document: LabDocument, impact: LabChangeImpact) => void>();
    render(<Harness initial={labWithRack()} onChange={changes} />);

    const tray = screen.getByRole("region", { name: "Unplaced Devices" });
    expect(tray.textContent).toContain("HUB1");
    await user.click(screen.getByRole("button", { name: "Unplaced HUB1" }));
    await user.selectOptions(screen.getByLabelText("Move to rack"), "rack-1");

    expect(changes).toHaveBeenCalledTimes(1);
    const [next, impact] = changes.mock.calls[0]!;
    // Running is irrelevant here: placement is presentation, so nothing is
    // rebuilt, no runtime is reset and Apply Topology never appears.
    expect(impact).toBe("presentation");
    expect(next.topology).toBe(HUB_ETHERNET_DEMO.topology);
    expect(next.configurations).toBe(HUB_ETHERNET_DEMO.configurations);
    expect(physicalViewOf(next).devicePlacements).toEqual([
      { deviceId: "hub-1", siteId: "site-default", roomId: "room-default", rackId: "rack-1", rackUnit: 1, rackUnitSpan: 1 },
    ]);
    expect(screen.getByRole("button", { name: /HUB1 in Rack A U1/ })).toBeTruthy();
  });

  it("summarizes existing logical links behind Show Connections without creating any", async () => {
    const user = userEvent.setup();
    const changes = vi.fn<(document: LabDocument, impact: LabChangeImpact) => void>();
    render(<Harness initial={labWithRack()} onChange={changes} />);

    expect(screen.queryByLabelText("Connection summary")).toBeNull();
    await user.click(screen.getByLabelText("Show Connections"));
    const summary = screen.getByLabelText("Connection summary");
    // Nothing is placed yet, so no link reaches the room and none is invented.
    expect(summary.textContent).toContain("No links reach this room.");
    expect(changes).not.toHaveBeenCalled();
    expect(screen.getByText(/Wireless coverage and cable length are not calculated/)).toBeTruthy();
  });
});
