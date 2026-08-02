import { expect, test, type Page } from "@playwright/test";

async function closeInspector(page: Page) {
  const inspector = page.getByRole("region", { name: "Inspector" });
  if (await inspector.isVisible().catch(() => false)) {
    await inspector.getByRole("button", { name: "Close inspector" }).click();
  }
}

async function loadRouterDemo(page: Page) {
  await page.getByRole("menuitem", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Load Demo Lab" }).click();
  await page.getByRole("button", { name: /Router-on-a-stick \+ DHCP/ }).click();
  await expect(page.getByTestId("topology-graph")).toBeVisible();
}

async function openCli(page: Page, device: string) {
  await closeInspector(page);
  await page.getByRole("button", { name: `Select ${device}` }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Open CLI/ }).click();
}

async function chooseBottomPanel(page: Page, label: "Show" | "Minimize" | "Hide") {
  await page.getByRole("menuitem", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Bottom Panel", exact: true }).click();
  await page.getByRole("menuitemradio", { name: new RegExp(`^${label}`) }).click();
}

const canvasHeight = (page: Page) => page.locator(".main-workspace").evaluate(
  (element) => Math.round(element.getBoundingClientRect().height),
);

test("hides and minimizes the bottom panel without closing terminal sessions", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await loadRouterDemo(page);

  const panel = page.getByLabel("Workspace bottom panel", { exact: true });
  const strip = page.getByLabel("Workspace bottom panel, minimized");

  // 1. Two terminal tabs in the shared workspace.
  await openCli(page, "R1");
  const rows = page.locator(".terminal-session.is-active .xterm-rows");
  await expect(rows).toContainText("R1>", { timeout: 20_000 });
  await openCli(page, "SW1");
  await expect(page.getByRole("tab", { name: /R1 terminal/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /SW1 terminal/ })).toBeVisible();

  // 2. A partially typed command that must survive every panel change.
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.type("show mac address-");
  await expect(rows).toContainText("show mac address-");
  const expandedCanvas = await canvasHeight(page);

  // 3/4/5. Minimize: only the strip remains and the canvas grows.
  await chooseBottomPanel(page, "Minimize");
  await expect(panel).toHaveCount(0);
  await expect(strip).toBeVisible();
  await expect(strip.getByRole("tab", { name: /Terminal/ })).toBeVisible();
  const minimizedCanvas = await canvasHeight(page);
  expect(minimizedCanvas).toBeGreaterThan(expandedCanvas);
  expect(Math.round(await strip.evaluate((element) => element.getBoundingClientRect().height))).toBeLessThan(40);

  // 6/7. Expanding brings back the same tabs and the same partial input.
  await strip.getByRole("button", { name: "Expand Bottom Panel" }).click();
  await expect(panel).toBeVisible();
  await expect(page.getByRole("tab", { name: /R1 terminal/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /SW1 terminal/ })).toBeVisible();
  await expect(rows).toContainText("show mac address-");

  // 8/9/10. Hide: zero height, and the canvas takes the whole workspace.
  await panel.getByRole("button", { name: "Hide Bottom Panel" }).click();
  await expect(panel).toHaveCount(0);
  await expect(strip).toHaveCount(0);
  await expect(page.locator(".resize-handle--horizontal")).toHaveCount(0);
  const hiddenCanvas = await canvasHeight(page);
  expect(hiddenCanvas).toBeGreaterThan(minimizedCanvas);

  // 11/12. Floating the terminal keeps it usable while the panel stays hidden,
  // and the events it produces keep accumulating behind that hidden panel.
  const status = page.locator(".bottom-panel-status");
  const eventCount = async () => Number(
    (await status.getByRole("button", { name: /Events/ }).innerText()).replace(/\D+/g, ""),
  );
  await expect(status).toBeVisible();
  const eventsBefore = await eventCount();

  await page.getByRole("menuitem", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Terminal", exact: true }).click();
  await page.getByRole("menuitemradio", { name: /^Float/ }).click();
  await expect(page.locator(".terminal-presentation")).toHaveAttribute("data-presentation-mode", "floating");
  await expect(panel).toHaveCount(0);

  // The partial command survived every panel change, so finishing it works.
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.type("table");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("terminal-transcript")).toContainText("Mac Address", { timeout: 25_000 });

  await page.getByRole("tab", { name: /R1 terminal/ }).click();
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.type("ping 192.168.10.1");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("terminal-transcript")).toContainText("Success rate", { timeout: 25_000 });
  await expect.poll(eventCount).toBeGreaterThan(eventsBefore);
  // The panel stayed hidden through all of it.
  await expect(panel).toHaveCount(0);

  // 13/14. Ctrl/Cmd+J brings the panel back. Lowercase: Ctrl+Shift+J stays the
  // browser's own shortcut and is deliberately not intercepted.
  await page.keyboard.press("Control+j");
  await expect(panel).toBeVisible();
  await page.screenshot({ path: "/tmp/m10-4-1-bottom-panel-expanded-1440x900.png", fullPage: true });

  // 15. Problems opens from the collapsed status entry.
  await panel.getByRole("button", { name: "Hide Bottom Panel" }).click();
  await status.getByRole("button", { name: /Problems/ }).click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("tab", { name: /Problems/ })).toHaveAttribute("aria-selected", "true");
});

