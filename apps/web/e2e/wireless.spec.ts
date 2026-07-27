import { expect, test, type Locator, type Page } from "@playwright/test";

async function loadWirelessDemo(page: Page, name: RegExp) {
  await page.goto("/");
  await page.getByRole("button", { name: "Load Demo Lab", exact: true }).click();
  await page.getByRole("button", { name }).click();
  await expect(page.getByRole("button", { name: "Load Demo Lab", exact: true })).toBeHidden();
  const start = page.getByRole("button", { name: "Start Lab" });
  if (await start.count()) await start.click();
  await expect(page.getByRole("button", { name: "Stop Lab" })).toBeEnabled();
}

async function closeInspector(page: Page) {
  const inspector = page.getByRole("region", { name: "Inspector" });
  if (await inspector.isVisible()) {
    await inspector.getByRole("button", { name: "Close inspector" }).click();
  }
}

async function openDevice(page: Page, hostname: string) {
  await closeInspector(page);
  await page.getByRole("button", { name: `Select ${hostname}` }).dblclick();
  const dialog = page.getByRole("dialog", { name: `${hostname} device window` });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openCli(page: Page, hostname: string) {
  await closeInspector(page);
  await page.getByRole("button", { name: `Select ${hostname}` }).click();
  const inspector = page.getByRole("region", { name: "Inspector" });
  await inspector.getByRole("button", { name: /Open CLI/ }).click();
  await expect(page.getByRole("tab", { name: new RegExp(hostname) })).toBeVisible();
}

async function runCli(page: Page, command: string) {
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

async function disconnectForgetAndScan(dialog: Locator) {
  await dialog.getByRole("button", { name: "Disconnect" }).click();
  await expect(dialog).toContainText(/Status:\s*disconnected/i);
  const forget = dialog.getByRole("button", { name: "Forget" });
  if (await forget.count()) await forget.first().click();
  await dialog.getByRole("button", { name: "Scan" }).click();
}

test("Open WLAN scans, associates, receives DHCP and reaches the wired gateway", async ({ page }) => {
  await loadWirelessDemo(page, /Open Wireless LAN/);
  const dialog = await openDevice(page, "LAPTOP1");
  await dialog.getByRole("tab", { name: "Wireless", exact: true }).click();
  await expect(dialog).toContainText(/Status:\s*associated/i);

  await disconnectForgetAndScan(dialog);
  const network = dialog.locator("tbody tr").filter({ hasText: "LAB-OPEN" });
  await expect(network).toBeVisible();
  await network.click();
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(dialog).toContainText(/Status:\s*associated/i);
  await expect(page.locator("[data-wireless-association]")).toHaveCount(1);
  await dialog.getByRole("button", { name: "Close device window" }).click();

  await openCli(page, "LAPTOP1");
  await runCli(page, "ipconfig");
  await expect(page.getByTestId("terminal-transcript")).toContainText(/192\.168\.10\.\d+/);
  await runCli(page, "ping 192.168.10.1");
  await expect(page.getByTestId("terminal-transcript")).toContainText("Success rate is 100 percent");
});

test("WPA2 rejects an incorrect key, accepts the configured key and never renders it", async ({ page }) => {
  await loadWirelessDemo(page, /WPA2 Wireless LAN/);
  const dialog = await openDevice(page, "LAPTOP1");
  await dialog.getByRole("tab", { name: "Wireless", exact: true }).click();
  await disconnectForgetAndScan(dialog);

  const network = dialog.locator("tbody tr").filter({ hasText: "SECURE-LAB" });
  await expect(network).toContainText("WPA2-Personal");
  await network.click();
  const password = dialog.locator('input[type="password"]');
  await password.fill("incorrect-wireless-key");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("The wireless security key is incorrect.");
  await expect(dialog).toContainText(/Status:\s*failed/i);

  await password.fill("simulatornet-wpa2");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Security key configured.");
  await expect(dialog).toContainText(/Status:\s*associated/i);
  await expect(page.locator("html > body")).not.toContainText("simulatornet-wpa2");
  await expect(page.locator("html > body")).not.toContainText("incorrect-wireless-key");
});

test("Home Wireless Router provides WLAN DHCP and PAT to a public server", async ({ page }) => {
  await loadWirelessDemo(page, /Home Wireless Router/);

  const router = await openDevice(page, "HOME-RTR");
  await router.getByRole("tab", { name: "Connected Clients" }).click();
  await expect(router).toContainText("HOME-LAPTOP");
  await expect(router).toContainText("PHONE1");
  await router.getByRole("button", { name: "Close device window" }).click();

  const laptop = await openDevice(page, "HOME-LAPTOP");
  await laptop.getByRole("tab", { name: "Wireless", exact: true }).click();
  await expect(laptop).toContainText(/Status:\s*associated/i);
  await laptop.getByRole("button", { name: "Close device window" }).click();

  await openCli(page, "HOME-LAPTOP");
  await runCli(page, "ipconfig");
  await expect(page.getByTestId("terminal-transcript")).toContainText(/192\.168\.50\.\d+/);
  await runCli(page, "ping 198.51.100.10");
  await expect(page.getByTestId("terminal-transcript")).toContainText("Success rate is 100 percent");
});

test("AP shutdown deterministically roams the station without a structural Wi-Fi link", async ({ page }) => {
  await loadWirelessDemo(page, /AP Failover/);
  await expect(page.locator("[data-wireless-association]")).toHaveCount(1);
  await expect(page.locator('[data-wireless-access-point="ap-1"]')).toHaveCount(1);
  await expect(page.locator('[data-link-id][data-source-interface="wlan0"], [data-link-id][data-target-interface="wlan0"]')).toHaveCount(0);

  const accessPoint = await openDevice(page, "AP-PRIMARY");
  await accessPoint.getByRole("tab", { name: "Wireless", exact: true }).click();
  await accessPoint.getByLabel("Enabled", { exact: true }).uncheck();
  await accessPoint.getByRole("button", { name: "Apply" }).click();
  await expect(accessPoint.getByRole("status")).toContainText("Wireless settings applied.");
  await accessPoint.getByRole("button", { name: "Close device window" }).click();

  await expect(page.locator('[data-wireless-access-point="ap-2"]')).toHaveCount(1);
  const laptop = await openDevice(page, "ROAM-LAPTOP");
  await laptop.getByRole("tab", { name: "Wireless", exact: true }).click();
  await expect(laptop).toContainText(/Status:\s*associated/i);
  await laptop.getByRole("button", { name: "Close device window" }).click();

  await page.getByRole("tab", { name: /Packet trace/ }).click();
  await page.getByLabel("Packet trace protocol filter").selectOption("Roaming");
  await expect(page.locator('tr[data-event-type="wireless-roamed"]')).toBeVisible();

  await openCli(page, "ROAM-LAPTOP");
  await runCli(page, "ping 172.16.60.1");
  await expect(page.getByTestId("terminal-transcript")).toContainText("Success rate is 100 percent");
});
