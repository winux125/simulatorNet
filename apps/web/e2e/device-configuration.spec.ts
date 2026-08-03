import { expect, test, type Page } from "@playwright/test";

/**
 * M10.9.1 configuration lifecycle and lab package flows.
 *
 * Both tests drive the surfaces a network engineer actually uses — the CLI, the
 * device Configuration tab and the File menu — and never reach into worker
 * internals, so what they assert is what a learner sees.
 */

async function loadDemo(page: Page, name: RegExp) {
  await page.getByRole("button", { name: "Load Demo Lab", exact: true }).click();
  await page.getByRole("button", { name }).click();
  await expect(page.getByRole("button", { name: "Load Demo Lab", exact: true })).toBeHidden();
}

async function closeInspector(page: Page) {
  const inspector = page.getByRole("region", { name: "Inspector" });
  if (await inspector.isVisible()) {
    await inspector.getByRole("button", { name: "Close inspector" }).click();
  }
}

async function openCli(page: Page, hostname: string) {
  await closeInspector(page);
  await page.getByRole("button", { name: `Select ${hostname}` }).click();
  const inspector = page.getByRole("region", { name: "Inspector" });
  await expect(inspector).toContainText(hostname);
  await inspector.getByRole("button", { name: /Open CLI/ }).click();
  await expect(page.getByRole("tab", { name: new RegExp(hostname) })).toBeVisible();
}

async function focusTerminal(page: Page) {
  const tab = page.getByRole("tab", { name: /^Terminal/ });
  if (await tab.count() > 0) await tab.first().click();
}

/**
 * A long `show` output pauses at `--More--`. Leave the pager before typing, or
 * the next command would be swallowed as a pager keystroke.
 */
async function dismissPager(page: Page) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const text = await page.locator(".terminal-session.is-active").innerText();
    if (!text.includes("--More--")) return;
    await page.keyboard.press("q");
    await page.waitForTimeout(50);
  }
}