test("keeps a floating terminal and restores the panel when docking", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await loadRouterDemo(page);
  await openCli(page, "R1");
  const rows = page.locator(".terminal-session.is-active .xterm-rows");
  await expect(rows).toContainText("R1>", { timeout: 20_000 });

  const panel = page.getByLabel("Workspace bottom panel", { exact: true });
  const terminal = page.locator(".terminal-presentation");

  // 16/17/18. A floating terminal is unaffected by hiding the panel.
  await page.getByRole("button", { name: "Float terminal" }).click();
  await expect(terminal).toHaveAttribute("data-presentation-mode", "floating");
  await chooseBottomPanel(page, "Hide");
  await expect(panel).toHaveCount(0);
  await expect(terminal).toHaveAttribute("data-terminal-on-screen", "true");
  await expect(rows).toContainText("R1>");
  await page.screenshot({ path: "/tmp/m10-4-1-bottom-panel-hidden-floating-1440x900.png", fullPage: true });

  // 19. Docking the terminal expands the panel automatically.
  await page.getByRole("button", { name: "Dock terminal at bottom" }).click();
  await expect(terminal).toHaveAttribute("data-presentation-mode", "docked");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("tab", { name: /Terminal/ })).toHaveAttribute("aria-selected", "true");
  await expect(rows).toContainText("R1>");

  // 20. Resizing keeps the links attached and the terminal fitted.
  const linksBefore = await page.getByRole("button", { name: /^Select link / }).count();
  for (const size of [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }]) {
    await page.setViewportSize(size);
    await expect(page.getByTestId("topology-graph")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Select link / })).toHaveCount(linksBefore);
    await expect(rows).toContainText("R1>");
    await page.screenshot({ path: `/tmp/m10-4-1-bottom-panel-${size.width}x${size.height}.png`, fullPage: true });
  }

  // 21/22/23. The preference survives a reload and never enters the document.
  await chooseBottomPanel(page, "Minimize");
  expect(await page.evaluate(() => localStorage.getItem("simulatornet.bottomPanelState"))).toBe("minimized");
  await page.reload();
  expect(await page.evaluate(() => localStorage.getItem("simulatornet.bottomPanelState"))).toBe("minimized");
  await loadRouterDemo(page);
  await expect(page.getByLabel("Workspace bottom panel, minimized")).toBeVisible();
  await expect(panel).toHaveCount(0);

  // The exported LabDocument carries no panel, terminal or session state. The
  // ordinary Save writes a `.simlab` package, so the canonical JSON is read
  // through File ▸ Advanced — the only place it is still exposed.
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Advanced/ }).click();
  await page.getByRole("menuitem", { name: /Export Lab JSON/ }).click();
  await page.getByRole("button", { name: "Export JSON" }).click();
  const exported = await (await download).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of exported) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  const document = JSON.parse(text) as Record<string, unknown>;
  expect(Object.keys(document)).not.toContain("bottomPanelState");
  for (const forbidden of ["bottomPanel", "terminalPresentation", "dockTab", "scrollback", "confirmMultilinePaste"]) {
    expect(text).not.toContain(forbidden);
  }
});
