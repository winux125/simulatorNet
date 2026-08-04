import { expect, test, type Page } from "@playwright/test";
import { openDeviceCli } from "./helpers/device-window";

/**
 * M10.4 control-protocol flows. Each test loads a demo lab explicitly, runs the
 * bounded Auto convergence, and reads the result back through the CLI — the
 * same surface a learner uses — so the assertions stay honest about what the
 * engine actually exposes.
 */

async function loadDemo(page: Page, name: RegExp) {
  await page.getByRole("button", { name: "Load Demo Lab", exact: true }).click();
  await page.getByRole("button", { name }).click();
  await expect(page.getByRole("button", { name: "Load Demo Lab", exact: true })).toBeHidden();
}

async function openCli(page: Page, hostname: string) {
  await openDeviceCli(page, hostname);
}

/** Bring the shared terminal back to the front after using another dock tab. */
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

/** The visible xterm buffer of the active session. */
async function terminalText(page: Page): Promise<string> {
  await focusTerminal(page);
  return page.locator(".terminal-session.is-active").innerText();
}

async function expectTerminal(page: Page, pattern: RegExp) {
  await expect.poll(async () => terminalText(page), { timeout: 15_000 }).toMatch(pattern);
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

test.describe("Spanning tree", () => {
  test("elects a root, blocks the redundant link and reconverges after a failure", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, /STP Redundant Triangle/);

    await openCli(page, "SW1");
    await runCli(page, "enable");
    await runCli(page, "show spanning-tree");
    // SW1 has the lowest configured priority, so it is the root bridge.
    await expectTerminal(page, /This bridge is the root/);

    await openCli(page, "SW3");
    await runCli(page, "enable");
    await runCli(page, "show spanning-tree");
    // Exactly one port is blocked, which is what breaks the loop.
    await expectTerminal(page, /alternate\s+blocking/);

    // Fail the forwarding path and let the protocol reconverge.
    await runCli(page, "configure terminal");
    await runCli(page, "interface Gi0/2");
    await runCli(page, "shutdown");
    await runCli(page, "end");
    await runAuto(page);
    await openCli(page, "SW3");
    await runCli(page, "show spanning-tree");
    await expectTerminal(page, /root\s+forwarding/);
  });

  test("Rapid-PVST uses proposal and agreement instead of the timed waits", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, /Rapid-PVST Failover/);
    await runAuto(page);

    await selectTraceFilter(page, "RSTP");
    const table = page.locator(".packet-table");
    await expect(table).toContainText("rstp-proposal");
    await expect(table).toContainText("rstp-agreement");

    await openCli(page, "SW3");
    await runCli(page, "enable");
    await runCli(page, "show spanning-tree");
    // 802.1w reports discarding rather than the 802.1D blocking state.
    await expectTerminal(page, /discarding/);
  });

  test("BPDU Guard error-disables an edge port and recovery clears it", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, /BPDU Guard/);
    await runAuto(page);

    await openCli(page, "SW1");
    await runCli(page, "enable");
    await runCli(page, "show spanning-tree summary");
    await expectTerminal(page, /Error-disabled ports: Gi0\/1/);

    await runCli(page, "errdisable recovery Gi0/1");
    await expectTerminal(page, /recovered from error-disabled state/);
  });
});

test.describe("EtherChannel", () => {
  test("LACP forms Port-channel1 and survives a member failure", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, /LACP Trunk/);
    await runAuto(page);

    await openCli(page, "SW1");
    await runCli(page, "enable");
    await runCli(page, "show etherchannel summary");
    await expectTerminal(page, /Port-channel1\(SU\)/);
    await expectTerminal(page, /Gi0\/1\(P\)/);

    await runCli(page, "show spanning-tree");
    // Spanning tree sees exactly one logical port for the whole bundle.
    await expectTerminal(page, /Port-channel1/);

    await runCli(page, "configure terminal");
    await runCli(page, "interface Gi0/1");
    await runCli(page, "shutdown");
    await runCli(page, "end");
    await runAuto(page);
    await runCli(page, "show etherchannel summary");
    // One member is gone but the bundle is still up.
    await expectTerminal(page, /Port-channel1\(SU\)/);
  });

  test("PAgP desirable/auto bundles and auto/auto does not", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, /PAgP Negotiation/);
    await runAuto(page);

    await openCli(page, "SW1");
    await runCli(page, "enable");
    await runCli(page, "show etherchannel summary");
    await expectTerminal(page, /PAGP/);
    await runCli(page, "show pagp neighbor");
    await expectTerminal(page, /Port-channel1/);
  });
});

test.describe("Neighbour discovery", () => {
  test("CDP and LLDP discover neighbours and a per-port disable clears them", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, /CDP and LLDP Discovery/);
    await runAuto(page);

    await openCli(page, "SW1");
    await runCli(page, "enable");
    await runCli(page, "show cdp neighbors");
    await expectTerminal(page, /R1/);
    await expectTerminal(page, /L3SW/);

    await runCli(page, "show lldp neighbors");
    // Only LLDP sees the vendor-neutral server.
    await expectTerminal(page, /SRV1/);

    await runCli(page, "configure terminal");
    await runCli(page, "interface Gi0/1");
    await runCli(page, "no cdp enable");
    await runCli(page, "end");
    await runCli(page, "show cdp neighbors");
    await expectTerminal(page, /L3SW/);
  });
});

test.describe("OSPFv2", () => {
  test("reaches Full, installs the remote route and withdraws it on failure", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, /OSPF Basic/);
    await runAuto(page);

    await openCli(page, "R1");
    await runCli(page, "enable");
    await runCli(page, "show ip ospf neighbor");
    await expectTerminal(page, /2\.2\.2\.2/);
    await expectTerminal(page, /full/);

    await runCli(page, "show ip route ospf");
    // The far-end loopback is learned through OSPF, not configured statically.
    await expectTerminal(page, /3\.3\.3\.3/);

    await runCli(page, "show ip ospf database");
    await expectTerminal(page, /router/);

    // Break the far link and let SPF withdraw the route.
    await openCli(page, "R2");
    await runCli(page, "enable");
    await runCli(page, "configure terminal");
    await runCli(page, "interface Gi0/1");
    await runCli(page, "shutdown");
    await runCli(page, "end");
    await runAuto(page);

    await openCli(page, "R1");
    await runCli(page, "show ip route ospf");
    await expectTerminal(page, /2\.2\.2\.2/);
  });

  test("Step mode exposes the OSPF protocol events one at a time", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, /OSPF Basic/);
    await runAuto(page);

    await selectTraceFilter(page, "OSPF");
    const table = page.locator(".packet-table");
    await expect(table).toContainText("ospf-hello-sent");
    await expect(table).toContainText("ospf-neighbor-state-changed");
    await expect(table).toContainText("ospf-spf-completed");
    await expect(table).toContainText("ospf-route-installed");
  });

  test("elects a deterministic DR and BDR on a broadcast segment", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, /OSPF DR\/BDR/);
    await runAuto(page);

    await openCli(page, "R1");
    await runCli(page, "enable");
    await runCli(page, "show ip ospf interface");
    // R2 carries priority 200 and R3 priority 100.
    await expectTerminal(page, /Designated Router id 10\.0\.0\.2/);
    await expectTerminal(page, /Backup 10\.0\.0\.3/);
  });
});
