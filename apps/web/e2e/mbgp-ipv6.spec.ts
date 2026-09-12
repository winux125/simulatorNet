import { expect, test, type Page } from "@playwright/test";
import { openDeviceCli, openDeviceSection } from "./helpers/device-window";

async function loadDemo(page: Page, name: string) {
  await page.getByRole("button", { name: "Load Demo Lab", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Load demo laboratory" });
  await dialog.getByRole("button").filter({ hasText: name }).click();
  await expect(page.getByRole("button", { name: "Load Demo Lab", exact: true })).toBeHidden();
}

/**
 * Exact matching throughout: this milestone's demo has PE1, PE2 and a P router,
 * so a substring match on "P" would resolve to three nodes.
 */
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

async function terminalText(page: Page) {
  await focusTerminal(page);
  return page.locator(".terminal-session.is-active").innerText();
}

async function expectTerminal(page: Page, pattern: RegExp) {
  await expect.poll(() => terminalText(page), { timeout: 20_000 }).toMatch(pattern);
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

async function openMonitorSection(page: Page, hostname: string, section: string) {
  // Section navigation renders as a rail on desktop and as a compact select only
  // at narrow widths, so go through the helper that handles both.
  return openDeviceSection(page, { hostname, topLevel: "Monitor", section });
}

test.describe("M10.13 MP-BGP IPv6 unicast and MPLS VPNv6", () => {
  test("eBGP over IPv6 establishes on an IPv6 transport and installs remote /64s", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, "eBGP over IPv6");
    await runAuto(page);

    await openCli(page, "R1");
    await runCli(page, "enable");
    // The session runs over a real IPv6 transport address, not a shortcut.
    await runCli(page, "show bgp ipv6 unicast summary");
    await expectTerminal(page, /2001:db8:12::2\s+4\s+65002/);
    await runCli(page, "show bgp ipv6 unicast");
    await expectTerminal(page, /2001:db8:b::\/64/);
    await runCli(page, "show ipv6 route bgp");
    await expectTerminal(page, /B\s+2001:db8:b::\/64\s+\[20\//);

    await openCli(page, "R2");
    await runCli(page, "enable");
    await runCli(page, "show bgp ipv6 unicast neighbors");
    await expectTerminal(page, /BGP state = established/);
    await expectTerminal(page, /Address families: ipv6-unicast/);

    // Every BGP trace row now carries the family the engine stamped.
    await selectTraceFilter(page, "BGP");
    await expect(page.locator(".packet-table")).toContainText("ipv6-unicast");

    const window = await openMonitorSection(page, "R1", "BGP");
    await expect(window.getByTestId("bgp-address-family-selector")).toBeVisible();
    await window.getByRole("combobox", { name: "Address family" }).selectOption("ipv6-unicast");
    await window.getByRole("tab", { name: "BGP Table" }).click();
    await expect(window.getByRole("table", { name: "BGP table" })).toContainText("2001:db8:b::/64");
  });

  test("Dual-Stack BGP keeps one session, two RIBs and independent IPv6 policy", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, "Dual-Stack BGP");
    await runAuto(page);

    await openCli(page, "R2");
    await runCli(page, "enable");
    // One TCP relationship, two negotiated families.
    await runCli(page, "show bgp ipv6 unicast neighbors");
    await expectTerminal(page, /Address families: ipv4-unicast, ipv6-unicast/);

    await runCli(page, "show ip bgp");
    await expectTerminal(page, /10\.10\.0\.0\/24/);

    await runCli(page, "show ipv6 prefix-list");
    await expectTerminal(page, /seq 10 permit 2001:db8:100::\/48 le 64/);

    // The IPv6 prefix list permits one /64 and the implicit deny stops the other;
    // the IPv4 prefix on the same session is untouched.
    await runCli(page, "show bgp ipv6 unicast");
    await expectTerminal(page, /2001:db8:100::\/64/);
    await expect.poll(() => terminalText(page), { timeout: 20_000 }).not.toMatch(/2001:db8:200::\/64/);

    const window = await openMonitorSection(page, "R2", "BGP");
    await window.getByRole("tab", { name: "Neighbors" }).click();
    await expect(window.getByRole("table", { name: "BGP neighbors" }))
      .toContainText("ipv4-unicast, ipv6-unicast");
    // Switching the family switches the RIB, not the session.
    await window.getByRole("combobox", { name: "Address family" }).selectOption("ipv6-unicast");
    await window.getByRole("tab", { name: "BGP Table" }).click();
    const table = window.getByRole("table", { name: "BGP table" });
    await expect(table).toContainText("2001:db8:100::/64");
    await expect(table).not.toContainText("10.10.0.0");
  });

  test("VPNv6 over MPLS isolates two customers that reuse the same IPv6 /64", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, "VPNv6 Over MPLS");
    await runAuto(page);

    await openCli(page, "PE2");
    await runCli(page, "enable");
    // The VRF-scoped view runs first: the terminal keeps its scrollback, so a
    // negative assertion is only meaningful before the unfiltered `all` output
    // has put the other customer's RD on screen.
    await runCli(page, "show bgp vpnv6 unicast vrf CUSTOMER-A");
    await expectTerminal(page, /65000:100\s+2001:db8:100::\/64/);
    await expect.poll(() => terminalText(page), { timeout: 20_000 }).not.toMatch(/65000:200/);

    // The same prefix arrives twice, made unique only by its route distinguisher.
    await runCli(page, "show bgp vpnv6 unicast all");
    await expectTerminal(page, /65000:200\s+2001:db8:100::\/64/);

    // Each VRF delivers through its own VPN label, allocated per VRF *and* family.
    await runCli(page, "show ipv6 route vrf CUSTOMER-A");
    await expectTerminal(page, /2001:db8:100::\/64/);
    await runCli(page, "show ipv6 route vrf CUSTOMER-B");
    await expectTerminal(page, /2001:db8:100::\/64/);

    // The P router forwards labels only and holds no customer IPv6 route.
    await openCli(page, "P");
    await runCli(page, "enable");
    await runCli(page, "show mpls forwarding-table");
    await expectTerminal(page, /10\.255\.0\./);
    await runCli(page, "show ipv6 route");
    await expect.poll(() => terminalText(page), { timeout: 20_000 }).not.toMatch(/2001:db8:100::/);

    await selectTraceFilter(page, "VPNv6");
    await expect(page.locator(".packet-table")).toContainText("vpnv6-unicast");

    const window = await openMonitorSection(page, "PE2", "VPNv6 Routes");
    await expect(window).toContainText("VPNv6 Routes");
    await expect(window).toContainText("65000:100");
    await expect(window).toContainText("65000:200");
  });
});
