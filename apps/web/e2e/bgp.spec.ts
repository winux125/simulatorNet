import { expect, test, type Page } from "@playwright/test";
import { openDeviceCli, openDeviceSection } from "./helpers/device-window";

async function loadDemo(page: Page, name: string) {
  await page.getByRole("button", { name: "Load Demo Lab", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Load demo laboratory" });
  await dialog.getByRole("button").filter({ hasText: name }).click();
  await expect(page.getByRole("button", { name: "Load Demo Lab", exact: true })).toBeHidden();
}

async function openCli(page: Page, hostname: string) {
  await openDeviceCli(page, hostname);
}

async function focusTerminal(page: Page) {
  const tab = page.getByRole("tab", { name: /^Terminal/ });
  if (await tab.count()) await tab.first().click();
}

async function runCli(page: Page, command: string) {
  await focusTerminal(page);
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

async function expectTerminal(page: Page, pattern: RegExp) {
  await expect.poll(async () => {
    await focusTerminal(page);
    return page.locator(".terminal-session.is-active").innerText();
  }, { timeout: 20_000 }).toMatch(pattern);
}

async function runAuto(page: Page) {
  await page.getByRole("tab", { name: /Packet trace/ }).click();
  const runAll = page.getByRole("button", { name: /Run All|Run until idle/i });
  if (await runAll.count() && await runAll.first().isEnabled()) await runAll.first().click();
}

async function selectTraceFilter(page: Page, protocol: string) {
  await page.getByRole("tab", { name: /Packet trace/ }).click();
  await page.getByLabel("Packet trace protocol filter").selectOption(protocol);
}

test.describe("M10.10 deterministic BGP", () => {
  test("eBGP Basic establishes, advertises prefixes and carries traffic", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, "eBGP Basic");
    await runAuto(page);

    await openCli(page, "R1");
    await runCli(page, "enable");
    await runCli(page, "show ip bgp summary");
    await expectTerminal(page, /192\.0\.2\.2\s+4\s+65002\s+1/);
    await runCli(page, "show ip route bgp");
    await expectTerminal(page, /10\.20\.0\.0\/24.*192\.0\.2\.2/);

    await openCli(page, "PC-A");
    await runCli(page, "ping 10.20.0.10");
    await expectTerminal(page, /Success rate is 100 percent|Reply from 10\.20\.0\.10/i);

    await selectTraceFilter(page, "BGP Session");
    await expect(page.locator(".packet-table")).toContainText("bgp-session-established");
  });

  test("Dual ISP route policy selects ISP1 and fails over to ISP2", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, "Dual ISP Best Path");
    await runAuto(page);
    await openCli(page, "CUSTOMER");
    await runCli(page, "enable");
    await runCli(page, "show ip bgp 203.0.113.0/24");
    await expectTerminal(page, />\s+192\.0\.2\.2\s+200/);

    await runCli(page, "configure terminal");
    await runCli(page, "interface Gi0/0");
    await runCli(page, "shutdown");
    await runCli(page, "end");
    await runAuto(page);
    await runCli(page, "show ip bgp 203.0.113.0/24");
    await expectTerminal(page, />\s+198\.51\.100\.2/);

    await selectTraceFilter(page, "Route Policy");
    await expect(page.locator(".packet-table")).toContainText(/bgp-policy-permit|bgp-policy-deny/);
  });

  test("iBGP full mesh exposes policies in CLI and the device Monitor", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, "iBGP and Route Policies");
    await runAuto(page);
    await openCli(page, "EDGE2");
    await runCli(page, "enable");
    await runCli(page, "show ip prefix-list");
    await expectTerminal(page, /CUSTOMER.*1 entries/);
    await runCli(page, "show route-map");
    await expectTerminal(page, /CUSTOMER-IN, permit, sequence 10/);
    await runCli(page, "show ip bgp 10.1.0.0/24");
    await expectTerminal(page, />.*150/);

    const window = await openDeviceSection(page, { hostname: "EDGE2", topLevel: "Monitor", section: "BGP" });
    await expect(window).toContainText("2/2 Established");
    // From M10.12 the monitor opens on Summary; the table is one subsection in.
    await window.getByRole("tab", { name: "BGP Table" }).click();
    await expect(window).toContainText("10.1.0.0/24");
  });
});
