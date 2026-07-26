import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// M10.3.3c — devices expose one cable handle and never a ring of port dots.
// Domain interfaces still exist: links stay anchored to exact interface IDs.

type IconProfile = "Classic Lab" | "Education Flat" | "Minimal Network";

async function chooseIconProfile(page: Page, profile: IconProfile) {
  await page.getByRole("menuitem", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Device Icon Style", exact: true }).click();
  await page.getByRole("menuitemradio", { name: profile, exact: true }).click();
}

async function closeInspector(page: Page) {
  const inspector = page.getByRole("region", { name: "Inspector" });
  if (await inspector.isVisible()) await inspector.getByRole("button", { name: "Close inspector" }).click();
}

async function choosePortLabels(page: Page, mode: "Always" | "Selected" | "Hidden") {
  await page.getByRole("menuitem", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Port Labels", exact: true }).click();
  await page.getByRole("menuitemradio", { name: mode, exact: true }).click();
}

/** Every port element that is actually painted anywhere on the canvas. */
async function visiblePortMarkers(page: Page) {
  return page.locator(".topology-graph [port]").evaluateAll((ports) => ports.flatMap((port) => {
    const shapes = port.matches("circle, rect, path, ellipse")
      ? [port]
      : [...port.querySelectorAll<SVGElement>("circle, rect, path, ellipse")];
    return shapes.filter((shape) => {
      const style = window.getComputedStyle(shape);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (Number(style.opacity) === 0) return false;
      const painted = (value: string) => value !== "none" && value !== "rgba(0, 0, 0, 0)" && value !== "transparent";
      return painted(style.fill) || (painted(style.stroke) && Number.parseFloat(style.strokeWidth) > 0);
    }).map((shape) => `${port.getAttribute("port")}:${window.getComputedStyle(shape).fill}`);
  }));
}

/** Edge endpoints and the interface anchor they are bound to. */
async function edgeAnchors(page: Page) {
  return page.locator(".x6-edge [data-link-id]").evaluateAll((lines) => lines.map((line) => {
    const path = line as SVGPathElement;
    const anchor = (deviceId: string, interfaceId: string) => {
      const device = document.querySelector(`[data-cell-id="${deviceId}"]`);
      const root = [...(device?.querySelectorAll<SVGElement>("[port]") ?? [])]
        .find((candidate) => candidate.getAttribute("port") === interfaceId);
      const shape = root?.matches("circle, rect, path") ? root : root?.querySelector<SVGElement>("circle, rect, path");
      const matrix = shape?.getScreenCTM();
      if (!shape || !matrix) return undefined;
      const box = shape.getBBox();
      const point = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(matrix);
      return { x: point.x, y: point.y };
    };
    const screenPoint = (distance: number) => {
      const matrix = path.getScreenCTM();
      if (!matrix) return undefined;
      const point = path.getPointAtLength(distance);
      const transformed = new DOMPoint(point.x, point.y).matrixTransform(matrix);
      return { x: transformed.x, y: transformed.y };
    };
    const gap = (a?: { x: number; y: number }, b?: { x: number; y: number }) =>
      a && b ? Math.hypot(a.x - b.x, a.y - b.y) : Number.POSITIVE_INFINITY;
    return {
      id: line.getAttribute("data-link-id"),
      sourceInterface: line.getAttribute("data-source-interface"),
      targetInterface: line.getAttribute("data-target-interface"),
      sourceGap: gap(screenPoint(0), anchor(line.getAttribute("data-source-device") ?? "", line.getAttribute("data-source-interface") ?? "")),
      targetGap: gap(screenPoint(path.getTotalLength()), anchor(line.getAttribute("data-target-device") ?? "", line.getAttribute("data-target-interface") ?? "")),
    };
  }));
}

async function connectWithCable(page: Page, from: string, to: string) {
  await closeInspector(page);
  const handle = page.getByRole("button", { name: `Connect ${from} to another device` });
  await expect(handle).toBeVisible();
  const handleBox = await handle.boundingBox();
  const targetBox = await page.getByRole("button", { name: `Select ${to}` }).boundingBox();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 12 });
  await page.mouse.up();
  const dialog = page.getByRole("dialog", { name: "Configure connection" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Connection type")).toHaveValue("ethernet");
  await expect(dialog.getByLabel("From interface")).toBeVisible();
  await expect(dialog.getByLabel("To interface")).toBeVisible();
  return dialog;
}

test("M10.3.3c devices show one cable handle and no port dots", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "New Lab", exact: true }).click();
  const canvas = page.getByTestId("topology-graph");
  const bounds = await canvas.boundingBox();

  // 1. Create PC1, PC2 and an L2 switch.
  await page.getByRole("button", { name: "Add Device", exact: true }).click();
  await page.getByRole("tab", { name: "End Devices" }).click();
  await page.getByRole("button", { name: "Add PC" }).click();
  await canvas.click({ position: { x: Math.round(bounds!.width * 0.18), y: Math.round(bounds!.height * 0.25) } });
  await page.getByRole("button", { name: "Add Device", exact: true }).click();
  await page.getByRole("tab", { name: "End Devices" }).click();
  await page.getByRole("button", { name: "Add PC" }).click();
  await canvas.click({ position: { x: Math.round(bounds!.width * 0.18), y: Math.round(bounds!.height * 0.7) } });
  await page.getByRole("button", { name: "Add Device", exact: true }).click();
  await page.getByRole("tab", { name: "Network Devices" }).click();
  await page.getByRole("button", { name: "Add L2 Switch" }).click();
  await canvas.click({ position: { x: Math.round(bounds!.width * 0.6), y: Math.round(bounds!.height * 0.45) } });
  await expect(page.locator(".canvas-statusbar").getByText("3 devices", { exact: true })).toBeVisible();

  // 2. No painted port marker exists at rest, on hover, or on selection.
  expect(await visiblePortMarkers(page)).toEqual([]);
  await page.getByRole("button", { name: "Select PC1" }).hover();
  expect(await visiblePortMarkers(page)).toEqual([]);
  await page.getByRole("button", { name: "Select SW1" }).click();
  expect(await visiblePortMarkers(page)).toEqual([]);
  await closeInspector(page);

  // 3. Internal ports still exist for anchoring.
  expect(await page.locator(".topology-graph [port]").count()).toBeGreaterThan(3);

  // 4. Hovering a device reveals exactly one cable handle.
  await page.getByRole("button", { name: "Select PC1" }).hover();
  await expect(page.getByRole("button", { name: "Connect PC1 to another device" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Connect PC1 to another device" })).toHaveAttribute("title", "Connect");

  // 5-6. Drag the cable handle onto the switch and choose interfaces.
  const first = await connectWithCable(page, "PC1", "SW1");
  await first.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".canvas-statusbar").getByText("1 links", { exact: true })).toBeVisible();

  // 7. Cancelling the modal creates no edge.
  const cancelled = await connectWithCable(page, "PC2", "SW1");
  await cancelled.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".canvas-statusbar").getByText("1 links", { exact: true })).toBeVisible();

  const second = await connectWithCable(page, "PC2", "SW1");
  // 8. The interface already used by PC1's link is not offered again.
  const offered = await second.getByLabel("To interface").evaluate((element) =>
    [...(element as HTMLSelectElement).options].map((option) => option.value));
  expect(offered).not.toContain("Gi0/1");
  await second.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".canvas-statusbar").getByText("2 links", { exact: true })).toBeVisible();

  // 9. Connect… from the device context menu starts the same device-first flow.
  await closeInspector(page);
  await page.locator('[data-device-id="switch-1"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Connect…/ }).click();
  await expect(page.locator(".canvas-statusbar")).toContainText("Select the device to connect");
  await page.locator(".topology-panel").press("Escape");
  await expect(page.locator(".canvas-statusbar")).not.toContainText("Select the device to connect");
  await expect(page.locator(".canvas-statusbar").getByText("2 links", { exact: true })).toBeVisible();

  // 10. Links are anchored to their exact interfaces and still no dots.
  await expect.poll(async () => (await edgeAnchors(page)).length).toBe(2);
  const anchors = await edgeAnchors(page);
  expect(anchors.map((edge) => edge.sourceInterface)).toEqual(["eth0", "eth0"]);
  expect(anchors.map((edge) => edge.targetInterface)).toEqual(["Gi0/1", "Gi0/2"]);
  expect(Math.max(...anchors.flatMap((edge) => [edge.sourceGap, edge.targetGap]))).toBeLessThanOrEqual(6);
  expect(await visiblePortMarkers(page)).toEqual([]);

  // 11. Port Labels are interface names, not connection points.
  for (const mode of ["Always", "Selected", "Hidden"] as const) {
    await choosePortLabels(page, mode);
    expect(await visiblePortMarkers(page)).toEqual([]);
    await expect.poll(async () => Math.max(...(await edgeAnchors(page)).flatMap((edge) => [edge.sourceGap, edge.targetGap])))
      .toBeLessThanOrEqual(6);
  }
  await choosePortLabels(page, "Always");
  await expect(page.locator(".x6-edge-label").first()).toBeVisible();

  // 12. All three icon profiles stay dot-free and keep their anchors.
  for (const profile of ["Classic Lab", "Education Flat", "Minimal Network"] as const) {
    await chooseIconProfile(page, profile);
    await page.waitForTimeout(150);
    expect(await visiblePortMarkers(page)).toEqual([]);
    await expect.poll(async () => Math.max(...(await edgeAnchors(page)).flatMap((edge) => [edge.sourceGap, edge.targetGap])))
      .toBeLessThanOrEqual(6);
    await page.screenshot({ path: `/tmp/m10-3-3c-cable-${profile.split(" ")[0]!.toLowerCase()}-1440x900.png`, animations: "disabled" });
  }
  await chooseIconProfile(page, "Classic Lab");

  // 13. Responsive resize keeps anchors and dot-free rendering.
  for (const size of [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }]) {
    await page.setViewportSize(size);
    await page.getByRole("button", { name: "Fit topology" }).click();
    await page.waitForTimeout(250);
    expect(await visiblePortMarkers(page)).toEqual([]);
    await expect.poll(async () => Math.max(...(await edgeAnchors(page)).flatMap((edge) => [edge.sourceGap, edge.targetGap])))
      .toBeLessThanOrEqual(6);
    await page.screenshot({ path: `/tmp/m10-3-3c-cable-${size.width}x${size.height}.png`, animations: "disabled" });
  }
});

