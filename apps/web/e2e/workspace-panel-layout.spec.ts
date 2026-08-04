import { expect, test, type Page } from "@playwright/test";
import { openDeviceSection } from "./helpers/device-window";
import {
  LEGACY_WORKSPACE_LAYOUT_STORAGE_KEY,
  WORKSPACE_BOTTOM_PANEL_ID,
  WORKSPACE_BOTTOM_SEPARATOR_ID,
  WORKSPACE_LAYOUT_STORAGE_KEY,
  WORKSPACE_MAIN_PANEL_ID,
  WORKSPACE_PANEL_GROUP_ID,
} from "../src/features/layout/workspace-panel-layout";

async function loadQosDemo(page: Page) {
  await page.getByRole("button", { name: "Load Demo Lab", exact: true }).click();
  await page.getByRole("button", { name: /QoS: DSCP Classification/ }).click();
  await expect(page.getByTestId("topology-graph")).toBeVisible();
}

async function chooseBottomPanel(page: Page, label: "Show" | "Minimize" | "Hide") {
  await page.getByRole("menuitem", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Bottom Panel", exact: true }).click();
  await page.getByRole("menuitemradio", { name: new RegExp(`^${label}`) }).click();
}

async function panelHeight(page: Page, id: string) {
  return page.locator(`#${id}`).evaluate((element) =>
    Math.round(element.getBoundingClientRect().height));
}

async function expectWorkspaceHealthy(page: Page) {
  await expect(page.getByText("The workspace could not be rendered")).toHaveCount(0);
  await expect(page.locator(`#${WORKSPACE_PANEL_GROUP_ID}`)).toHaveCount(1);
  await expect(page.locator(`#${WORKSPACE_MAIN_PANEL_ID}`)).toHaveCount(1);
  await expect(page.locator(`#${WORKSPACE_BOTTOM_PANEL_ID}`)).toHaveCount(1);
}

async function expectNoDocumentOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    vertical: document.documentElement.scrollHeight > document.documentElement.clientHeight,
  }));
  expect(overflow).toEqual({ horizontal: false, vertical: false });
}

