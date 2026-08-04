import { expect, test, type Page } from "@playwright/test";
import { openDeviceCli } from "./helpers/device-window";

function denseSwitchLab() {
  const pcPositions = [
    ...Array.from({ length: 5 }, (_, index) => ({ x: 80, y: 40 + index * 120 })),
    ...Array.from({ length: 5 }, (_, index) => ({ x: 1120, y: 40 + index * 120 })),
    ...Array.from({ length: 5 }, (_, index) => ({ x: 260 + index * 170, y: 10 })),
    ...Array.from({ length: 5 }, (_, index) => ({ x: 260 + index * 170, y: 680 })),
  ];
  const pcs = pcPositions.map((position, index) => ({
    id: `pc-${index + 1}`,
    kind: "pc" as const,
    name: `PC${index + 1}`,
    position,
    interfaces: [{ id: "eth0" }],
  }));
  const switchInterfaces = [
    ...Array.from({ length: 24 }, (_, index) => ({ id: `Fa0/${index + 1}` })),
    { id: "Gi0/1" },
    { id: "Gi0/2" },
  ];
  return {
    schemaVersion: 1,
    id: "dense-access-switch",
    title: "Dense Access Switch",
    simulation: { seed: 1092 },
    topology: {
      schemaVersion: 1,
      nodes: [
        ...pcs,
        { id: "server-1", kind: "server" as const, name: "SRV1", position: { x: 600, y: 130 }, interfaces: [{ id: "eth0" }, { id: "eth1" }] },
        { id: "switch-1", kind: "l2-switch" as const, name: "SW-ACCESS", hardwareProfileId: "access-24" as const, position: { x: 600, y: 350 }, interfaces: switchInterfaces },
      ],
      links: [
        ...pcs.map((pc, index) => ({
          id: `link-${String(index + 1).padStart(2, "0")}`,
          a: { node: pc.id, iface: "eth0" },
          b: { node: "switch-1", iface: `Fa0/${index + 1}` },
        })),
        { id: "link-21", a: { node: "server-1", iface: "eth0" }, b: { node: "switch-1", iface: "Fa0/21" } },
      ],
    },
    configurations: {
      ...Object.fromEntries(pcs.map((pc, index) => [pc.id, {
        kind: "pc",
        hostname: pc.name,
        interfaces: [],
        ipv4: { address: `10.90.0.${index + 10}`, prefixLength: 24 },
        dhcpEnabled: false,
      }])),
      "server-1": {
        kind: "server",
        hostname: "SRV1",
        interfaces: [{ id: "eth0", shutdown: false, ipv4: { address: "10.90.0.5", prefixLength: 24 } }],
        dhcpClientEnabled: false,
        enabledServices: [],
      },
      "switch-1": { kind: "l2-switch", hostname: "SW-ACCESS", interfaces: [], vlans: [] },
    },
  };
}

async function closeInspector(page: Page) {
  const inspector = page.getByRole("region", { name: "Inspector" });
  if (await inspector.isVisible().catch(() => false)) {
    await inspector.getByRole("button", { name: "Close inspector" }).click();
  }
}

