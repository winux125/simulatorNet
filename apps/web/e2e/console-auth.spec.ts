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
});
