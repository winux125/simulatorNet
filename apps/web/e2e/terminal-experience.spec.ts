import { expect, test, type Page } from "@playwright/test";

async function closeInspector(page: Page) {
  const inspector = page.getByRole("region", { name: "Inspector" });
  if (await inspector.isVisible().catch(() => false)) {
    await inspector.getByRole("button", { name: "Close inspector" }).click();
  }
}

async function chooseAppearance(page: Page, name: string) {
  await page.getByRole("menuitem", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Terminal Appearance", exact: true }).click();
  await page.getByRole("menuitemradio", { name, exact: true }).click();
}

test("switches terminal appearance and shows contextual help", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("menuitem", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Load Demo Lab" }).click();
  await page.getByRole("button", { name: /Router-on-a-stick \+ DHCP/ }).click();
  await expect(page.getByTestId("topology-graph")).toBeVisible();

  // View → Terminal Appearance persists locally (never in the LabDocument).
  await chooseAppearance(page, "Light Console");
  expect(await page.evaluate(() => localStorage.getItem("simulatornet.terminalAppearance"))).toBe("light");

  // Open R1 CLI and confirm `?` lists implemented commands.
  await closeInspector(page);
  await page.getByRole("button", { name: "Select R1" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Open CLI/ }).click();
  const rows = page.locator(".terminal-session.is-active .xterm-rows");
  await expect(rows).toContainText("R1>", { timeout: 15_000 });

  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.type("?");
  await page.keyboard.press("Enter");
  // Assert against the full transcript: long help scrolls the earliest lines out
  // of the visible viewport, but every listed command is recorded.
  const transcript = page.getByTestId("terminal-transcript");
  await expect(transcript).toContainText("ping");
  await expect(transcript).toContainText("show");

  // The default Appliance Console profile is selectable too.
  await chooseAppearance(page, "Appliance Console");
  expect(await page.evaluate(() => localStorage.getItem("simulatornet.terminalAppearance"))).toBe("appliance");
});