test("recovers stale workspace layout across Inspector, dock, reload and QoS transitions", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.addInitScript(({ legacyKey }) => {
    if (sessionStorage.getItem("workspace-layout-fixture-loaded") !== "true") {
      localStorage.setItem(legacyKey, JSON.stringify([73.333, 26.667]));
      localStorage.setItem("simulatornet.theme", "dark");
      localStorage.setItem("simulatornet.bottomPanelState", "expanded");
      localStorage.setItem("simulatornet.inspectorAutoOpen", "true");
      sessionStorage.setItem("workspace-layout-fixture-loaded", "true");
    }
  }, { legacyKey: LEGACY_WORKSPACE_LAYOUT_STORAGE_KEY });
  await page.goto("/");

  // Welcome mounts the same two registered Panels but safely collapses the
  // empty Bottom Dock. The legacy two-value array is migrated by explicit IDs.
  await expectWorkspaceHealthy(page);
  await expect.poll(() => panelHeight(page, WORKSPACE_BOTTOM_PANEL_ID)).toBeLessThanOrEqual(1);
  expect(await page.evaluate((key) => localStorage.getItem(key), LEGACY_WORKSPACE_LAYOUT_STORAGE_KEY)).toBeNull();
  const migrated = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), WORKSPACE_LAYOUT_STORAGE_KEY);
  expect(migrated).toMatchObject({
    version: 2,
    groups: {
      [WORKSPACE_PANEL_GROUP_ID]: {
        orderedPanelIds: [WORKSPACE_MAIN_PANEL_ID, WORKSPACE_BOTTOM_PANEL_ID],
      },
    },
  });
  expect(await page.evaluate(() => localStorage.getItem("simulatornet.theme"))).toBe("dark");

  await loadQosDemo(page);
  await expectWorkspaceHealthy(page);
  await expectNoDocumentOverflow(page);
  await expect(page.getByRole("region", { name: "Inspector" })).toHaveCount(0);
  await expect(page.locator(`#${WORKSPACE_BOTTOM_SEPARATOR_ID}`)).toBeVisible();
  await expect.poll(() => panelHeight(page, WORKSPACE_BOTTOM_PANEL_ID)).toBeGreaterThan(170);

  // Inspector is an overlay; opening and closing it never changes panel IDs.
  await page.getByRole("button", { name: "Select R1" }).click();
  const inspector = page.getByRole("region", { name: "Inspector" });
  await expect(inspector).toBeVisible();
  await expectWorkspaceHealthy(page);

  const separator = page.locator(`#${WORKSPACE_BOTTOM_SEPARATOR_ID}`);
  const box = await separator.boundingBox();
  expect(box).not.toBeNull();
  const beforeResize = await panelHeight(page, WORKSPACE_BOTTOM_PANEL_ID);
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2, box!.y - 55, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => panelHeight(page, WORKSPACE_BOTTOM_PANEL_ID)).toBeGreaterThan(beforeResize + 30);
  const resizedHeight = await panelHeight(page, WORKSPACE_BOTTOM_PANEL_ID);

  const storedAfterResize = await page.evaluate((key) =>
    JSON.parse(localStorage.getItem(key) ?? "null"), WORKSPACE_LAYOUT_STORAGE_KEY);
  const storedLayout = storedAfterResize.groups[WORKSPACE_PANEL_GROUP_ID].layout as Record<string, number>;
  expect(Object.keys(storedLayout)).toEqual([WORKSPACE_MAIN_PANEL_ID, WORKSPACE_BOTTOM_PANEL_ID]);
  expect(Math.abs(Object.values(storedLayout).reduce((sum, value) => sum + value, 0) - 100)).toBeLessThan(0.001);

  await inspector.getByRole("button", { name: "Close inspector" }).click();
  await expect(inspector).toHaveCount(0);
  await expectWorkspaceHealthy(page);

  await chooseBottomPanel(page, "Minimize");
  await expect(page.getByLabel("Workspace bottom panel, minimized")).toBeVisible();
  await expect(page.locator(`#${WORKSPACE_BOTTOM_SEPARATOR_ID}`)).toHaveCount(0);
  await expect.poll(() => panelHeight(page, WORKSPACE_BOTTOM_PANEL_ID)).toBeLessThanOrEqual(1);

  await chooseBottomPanel(page, "Hide");
  await expect(page.getByLabel("Workspace bottom panel, minimized")).toHaveCount(0);
  await expect.poll(() => panelHeight(page, WORKSPACE_BOTTOM_PANEL_ID)).toBeLessThanOrEqual(1);

  await chooseBottomPanel(page, "Show");
  await expect(page.getByLabel("Workspace bottom panel", { exact: true })).toBeVisible();
  await expect.poll(() => panelHeight(page, WORKSPACE_BOTTOM_PANEL_ID)).toBeGreaterThan(170);
  await expectWorkspaceHealthy(page);

  await page.reload();
  await expectWorkspaceHealthy(page);
  await loadQosDemo(page);
  await expect.poll(async () =>
    Math.abs((await panelHeight(page, WORKSPACE_BOTTOM_PANEL_ID)) - resizedHeight)).toBeLessThanOrEqual(3);
  await expectWorkspaceHealthy(page);

  // QoS device content is not a nested PanelGroup and remains usable.
  const deviceWindow = await openDeviceSection(page, {
    hostname: "R1",
    topLevel: "Config",
    section: "QoS",
  });
  await deviceWindow.getByRole("tablist", { name: "QoS sections" })
    .getByRole("tab", { name: "Classification" }).click();
  await expect(deviceWindow.getByLabel("Class maps JSON")).toBeVisible();
  await expectWorkspaceHealthy(page);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId("topology-graph")).toBeVisible();
  await expectNoDocumentOverflow(page);
  await expectWorkspaceHealthy(page);
});
