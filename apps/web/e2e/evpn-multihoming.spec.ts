import { expect, test, type Page } from "@playwright/test";
import { openDeviceCli, openDeviceSection } from "./helpers/device-window";

const ESI = "0000:0000:0000:0000:0001";

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

test.describe("M10.16 EVPN Single-Active multihoming", () => {
  test("two leaves discover one Ethernet Segment and elect exactly one forwarder", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, "EVPN Single-Active Multihoming");
    await runAuto(page);

    // The segment is visible on both leaves, with the same ESI.
    for (const leaf of ["LEAF1", "LEAF2"]) {
      const dialog = await openDeviceSection(page, {
        hostname: leaf,
        topLevel: "Monitor",
        section: "Ethernet Segments",
      });
      await expect(dialog.getByRole("heading", { name: "Ethernet Segments" })).toBeVisible();
      const segments = dialog.getByRole("tabpanel", { name: "VXLAN ethernet-segments" });
      await expect(segments.getByRole("row", { name: /ES-CE1/ })).toContainText(ESI);
      await expect(segments.getByRole("row", { name: /ES-CE1/ })).toContainText("Single Active");
      await dialog.getByRole("button", { name: "Close device window", exact: true }).click();
    }

    // Exactly one DF and one non-DF for VLAN 10, computed independently.
    const leaf1 = await openDeviceSection(page, {
      hostname: "LEAF1",
      topLevel: "Monitor",
      section: "DF Election",
    });
    const df = leaf1.getByRole("tabpanel", { name: "VXLAN df-election" });
    await expect(df.getByRole("row", { name: new RegExp(ESI) })).toContainText("10.255.0.1");
    await expect(df.getByRole("row", { name: new RegExp(ESI) })).toContainText("DF");
    // Both Ethernet Segment route types are present on the leaf.
    await leaf1.getByRole("tab", { name: "EVPN Type 4", exact: true }).click();
    await expect(leaf1.getByRole("tabpanel", { name: "VXLAN type4" }).getByRole("row", { name: new RegExp(ESI) }).first())
      .toBeVisible();
    await leaf1.getByRole("tab", { name: "EVPN Type 1", exact: true }).click();
    const type1 = leaf1.getByRole("tabpanel", { name: "VXLAN type1" });
    await expect(type1).toContainText("per-es");
    await expect(type1).toContainText("per-evi");
    await leaf1.getByRole("button", { name: "Close device window", exact: true }).click();

    const leaf2 = await openDeviceSection(page, {
      hostname: "LEAF2",
      topLevel: "Monitor",
      section: "DF Election",
    });
    await expect(leaf2.getByRole("tabpanel", { name: "VXLAN df-election" })
      .getByRole("row", { name: new RegExp(ESI) })).toContainText("non-DF");
    await leaf2.getByRole("button", { name: "Close device window", exact: true }).click();

    // The tenant reaches the far side of the fabric through the DF.
    await openDeviceCli(page, "HOST-A");
    await runCli(page, "ping 192.168.10.20");
    await expectTerminal(page, /Success rate is 100 percent/);

    // The remote leaf programmed the MAC behind the DF, with a real backup.
    const leaf3 = await openDeviceSection(page, {
      hostname: "LEAF3",
      topLevel: "Monitor",
      section: "Multihoming Paths",
    });
    const paths = leaf3.getByRole("tabpanel", { name: "VXLAN multihoming" });
    await expect(paths.getByRole("row", { name: new RegExp(ESI) })).toContainText("10.255.0.1");
    await expect(paths.getByRole("row", { name: new RegExp(ESI) })).toContainText("10.255.0.2");
    await leaf3.getByRole("tab", { name: "Remote MACs", exact: true }).click();
    await expect(leaf3.getByRole("tabpanel", { name: "VXLAN remote-macs" })).toContainText(ESI);
  });

  test("a mass withdrawal moves forwarding to the backup leaf and traffic recovers", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, "EVPN Fast Failover");
    await runAuto(page);

    // Connectivity before the failure.
    await openDeviceCli(page, "HOST-A");
    await runCli(page, "ping 192.168.10.20");
    await expectTerminal(page, /Success rate is 100 percent/);

    // Break the Designated Forwarder's attachment to the CE.
    await openDeviceCli(page, "LEAF1");
    await runCli(page, "enable");
    await runCli(page, "configure terminal");
    await runCli(page, "interface Gi0/1");
    await runCli(page, "shutdown");
    await runCli(page, "end");
    await runAuto(page);

    // Wait on the explicit EVPN convergence condition, never on a sleep: the
    // surviving leaf takes the Designated Forwarder role over.
    await openDeviceCli(page, "LEAF2");
    await runCli(page, "enable");
    await expect.poll(async () => {
      await runCli(page, "show evpn df");
      return page.locator(".terminal-session.is-active").innerText();
    }, { timeout: 30_000 }).toMatch(/0000:0000:0000:0000:0001[\s\S]*DF/);
    await expectTerminal(page, /10\.255\.0\.2/);

    // The remote leaf follows the segment rather than the withdrawn MAC route.
    const leaf3 = await openDeviceSection(page, {
      hostname: "LEAF3",
      topLevel: "Monitor",
      section: "Multihoming Paths",
    });
    await expect(leaf3.getByRole("tabpanel", { name: "VXLAN multihoming" })
      .getByRole("row", { name: new RegExp(ESI) })).toContainText("10.255.0.2");
    await leaf3.getByRole("button", { name: "Close device window", exact: true }).click();

    // Traffic recovers with no topology rebuild and no manual relearning.
    await openDeviceCli(page, "HOST-A");
    await runCli(page, "ping 192.168.10.20");
    await expectTerminal(page, /Success rate is 100 percent/);

    // The convergence is walkable in Packet Trace under its own filters.
    await page.getByRole("tab", { name: /Packet trace/ }).click();
    await page.getByLabel("Packet trace protocol filter").selectOption("Fast Failover");
    await expect(page.locator(".packet-table")).toContainText(/evpn-es-mass-withdraw|evpn-ad-route-withdrawn/);
    await page.getByLabel("Packet trace protocol filter").selectOption("DF Election");
    await expect(page.locator(".packet-table")).toContainText("evpn-df-elected");
    await page.getByLabel("Packet trace protocol filter").selectOption("Ethernet Segment");
    await expect(page.locator(".packet-table")).toContainText(/evpn-es-/);
  });
});