async function runCli(page: Page, command: string) {
  await focusTerminal(page);
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await dismissPager(page);
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

async function terminalText(page: Page): Promise<string> {
  await focusTerminal(page);
  return page.locator(".terminal-session.is-active").innerText();
}

async function expectTerminal(page: Page, pattern: RegExp) {
  await expect.poll(async () => terminalText(page), { timeout: 15_000 }).toMatch(pattern);
}

/**
 * Open one device window and select a tab. The dialog is located by role only:
 * its accessible name follows the hostname, which a configuration change may
 * legitimately alter mid-test.
 */
async function openDeviceTab(page: Page, hostname: string, tab: RegExp) {
  await closeInspector(page);
  await page.getByRole("button", { name: `Select ${hostname}` }).dblclick();
  const window = page.getByRole("dialog", { name: /device window/ });
  await expect(window).toBeVisible();
  if (tab.test("Configuration")) {
    await window.getByRole("tab", { name: "Config", exact: true }).click();
    const compact = window.getByRole("combobox", { name: "Configuration section", exact: true });
    if (await compact.isVisible()) await compact.selectOption("configuration-files");
    else await window.getByRole("navigation", { name: "Configuration sections" }).getByRole("button", { name: "Running & Startup" }).click();
  } else {
    await window.getByRole("tab", { name: tab }).click();
  }
  return window;
}

function deviceWindow(page: Page) {
  return page.getByRole("dialog", { name: /device window/ });
}

async function closeDeviceWindow(page: Page) {
  await deviceWindow(page).getByRole("button", { name: "Close device window" }).click();
  await expect(deviceWindow(page)).toBeHidden();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("configures a router through the CLI and reloads it back to startup", async ({ page }) => {
  await loadDemo(page, /Router-on-a-stick/i);
  await openCli(page, "R1");

  await runCli(page, "enable");
  await runCli(page, "configure terminal");
  await runCli(page, "interface Gi0/1");
  await runCli(page, "description SAVED-UPLINK");
  await runCli(page, "end");
  await runCli(page, "show running-config");
  await expectTerminal(page, /description SAVED-UPLINK/);

  // Save it from the CLI, then confirm the workspace agrees.
  await runCli(page, "copy run start");
  await expectTerminal(page, /Building configuration\.\.\.[\s\S]*\[OK\]/);

  let window = await openDeviceTab(page, "R1", /^Configuration$/);
  await expect(window.getByLabel("Running configuration")).toContainText("description SAVED-UPLINK");
  await expect(window.locator(".configuration-status").first()).toContainText("Saved");
  await closeDeviceWindow(page);

  // Change the same interface again, do not save, and reload.
  await runCli(page, "configure terminal");
  await runCli(page, "interface Gi0/1");
  await runCli(page, "description TEMPORARY-LINK");
  await runCli(page, "end");
  await runCli(page, "show running-config");
  await expectTerminal(page, /description TEMPORARY-LINK/);

  // The workspace now reports the device as modified.
  window = await openDeviceTab(page, "R1", /^Configuration$/);
  await expect(window.locator(".configuration-status").first()).toContainText("Modified");
  await window.getByRole("tab", { name: "Compare" }).click();
  await expect(window.getByText(/unsaved change/)).toBeVisible();
  await closeDeviceWindow(page);

  await runCli(page, "reload");
  await expectTerminal(page, /System configuration has been modified\. Save\? \[yes\/no\]:/);
  await runCli(page, "no");
  await expectTerminal(page, /Proceed with reload\? \[confirm\]/);
  await runCli(page, "");
  await expectTerminal(page, /Reload requested\./);

  // The reloaded device is back at its saved configuration.
  window = await openDeviceTab(page, "R1", /^Configuration$/);
  await expect(window.getByLabel("Running configuration")).toContainText("description SAVED-UPLINK");
  await expect(window.getByLabel("Running configuration")).not.toContainText("TEMPORARY-LINK");
  await expect(window.locator(".configuration-status").first()).toContainText("Saved");
  await closeDeviceWindow(page);

  // Another device's session survived the reload untouched.
  await openCli(page, "SW1");
  await runCli(page, "enable");
  await runCli(page, "show vlan brief");
  await expectTerminal(page, /VLAN\s+Name/);
});

test("pastes a configuration, exports a .cfg and saves a .simlab package", async ({ page }) => {
  await loadDemo(page, /Router-on-a-stick/i);

  const window = await openDeviceTab(page, "SW1", /^Configuration$/);
  // The ordinary device window never shows raw JSON.
  await expect(window.getByLabel("Running configuration")).toContainText("hostname SW1");
  await expect(window.getByLabel("Running configuration")).not.toContainText('"kind":');

  // A pasted configuration replaces the whole running configuration, so it
  // restates the VLAN plan the demo relies on and adds one new port setting.
  await window.getByRole("tab", { name: "Import / Paste" }).click();
  await window.getByLabel("Configuration text").fill([
    "hostname CAMPUS-SW",
    "!",
    "vlan 10",
    " name STUDENTS",
    "!",
    "vlan 20",
    " name SERVERS",
    "!",
    "interface Gi0/1",
    " description PASTED-PORT",
    " switchport mode access",
    " switchport access vlan 10",
    "!",
    "interface Gi0/2",
    " switchport mode access",
    " switchport access vlan 20",
    "!",
    "interface Gi0/8",
    " switchport mode trunk",
    "!",
    // EIGRP is genuinely outside the parser's IOS-like subset, so it keeps the
    // honest-report assertion meaningful. `router bgp` no longer belongs here:
    // the parser supports it, and this test verifies that on R1 below.
    "router eigrp 100",
  ].join("\n"));
  await window.getByRole("button", { name: "Parse" }).click();

  // The report is honest about what will and will not be applied.
  await expect(window.getByText("Parse report")).toBeVisible();
  await expect(window.getByRole("cell", { name: "router eigrp 100" })).toBeVisible();

  await window.getByRole("button", { name: /Apply to running/ }).click();
  await expect(window.getByLabel("Running configuration")).toContainText("hostname CAMPUS-SW");
  await expect(window.getByLabel("Running configuration")).toContainText("description PASTED-PORT");

  const cfgDownload = page.waitForEvent("download");
  await window.getByRole("button", { name: /Download \.cfg/ }).click();
  expect((await cfgDownload).suggestedFilename()).toBe("CAMPUS-SW-running.cfg");
  await closeDeviceWindow(page);

  // `router bgp` is inside the supported subset, so configure it on the router
  // that can actually run it and confirm the process, not just the text.
  await openCli(page, "R1");
  await runCli(page, "enable");
  await runCli(page, "configure terminal");
  await runCli(page, "router bgp 65000");
  await runCli(page, "end");
  await runCli(page, "show ip bgp summary");
  await expectTerminal(page, /local AS number 65000/);

  const routerWindow = await openDeviceTab(page, "R1", /^Configuration$/);
  await expect(routerWindow.getByLabel("Running configuration")).toContainText("router bgp 65000");
  await closeDeviceWindow(page);

  // Save Lab writes one .simlab package, not a JSON file.
  await page.getByRole("menuitem", { name: /^File$/ }).click();
  const packageDownload = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: /^Save Lab(?! As)/ }).click();
  const saved = await packageDownload;
  expect(saved.suggestedFilename()).toMatch(/\.simlab$/);

  // Reopen the package: topology, running configuration and the applied paste
  // all come back, and the lab still forwards traffic.
  const path = await saved.path();
  await page.getByRole("menuitem", { name: /^File$/ }).click();
  await page.getByRole("menuitem", { name: /^Open Lab/ }).click();
  await page.locator("#load-lab-file").setInputFiles(path);
  await expect(page.getByRole("button", { name: "Select CAMPUS-SW" })).toBeVisible({ timeout: 20_000 });

  const reopened = await openDeviceTab(page, "CAMPUS-SW", /^Configuration$/);
  await expect(reopened.getByLabel("Running configuration")).toContainText("description PASTED-PORT");
  await closeDeviceWindow(page);

  // The package carries configuration, so the BGP process comes back with it.
  const reopenedRouter = await openDeviceTab(page, "R1", /^Configuration$/);
  await expect(reopenedRouter.getByLabel("Running configuration")).toContainText("router bgp 65000");
  await closeDeviceWindow(page);

  await openCli(page, "PC1");
  await runCli(page, "ping 192.168.10.1");
  await expectTerminal(page, /Reply from|Success rate|Request timed out/);

  // Raw JSON stays reachable, but only under File ▸ Advanced.
  await page.getByRole("menuitem", { name: /^File$/ }).click();
  await page.getByRole("menuitem", { name: /^Advanced$/ }).click();
  await page.getByRole("menuitem", { name: /Export Lab JSON/ }).click();
  await expect(page.getByText(/Advanced format intended for diagnostics/)).toBeVisible();
  const jsonDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  expect((await jsonDownload).suggestedFilename()).toMatch(/\.json$/);
});