async function chooseIconProfile(page: Page, profile: "Classic Lab" | "Education Flat" | "Minimal Network") {
  await page.getByRole("menuitem", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Device Icon Style", exact: true }).click();
  await page.getByRole("menuitemradio", { name: profile, exact: true }).click();
}

async function choosePortLabels(page: Page, mode: "Always" | "Selected" | "Hidden") {
  await page.getByRole("menuitem", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Port Labels", exact: true }).click();
  await page.getByRole("menuitemradio", { name: mode, exact: true }).click();
}

async function switchEndpointKeys(page: Page): Promise<string[]> {
  return page.locator('.x6-edge [data-target-device="switch-1"]').evaluateAll((lines) => lines.map((line) => (
    `${line.getAttribute("data-target-side")}:${line.getAttribute("data-target-offset")}`
  )));
}

async function dragDevice(page: Page, deviceId: string, dx: number, dy: number) {
  const node = page.locator(`[data-device-id="${deviceId}"]`).locator("xpath=ancestor::*[contains(@class,'x6-node')]");
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
  await openDeviceCli(page, hostname);
}

async function runCli(page: Page, command: string) {
  await page.getByRole("tab", { name: /^Terminal/ }).first().click();
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

async function visiblePortMarkers(page: Page) {
  return page.locator(".topology-graph [port]").evaluateAll((ports) => ports.filter((port) => {
    const shape = port.matches("circle, rect, path, ellipse") ? port : port.querySelector("circle, rect, path, ellipse");
    if (!shape) return false;
    const style = window.getComputedStyle(shape);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0
      && style.fill !== "none" && style.fill !== "transparent";
  }).map((port) => port.getAttribute("port")));
}

test("access-24 keeps twenty-one endpoint links distinct through movement, runtime and round-trip", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator("#load-lab-file").setInputFiles({
    name: "dense-access-switch.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(denseSwitchLab())),
  });
  await expect(page.getByText("Dense Access Switch", { exact: true }).first()).toBeVisible();
  await closeInspector(page);
  await page.getByRole("button", { name: "Fit topology" }).click();

  await expect.poll(async () => page.locator('.x6-edge [data-target-device="switch-1"]').count()).toBe(21);
  await expect.poll(async () => new Set(await switchEndpointKeys(page)).size).toBe(21);
  expect(await visiblePortMarkers(page)).toEqual([]);

  await dragDevice(page, "pc-1", 60, 45);
  await expect.poll(async () => new Set(await switchEndpointKeys(page)).size).toBe(21);
  for (const profile of ["Education Flat", "Minimal Network", "Classic Lab"] as const) {
    await chooseIconProfile(page, profile);
    await expect.poll(async () => new Set(await switchEndpointKeys(page)).size).toBe(21);
  }
  await choosePortLabels(page, "Selected");
  await closeInspector(page);
  await page.screenshot({ path: testInfo.outputPath("dense-switch-1440x900.png"), animations: "disabled" });

  const startLab = page.getByRole("button", { name: "Start Lab" });
  if (await startLab.count()) await startLab.click();
  await expect(page.getByRole("button", { name: "Stop Lab" })).toBeVisible();
  await openCli(page, "PC1");
  await runCli(page, "ping 10.90.0.29");
  await expect(page.getByTestId("terminal-transcript")).toContainText("Success rate is 100 percent");
  await closeInspector(page);
  await dragDevice(page, "switch-1", 35, 25);
  await expect(page.getByText("Pending topology changes")).toHaveCount(0);
  await expect.poll(async () => new Set(await switchEndpointKeys(page)).size).toBe(21);
  await runCli(page, "ping 10.90.0.29");
  await expect.poll(async () => ((await page.getByTestId("terminal-transcript").textContent())?.match(/Success rate is 100 percent/g) ?? []).length)
    .toBeGreaterThanOrEqual(2);

  await page.getByRole("button", { name: "Stop Lab" }).click();
  const stopDialog = page.getByRole("dialog", { name: "Stop this lab?" });
  if (await stopDialog.count()) await stopDialog.getByRole("button", { name: "Stop Lab" }).click();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: "Fit topology" }).click();
  await page.screenshot({ path: testInfo.outputPath("dense-switch-1280x720.png"), animations: "disabled" });

  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Save Lab(?! As)/ }).click();
  const exported = await (await download).path();
  expect(exported).not.toBeNull();
  await page.locator("#load-lab-file").setInputFiles(exported!);
  await expect.poll(async () => new Set(await switchEndpointKeys(page)).size).toBe(21);
  await closeInspector(page);
  await page.getByRole("button", { name: "Select SW-ACCESS" }).dblclick();
  const deviceWindow = page.getByRole("dialog", { name: "SW-ACCESS device window" });
  await deviceWindow.getByRole("tab", { name: "Attributes" }).click();
  await expect(deviceWindow.getByLabel("Hardware profile")).toHaveValue("access-24");
  await expect(deviceWindow.getByText("26", { exact: true })).toBeVisible();
  expect(await visiblePortMarkers(page)).toEqual([]);
});
