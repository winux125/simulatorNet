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

test("configures a console login and gates the terminal", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await loadRouterDemo(page);
  await closeInspector(page);
  await page.getByRole("menuitem", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Theme", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Dark", exact: true }).click();

  await page.getByRole("button", { name: "Select R1" }).dblclick();
  const win = page.getByRole("dialog", { name: /R1 device window/ });
  await expect(win).toBeVisible();

  // Config → Console Access: enable Local User and add a privileged account.
  await win.getByRole("tab", { name: "Console Access" }).click();
  await expect(page.getByTestId("console-access-panel")).toBeVisible();
  await page.getByTestId("console-mode").selectOption("local-user");
  await page.getByLabel("New username").fill("admin");
  await page.getByLabel("New user password").fill("cisco123");
  await page.getByLabel("Privilege level").fill("15");
  await page.getByRole("button", { name: "Add user" }).click();
  await expect(page.getByTestId("console-users")).toContainText("admin");
  // The plaintext password is never shown back.
  await expect(page.getByTestId("console-access-panel")).not.toContainText("cisco123");

  // Open the device CLI: the login gate demands a username/password.
  await win.getByRole("tab", { name: "CLI" }).click();
  await win.getByRole("button", { name: "Open in Terminal Workspace" }).click();
  const rows = page.locator(".terminal-session.is-active .xterm-rows");
  await expect(rows).toContainText("Username:", { timeout: 15_000 });

  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.type("admin");
  await page.keyboard.press("Enter");
  await expect(rows).toContainText("Password:");
  await page.keyboard.type("cisco123");
  await page.keyboard.press("Enter");

  // A privilege-15 login reaches the privileged prompt; the password is not echoed.
  await expect(rows).toContainText("R1#", { timeout: 15_000 });
  await expect(rows).not.toContainText("cisco123");

  // Presentation changes keep the exact authenticated session and partial line.
  await page.keyboard.type("configure terminal");
  await page.keyboard.press("Enter");
  await expect(rows).toContainText("R1(config)#");
  await page.keyboard.type("interface");
  await page.getByRole("button", { name: "Float terminal" }).click();
  const terminal = page.locator(".terminal-presentation");
  await expect(terminal).toHaveAttribute("data-presentation-mode", "floating");
  await expect(rows).toContainText("R1(config)# interface");

  // A native resize changes only presentation; ResizeObserver refits xterm.
  await terminal.evaluate((element) => {
    (element as HTMLElement).style.width = "660px";
    (element as HTMLElement).style.height = "360px";
  });
  await expect.poll(async () => (await terminal.boundingBox())?.width ?? 0).toBeGreaterThan(600);
  await page.screenshot({ path: "/tmp/m10-3-2-terminal-floating-dark-1440x900.png", fullPage: true });

  await page.getByRole("button", { name: "Maximize terminal" }).click();
  await expect(terminal).toHaveAttribute("data-presentation-mode", "maximized");
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.screenshot({ path: "/tmp/m10-3-2-terminal-maximized-dark-1920x1080.png", fullPage: true });
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.press("Control+C");
  await page.keyboard.type("?");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("terminal-transcript")).toContainText("interface");

  await page.getByRole("button", { name: "Dock terminal at bottom" }).click();
  await expect(terminal).toHaveAttribute("data-presentation-mode", "docked");
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: "/tmp/m10-3-2-terminal-docked-dark-1280x720.png", fullPage: true });

  // A second device joins the same tab strip. Hiding the window preserves both.
  await closeInspector(page);
  await page.getByRole("button", { name: "Select SW1" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Open CLI/ }).click();
  await expect(page.getByRole("tab", { name: /R1 terminal/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /SW1 terminal/ })).toBeVisible();
  await page.getByRole("button", { name: "Close terminal window" }).click();
  await expect(terminal).toHaveAttribute("data-terminal-visible", "false");
  await page.getByRole("menuitem", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Terminal", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Show Terminal/ }).click();
  await expect(terminal).toHaveAttribute("data-terminal-visible", "true");
  await expect(page.getByRole("tab", { name: /R1 terminal/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /SW1 terminal/ })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("menuitem", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Theme", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Light", exact: true }).click();
  await page.screenshot({ path: "/tmp/m10-3-2-terminal-docked-light-1440x900.png", fullPage: true });

  // Stopping and deleting an unrelated node does not touch either session.
  await page.getByRole("button", { name: "Stop Lab" }).click();
  const stopDialog = page.getByRole("dialog", { name: "Stop this lab?" });
  if (await stopDialog.isVisible().catch(() => false)) {
    await stopDialog.getByRole("button", { name: "Stop Lab" }).click();
  }
  await expect(page.getByRole("button", { name: "Start Lab" })).toBeVisible();
  await page.getByRole("button", { name: "Select PC2" }).click();
  await page.getByRole("button", { name: "Delete selected" }).click();
  await expect(page.getByRole("button", { name: "Select PC2" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /R1 terminal/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /SW1 terminal/ })).toBeVisible();
});
