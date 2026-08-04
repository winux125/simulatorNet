import { expect, test, type Page } from "@playwright/test";
import { openDeviceCli, openDeviceSection, openDeviceWindow } from "./helpers/device-window";

/**
 * M10.9 site-to-site VPN flows. Each test loads a VPN demo explicitly, runs the
 * bounded Auto drain, and reads the result back through the surfaces a learner
 * actually uses — the CLI, Packet Trace and the device VPN panel — so the
 * assertions stay honest about what the engine exposes.
 *
 * SimulatorNet models deterministic educational GRE and site-to-site IPsec
 * behaviour; its simulated ESP/IKE implementation provides no real
 * cryptographic protection, and these flows never assert otherwise.
 */

async function loadDemo(page: Page, name: RegExp) {
  await page.getByRole("button", { name: "Load Demo Lab", exact: true }).click();
  await page.getByRole("button", { name }).click();
  await expect(page.getByRole("button", { name: "Load Demo Lab", exact: true })).toBeHidden();
}

async function openCli(page: Page, hostname: string) {
  await openDeviceCli(page, hostname);
}

async function focusTerminal(page: Page) {
  const tab = page.getByRole("tab", { name: /^Terminal/ });
  if (await tab.count() > 0) await tab.first().click();
}

async function runCli(page: Page, command: string) {
  await focusTerminal(page);
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

async function terminalText(page: Page): Promise<string> {
  await focusTerminal(page);
  return page.locator(".terminal-session.is-active").innerText();
}

async function expectTerminal(page: Page, pattern: RegExp) {
  await expect.poll(async () => terminalText(page), { timeout: 20_000 }).toMatch(pattern);
}

async function runAuto(page: Page) {
  await page.getByRole("tab", { name: /Packet trace/ }).click();
  const runAll = page.getByRole("button", { name: /Run All|Run until idle/i });
  if (await runAll.count() > 0 && await runAll.first().isEnabled()) await runAll.first().click();
}

async function selectTraceFilter(page: Page, protocol: string) {
  await page.getByRole("tab", { name: /Packet trace/ }).click();
  await page.getByLabel("Packet trace protocol filter").selectOption(protocol);
}

async function openDeviceTab(page: Page, hostname: string, tab: RegExp) {
  const window = await openDeviceWindow(page, hostname);
  await window.getByRole("tab", { name: tab }).click();
  return window;
}

/** Open VPN through Config and then select one of its focused subsections. */
async function openVpnSection(page: Page, hostname: string, name: string) {
  const window = await openDeviceSection(page, { hostname, topLevel: "Config", section: "VPN" });
  await window.getByRole("tablist", { name: "VPN sections" }).getByRole("tab", { name }).click();
  return { window, panel: window.getByRole("tabpanel", { name: `VPN ${name}` }) };
}

const DEMO_KEY = "simulatornet-site-vpn";

test.describe("Site-to-site VPN", () => {
  test("GRE carries IPv4 and IPv6 between the sites and survives export/import", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/");
    await loadDemo(page, /VPN: GRE Site-to-Site/);

    // 2-3. The tunnel is configured and reports itself operational.
    await openCli(page, "R1");
    await runCli(page, "enable");
    await runCli(page, "show interfaces tunnel");
    await expectTerminal(page, /Tunnel0 is up, line protocol is up/);
    await expectTerminal(page, /Tunnel source 203\.0\.113\.1 \(Gi0\/1\), destination 203\.0\.113\.6/);
    await expectTerminal(page, /Tunnel protection: none \(plain GRE\)/);
    await runCli(page, "show ip route");
    await expectTerminal(page, /10\.255\.0\.0/);

    // 4. Both address families reach the remote LAN across the overlay.
    await openCli(page, "PC-A");
    await runCli(page, "ping 10.2.0.10");
    await runAuto(page);
    await expectTerminal(page, /Sending 5, 100-byte ICMP Echos to 10\.2\.0\.10[\s\S]*Success rate is 100 percent/);
    await runCli(page, "ping 2001:db8:2::10");
    await runAuto(page);
    await expectTerminal(page, /2001:db8:2::10[\s\S]*Success rate is 100 percent/);

    // 5. The GRE trace shows encapsulation and decapsulation.
    await selectTraceFilter(page, "GRE");
    const table = page.locator(".packet-table");
    await expect(table).toContainText("gre-encapsulation-started");
    await expect(table).toContainText("gre-packet-sent");
    await expect(table).toContainText("gre-decapsulated");

    // 6. Export and re-import: the tunnel configuration survives the round trip
    // and the overlay still carries traffic.
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "File", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Save Lab(?! As)/ }).click();
    const exportedPath = await (await downloadPromise).path();
    expect(exportedPath).not.toBeNull();
    await page.locator("#load-lab-file").setInputFiles(exportedPath!);

    await openCli(page, "R1");
    await runCli(page, "enable");
    await runCli(page, "show interfaces tunnel");
    await expectTerminal(page, /Tunnel0 is up, line protocol is up/);
    await openCli(page, "PC-A");
    await runCli(page, "ping 10.2.0.10");
    await runAuto(page);
    await expectTerminal(page, /Success rate is 100 percent/);
  });

  test("GRE over IPsec establishes an SA and hides the inner HTTP exchange", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    await loadDemo(page, /VPN: GRE over IPsec/);
    await runAuto(page);

    // 3. IKE negotiation is visible as its own trace family.
    await selectTraceFilter(page, "IKE");
    const table = page.locator(".packet-table");
    await expect(table).toContainText("ike-negotiation-started");
    await expect(table).toContainText("ike-proposal-selected");
    await expect(table).toContainText("ike-authentication-succeeded");

    // 4. The SA pair is established on both ends.
    await openCli(page, "R1");
    await runCli(page, "enable");
    await runCli(page, "show crypto ikev2 sa");
    await expectTerminal(page, /ESTABLISHED/);
    await runCli(page, "show crypto ipsec sa");
    await expectTerminal(page, /inbound SA to 203\.0\.113\.6/);
    await expectTerminal(page, /outbound SA to 203\.0\.113\.6/);
    await runCli(page, "show crypto session");
    await expectTerminal(page, /Profile: SITE-VPN/);

    // 5. HTTP crosses the protected tunnel.
    await openCli(page, "PC-A");
    await runCli(page, "sim http get http://10.2.0.10/");
    await runAuto(page);
    await expectTerminal(page, /branch intranet over the protected tunnel/);

    // 6. ESP is visible; the inner HTTP conversation is not, anywhere on the
    // underlay. The provider only ever routed outer 203.0.113.x packets.
    await selectTraceFilter(page, "ESP");
    await expect(table).toContainText("esp-packet-protected");
    await expect(table).toContainText("esp-packet-unprotected");
    await selectTraceFilter(page, "HTTP");
    const httpRows = page.locator(".packet-table tbody tr");
    const httpCount = await httpRows.count();
    for (let index = 0; index < httpCount; index += 1) {
      // Only the two endpoints ever see HTTP; ISP never does.
      await expect(httpRows.nth(index)).not.toContainText("203.0.113.2");
      await expect(httpRows.nth(index)).not.toContainText("203.0.113.5");
    }

    // VPN runtime lives under Monitor, without adding another top-level tab.
    const window = await openDeviceSection(page, {
      hostname: "R1",
      topLevel: "Monitor",
      section: "VPN Sessions",
    });
    const tabs = await window.getByRole("tablist", { name: /R1 sections/ }).getByRole("tab").allInnerTexts();
    expect(tabs).toEqual(["Physical", "Config", "CLI", "Monitor", "Attributes"]);
    expect(tabs.filter((label) => label.includes("VPN"))).toEqual([]);
    const sections = window.getByRole("tablist", { name: "VPN sections" });
    await expect(sections.getByRole("tab")).toHaveText([
      "Tunnels", "IKE Peers", "IPsec Profiles", "Sessions", "Counters",
    ]);
    await sections.getByRole("tab", { name: "Sessions" }).click();
    const sessions = window.getByRole("tabpanel", { name: "VPN Sessions" });
    await expect(sessions).toContainText("outbound");
    await expect(sessions).toContainText("active");
    await expect(window).not.toContainText(DEMO_KEY);
  });

  test("a wrong key fails, the right key establishes, and the SA rekeys", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    await loadDemo(page, /VPN: Failure and Rekey/);
    await runAuto(page);

    // 1-2. The branch ships without a key, so authentication cannot succeed.
    await openCli(page, "R2");
    await runCli(page, "enable");
    await runCli(page, "show crypto ikev2 sa");
    await expectTerminal(page, /FAILED|DOWN/);
    await expectTerminal(page, /no-pre-shared-key|authentication-failed/);
    await openCli(page, "R1");
    await runCli(page, "enable");
    await runCli(page, "show interfaces tunnel");
    await expectTerminal(page, /Tunnel0 is down/);

    // 3. Set the correct key through the VPN panel. It is typed into a password
    // field, derived in the main thread, and never rendered back.
    const { window, panel } = await openVpnSection(page, "R2", "IKE Peers");
    await expect(panel).toContainText("not set");
    await panel.getByRole("button", { name: /Set Key|Reset Key/ }).first().click();
    await panel.getByLabel(/Pre-shared key for/).fill(DEMO_KEY);
    await panel.getByRole("button", { name: "Store Key" }).click();
    await expect(panel).toContainText("never displayed");
    await expect(panel).toContainText("configured");
    await expect(window).not.toContainText(DEMO_KEY);
    await window.getByRole("button", { name: "Close device window" }).click();

    // 4. The SA establishes and protected traffic flows.
    await runAuto(page);
    await openCli(page, "R1");
    await runCli(page, "clear crypto ikev2 sa");
    await runAuto(page);
    await runCli(page, "show crypto ikev2 sa");
    await expectTerminal(page, /ESTABLISHED/);
    await openCli(page, "PC-A");
    await runCli(page, "ping 10.2.0.10");
    await runAuto(page);
    await expectTerminal(page, /Success rate is 100 percent/);

    // 5. Advance virtual time past 90% of the 120 s lifetime and confirm the
    // deterministic rekey. IPsec keeps no periodic timer, so advancing the
    // clock is what makes the rekey due.
    await page.getByRole("menuitem", { name: "Simulation", exact: true }).click();
    await page.getByRole("menuitem", { name: "Advance Virtual Time" }).click();
    await page.getByRole("menuitem", { name: "5 minutes" }).click();
    await runAuto(page);
    await selectTraceFilter(page, "IPsec");
    const table = page.locator(".packet-table");
    await expect(table).toContainText("ipsec-sa-rekeyed");
    await openCli(page, "R1");
    await runCli(page, "show crypto ipsec sa");
    await expectTerminal(page, /generation 2/);

    // 6. Deny ESP on the underlay: protected traffic stops while IKE, which
    // runs over UDP 500, is still permitted.
    await openCli(page, "R1");
    await runCli(page, "configure terminal");
    await runCli(page, "interface Gi0/1");
    await runCli(page, "ip access-group BLOCK-ESP out");
    await runCli(page, "end");
    await openCli(page, "PC-A");
    await runCli(page, "ping 10.2.0.10");
    await runAuto(page);
    await expectTerminal(page, /Success rate is 0 percent/);
    await selectTraceFilter(page, "ACL");
    await expect(page.locator(".packet-table")).toContainText("acl-denied");
    // IKE runs over UDP 500, which the ACL still permits, so the session stays
    // up even though no protected packet gets through.
    await openCli(page, "R1");
    await runCli(page, "show crypto ikev2 sa");
    await expectTerminal(page, /ESTABLISHED/);

    // 7. Remove the binding and protected traffic flows again.
    await runCli(page, "configure terminal");
    await runCli(page, "interface Gi0/1");
    await runCli(page, "no ip access-group BLOCK-ESP out");
    await runCli(page, "end");
    await openCli(page, "PC-A");
    await runCli(page, "ping 10.2.0.10");
    await runAuto(page);
    await expectTerminal(page, /Success rate is 100 percent/);
  });
});
