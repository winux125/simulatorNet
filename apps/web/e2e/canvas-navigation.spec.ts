import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// M10.3.3a — trackpad navigation over the topology canvas.
//
// Synthetic WheelEvents are used for the measured assertions so deltaX/deltaY
// are exact; one real `mouse.wheel` confirms a trusted event behaves the same
// and never scrolls the page.

async function chooseDemo(page: Page, name: RegExp) {
  await page.getByRole("button", { name: "Load Demo Lab", exact: true }).click();
  await page.getByRole("button", { name }).click();
}

async function wheelOverCanvas(
  page: Page,
  init: { deltaX?: number; deltaY?: number; ctrlKey?: boolean; shiftKey?: boolean; clientX?: number; clientY?: number },
) {
  await page.locator(".topology-graph").evaluate((element, detail) => {
    const bounds = element.getBoundingClientRect();
    element.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaX: detail.deltaX ?? 0,
      deltaY: detail.deltaY ?? 0,
      ctrlKey: detail.ctrlKey ?? false,
      shiftKey: detail.shiftKey ?? false,
      clientX: detail.clientX ?? bounds.left + bounds.width / 2,
      clientY: detail.clientY ?? bounds.top + bounds.height / 2,
    }));
  }, init);
  // The controller batches wheel input into one animation frame.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function deviceBoxes(page: Page) {
  return page.locator(".topology-graph .x6-node[data-cell-id]").evaluateAll((nodes) => nodes.map((node) => {
    const bounds = node.getBoundingClientRect();
    return {
      id: node.getAttribute("data-cell-id") ?? "",
      x: Math.round(bounds.left * 100) / 100,
      y: Math.round(bounds.top * 100) / 100,
      width: Math.round(bounds.width * 100) / 100,
    };
  }).filter((node) => node.width > 0).sort((a, b) => a.id.localeCompare(b.id)));
}

async function pageScrollState(page: Page) {
  return page.evaluate(() => ({
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    bodyOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    bodyOverflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    // A real scrollbar needs both scrollable overflow and overflowing content;
    // clipped (overflow: hidden) X6 node content is not a scroll container.
    canvasScrollbars: [...document.querySelectorAll(".topology-graph, .topology-graph *")]
      .filter((element) => {
        const style = window.getComputedStyle(element);
        const scrollable = (axis: string) => axis === "auto" || axis === "scroll";
        return (scrollable(style.overflowY) && element.scrollHeight - element.clientHeight > 1)
          || (scrollable(style.overflowX) && element.scrollWidth - element.clientWidth > 1);
      })
      .length,
  }));
}

test("M10.3.3a trackpad gestures pan freely and pinch zooms gently", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await chooseDemo(page, /Large Campus Topology/);
  await page.getByRole("button", { name: "Fit topology" }).click();
  await expect(page.locator(".canvas-statusbar").getByText("13 devices", { exact: true })).toBeVisible();
  await page.waitForTimeout(250);

  // 1-2. Record where every device is drawn before any navigation.
  const initial = await deviceBoxes(page);
  expect(initial.length).toBeGreaterThan(5);

  // 3. Two-finger vertical gesture moves all topology content vertically.
  await wheelOverCanvas(page, { deltaY: 120 });
  const afterVertical = await deviceBoxes(page);
  expect(afterVertical.map((node) => node.id)).toEqual(initial.map((node) => node.id));
  for (const [index, node] of afterVertical.entries()) {
    expect(node.y).toBeCloseTo(initial[index]!.y - 120, 0);
    expect(node.x).toBeCloseTo(initial[index]!.x, 0);
  }

  // 4. Horizontal deltaX pans horizontally without Shift or any modifier.
  await wheelOverCanvas(page, { deltaX: 150 });
  const afterHorizontal = await deviceBoxes(page);
  for (const [index, node] of afterHorizontal.entries()) {
    expect(node.x).toBeCloseTo(initial[index]!.x - 150, 0);
    expect(node.y).toBeCloseTo(initial[index]!.y - 120, 0);
  }

  // 5. A diagonal gesture moves both axes at once.
  await wheelOverCanvas(page, { deltaX: -50, deltaY: -70 });
  const afterDiagonal = await deviceBoxes(page);
  for (const [index, node] of afterDiagonal.entries()) {
    expect(node.x).toBeCloseTo(initial[index]!.x - 100, 0);
    expect(node.y).toBeCloseTo(initial[index]!.y - 50, 0);
  }

  // 6. Panning never changed the scale.
  expect(afterDiagonal.map((node) => node.width)).toEqual(initial.map((node) => node.width));
  const zoomControl = page.locator(".canvas-statusbar__zoom");
  const zoomPercent = async () => Number(/(\d+)%/.exec((await zoomControl.textContent()) ?? "")?.[1] ?? "0");
  const zoomBeforePinch = await zoomPercent();
  expect(zoomBeforePinch).toBeGreaterThan(0);

  // 7-8. Ctrl+wheel zooms gently and keeps the world point under the pointer.
  const anchor = afterDiagonal[0]!;
  const pointer = { x: anchor.x + anchor.width / 2, y: anchor.y + 10 };
  await wheelOverCanvas(page, { deltaY: -100, ctrlKey: true, clientX: pointer.x, clientY: pointer.y });
  const zoomed = await deviceBoxes(page);
  const zoomedAnchor = zoomed.find((node) => node.id === anchor.id)!;
  // 1.05 exactly — gentle, not the old 1.2 jump.
  expect(zoomedAnchor.width / anchor.width).toBeGreaterThan(1.03);
  expect(zoomedAnchor.width / anchor.width).toBeLessThan(1.07);
  expect(zoomedAnchor.x + zoomedAnchor.width / 2).toBeCloseTo(pointer.x, 0);
  await expect.poll(zoomPercent).toBeGreaterThan(zoomBeforePinch);
  // One 100px pinch is a single gentle 5% step, not a 20% jump.
  expect(await zoomPercent()).toBeLessThanOrEqual(Math.round(zoomBeforePinch * 1.07));

  // 9. A real trusted wheel behaves identically and never scrolls the page.
  await page.mouse.move(pointer.x, Math.max(pointer.y, 200));
  await page.mouse.wheel(0, 240);
  await page.waitForTimeout(120);
  expect(await pageScrollState(page)).toMatchObject({
    scrollX: 0,
    scrollY: 0,
    bodyOverflowX: 0,
    canvasScrollbars: 0,
  });

  // 10. Reset Zoom returns to exactly 100% and is not a fit.
  await zoomControl.click();
  await expect(zoomControl).toContainText("100%");
  await page.screenshot({ path: "/tmp/m10-3-3a-trackpad-1440x900.png", animations: "disabled" });
});

