import { expect, test, type Page } from "@playwright/test";

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
  await expect(inspector).toContainText(hostname);
  await inspector.getByRole("button", { name: /Open CLI/ }).click();
  await expect(page.getByRole("tab", { name: new RegExp(hostname) })).toBeVisible();
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
  await closeInspector(page);
  await page.getByRole("button", { name: `Select ${hostname}` }).dblclick();
  const window = page.getByRole("dialog", { name: new RegExp(`${hostname} device window`) });
  await expect(window).toBeVisible();
  await window.getByRole("tab", { name: tab }).click();
  return window;
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

    const counters = await openDeviceTab(page, "R1", /QoS Counters/);
    await expect(counters).toContainText("GUEST");
  });
});
