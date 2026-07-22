import { expect, test } from "@playwright/test";

test("M8.3 desktop menus drive the browser lab with an xterm-native CLI", async ({ page }) => {
  const menu = (label: string) => page.getByRole("menuitem", { name: label, exact: true });
  const theme = page.getByLabel("Color theme");
  const shell = page.locator(".app-shell");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  // 1. Welcome workspace.
  await expect(page.getByRole("heading", { name: "SimulatorNet" })).toBeVisible();
  await expect(theme).toHaveValue("system");

  // 2. File → Load Demo Lab.
  await menu("File").click();
  await page.getByRole("menuitem", { name: "Load Demo Lab" }).click();
  await expect(page.getByText("VLAN Routing Lab", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".react-flow__minimap")).toHaveCount(0);

  // 3. Lab menu → toggle Edit then Simulate mode.
  await menu("Lab").click();
  await page.getByRole("menuitemradio", { name: "Edit Mode" }).click();
  await expect(shell).toHaveAttribute("data-workspace-mode", "edit");
  await menu("Lab").click();
  await page.getByRole("menuitemradio", { name: "Simulate Mode" }).click();
  await expect(shell).toHaveAttribute("data-workspace-mode", "simulate");

  // 4. Device context menu → open the PC terminal.
  await page.getByRole("button", { name: "Select PC1" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Open CLI/ }).click();
  await expect(page.getByRole("tab", { name: /PC1/ })).toBeVisible();
  await expect(page.getByText("PC1 connected")).toBeVisible();

  // 5-7. Type directly into xterm, repair the octet with ArrowLeft + Backspace, run.
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.type("ping 192.168.20.100");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("terminal-transcript")).toContainText("ping 192.168.20.10");
  await expect(page.getByTestId("terminal-transcript")).toContainText("Success rate is 100 percent");

  // 8. View menu → hide and restore the Inspector.
  await menu("View").click();
  await page.getByRole("menuitem", { name: "Hide Inspector" }).click();
  await expect(page.locator(".inspector-panel")).toHaveCount(0);
  await menu("View").click();
  await page.getByRole("menuitem", { name: "Show Inspector" }).click();
  await expect(page.locator(".inspector-panel").first()).toBeVisible();

  // 9. Simulation menu → Run Until Idle.
  await menu("Simulation").click();
  await page.getByRole("menuitem", { name: /Run Until Idle/ }).click();

  // 10. File menu → export the canonical lab (browser download).
  const download = page.waitForEvent("download");
  await menu("File").click();
  await page.getByRole("menuitem", { name: /Save \/ Export Lab/ }).click();
  expect((await download).suggestedFilename()).toContain(".json");

  // Dark/light review screenshots.
  await theme.selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: "/tmp/m8-3-dark-1440x900.png", animations: "disabled" });
  await theme.selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: "/tmp/m8-3-light-1440x900.png", animations: "disabled" });
});

test("M8 launch exchange strips the code and exposes organization session controls", async ({ page }) => {
  const launchCode = "launch-secret-that-must-disappear";
  await page.route("**/v1/session/launch-exchange", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ code: launchCode });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "set-cookie": "simulatornet_session=opaque; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800" },
      body: JSON.stringify({
        user: { id: "user-1", displayName: "KAI Student" },
        organization: { id: "org-1", name: "KAI Development" },
        role: "student",
        returnUrl: "https://academy.kai.kz/course/ccna",
      }),
    });
  });
  await page.route("**/v1/session/logout", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ loggedOut: true }) }));

  await page.goto(`/launch?code=${launchCode}`);
  await expect(page).toHaveURL("http://127.0.0.1:4173/");
  await expect(page.getByLabel("Authenticated organization session")).toContainText("KAI Student");
  await expect(page.getByLabel("Authenticated organization session")).toContainText("KAI Development");
  expect(page.url()).not.toContain(launchCode);
  await page.getByLabel("Log out organization session").click();
  await expect(page.getByText("Anonymous", { exact: true })).toBeVisible();
  await expect(page.getByText("Local Lab", { exact: true })).toBeVisible();
});
