import { expect, test, type Page } from "@playwright/test";

async function loadDemo(page: Page, name: RegExp) {
  await page.getByRole("button", { name: "Load Demo Lab", exact: true }).click();
  await page.getByRole("button", { name }).click();
  await expect(page.getByRole("button", { name: "Load Demo Lab", exact: true })).toBeHidden();
}

async function loadDemoFromMenu(page: Page, name: RegExp) {
  await page.getByRole("menuitem", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Load Demo Lab", exact: true }).click();
  await page.getByRole("button", { name }).click();
}

async function drainEvents(page: Page) {
  await page.getByRole("menuitem", { name: "Simulation", exact: true }).click();
  const runAll = page.getByRole("menuitem", { name: /^Run All Queued Events/ });
  if (await runAll.isEnabled()) await runAll.click();
  else await page.keyboard.press("Escape");
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
  await inspector.getByRole("button", { name: /Open CLI/ }).click();
  await expect(page.getByRole("tab", { name: new RegExp(hostname) })).toBeVisible();
}

async function runCli(page: Page, command: string) {
  const terminalTab = page.getByRole("tab", { name: /^Terminal/ });
  if (await terminalTab.count()) await terminalTab.first().click();
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

async function expectTerminal(page: Page, pattern: RegExp) {
  await expect.poll(
    () => page.locator(".terminal-session.is-active").innerText(),
    { timeout: 15_000 },
  ).toMatch(pattern);
}

test("Static IPv6 LAN resolves NDP and completes ICMPv6 in Auto", async ({ page }) => {
  await page.goto("/");
  await loadDemo(page, /IPv6 Static LAN/);
  await openCli(page, "PC1");
  await runCli(page, "ping -6 2001:db8:10::20");
  await expectTerminal(page, /Success rate is 100 percent \(5\/5\)/);

  await page.getByRole("tab", { name: /Packet trace/ }).click();
  await page.getByLabel("Packet trace protocol filter").selectOption("NDP");
  await expect(page.locator('tr[data-event-type^="ndp-"]').first()).toBeVisible();
  await page.getByLabel("Packet trace protocol filter").selectOption("ICMPv6");
  await expect(page.locator('tr[data-event-type="ipv6-ping-success"]').first()).toBeVisible();
});

test("SLAAC and DHCPv6 expose learned host configuration", async ({ page }) => {
  await page.goto("/");
  await loadDemo(page, /SLAAC and Router Advertisement/);
  await drainEvents(page);
  await closeInspector(page);
  await page.getByRole("button", { name: "Select PC1" }).dblclick();
  let deviceWindow = page.getByRole("dialog", { name: "PC1 device window" });
  await deviceWindow.getByRole("tab", { name: "IPv6", exact: true }).click();
  await expect(deviceWindow).toContainText(/2001:db8:20:/);
  await expect(deviceWindow).toContainText(/slaac/i);
  await deviceWindow.getByRole("button", { name: "Close device window" }).click();

  await loadDemoFromMenu(page, /DHCPv6 and DNS AAAA/);
  await drainEvents(page);
  await closeInspector(page);
  await page.getByRole("button", { name: "Select PC1" }).dblclick();
  deviceWindow = page.getByRole("dialog", { name: "PC1 device window" });
  await deviceWindow.getByRole("tab", { name: "IPv6", exact: true }).click();
  await expect(deviceWindow.getByLabel("DHCPv6")).toBeChecked();
  await deviceWindow.getByRole("button", { name: "Renew" }).click();
  await expect(deviceWindow).toContainText("2001:db8:30::100");
});

test("OSPFv3 forms Full adjacency and withdraws a route after link failure", async ({ page }) => {
  await page.goto("/");
  await loadDemo(page, /OSPFv3 and IPv6 ACL/);
  await drainEvents(page);
  await openCli(page, "R2");
  await runCli(page, "enable");
  await runCli(page, "show ipv6 ospf neighbor");
  await expectTerminal(page, /1\.1\.1\.1\s+FULL/);
  await expectTerminal(page, /3\.3\.3\.3\s+FULL/);

  await runCli(page, "configure terminal");
  await runCli(page, "interface Gi0/1");
  await runCli(page, "shutdown");
  await runCli(page, "end");
  await drainEvents(page);

  await openCli(page, "R1");
  await runCli(page, "enable");
  await runCli(page, "show ipv6 route");
  await expectTerminal(page, /2001:db8:12::\/64/);
  await expect(page.locator(".terminal-session.is-active")).not.toContainText("2001:db8:103::/64");
});

test("IPv6 ACL permits HTTP and counts denied unmatched traffic", async ({ page }) => {
  await page.goto("/");
  await loadDemo(page, /OSPFv3 and IPv6 ACL/);
  await drainEvents(page);
  await openCli(page, "PC1");
  await runCli(page, "sim http get http://[2001:db8:103::10]/");
  await expectTerminal(page, /HTTP\/1\.1 200/);
  await runCli(page, "sim http get http://[2001:db8:103::10]:81/");
  await expectTerminal(page, /HTTP (?:timeout|timed-out|request did not complete|failed)/i);

  await openCli(page, "R3");
  await runCli(page, "enable");
  await runCli(page, "show ipv6 access-list");
  await expectTerminal(page, /permit tcp 2001:db8:101::\/64 host 2001:db8:103::10 eq 80/);
  await expectTerminal(page, /deny ipv6 any any \([1-9][0-9]* matches\)/);
});
