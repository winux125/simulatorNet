import { expect, test, type Page } from "@playwright/test";
import { openDeviceCli } from "./helpers/device-window";

async function loadDemo(page: Page, name: string) {
  await page.getByRole("button", { name: "Load Demo Lab", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Load demo laboratory" });
  await dialog.getByRole("button").filter({ hasText: name }).click();
  await expect(page.getByRole("button", { name: "Load Demo Lab", exact: true })).toBeHidden();
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

async function showVxlanOverlay(page: Page) {
  await page.getByRole("menuitem", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Protocol Overlays", exact: true }).click();
  await page.getByRole("menuitem", { name: "VXLAN Tunnels", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Show", exact: true }).click();
}

test.describe("M10.14 deterministic VXLAN and BGP EVPN", () => {
  test("static VXLAN stretches one VLAN and the underlay learns no tenant MAC", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, "Static VXLAN VLAN Stretch");
    await runAuto(page);

    await openDeviceCli(page, "VTEP1");
    await runCli(page, "enable");
    await runCli(page, "show nve interfaces");
    await expectTerminal(page, /nve1.*Loopback0.*10\.255\.0\.1/s);
    await runCli(page, "show nve vni");
    await expectTerminal(page, /10010.*10/s);
    await runCli(page, "show nve peers");
    await expectTerminal(page, /10\.255\.0\.2/);

    // One stretched broadcast domain: the two hosts are Layer 2 adjacent even
    // though a routed underlay sits between them.
    await openDeviceCli(page, "PC-A");
    await runCli(page, "ping 192.168.10.20");
    await expectTerminal(page, /Success rate is 100 percent/);

    await openDeviceCli(page, "VTEP1");
    await runCli(page, "show mac address-table remote");
    await expectTerminal(page, /10\.255\.0\.2/);

    // The underlay router carries the outer IPv4/UDP only and has no VTEP CLI.
    await openDeviceCli(page, "CORE");
    await runCli(page, "enable");
    await runCli(page, "show nve peers");
    const core = await page.locator(".terminal-session.is-active").innerText();
    expect(core).not.toMatch(/10010/);

    await showVxlanOverlay(page);
    // The overlay is derived presentation: it never becomes a topology link.
    await expect(page.locator("[data-vxlan-tunnel]").first()).toBeAttached();

    await page.getByRole("tab", { name: /Packet trace/ }).click();
    await page.getByLabel("Packet trace protocol filter").selectOption("VXLAN");
    await expect(page.locator(".packet-table")).toContainText("vxlan-encapsulation-started");
  });

  test("BGP EVPN advertises Type 3 membership and Type 2 MACs through a reflector", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, "BGP EVPN VLAN Stretch");
    await runAuto(page);

    await openDeviceCli(page, "LEAF1");
    await runCli(page, "enable");
    // Type 3 builds head-end replication before any tenant traffic exists.
    await runCli(page, "show bgp l2vpn evpn route-type 3");
    await expectTerminal(page, /65000:20020.*20020/s);
    await runCli(page, "show nve peers");
    await expectTerminal(page, /10\.255\.0\.2.*BGP EVPN/s);

    await openDeviceCli(page, "HOST-A");
    await runCli(page, "ping 192.168.20.20");
    await expectTerminal(page, /Success rate is 100 percent/);

    // Type 2 installs the remote MAC through the control plane, so unicast is
    // forwarded rather than flooded.
    await openDeviceCli(page, "LEAF1");
    await runCli(page, "show bgp l2vpn evpn route-type 2");
    await expectTerminal(page, /20020/);
    await runCli(page, "show mac address-table remote");
    await expectTerminal(page, /BGP EVPN/);

    // The spine reflects EVPN routes but is never a VTEP.
    await openDeviceCli(page, "SPINE-RR");
    await runCli(page, "enable");
    await runCli(page, "show bgp l2vpn evpn");
    await expectTerminal(page, /20020/);
    await runCli(page, "show nve vni");
    const spine = await page.locator(".terminal-session.is-active").innerText();
    expect(spine).not.toMatch(/ingress-replication/);

    await page.getByRole("tab", { name: /Packet trace/ }).click();
    await page.getByLabel("Packet trace protocol filter").selectOption("EVPN");
    await expect(page.locator(".packet-table")).toContainText(/evpn-/);
  });
});
