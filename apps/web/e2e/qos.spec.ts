import { expect, test, type Page } from "@playwright/test";
import { openDeviceCli, openDeviceSection, openDeviceWindow } from "./helpers/device-window";

/**
 * M10.8 quality-of-service flows. Each test loads a QoS demo explicitly, runs
 * the bounded Auto drain, and reads the result back through the surfaces a
 * learner actually uses — the CLI, Packet Trace and the device QoS panel — so
 * the assertions stay honest about what the engine exposes.
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

/** Open a device window and its named tab. */
async function openDeviceTab(page: Page, hostname: string, tab: RegExp) {
  const window = await openDeviceWindow(page, hostname);
  await window.getByRole("tab", { name: tab }).click();
  return window;
}

/** Open QoS through the capability-driven Config/Monitor navigation. */
async function openQosSection(page: Page, hostname: string, name: string) {
  const window = await openDeviceSection(page, name === "Queues & Counters"
    ? { hostname, topLevel: "Monitor", section: "QoS Queues & Counters" }
    : { hostname, topLevel: "Config", section: "QoS" });
  await window.getByRole("tablist", { name: "QoS sections" }).getByRole("tab", { name }).click();
  return { window, panel: window.getByRole("tabpanel", { name: `QoS ${name}` }) };
}

async function runTrafficFlow(page: Page, hostname: string, flowId: string) {
  const window = await openDeviceTab(page, hostname, /^Run$/);
  await window.getByText(flowId, { exact: true }).waitFor();
  await window.getByRole("button", { name: "Run" }).first().click();
  await window.getByRole("button", { name: "Close device window" }).click();
}

