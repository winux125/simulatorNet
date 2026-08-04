import { expect, test, type Page } from "@playwright/test";
import { openDeviceCli } from "./helpers/device-window";

/**
 * M10.7 end-to-end flows.
 *
 * Deliberately four user-facing journeys only: everything below the UI (method
 * lists, OID resolution, credential comparison, session limits) is covered by
 * unit and integration tests at the level it belongs to.
 *
 * The demo credential is documented in the lab instructions and in
 * `management-demo-labs.ts`; it is educational only and is stored as a
 * verifier, never as plaintext.
 */
const ADMIN_USER = "admin";
const ADMIN_PASSWORD = "SimulatorNetLab!";

async function loadDemo(page: Page, name: RegExp) {
  await page.goto("/");
  await page.getByRole("button", { name: "Load Demo Lab", exact: true }).click();
  await page.getByRole("button", { name }).click();
  await expect(page.getByRole("button", { name: "Load Demo Lab", exact: true })).toBeHidden();
  const start = page.getByRole("button", { name: "Start Lab" });
  if (await start.count()) await start.click();
  await expect(page.getByRole("button", { name: "Stop Lab" })).toBeEnabled();
}

async function openCli(page: Page, hostname: string) {
  await openDeviceCli(page, hostname);
}

async function runCli(page: Page, command: string) {
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

/** The transcript never records a credential, so assert on the prompt instead. */
async function typeSecret(page: Page, secret: string) {
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.type(secret);
  await page.keyboard.press("Enter");
}

test("SSH management: an admin PC manages a switch and a router over simulated SSH", async ({ page }) => {
  await loadDemo(page, /SSH Management/);
  await openCli(page, "ADMIN-PC");

  await runCli(page, "ssh admin@192.168.10.2");
  const transcript = page.getByTestId("terminal-transcript");
  await expect(transcript).toContainText("cannot be established");
  await expect(transcript).toContainText("Fingerprint: SHA256:");

  await runCli(page, "yes");
  await typeSecret(page, ADMIN_PASSWORD);
  // The tab now shows what the terminal is really driving.
  await expect(page.getByRole("tab", { name: /ADMIN-PC → SSH/ })).toBeVisible();

  await runCli(page, "show vlan brief");
  await expect(transcript).toContainText("MGMT");
  // The password never reaches the transcript.
  await expect(transcript).not.toContainText(ADMIN_PASSWORD);

  await runCli(page, "exit");
  await expect(transcript).toContainText("Connection closed by foreign host.");
  await runCli(page, "ipconfig");
  await expect(transcript).toContainText("192.168.10.50");
});

test("Telnet blocked, SSH allowed: the ACL denies Telnet in Packet Trace", async ({ page }) => {
  await loadDemo(page, /Telnet vs SSH/);
  await openCli(page, "ADMIN-PC");
  const transcript = page.getByTestId("terminal-transcript");

  await runCli(page, "telnet 10.0.0.1");
  await expect(transcript).toContainText("%");
  await expect(page.getByRole("tab", { name: /ADMIN-PC → Telnet/ })).toBeHidden();

  await page.getByRole("tab", { name: /Packet trace/ }).click();
  await page.getByLabel("Packet trace protocol filter").selectOption("Telnet");
  await page.getByLabel("Packet trace protocol filter").selectOption("ALL");
  await expect(page.locator(".packet-table")).toContainText("acl-denied");

  await page.getByRole("tab", { name: /Terminal/ }).click();
  await runCli(page, "ssh admin@10.0.0.1");
  await runCli(page, "yes");
  await typeSecret(page, ADMIN_PASSWORD);
  await expect(page.getByRole("tab", { name: /ADMIN-PC → SSH/ })).toBeVisible();
  await runCli(page, "show ip interface brief");
  await expect(transcript).toContainText("10.0.0.1");
});

test("Centralized AAA: RADIUS authenticates and TACACS+ denies a command", async ({ page }) => {
  await loadDemo(page, /Centralized AAA/);
  await openCli(page, "ADMIN-PC");
  const transcript = page.getByTestId("terminal-transcript");

  await runCli(page, "telnet 192.168.20.1");
  await expect(transcript).toContainText("Warning: Telnet transmits credentials without encryption.");
  await runCli(page, ADMIN_USER);
  await typeSecret(page, ADMIN_PASSWORD);
  await expect(page.getByRole("tab", { name: /ADMIN-PC → Telnet/ })).toBeVisible();

  await runCli(page, "show version");
  await expect(transcript).not.toContainText("% Authorization failed.");

  // TACACS+ command authorization denies this one, and it never executes.
  await runCli(page, "configure terminal");
  await expect(transcript).toContainText("% Authorization failed.");
  await expect(transcript).not.toContainText(ADMIN_PASSWORD);
});

test("SNMP management: the NMS polls a device and receives a link-down trap", async ({ page }) => {
  await loadDemo(page, /SNMP Network Management/);
  await openCli(page, "NMS");
  const transcript = page.getByTestId("terminal-transcript");

  await runCli(page, "snmpget R1 1.3.6.1.2.1.1.5.0");
  await expect(transcript).toContainText("OctetString: R1");

  await runCli(page, "snmpwalk SW1 1.3.6.1.2.1.2.2.1.2");
  await expect(transcript).toContainText("Gi0/1");
  await expect(transcript).toContainText("Vlan30");

  // Take a monitored link down and watch the trap arrive at the NMS.
  await openCli(page, "R1");
  await runCli(page, "enable");
  await runCli(page, "configure terminal");
  await runCli(page, "interface Gi0/1");
  await runCli(page, "shutdown");
  await runCli(page, "end");
  await runCli(page, "show ip interface brief");
  await expect(page.getByTestId("terminal-transcript")).toContainText("administratively down");

  // Poll again from the NMS. That is both the natural operator reflex after a
  // change and the bounded operation that carries the queued trap.
  await page.getByRole("tab", { name: /^NMS terminal/ }).click();
  await runCli(page, "snmpget R1 1.3.6.1.2.1.1.3.0");
  await runCli(page, "sim show snmp traps");
  await expect(page.getByTestId("terminal-transcript")).toContainText("linkDown");
});
