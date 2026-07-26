import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// M10.3.3b — diagram text is edited directly on the canvas. No step of this
// flow may open a modal window.

const TEXT_EDITOR = { name: "Editing topology text" } as const;

async function expectNoModal(page: Page) {
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".dialog-backdrop")).toHaveCount(0);
}

/** Canvas-relative position, so clicks never land on the dock or a separator. */
async function canvasPoint(page: Page, fractionX: number, fractionY: number) {
  const bounds = await page.getByTestId("topology-graph").boundingBox();
  if (!bounds) throw new Error("topology canvas is not laid out");
  return { x: Math.round(bounds.width * fractionX), y: Math.round(bounds.height * fractionY) };
}

test("M10.3.3b inline text editing never opens a modal and survives a running lab", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  // 1-2. Create a lab and choose the Text tool.
  await page.getByRole("button", { name: "New Lab", exact: true }).click();
  const canvas = page.getByTestId("topology-graph");
  await page.getByRole("button", { name: "Text", exact: true }).click();

  // 3-4. Click the canvas: the caret appears in place, with no dialog.
  await canvas.click({ position: await canvasPoint(page, 0.25, 0.3) });
  const editor = page.getByRole("textbox", TEXT_EDITOR);
  await expect(editor).toBeFocused();
  await expectNoModal(page);
  expect(await editor.evaluate((element) => element.closest("[role='dialog']") !== null)).toBe(false);

  // 5. Type multiline text.
  await page.keyboard.type("Distribution layer");
  await page.keyboard.press("Enter");
  await page.keyboard.type("VLAN 10, 20, 30");
  await expect(editor).toHaveValue("Distribution layer\nVLAN 10, 20, 30");

  // 6. Apply bold and a larger font size while still typing.
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Size", exact: true }).fill("22");
  await expect(page.getByRole("textbox", TEXT_EDITOR)).toHaveValue("Distribution layer\nVLAN 10, 20, 30");
  await expectNoModal(page);

  // 7. Ctrl+Enter commits.
  await page.getByRole("textbox", TEXT_EDITOR).press("Control+Enter");
  await expect(page.getByRole("textbox", TEXT_EDITOR)).toHaveCount(0);
  const annotation = page.locator('[data-cell-id="diagram:annotation-1"]');
  await expect(annotation).toContainText("Distribution layer");

  // 8-9. Double-click reopens the editor in place; Escape rolls the edit back.
  await annotation.dblclick();
  await expect(page.getByRole("textbox", TEXT_EDITOR)).toBeVisible();
  await expectNoModal(page);
  await page.getByRole("textbox", TEXT_EDITOR).fill("Discarded edit");
  await page.getByRole("textbox", TEXT_EDITOR).press("Escape");
  await expect(page.getByRole("textbox", TEXT_EDITOR)).toHaveCount(0);
  await expect(annotation).toContainText("Distribution layer");
  await expect(annotation).not.toContainText("Discarded edit");

  // 10. Editing again and clicking outside commits.
  await annotation.dblclick();
  await page.getByRole("textbox", TEXT_EDITOR).fill("Committed by blur");
  await canvas.click({ position: await canvasPoint(page, 0.8, 0.35) });
  await expect(page.getByRole("textbox", TEXT_EDITOR)).toHaveCount(0);
  await expect(annotation).toContainText("Committed by blur");

  // 11. Undo treats the whole session as one operation.
  await page.keyboard.press("Control+z");
  await expect(annotation).toContainText("Distribution layer");
  await page.keyboard.press("Control+Shift+z");
  await expect(annotation).toContainText("Committed by blur");

  // 12. The editor follows the canvas transform. Select first so the
  // contextual formatting toolbar is already laid out before the double-click.
  await annotation.click();
  await expect(page.getByLabel("Annotation formatting")).toBeVisible();
  await annotation.dblclick();
  const before = await page.getByRole("textbox", TEXT_EDITOR).boundingBox();
  await canvas.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: 90, deltaX: 60, bubbles: true, cancelable: true }));
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const after = await page.getByRole("textbox", TEXT_EDITOR).boundingBox();
  expect(after!.x).toBeCloseTo(before!.x - 60, 0);
  expect(after!.y).toBeCloseTo(before!.y - 90, 0);
  await page.getByRole("textbox", TEXT_EDITOR).press("Escape");
  await page.screenshot({ path: "/tmp/m10-3-3b-inline-text-1440x900.png", animations: "disabled" });

  // 13-15. Start the lab and confirm text editing still works and keeps runtime.
  await page.getByRole("button", { name: "Add Device", exact: true }).click();
  await page.getByRole("tab", { name: "End Devices" }).click();
  await page.getByRole("button", { name: "Add PC" }).click();
  await canvas.click({ position: await canvasPoint(page, 0.2, 0.7) });
  await page.getByRole("button", { name: "Start Lab" }).click();
  await expect(page.getByRole("button", { name: "Stop Lab" })).toBeVisible();

  await page.getByRole("button", { name: "Text", exact: true }).click();
  await canvas.click({ position: await canvasPoint(page, 0.6, 0.7) });
  await expectNoModal(page);
  await page.keyboard.type("Edited while running");
  await page.getByRole("textbox", TEXT_EDITOR).press("Control+Enter");
  await expect(page.locator('[data-cell-id="diagram:annotation-2"]')).toContainText("Edited while running");
  // Presentation-only: no rebuild is pending and the lab keeps running.
  await expect(page.locator(".pending-banner")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop Lab" })).toBeVisible();

  // 16-17. Export and re-import preserve the text and its style.
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: /Save \/ Export Lab/ }).click();
  const exported = await (await downloadPromise).path();
  expect(exported).not.toBeNull();
  await page.locator("#load-lab-file").setInputFiles(exported!);
  await expect(page.locator('[data-cell-id="diagram:annotation-1"]')).toContainText("Committed by blur");
  await expect(page.locator('[data-cell-id="diagram:annotation-2"]')).toContainText("Edited while running");
});

