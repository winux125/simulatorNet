import { expect, test, type Page } from "@playwright/test";
import { openDeviceCli, openDeviceSection } from "./helpers/device-window";
import { WORKSPACE_BOTTOM_PANEL_ID } from "../src/features/layout/workspace-panel-layout";

/**
 * M10.17.6 — two rendered checks that a static assertion cannot make: that
 * 1280x720 is a usable desktop viewport, and that the docked terminal is
 * mostly terminal.
 */

/** A 24-port access switch: where table and rail density actually show. */
function denseSwitchLab() {
  const pcs = Array.from({ length: 6 }, (_, index) => ({
    id: `pc-${index + 1}`,
    kind: "pc" as const,
    name: `PC${index + 1}`,
    position: { x: 120 + index * 150, y: 90 },
    interfaces: [{ id: "eth0" }],
  }));
  return {
    schemaVersion: 1,
    id: "density-access-switch",
    title: "Density Access Switch",
    simulation: { seed: 1092 },
    topology: {
      schemaVersion: 1,
      nodes: [...pcs, {
        id: "switch-1",
        kind: "l2-switch" as const,
        name: "SW-ACCESS",
        hardwareProfileId: "access-24" as const,
        position: { x: 460, y: 380 },
        interfaces: [
          ...Array.from({ length: 24 }, (_, index) => ({ id: `Fa0/${index + 1}` })),
          { id: "Gi0/1" }, { id: "Gi0/2" },
        ],
      }],
      links: pcs.map((pc, index) => ({
        id: `link-${index + 1}`,
        a: { node: pc.id, iface: "eth0" },
        b: { node: "switch-1", iface: `Fa0/${index + 1}` },
      })),
    },
    configurations: {
      ...Object.fromEntries(pcs.map((pc, index) => [pc.id, {
        kind: "pc",
        hostname: pc.name,
        interfaces: [],
        ipv4: { address: `10.90.0.${index + 10}`, prefixLength: 24 },
        dhcpEnabled: false,
      }])),
      "switch-1": { kind: "l2-switch", hostname: "SW-ACCESS", interfaces: [], vlans: [] },
    },
  };
}

async function loadDenseLab(page: Page) {
  await page.goto("/");
  await page.locator("#load-lab-file").setInputFiles({
    name: "density-access-switch.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(denseSwitchLab())),
  });
  await expect(page.getByTestId("topology-graph")).toBeVisible();
  const inspector = page.getByRole("region", { name: "Inspector" });
  if (await inspector.isVisible().catch(() => false)) {
    await inspector.getByRole("button", { name: "Close inspector" }).click();
  }
}

async function documentOverflow(page: Page) {
  return page.evaluate(() => ({
    horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    vertical: document.documentElement.scrollHeight > document.documentElement.clientHeight,
  }));
}

/** Every element inside `root` that is actually scrolling. */
async function activeScrollers(page: Page, root: string) {
  return page.locator(root).first().evaluate((element) => [...element.querySelectorAll("*")]
    .filter((child) => {
      const style = getComputedStyle(child);
      return /(auto|scroll)/.test(style.overflowY) && child.scrollHeight > child.clientHeight + 2;
    })
    .map((child) => child.className.toString().split(" ")[0] ?? child.tagName));
}

test("a device window at 1280x720 keeps its section rail, one scroll region and a reachable footer", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await loadDenseLab(page);

  const dialog = await openDeviceSection(page, {
    hostname: "SW-ACCESS",
    topLevel: "Monitor",
    section: "Interfaces",
  });

  // The rail survives: 1280 is a desktop viewport, not a narrow one.
  const rail = dialog.getByRole("navigation", { name: "Monitor sections" });
  await expect(rail).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Monitor section" })).toBeHidden();

  // A dense table fills the window rather than stranding rows below a select.
  const rows = dialog.locator(".data-table tbody tr");
  await expect.poll(async () => {
    const viewport = await dialog.locator(".device-section-workspace__content").boundingBox();
    const boxes = await rows.evaluateAll((list) => list.map((row) => row.getBoundingClientRect()));
    return boxes.filter((box) => box.top >= viewport!.y - 1 && box.bottom <= viewport!.y + viewport!.height + 1).length;
  }).toBeGreaterThanOrEqual(16);

  // Exactly one scroll owner inside the window, and the page never scrolls.
  expect(await activeScrollers(page, ".device-window")).toEqual(["device-section-workspace__content"]);
  expect(await documentOverflow(page)).toEqual({ horizontal: false, vertical: false });

  // The window and its titlebar controls stay inside the viewport.
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1280);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(720);
  await expect(dialog.getByRole("button", { name: "Close device window" })).toBeVisible();
});

test("the docked terminal is mostly terminal, with no duplicated panel chrome", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await loadDenseLab(page);
  await openDeviceCli(page, "SW-ACCESS");
  await expect(page.locator(".xterm-rows")).toBeVisible();

  const panel = await page.locator(`#${WORKSPACE_BOTTOM_PANEL_ID}`).boundingBox();
  const xterm = await page.locator(".xterm-host").boundingBox();
  expect(panel).not.toBeNull();
  expect(xterm).not.toBeNull();

  // Chrome is one dock header plus one shared tab row — the docked terminal
  // has no titlebar of its own, and the session actions cost no extra row.
  await expect(page.locator(".terminal-presentation--docked .terminal-presentation__titlebar")).toBeHidden();
  const chrome = panel!.height - xterm!.height;
  expect(chrome, "dock chrome above the terminal").toBeLessThanOrEqual(60);
  expect(xterm!.height / panel!.height, "share of the panel the terminal owns").toBeGreaterThan(0.7);

  // The tab row carries the window controls and the session actions together.
  const tabRow = await page.locator(".terminal-tabs").boundingBox();
  const actions = await page.locator(".terminal-session.is-active .terminal-session__actions").boundingBox();
  expect(Math.abs(tabRow!.y - actions!.y), "actions share the tab row").toBeLessThanOrEqual(2);
  await expect(page.getByRole("button", { name: "Dock terminal at bottom" })).toBeVisible();

  // Every action stays reachable; none of them is offered twice.
  for (const label of ["Copy terminal selection", "Clear terminal (Ctrl+L)", "Close terminal window"]) {
    await expect(page.getByRole("button", { name: label })).toHaveCount(1);
  }
  // The minimized strip already carries these counts, so the status bar does not.
  await expect(page.locator(".workspace-footer button")).toHaveCount(0);
  expect(await documentOverflow(page)).toEqual({ horizontal: false, vertical: false });
});
