import { expect, test } from "@playwright/test";

test("M6.1 welcome, themes and CLI guidance remain a complete browser workflow", async ({ page }) => {
  const commandInput = () => page.locator('input[aria-label="CLI command"]:visible');
  const sendCommand = () => page.locator(".terminal-command button:visible");
  const theme = page.getByLabel("Color theme");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "SimulatorNet" })).toBeVisible();
  await expect(page.getByText("Create and test deterministic network topologies directly in your browser.")).toBeVisible();
  await expect(theme).toHaveValue("system");

  await theme.selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await theme.selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.getByRole("button", { name: "Load Demo Lab", exact: true }).click();
  await expect(page.getByText("VLAN Routing Lab", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".react-flow__minimap")).toHaveCount(0);
  await page.getByLabel("Simulation toolbar").getByLabel("Fit topology").click();

  await page.getByRole("button", { name: "Select PC1" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Open CLI/ }).click();
  await expect(page.getByRole("tab", { name: /PC1/ })).toBeVisible();
  await commandInput().fill("ping");
  await sendCommand().click();
  await expect(page.getByTestId("terminal-transcript")).toContainText("% Incomplete command.");
  await expect(page.getByTestId("terminal-transcript")).toContainText("Usage: ping <destination-ip>");

  await commandInput().fill("ping 192.168.20.10");
  await sendCommand().click();
  await expect(page.getByTestId("terminal-transcript")).toContainText("Success rate is 100 percent");

  await theme.selectOption("dark");
  await page.screenshot({ path: "/tmp/m6-1-dark-1440x900.png", animations: "disabled" });
  await theme.selectOption("light");
  await page.screenshot({ path: "/tmp/m6-1-light-1440x900.png", animations: "disabled" });

  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.locator("body")).toHaveJSProperty("scrollHeight", 720);
  await page.getByLabel("Simulation toolbar").getByLabel("Fit topology").click();
  await expect.poll(async () => {
    const canvas = await page.locator(".topology-panel").boundingBox();
    const router = await page.locator('.react-flow__node[data-id="router-1"]').boundingBox();
    return canvas && router ? router.x + router.width <= canvas.x + canvas.width + 1 : false;
  }).toBe(true);
  await theme.selectOption("dark");
  await page.screenshot({ path: "/tmp/m6-1-dark-1280x720.png", animations: "disabled" });
  await theme.selectOption("light");
  await page.screenshot({ path: "/tmp/m6-1-light-1280x720.png", animations: "disabled" });

  await page.getByLabel("Close lab").click();
  await expect(page.getByRole("heading", { name: "SimulatorNet" })).toBeVisible();
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
  await expect(page.getByText("Anonymous Local Lab")).toBeVisible();
});
