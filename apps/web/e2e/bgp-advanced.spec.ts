import { expect, test, type Page } from "@playwright/test";
import { openDeviceCli } from "./helpers/device-window";

async function loadDemo(page: Page, name: string) {
  await page.getByRole("button", { name: "Load Demo Lab", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Load demo laboratory" });
  await dialog.getByRole("button").filter({ hasText: name }).click();
  await expect(page.getByRole("button", { name: "Load Demo Lab", exact: true })).toBeHidden();
}

async function closeInspector(page: Page) {
  const inspector = page.getByRole("region", { name: "Inspector" });
  if (await inspector.isVisible()) await inspector.getByRole("button", { name: "Close inspector" }).click();
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

async function openMonitorBgp(page: Page, hostname: string) {
  await closeInspector(page);
  await page.getByRole("button", { name: `Select ${hostname}` }).dblclick();
  const window = page.getByRole("dialog", { name: new RegExp(`${hostname} device window`) });
  await window.getByRole("tab", { name: "Monitor" }).click();
  await window.getByRole("combobox", { name: "Monitor section", exact: true }).selectOption("bgp-runtime");
  return window;
}

test.describe("M10.12 BGP route reflection, communities and advanced policy", () => {
  test("iBGP Route Reflector replaces the full mesh and stamps ORIGINATOR_ID", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, "iBGP Route Reflector");
    await runAuto(page);

    await openCli(page, "RR");
    await runCli(page, "enable");
    await runCli(page, "show ip bgp summary");
    await expectTerminal(page, /Route reflector cluster ID 10\.255\.0\.1/);

    await openCli(page, "CLIENT2");
    await runCli(page, "enable");
    // CLIENT2 has exactly one session — the reflector — yet still learns the
    // other clients' prefixes.
    await runCli(page, "show ip bgp 172.16.1.0/24");
    await expectTerminal(page, /Originator: 1\.1\.1\.1/);
    await expectTerminal(page, /Cluster list: 10\.255\.0\.1/);

    await selectTraceFilter(page, "Route Reflection");
    await expect(page.locator(".packet-table")).toContainText("bgp-route-reflected");

    const window = await openMonitorBgp(page, "RR");
    await window.getByRole("tab", { name: "Route Reflection" }).click();
    await expect(window).toContainText("10.255.0.1");
    await expect(window).toContainText("acting as a route reflector");
  });

  test("BGP Communities re-price a tagged prefix and no-export holds at the AS edge", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, "BGP Communities");
    await runAuto(page);

    await openCli(page, "PROVIDER");
    await runCli(page, "enable");
    await runCli(page, "show ip community-list");
    await expectTerminal(page, /Standard community-list CUSTOMER-ROUTES/);
    await runCli(page, "show ip bgp community 65000:100");
    await expectTerminal(page, /198\.51\.100\.0\/24/);

    await openCli(page, "UPSTREAM");
    await runCli(page, "enable");
    await runCli(page, "show ip bgp");
    // The no-export prefix never crosses the eBGP boundary.
    await expectTerminal(page, /198\.51\.100\.0/);
    await expect.poll(async () => {
      await focusTerminal(page);
      return page.locator(".terminal-session.is-active").innerText();
    }, { timeout: 20_000 }).not.toMatch(/198\.51\.101\.0/);

    await selectTraceFilter(page, "Community");
    await expect(page.locator(".packet-table")).toContainText(/bgp-community-added|bgp-community-suppressed-advertisement/);

    const window = await openMonitorBgp(page, "PROVIDER");
    await window.getByRole("tab", { name: "Communities" }).click();
    await expect(window).toContainText("65000:100");
  });

  test("Aggregation suppresses specifics, prepends to the backup and originates a default", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, "Aggregation and Advanced Policy");
    await runAuto(page);

    await openCli(page, "EDGE");
    await runCli(page, "enable");
    await runCli(page, "show ip bgp suppressed-paths");
    await expectTerminal(page, /10\.20\.1\.0\/24\s+10\.20\.0\.0\/16/);
    await runCli(page, "show ip as-path-access-list");
    await expectTerminal(page, /AS path access list NO-TRANSIT/);
    // Soft reconfiguration reevaluates policy without resetting the session.
    await runCli(page, "clear ip bgp 192.0.2.2 soft out");
    await expectTerminal(page, /session is unchanged/);
    await runAuto(page);

    await openCli(page, "ISP1");
    await runCli(page, "enable");
    await runCli(page, "show ip bgp");
    await expectTerminal(page, /10\.20\.0\.0\/16/);
    await expectTerminal(page, /0\.0\.0\.0\/0/);

    await selectTraceFilter(page, "Aggregation");
    await expect(page.locator(".packet-table")).toContainText(/bgp-aggregate-originated|bgp-specific-suppressed/);

    const window = await openMonitorBgp(page, "EDGE");
    await window.getByRole("tab", { name: "Aggregates" }).click();
    await expect(window).toContainText("10.20.0.0/16");
  });
});