test("M10.3.3b inline editing owns its own keyboard and clipboard", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await page.getByRole("button", { name: "New Lab", exact: true }).click();
  const canvas = page.getByTestId("topology-graph");

  // 1. Place a device so a stray global Delete would be observable.
  await page.getByRole("button", { name: "Add Device", exact: true }).click();
  await page.getByRole("tab", { name: "End Devices" }).click();
  await page.getByRole("button", { name: "Add PC" }).click();
  await canvas.click({ position: await canvasPoint(page, 0.2, 0.3) });
  await expect(page.locator(".canvas-statusbar").getByText("1 devices", { exact: true })).toBeVisible();

  // 2. Open an inline editor and press keys that are global shortcuts.
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await canvas.click({ position: await canvasPoint(page, 0.55, 0.35) });
  await page.keyboard.type("Keeps focus");
  await page.keyboard.press("Delete");
  await page.keyboard.press("f");
  await expect(page.getByRole("textbox", TEXT_EDITOR)).toBeVisible();
  await expect(page.locator(".canvas-statusbar").getByText("1 devices", { exact: true })).toBeVisible();

  // 3. Pasting uses text/plain only; clipboard HTML is discarded.
  await page.getByRole("textbox", TEXT_EDITOR).evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "Plain\r\npaste");
    transfer.setData("text/html", "<b>Rich paste</b>");
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
  });
  await expect(page.getByRole("textbox", TEXT_EDITOR)).toHaveValue(/Plain\npaste/);
  await page.getByRole("textbox", TEXT_EDITOR).press("Control+Enter");
  const annotation = page.locator('[data-cell-id="diagram:annotation-1"]');
  await expect(annotation).toContainText("Plain");
  expect(await annotation.evaluate((element) => element.querySelector("b") !== null)).toBe(false);

  // 4. Wheel over the editor never scrolls the page or pans the canvas.
  await annotation.dblclick();
  const canvasBefore = await annotation.boundingBox();
  await page.getByRole("textbox", TEXT_EDITOR).evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: 300, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))).toEqual({ x: 0, y: 0 });
  await page.getByRole("textbox", TEXT_EDITOR).press("Escape");
  const canvasAfter = await annotation.boundingBox();
  expect(canvasAfter!.y).toBeCloseTo(canvasBefore!.y, 0);
  await page.screenshot({ path: "/tmp/m10-3-3b-inline-text-1280x720.png", animations: "disabled" });
});
