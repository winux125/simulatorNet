import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

/**
 * M10.8.1 physical workspace. The point of this flow is that placement is
 * presentation only: it works while the lab runs, never queues Apply Topology,
 * and leaves the logical topology and a live ping untouched.
 */

async function loadServerDemo(page: Page) {
  await page.getByRole("menuitem", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Load Demo Lab" }).click();
  await page.getByRole("button", { name: /Server Connectivity/ }).click();
  await expect(page.getByTestId("topology-graph")).toBeVisible();
}

async function closeInspector(page: Page) {
  const inspector = page.getByRole("region", { name: "Inspector" });
  if (await inspector.isVisible().catch(() => false)) {
    await inspector.getByRole("button", { name: "Close inspector" }).click();
  }
}

const chooseView = (page: Page, view: "Logical" | "Physical") =>
  page.getByRole("tablist", { name: "Workspace view" }).getByRole("tab", { name: view }).click();

const addInTree = (page: Page, label: "Site" | "Room" | "Rack") =>
  page.getByRole("complementary", { name: "Physical hierarchy" })
    .getByRole("button", { name: label, exact: true })
    .last()
    .click();

async function placeInRack(page: Page, hostname: string, rack: string) {
  await page.getByRole("button", { name: `Unplaced ${hostname}` }).click();
  await page.getByLabel("Move to rack").selectOption({ label: rack });
  await expect(page.getByRole("button", { name: new RegExp(`${hostname} in ${rack} U\\d+`) })).toBeVisible();
}

test("places equipment in sites, rooms and racks without touching the logical lab", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await loadServerDemo(page);
  await closeInspector(page);

  // 1-3. Switch to Physical, then build a site, a room and a rack.
  await chooseView(page, "Physical");
  await expect(page.getByRole("region", { name: "Physical workspace" })).toBeVisible();
  await addInTree(page, "Site");
  await addInTree(page, "Room");
  await page.getByRole("button", { name: "Room 1", exact: true }).click();
  await addInTree(page, "Rack");
  await expect(page.getByRole("region", { name: "Rack Rack 1", exact: true })).toBeVisible();

  // 4-5. Rack the switch and the server; leave the PC unplaced, then place it.
  await placeInRack(page, "SW1", "Rack 1");
  await placeInRack(page, "SRV1", "Rack 1");
  const tray = page.getByRole("region", { name: "Unplaced Devices" });
  await expect(tray).toContainText("PC1");
  await page.getByRole("button", { name: "Unplaced PC1" }).click();
  await page.getByRole("button", { name: "Place in room" }).click();
  await expect(tray).toContainText("Every device has a place.");
  // Placement never queues a rebuild.
  await expect(page.getByText("Pending topology changes")).toHaveCount(0);

  // 6. Stop and start the lab; the placement survives the power cycle.
  await page.getByRole("button", { name: /Stop Lab/ }).click();
  const confirmStop = page.locator(".dialog-actions").getByRole("button", { name: "Stop Lab" });
  if (await confirmStop.isVisible().catch(() => false)) await confirmStop.click();
  await expect(page.getByRole("button", { name: /Start Lab/ })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole("button", { name: /Start Lab/ }).click();
  await expect(page.getByRole("button", { name: /Stop Lab/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: /SW1 in Rack 1 U\d+/ })).toBeVisible();

  // 7. Move a device while the lab is running — still no rebuild.
  await page.getByRole("button", { name: /SRV1 in Rack 1 U\d+/ }).click();
  await page.getByLabel("Rack units occupied").selectOption("2");
  await expect(page.getByText("Pending topology changes")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /SRV1 in Rack 1 U\d+/ })).toBeVisible();

  // 8-9. Back to Logical: the topology and a live ping are unchanged.
  await chooseView(page, "Logical");
  await expect(page.getByTestId("topology-graph")).toBeVisible();
  await expect(page.locator(".workspace-footer")).toContainText(/3 device/);
  await closeInspector(page);
  await page.getByRole("button", { name: "Select PC1" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Open CLI/ }).click();
  const session = page.locator(".terminal-session.is-active");
  await expect(session).toContainText("C:\\>", { timeout: 30_000 });
  await session.locator(".xterm-screen").click();
  await page.keyboard.type("ping 172.16.10.100");
  await page.keyboard.press("Enter");
  await expect.poll(async () => session.innerText(), { timeout: 30_000 })
    .toMatch(/Sending 5, 100-byte ICMP Echos to 172\.16\.10\.100[\s\S]*Success rate is 100 percent \(5\/5\)/);
});

test("export and import preserve physical placement", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await loadServerDemo(page);
  await closeInspector(page);

  // The default view of a lab with no physical metadata already offers one
  // Default Site and one Default Room, so a rack can be added immediately.
  await chooseView(page, "Physical");
  await addInTree(page, "Rack");
  await placeInRack(page, "SW1", "Rack 1");

  // 10. Round-trip the document through the native JSON export.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Save lab" }).click(),
  ]);
  const saved = await download.path();
  expect(saved).not.toBeNull();
  await page.locator("#load-lab-file").setInputFiles({
    name: "physical-round-trip.json",
    mimeType: "application/json",
    buffer: await readFile(saved!),
  });
  await expect(page.getByTestId("topology-graph")).toBeVisible({ timeout: 30_000 });

  await chooseView(page, "Physical");
  await expect(page.getByRole("button", { name: /SW1 in Rack 1 U\d+/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("region", { name: "Unplaced Devices" })).toContainText("PC1");
});