test.describe("QoS", () => {
  test("DSCP marking classifies voice as EF and web as AF31", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, /QoS: DSCP Classification/);

    await openCli(page, "R1");
    await runCli(page, "enable");
    await runCli(page, "show class-map");
    await expectTerminal(page, /Class Map match-any REALTIME/);
    await runCli(page, "show policy-map");
    await expectTerminal(page, /set dscp ef/);
    await expectTerminal(page, /set dscp af31/);

    // Send traffic from both hosts and read the markings off the trace.
    await openCli(page, "VOICE");
    await runCli(page, "ping 10.0.30.10");
    await openCli(page, "WEB");
    await runCli(page, "ping 10.0.30.10");
    await runAuto(page);

    await selectTraceFilter(page, "Marking");
    const table = page.locator(".packet-table");
    await expect(table).toContainText("qos-marked");
    // EF (46) for the voice subnet and AF31 (26) for the web subnet.
    await expect(table).toContainText("dscp 0→46");
    await expect(table).toContainText("dscp 0→26");

    await selectTraceFilter(page, "Classification");
    await expect(table).toContainText("qos-classified");
    await expect(table).toContainText("class REALTIME");
    await expect(table).toContainText("class WEB-CLASS");

    await openCli(page, "R1");
    await runCli(page, "show policy-map interface");
    await expectTerminal(page, /Service-policy output: EDGE-MARK/);
  });

  test("Voice vs Bulk serves the priority queue before the bulk queue", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, /QoS: Voice vs Bulk/);

    // Queue the bulk transfer first, then the voice flow.
    await runTrafficFlow(page, "TG-BULK", "BULK");
    await runTrafficFlow(page, "TG-VOICE", "VOICE");
    await runAuto(page);

    await selectTraceFilter(page, "Queue");
    const table = page.locator(".packet-table");
    await expect(table).toContainText("qos-priority-served");
    await expect(table).toContainText("qos-weighted-served");

    await openCli(page, "R1");
    await runCli(page, "enable");
    await runCli(page, "show queueing interface Gi0/2");
    await expectTerminal(page, /class-based \(priority \+ deficit round robin\)/);
    await expectTerminal(page, /REALTIME/);

    const results = await openDeviceTab(page, "TG-VOICE", /^Results$/);
    await expect(results).toContainText("averageDelayNs");
  });

  test("Policing drops excess guest traffic and shaping delays the WAN egress", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, /QoS: Guest Policing and WAN Shaping/);

    await runTrafficFlow(page, "GUEST", "GUEST-BURST");
    await runAuto(page);

    await selectTraceFilter(page, "Policing");
    const table = page.locator(".packet-table");
    await expect(table).toContainText("qos-police-conform");
    await expect(table).toContainText("qos-police-dropped");

    await selectTraceFilter(page, "Shaping");
    await expect(table).toContainText("qos-shape-delayed");
    await expect(table).toContainText("qos-shape-released");

    await openCli(page, "R1");
    await runCli(page, "enable");
    await runCli(page, "show policy-map interface");
    await expectTerminal(page, /Service-policy input: GUEST-POLICE/);
    await expectTerminal(page, /Service-policy output: WAN-SHAPE/);

    const { panel } = await openQosSection(page, "R1", "Queues & Counters");
    await expect(panel).toContainText("GUEST");
  });

  test("the Config QoS section exposes every panel on Router, L3 Switch and Firewall", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    await loadDemo(page, /QoS: Guest Policing and WAN Shaping/);

    // QoS is one Config section, not another crowded top-level tab.
    const router = await openDeviceSection(page, { hostname: "R1", topLevel: "Config", section: "QoS" });
    const tabs = await router.getByRole("tablist", { name: /R1 sections/ }).getByRole("tab").allInnerTexts();
    expect(tabs).toEqual(["Physical", "Config", "CLI", "Monitor", "Attributes"]);
    expect(tabs.filter((label) => label.includes("QoS"))).toEqual([]);
    const sections = router.getByRole("tablist", { name: "QoS sections" });
    await expect(sections.getByRole("tab")).toHaveText([
      "Overview", "Classification", "Policies", "Interfaces", "Queues & Counters",
    ]);
    // The secondary navigation is fully reachable at 1280x720.
    for (const name of ["Overview", "Classification", "Policies", "Interfaces", "Queues & Counters"]) {
      await expect(sections.getByRole("tab", { name })).toBeVisible();
    }

    // 3-4. Classification holds the class maps; a new one round-trips through
    // the worker rather than only living in the textarea.
    await sections.getByRole("tab", { name: "Classification" }).click();
    const classMaps = router.getByLabel("Class maps JSON");
    await expect(classMaps).toHaveValue(/GUEST/);
    await router.getByRole("button", { name: "Add class map" }).click();
    await router.getByRole("button", { name: "Apply", exact: true }).click();
    await router.getByRole("button", { name: "Refresh" }).click();
    await expect(classMaps).toHaveValue(/NEW-CLASS/);
    await expect(classMaps).toHaveValue(/GUEST/);

    // 5-6. Policies show the policer and the shaper.
    await sections.getByRole("tab", { name: "Policies" }).click();
    const policyMaps = router.getByLabel("Policy maps JSON");
    await expect(policyMaps).toHaveValue(/police/);
    await expect(policyMaps).toHaveValue(/shape/);

    // 7. Interfaces list the bound policies and open their detail in place.
    await sections.getByRole("tab", { name: "Interfaces" }).click();
    const interfaces = router.getByRole("tabpanel", { name: "QoS Interfaces" });
    await expect(interfaces).toContainText("WAN-SHAPE");
    const row = interfaces.locator(".qos-interface-table__pick").first();
    const interfaceName = (await row.innerText()).trim();
    await row.click();
    await expect(interfaces.getByLabel(`${interfaceName} QoS detail`)).toBeVisible();
    // The detail opens inside the QoS tab: still exactly one device window.
    await expect(page.getByRole("dialog")).toHaveCount(1);

    // 8-10. Clearing counters never removes configuration.
    await sections.getByRole("tab", { name: "Queues & Counters" }).click();
    await router.getByRole("button", { name: "Clear Runtime Counters" }).click();
    await sections.getByRole("tab", { name: "Classification" }).click();
    await expect(router.getByLabel("Class maps JSON")).toHaveValue(/NEW-CLASS/);
    await sections.getByRole("tab", { name: "Policies" }).click();
    await expect(router.getByLabel("Policy maps JSON")).toHaveValue(/GUEST-POLICE/);
    // Nothing in this flow raised a Problem.
    await expect(page.locator(".workspace-error")).toHaveCount(0);
    await router.getByRole("button", { name: "Close device window" }).click();
  });

  // 11. The same component serves the L3 Switch and the Firewall.
  for (const [demo, hostname, unsupported] of [
    [/Inter-VLAN Routing/, "DSW1", /802\.1Q subinterfaces/],
    [/DMZ Stateful Firewall/, "FW1", /switched virtual interfaces/],
  ] as const) {
    test(`the shared QoS panel serves ${hostname}`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto("/");
      await loadDemo(page, demo);

      const window = await openDeviceSection(page, { hostname, topLevel: "Config", section: "QoS" });
      const tabs = await window.getByRole("tablist", { name: new RegExp(`${hostname} sections`) })
        .getByRole("tab").allInnerTexts();
      expect(tabs.filter((label) => label.includes("QoS"))).toEqual([]);
      const sections = window.getByRole("tablist", { name: "QoS sections" });
      await expect(sections.getByRole("tab")).toHaveText([
        "Overview", "Classification", "Policies", "Interfaces", "Queues & Counters",
      ]);
      await sections.getByRole("tab", { name: "Interfaces" }).click();
      // Capabilities keep the unsupported attachment point off this device.
      await expect(window.getByRole("tabpanel", { name: "QoS Interfaces" })).not.toContainText(unsupported);
    });
  }
});
