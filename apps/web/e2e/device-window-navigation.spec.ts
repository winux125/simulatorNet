import { expect, test, type Page } from "@playwright/test";

async function loadDemo(page: Page, name: RegExp) {
  await page.getByRole("button", { name: "Load Demo Lab", exact: true }).click();
  await page.getByRole("button", { name }).click();
}

async function openDevice(page: Page, hostname: string) {
  const inspector = page.getByRole("region", { name: "Inspector" });
  if (await inspector.isVisible()) await inspector.getByRole("button", { name: "Close inspector" }).click();
  await page.getByRole("button", { name: `Select ${hostname}` }).dblclick();
  const dialog = page.getByRole("dialog", { name: `${hostname} device window` });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function chooseSection(dialog: ReturnType<Page["getByRole"]>, workspace: "Configuration" | "Monitor", value: string, label: string) {
  const compact = dialog.getByRole("combobox", { name: `${workspace} section`, exact: true });
  if (await compact.isVisible()) await compact.selectOption(value);
  else await dialog.getByRole("navigation", { name: `${workspace} sections` }).getByRole("button", { name: label }).click();
}

test("managed device windows use compact Config and Monitor navigation", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await loadDemo(page, /Router-on-a-stick/i);

  let dialog = await openDevice(page, "R1");
  const tabs = dialog.getByRole("tablist", { name: "R1 sections" });
  await expect(tabs.getByRole("tab")).toHaveText(["Physical", "Config", "CLI", "Monitor", "Attributes"]);
  expect(await tabs.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  await tabs.getByRole("tab", { name: "Config" }).click();
  await chooseSection(dialog, "Configuration", "console-config", "Console Access");
  await expect(dialog.getByText("Config · Console Access")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("device-window-1280x720.png"), fullPage: true });
  await chooseSection(dialog, "Configuration", "qos-config", "QoS");
  await expect(dialog.getByRole("tablist", { name: "QoS sections" })).toBeVisible();

  await tabs.getByRole("tab", { name: "Monitor" }).click();
  await chooseSection(dialog, "Monitor", "sessions-runtime", "Sessions");
  await expect(dialog.getByText(/No remote sessions|Start the lab to inspect management state/)).toBeVisible();
  await dialog.getByRole("button", { name: "Close device window" }).click();

  dialog = await openDevice(page, "SW1");
  await dialog.getByRole("tab", { name: "Config" }).click();
  const l2Options = await dialog.getByLabel("Configuration section").locator("option").allTextContents();
  expect(l2Options.join(" ")).toContain("VLANs");
  expect(l2Options.join(" ")).toContain("Spanning Tree");
  expect(l2Options.join(" ")).not.toContain("NAT");
  expect(await dialog.getByRole("tablist", { name: "SW1 sections" }).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByRole("button", { name: "Close device window" }).click();

  await page.getByRole("menuitem", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Close Lab" }).click();
  await expect(page.getByRole("button", { name: "Load Demo Lab", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadDemo(page, /DMZ Stateful Firewall/i);
  dialog = await openDevice(page, "FW1");
  const firewallTabs = dialog.getByRole("tablist", { name: "FW1 sections" });
  await expect(firewallTabs.getByRole("tab")).toHaveText(["Physical", "Config", "CLI", "Monitor", "Attributes"]);
  await firewallTabs.getByRole("tab", { name: "Config" }).click();
  const config = dialog.getByRole("navigation", { name: "Configuration sections" });
  await expect(config.getByRole("button", { name: "Policies" })).toBeVisible();
  await expect(config.getByRole("button", { name: "NAT" })).toBeVisible();
  await expect(config.getByRole("button", { name: "VPN" })).toBeVisible();
  await expect(config.getByRole("button", { name: "QoS" })).toBeVisible();
  await expect(firewallTabs.getByRole("tab", { name: "NAT" })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("device-window-1440x900.png"), fullPage: true });
});
