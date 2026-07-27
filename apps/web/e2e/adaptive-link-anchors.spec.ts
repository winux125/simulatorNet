import { expect, test, type Page } from "@playwright/test";

type DeviceCategory = "End Devices" | "Network Devices";

interface RenderedLink {
  id: string;
  sourceDevice: string;
  sourceInterface: string;
  targetDevice: string;
  targetInterface: string;
  sourceSide: string;
  targetSide: string;
  parallelOffset: number;
  path: string;
}

async function closeInspector(page: Page) {
  const inspector = page.getByRole("region", { name: "Inspector" });
  if (await inspector.isVisible().catch(() => false)) {
    await inspector.getByRole("button", { name: "Close inspector" }).click();
  }
}

async function chooseIconProfile(
  page: Page,
  profile: "Classic Lab" | "Education Flat" | "Minimal Network",
) {
  await page.getByRole("menuitem", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Device Icon Style", exact: true }).click();
  await page.getByRole("menuitemradio", { name: profile, exact: true }).click();
}

async function chooseBottomPanel(page: Page, state: "Show" | "Minimize" | "Hide") {
  await page.getByRole("menuitem", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Bottom Panel", exact: true }).click();
  await page.getByRole("menuitemradio", { name: new RegExp(`^${state}`) }).click();
}

async function choosePortLabels(page: Page, mode: "Always" | "Selected" | "Hidden") {
  await page.getByRole("menuitem", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Port Labels", exact: true }).click();
  await page.getByRole("menuitemradio", { name: mode, exact: true }).click();
}

async function placeDevice(
  page: Page,
  category: DeviceCategory,
  device: string,
  position: { x: number; y: number },
) {
  await page.getByRole("button", { name: "Add Device", exact: true }).click();
  await page.getByRole("tab", { name: category }).click();
  await page.getByRole("button", { name: `Add ${device}` }).click();
  await page.getByTestId("topology-graph").click({ position });
}

async function connectDevices(
  page: Page,
  sourceHostname: string,
  targetHostname: string,
  sourceInterface?: string,
  targetInterface?: string,
) {
  await closeInspector(page);
  const source = page.getByRole("button", { name: `Select ${sourceHostname}` });
  const target = page.getByRole("button", { name: `Select ${targetHostname}` });
  await source.hover();
  const handle = page.getByRole("button", { name: `Connect ${sourceHostname} to another device` });
  const handleBox = await handle.boundingBox();
  const targetBox = await target.boundingBox();
  expect(handleBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 10 });
  await page.mouse.up();
  const dialog = page.getByRole("dialog", { name: "Configure connection" });
  await expect(dialog).toBeVisible();
  if (sourceInterface) await dialog.getByLabel("From interface").selectOption(sourceInterface);
  if (targetInterface) await dialog.getByLabel("To interface").selectOption(targetInterface);
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

async function configurePc(page: Page, hostname: string, address: string) {
  await closeInspector(page);
  await page.getByRole("button", { name: `Select ${hostname}` }).dblclick();
  const deviceWindow = page.getByRole("dialog", { name: `${hostname} device window` });
  await deviceWindow.getByLabel("IPv4 Address").fill(address);
  await deviceWindow.getByLabel("Subnet Mask").fill("255.255.255.0");
  await deviceWindow.getByRole("button", { name: "Apply" }).click();
  await expect(deviceWindow.getByText("Loading IP configuration…")).toHaveCount(0);
  await deviceWindow.getByRole("button", { name: "Close device window" }).click();
}

async function renderedLinks(page: Page): Promise<RenderedLink[]> {
  return page.locator(".x6-edge [data-link-id]").evaluateAll((lines) => lines.map((line) => ({
    id: line.getAttribute("data-link-id") ?? "",
    sourceDevice: line.getAttribute("data-source-device") ?? "",
    sourceInterface: line.getAttribute("data-source-interface") ?? "",
    targetDevice: line.getAttribute("data-target-device") ?? "",
    targetInterface: line.getAttribute("data-target-interface") ?? "",
    sourceSide: line.getAttribute("data-source-side") ?? "",
    targetSide: line.getAttribute("data-target-side") ?? "",
    parallelOffset: Number(line.getAttribute("data-parallel-offset") ?? "0"),
    path: line.getAttribute("d") ?? "",
  })));
}

async function linkFrom(page: Page, sourceDevice: string) {
  return (await renderedLinks(page)).find((link) => link.sourceDevice === sourceDevice);
}

async function dragDevice(page: Page, deviceId: string, dx: number, dy: number) {
  const node = page.locator(`[data-device-id="${deviceId}"]`)
    .locator("xpath=ancestor::*[contains(@class,'x6-node')]");
  const bounds = await node.boundingBox();
  expect(bounds).not.toBeNull();
  const x = bounds!.x + bounds!.width / 2;
  const y = bounds!.y + bounds!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up();
}

async function openCli(page: Page, hostname: string) {
  await closeInspector(page);
  await page.getByRole("button", { name: `Select ${hostname}` }).click();
  await page.getByRole("region", { name: "Inspector" }).getByRole("button", { name: /Open CLI/ }).click();
  await expect(page.getByRole("tab", { name: new RegExp(`${hostname} terminal`) })).toBeVisible();
}

async function focusTerminal(page: Page) {
  const terminal = page.getByRole("tab", { name: /^Terminal/ });
  if (await terminal.count()) await terminal.first().click();
}

async function runCli(page: Page, command: string) {
  await focusTerminal(page);
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

async function runAuto(page: Page) {
  await page.getByRole("tab", { name: /Packet trace/ }).click();
  const runAll = page.getByRole("button", { name: /Run All|Run until idle/i });
  if (await runAll.count() > 0 && await runAll.first().isEnabled()) await runAll.first().click();
}

async function stopLab(page: Page) {
  await page.getByRole("button", { name: "Stop Lab" }).click();
  const dialog = page.getByRole("dialog", { name: "Stop this lab?" });
  if (await dialog.count()) await dialog.getByRole("button", { name: "Stop Lab" }).click();
  await expect(page.getByRole("button", { name: "Start Lab" })).toBeVisible();
}

async function visiblePortMarkers(page: Page) {
  return page.locator(".topology-graph [port]").evaluateAll((ports) => ports.filter((port) => {
    const shape = port.matches("circle, rect, path, ellipse")
      ? port
      : port.querySelector("circle, rect, path, ellipse");
    if (!shape) return false;
    const style = window.getComputedStyle(shape);
    const painted = (value: string) =>
      value !== "none" && value !== "transparent" && value !== "rgba(0, 0, 0, 0)";
    return style.display !== "none"
      && style.visibility !== "hidden"
      && Number(style.opacity) !== 0
      && (painted(style.fill) || (painted(style.stroke) && Number.parseFloat(style.strokeWidth) > 0));
  }).map((port) => port.getAttribute("port")));
}

test("adaptive anchors follow device movement without rebuilding a running lab", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "New Lab", exact: true }).click();

  await placeDevice(page, "End Devices", "PC", { x: 150, y: 210 });
  await placeDevice(page, "Network Devices", "L2 Switch", { x: 570, y: 260 });
  await placeDevice(page, "End Devices", "PC", { x: 900, y: 390 });
  await configurePc(page, "PC1", "192.168.40.10");
  await configurePc(page, "PC2", "192.168.40.20");
  await connectDevices(page, "PC1", "SW1", "eth0", "Gi0/1");
  await connectDevices(page, "PC2", "SW1", "eth0", "Gi0/2");
  await choosePortLabels(page, "Always");

  await expect.poll(async () => await linkFrom(page, "pc-1")).toMatchObject({
    sourceInterface: "eth0",
    targetInterface: "Gi0/1",
    sourceSide: "right",
    targetSide: "left",
  });
  expect(await visiblePortMarkers(page)).toEqual([]);

  await dragDevice(page, "pc-1", 650, 0);
  await expect.poll(async () => await linkFrom(page, "pc-1")).toMatchObject({
    sourceInterface: "eth0",
    targetInterface: "Gi0/1",
    sourceSide: "left",
    targetSide: "right",
  });

  await page.getByRole("button", { name: "Select PC1" }).click();
  await expect(page.getByRole("region", { name: "Inspector" })).toBeVisible();
  await closeInspector(page);
  await chooseBottomPanel(page, "Minimize");
  await chooseBottomPanel(page, "Show");
  await chooseIconProfile(page, "Minimal Network");
  await expect.poll(async () => await linkFrom(page, "pc-1")).toMatchObject({
    sourceSide: "left",
    targetSide: "right",
  });
  await chooseBottomPanel(page, "Minimize");
  await page.screenshot({ path: "/tmp/m10-5-1-adaptive-1440x900.png", animations: "disabled" });

  await page.getByRole("button", { name: "Start Lab" }).click();
  await expect(page.getByRole("button", { name: "Stop Lab" })).toBeVisible();
  await openCli(page, "PC1");
  await runCli(page, "ping 192.168.40.20");
  await expect(page.getByTestId("terminal-transcript")).toContainText("Success rate is 100 percent");

  await closeInspector(page);
  await dragDevice(page, "pc-1", 40, 45);
  await expect(page.getByText("Pending topology changes")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop Lab" })).toBeVisible();
  await expect.poll(async () => await linkFrom(page, "pc-1")).toMatchObject({
    sourceInterface: "eth0",
    targetInterface: "Gi0/1",
    sourceSide: "left",
    targetSide: "right",
  });
  await page.getByRole("tab", { name: /Terminal/ }).click();
  await runCli(page, "ping 192.168.40.20");
  await expect.poll(async () =>
    ((await page.getByTestId("terminal-transcript").textContent())?.match(/Success rate is 100 percent/g) ?? []).length,
  ).toBeGreaterThanOrEqual(2);
  expect(await visiblePortMarkers(page)).toEqual([]);
});

test("parallel switch links keep stable offsets through EtherChannel, resize and import", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "New Lab", exact: true }).click();
  await placeDevice(page, "Network Devices", "L2 Switch", { x: 280, y: 260 });
  await placeDevice(page, "Network Devices", "L2 Switch", { x: 820, y: 260 });
  await connectDevices(page, "SW1", "SW2", "Gi0/1", "Gi0/1");
  await connectDevices(page, "SW1", "SW2", "Gi0/2", "Gi0/2");
  await choosePortLabels(page, "Always");

  await expect.poll(async () => (await renderedLinks(page)).length).toBe(2);
  const parallel = await renderedLinks(page);
  expect(parallel.map((link) => link.parallelOffset).sort((left, right) => left - right)).toEqual([-7, 7]);
  expect(new Set(parallel.map((link) => link.path)).size).toBe(2);
  expect(parallel.map((link) => [link.sourceInterface, link.targetInterface])).toEqual([
    ["Gi0/1", "Gi0/1"],
    ["Gi0/2", "Gi0/2"],
  ]);
  await expect(page.locator(".x6-edge-label")).toHaveCount(4);

  await page.getByRole("button", { name: "Start Lab" }).click();
  for (const switchName of ["SW1", "SW2"]) {
    await openCli(page, switchName);
    for (const command of [
      "enable",
      "configure terminal",
      "interface Gi0/1",
      "channel-group 1 mode on",
      "exit",
      "interface Gi0/2",
      "channel-group 1 mode on",
      "end",
    ]) await runCli(page, command);
  }
  await runAuto(page);
  await focusTerminal(page);
  await page.getByRole("tab", { name: /SW1 terminal/ }).click();
  await runCli(page, "show etherchannel summary");
  await expect(page.getByTestId("terminal-transcript")).toContainText("Port-channel1(SU)");

  await closeInspector(page);
  await chooseBottomPanel(page, "Minimize");
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect.poll(async () =>
    (await renderedLinks(page)).map((link) => link.parallelOffset).sort((left, right) => left - right),
  ).toEqual([-7, 7]);
  await page.screenshot({ path: "/tmp/m10-5-1-parallel-1280x720.png", animations: "disabled" });
  expect(await visiblePortMarkers(page)).toEqual([]);

  await stopLab(page);
  await closeInspector(page);
  await page.locator('[data-cell-id="link-1"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete link" }).click();
  await expect.poll(async () => (await renderedLinks(page)).length).toBe(1);
  const [remaining] = await renderedLinks(page);
  expect(remaining).toMatchObject({
    id: "link-2",
    sourceInterface: "Gi0/2",
    targetInterface: "Gi0/2",
    parallelOffset: 0,
  });

  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: /Save \/ Export Lab/ }).click();
  const exported = await (await download).path();
  expect(exported).not.toBeNull();
  await page.locator("#load-lab-file").setInputFiles(exported!);
  await expect.poll(async () => await renderedLinks(page)).toEqual([remaining]);
  expect(await visiblePortMarkers(page)).toEqual([]);
});
