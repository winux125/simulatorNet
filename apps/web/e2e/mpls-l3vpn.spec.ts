import { expect, test, type Page } from "@playwright/test";

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
  await closeInspector(page);
  await page.getByRole("button", { name: `Select ${hostname}`, exact: true }).click();
  const inspector = page.getByRole("region", { name: "Inspector" });
  await inspector.getByRole("button", { name: /Open CLI/ }).click();
  await expect(page.getByRole("tab", { name: new RegExp(`^${hostname} terminal`) })).toBeVisible();
}

async function runCli(page: Page, command: string) {
  const terminalTab = page.getByRole("tab", { name: /^Terminal/ });
  if (await terminalTab.count()) await terminalTab.first().click();
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

async function expectTerminal(page: Page, pattern: RegExp) {
  await expect.poll(async () => page.locator(".terminal-session.is-active").innerText(), {
    timeout: 20_000,
  }).toMatch(pattern);
}

async function runAuto(page: Page) {
  await page.getByRole("tab", { name: /Packet trace/ }).click();
  const runAll = page.getByRole("button", { name: /Run All|Run until idle/i });
  if (await runAll.count() && await runAll.first().isEnabled()) await runAll.first().click();
}

async function showProtocolOverlay(page: Page, name: "MPLS Labels" | "L3VPN") {
  await page.getByRole("menuitem", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Protocol Overlays", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Show", exact: true }).click();
}

test.describe("M10.11 deterministic MPLS and L3VPN", () => {
  test("MPLS LDP core establishes sessions and exposes deterministic LFIB", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, "MPLS LDP Core");
    await runAuto(page);

    await openCli(page, "P1");
    await runCli(page, "enable");
    await runCli(page, "show mpls ldp neighbor");
    await expectTerminal(page, /operational/);
    await runCli(page, "show mpls forwarding-table");
    await expectTerminal(page, /swap|pop/i);
    await showProtocolOverlay(page, "MPLS Labels");
    await expect(page.getByTestId("topology-graph")).toContainText(/swap|pop/i);

    await page.getByRole("tab", { name: /Packet trace/ }).click();
    await page.getByLabel("Packet trace protocol filter").selectOption("LDP");
    await expect(page.locator(".packet-table")).toContainText("ldp-binding-installed");
  });

  test("single-customer L3VPN carries traffic while the P router has no customer route", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, "Single-Customer L3VPN");
    await runAuto(page);

    await openCli(page, "CE1");
    await runCli(page, "enable");
    await runCli(page, "ping 10.2.1.2");
    await expectTerminal(page, /Success rate is 100 percent/);

    await openCli(page, "P");
    await runCli(page, "enable");
    await runCli(page, "show ip route");
    const text = await page.locator(".terminal-session.is-active").innerText();
    expect(text).not.toMatch(/10\.1\.1\.0\/24|10\.2\.1\.0\/24/);

    await openCli(page, "PE1");
    await runCli(page, "enable");
    await runCli(page, "show bgp vpnv4 unicast all");
    await expectTerminal(page, /65000:100.*10\.2\.1\.0\/24/s);
    await showProtocolOverlay(page, "L3VPN");
    await expect(page.locator("[data-l3vpn-relation]")).toHaveCount(1);
  });

  test("overlapping customer prefixes remain isolated by RD and route target", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, "Overlapping Customer Networks");
    await runAuto(page);

    await openCli(page, "A-SITE1");
    await runCli(page, "enable");
    await runCli(page, "ping 10.1.0.2");
    await expectTerminal(page, /Success rate is 100 percent/);
    await runCli(page, "ping 10.2.0.2");
    await expectTerminal(page, /has no route to 10\.2\.0\.2|Success rate is 0 percent/);

    await openCli(page, "B-SITE1");
    await runCli(page, "enable");
    await runCli(page, "ping 10.2.0.2");
    await expectTerminal(page, /Success rate is 100 percent/);

    await openCli(page, "PE1");
    await runCli(page, "enable");
    await runCli(page, "show ip route vrf customer-a");
    await expectTerminal(page, /10\.1\.0\.0\/24/);
    const customerA = await page.locator(".terminal-session.is-active").innerText();
    expect(customerA).not.toMatch(/10\.2\.0\.0\/24/);
  });
});
