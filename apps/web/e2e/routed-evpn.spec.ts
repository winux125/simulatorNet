import { expect, test, type Page } from "@playwright/test";
import { openDeviceCli, openDeviceSection } from "./helpers/device-window";

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

/** Drain the bounded deterministic events the operation needs, then continue. */
async function runAuto(page: Page) {
  await page.getByRole("tab", { name: /Packet trace/ }).click();
  const runAll = page.getByRole("button", { name: /Run All|Run until idle/i });
  if (await runAll.count() && await runAll.first().isEnabled()) await runAll.first().click();
}

test.describe("M10.15 routed EVPN", () => {
  test("a distributed anycast gateway answers on each leaf and stretches one subnet", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, "EVPN Distributed Anycast Gateway");
    await runAuto(page);

    // Both leaves present the same gateway IPv4 and the same fabric MAC. That
    // shared address is a distributed gateway, not a duplicate.
    for (const leaf of ["LEAF1", "LEAF2"]) {
      const dialog = await openDeviceSection(page, {
        hostname: leaf,
        topLevel: "Monitor",
        section: "L3VNI",
      });
      await dialog.getByRole("tab", { name: "Anycast Gateway", exact: true }).click();
      await expect(dialog.getByRole("heading", { name: "Distributed Anycast Gateway" })).toBeVisible();
      await expect(dialog.getByText("02:00:00:ff:00:01").first()).toBeVisible();
      await expect(dialog.getByRole("row", { name: /Vlan10/ })).toContainText("10.10.10.1");
      await dialog.getByRole("button", { name: "Close device window", exact: true }).click();
    }

    // Each host reaches the gateway on its own local leaf.
    await openDeviceCli(page, "HOST-A");
    await runCli(page, "ping 10.10.10.1");
    await expectTerminal(page, /Success rate is 100 percent/);

    await openDeviceCli(page, "HOST-B");
    await runCli(page, "ping 10.10.10.1");
    await expectTerminal(page, /Success rate is 100 percent/);

    // One stretched broadcast domain: the two hosts are Layer 2 adjacent even
    // though a routed underlay sits between them.
    await runCli(page, "ping 10.10.10.10");
    await expectTerminal(page, /Success rate is 100 percent/);

    // Monitor shows the expected Layer 2 EVPN state on the leaf.
    const leaf1 = await openDeviceSection(page, {
      hostname: "LEAF1",
      topLevel: "Monitor",
      section: "EVPN Type 3",
    });
    await expect(leaf1.getByRole("row", { name: /10010/ }).first()).toBeVisible();
    await leaf1.getByRole("tab", { name: "Remote MACs", exact: true }).click();
    // Scope to the panel body: the compact section select also lists these
    // labels, and a hidden <option> is not what this asserts.
    const remoteMacs = leaf1.getByRole("tabpanel", { name: "VXLAN remote-macs" });
    await expect(remoteMacs.getByRole("row", { name: /10\.255\.0\.2/ })).toContainText("EVPN Type 2");
  });

  test("symmetric IRB routes both ways over an L3VNI while the second tenant stays isolated", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, "EVPN Symmetric IRB and Type 5");
    await runAuto(page);

    // Type 5 carries the tenant prefix, and the far leaf installs it into the
    // VRF its route targets name.
    const leaf2 = await openDeviceSection(page, {
      hostname: "LEAF2",
      topLevel: "Monitor",
      section: "EVPN Type 5",
    });
    await expect(leaf2.getByRole("row", { name: /10\.10\.10\.0\/24/ })).toContainText("50001");
    await leaf2.getByRole("tab", { name: "VRF Routes", exact: true }).click();
    const imported = leaf2.getByRole("row", { name: /10\.10\.10\.0\/24/ });
    await expect(imported).toContainText("EVPN Type 5");
    await expect(imported).toContainText("TENANT-A");
    await expect(imported).toContainText("10.255.0.1");
    // TENANT-B imports no TENANT-A prefix: route targets, not VNIs, decide.
    await expect(leaf2.getByRole("row", { name: /TENANT-B.*10\.10\.10\.0/ })).toHaveCount(0);
    await leaf2.getByRole("button", { name: "Close device window", exact: true }).click();

    // Both directions route independently over the same L3VNI.
    await openDeviceCli(page, "HOST-A");
    await runCli(page, "ping 10.20.20.20");
    await expectTerminal(page, /Success rate is 100 percent/);

    await openDeviceCli(page, "HOST-B");
    await runCli(page, "ping 10.10.10.10");
    await expectTerminal(page, /Success rate is 100 percent/);

    // A TENANT-B host cannot reach TENANT-A: the global table is never a
    // fallback and no route target is shared.
    await openDeviceCli(page, "HOST-C");
    await runCli(page, "ping 10.10.10.10");
    await expectTerminal(page, /Success rate is 0 percent|Request timed out|unreachable/i);

    // The reflector carries and reflects EVPN routes without ever becoming a
    // VTEP: it has no overlay CLI and no tenant routing context.
    await openDeviceCli(page, "SPINE-RR");
    await runCli(page, "enable");
    await runCli(page, "show ip route");
    const spine = await page.locator(".terminal-session.is-active").innerText();
    expect(spine).not.toMatch(/10\.10\.10\.0|10\.20\.20\.0|TENANT-/);

    // The routed flow is walkable in Packet Trace under its own filters.
    await page.getByRole("tab", { name: /Packet trace/ }).click();
    await page.getByLabel("Packet trace protocol filter").selectOption("L3VNI");
    await expect(page.locator(".packet-table")).toContainText("evpn-l3vni-encapsulated");
    await page.getByLabel("Packet trace protocol filter").selectOption("IRB");
    await expect(page.locator(".packet-table")).toContainText("evpn-irb-routed");
    await page.getByLabel("Packet trace protocol filter").selectOption("Type 5");
    await expect(page.locator(".packet-table")).toContainText(/evpn-type5-|routeType/);
  });
});