test("M10.3.3c the lab power lock owns the cable handle, and ping still works", async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "New Lab", exact: true }).click();
  const canvas = page.getByTestId("topology-graph");

  const place = async (category: "End Devices" | "Network Devices", name: string, x: number, y: number) => {
    await page.getByRole("button", { name: "Add Device", exact: true }).click();
    await page.getByRole("tab", { name: category }).click();
    await page.getByRole("button", { name: `Add ${name}` }).click();
    await canvas.click({ position: { x, y } });
  };
  await place("End Devices", "PC", 170, 150);
  await place("Network Devices", "L2 Switch", 500, 260);
  await place("End Devices", "PC", 830, 150);

  const configurePc = async (hostname: string, address: string) => {
    await page.getByRole("button", { name: `Select ${hostname}` }).dblclick();
    const window = page.getByRole("dialog", { name: `${hostname} device window` });
    await window.getByLabel("IPv4 Address").fill(address);
    await window.getByLabel("Subnet Mask").fill("255.255.255.0");
    await window.getByRole("button", { name: "Apply" }).click();
    await expect(window.getByText("Loading IP configuration…")).toHaveCount(0);
    await window.getByRole("button", { name: "Close device window" }).click();
  };
  await configurePc("PC1", "192.168.30.10");
  await configurePc("PC2", "192.168.30.20");
  const inspector = page.getByRole("region", { name: "Inspector" });
  if (await inspector.isVisible()) await inspector.getByRole("button", { name: "Close inspector" }).click();

  // 1. Wire both PCs through the cable handle only.
  for (const source of ["PC1", "PC2"] as const) {
    const dialog = await connectWithCable(page, source, "SW1");
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  await expect(page.locator(".canvas-statusbar").getByText("2 links", { exact: true })).toBeVisible();
  expect(await visiblePortMarkers(page)).toEqual([]);

  // 2. A running lab exposes no cable handle and no Connect affordance.
  await page.getByRole("button", { name: "Start Lab" }).click();
  await expect(page.getByRole("button", { name: "Stop Lab" })).toBeVisible();
  await expect(page.locator("[data-connection-handle]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add link" })).toBeDisabled();
  expect(await visiblePortMarkers(page)).toEqual([]);

  // 3. Connectivity still works while the topology is locked.
  await page.getByRole("button", { name: "Select PC1" }).click();
  await page.getByRole("region", { name: "Inspector" }).getByRole("button", { name: /Open CLI/ }).click();
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.type("ping 192.168.30.20");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("terminal-transcript")).toContainText("Success rate is 100 percent");

  // 4. Stopping the lab restores the cable handle.
  await page.getByRole("button", { name: "Stop Lab" }).click();
  const stopDialog = page.getByRole("dialog", { name: "Stop this lab?" });
  if (await stopDialog.count()) await stopDialog.getByRole("button", { name: "Stop Lab" }).click();
  await expect(page.getByRole("button", { name: "Start Lab" })).toBeVisible();
  await expect(page.locator("[data-connection-handle]")).toHaveCount(3);
  expect(await visiblePortMarkers(page)).toEqual([]);

  // 5. Export/import keeps interface IDs and dot-free anchoring.
  const before = (await edgeAnchors(page)).map((edge) => `${edge.id}:${edge.sourceInterface}:${edge.targetInterface}`);
  expect(before).toHaveLength(2);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: /Save \/ Export Lab/ }).click();
  const exported = await (await downloadPromise).path();
  await page.locator("#load-lab-file").setInputFiles(exported!);
  await page.getByRole("button", { name: "Fit topology" }).click();
  await expect.poll(async () => (await edgeAnchors(page)).map((edge) => `${edge.id}:${edge.sourceInterface}:${edge.targetInterface}`))
    .toEqual(before);
  await expect.poll(async () => Math.max(...(await edgeAnchors(page)).flatMap((edge) => [edge.sourceGap, edge.targetGap])))
    .toBeLessThanOrEqual(6);
  expect(await visiblePortMarkers(page)).toEqual([]);
});