test("M10.3.3a canvas navigation coexists with terminal, panels and small viewports", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await chooseDemo(page, /Router-on-a-stick \+ DHCP/);
  await page.getByRole("button", { name: "Fit topology" }).click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: "/tmp/m10-3-3a-navigation-1920x1080.png", animations: "disabled" });

  // 1. Open a CLI so the shared terminal owns its own scrolling.
  await page.getByRole("button", { name: "Select SW1" }).click();
  const inspector = page.getByRole("region", { name: "Inspector" });
  await inspector.getByRole("button", { name: /Open CLI/ }).click();
  await expect(page.getByRole("tab", { name: /SW1/ })).toBeVisible();
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  for (const command of ["show mac address-table", "show interfaces", "show vlan brief"]) {
    await page.keyboard.type(command);
    await page.keyboard.press("Enter");
  }

  const beforeTerminalWheel = await deviceBoxes(page);
  await page.locator(".terminal-session.is-active .xterm-viewport").evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(150);
  // 2. Scrolling the terminal never moves the canvas.
  expect(await deviceBoxes(page)).toEqual(beforeTerminalWheel);

  // 3. Toggling the inspector resizes the canvas without changing the viewport.
  await wheelOverCanvas(page, { deltaX: 60, deltaY: 40 });
  const panned = await deviceBoxes(page);
  const zoomLabel = await page.locator(".canvas-statusbar__zoom").textContent();
  await inspector.getByRole("button", { name: "Close inspector" }).click();
  await page.waitForTimeout(250);
  expect(await page.locator(".canvas-statusbar__zoom").textContent()).toBe(zoomLabel);
  const afterInspector = await deviceBoxes(page);
  for (const [index, node] of afterInspector.entries()) {
    expect(node.width).toBeCloseTo(panned[index]!.width, 1);
  }

  // 4. Navigation stays usable at the smallest supported desktop viewport.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(250);
  const beforeSmall = await deviceBoxes(page);
  await wheelOverCanvas(page, { deltaX: -40, deltaY: -30 });
  const afterSmall = await deviceBoxes(page);
  for (const [index, node] of afterSmall.entries()) {
    expect(node.x).toBeCloseTo(beforeSmall[index]!.x + 40, 0);
    expect(node.y).toBeCloseTo(beforeSmall[index]!.y + 30, 0);
  }
  expect(await pageScrollState(page)).toMatchObject({ scrollX: 0, scrollY: 0, canvasScrollbars: 0 });

  // 5. Shift+wheel on a classic mouse pans horizontally; Ctrl+wheel still zooms.
  const beforeShift = await deviceBoxes(page);
  await wheelOverCanvas(page, { deltaY: 100, shiftKey: true });
  const afterShift = await deviceBoxes(page);
  for (const [index, node] of afterShift.entries()) {
    expect(node.x).toBeCloseTo(beforeShift[index]!.x - 100, 0);
    expect(node.y).toBeCloseTo(beforeShift[index]!.y, 0);
  }

  // 6. Nothing about the lab document or runtime changed while navigating.
  await expect(page.locator(".pending-banner")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop Lab" })).toBeVisible();
  await page.screenshot({ path: "/tmp/m10-3-3a-navigation-1280x720.png", animations: "disabled" });
});
