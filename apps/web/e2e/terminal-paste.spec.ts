import { expect, test, type Locator, type Page } from "@playwright/test";
import { openDeviceSection } from "./helpers/device-window";

async function closeInspector(page: Page) {
  const inspector = page.getByRole("region", { name: "Inspector" });
  if (await inspector.isVisible().catch(() => false)) {
    await inspector.getByRole("button", { name: "Close inspector" }).click();
  }
}

async function loadRouterDemo(page: Page) {
  await page.getByRole("menuitem", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Load Demo Lab" }).click();
  await page.getByRole("button", { name: /Router-on-a-stick \+ DHCP/ }).click();
  await expect(page.getByTestId("topology-graph")).toBeVisible();
}

async function openCli(page: Page, device: string) {
  await closeInspector(page);
  await page.getByRole("button", { name: `Select ${device}` }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Open CLI/ }).click();
}

/**
 * Deliver clipboard text through the real browser paste event on the terminal
 * container — the same path Ctrl/Cmd+V, Shift+Insert and middle-click use.
 */
async function pasteIntoTerminal(host: Locator, text: string) {
  await host.evaluate((element, value) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", value);
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, text);
}

test("pastes single and bulk commands into the shared terminal", async ({ page, context }) => {
  test.setTimeout(150_000);
  // Copying from the terminal uses the Clipboard API after a user action.
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await loadRouterDemo(page);

  // 1. Open the Router terminal.
  await openCli(page, "R1");
  const rows = page.locator(".terminal-session.is-active .xterm-rows");
  const host = page.locator(".terminal-session.is-active .xterm-host");
  await expect(rows).toContainText("R1>", { timeout: 20_000 });

  // 2/3. A paste without a newline appears in the input line but does not run.
  await pasteIntoTerminal(host, "show ip route");
  await expect(rows).toContainText("R1> show ip route");
  await expect(page.getByTestId("terminal-transcript")).not.toContainText("Gateway of last resort");

  // 4/5. The user presses Enter, then copies the resulting output.
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("terminal-transcript")).toContainText("192.168.10.0");
  await page.getByRole("button", { name: "Copy terminal selection" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("192.168.10.0");
  // Copying must not raise a workspace problem or move the dock off Terminal.
  await expect(page.getByRole("tab", { name: /R1 terminal/ })).toBeVisible();

  // 6/7/8/9. A multi-line paste confirms first, then runs each line in order.
  await pasteIntoTerminal(host, [
    "enable",
    "configure terminal",
    "interface Gi0/1",
    "description Uplink",
    "no shutdown",
    "end",
    "show ip interface brief",
    "",
  ].join("\n"));
  const confirm = page.getByRole("dialog", { name: /^Paste 7 commands into R1/ });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("description Uplink");
  await confirm.getByRole("button", { name: "Paste Commands" }).click();

  await expect(page.getByTestId("terminal-transcript")).toContainText("Gi0/1", { timeout: 20_000 });
  await expect(rows).toContainText("R1#");
  // Modes really changed while the sequence ran.
  await expect(page.getByTestId("terminal-transcript")).toContainText("R1(config-if)#");

  // History received the pasted commands individually; ArrowDown returns the
  // input line to empty so the next paste starts from a clean prompt.
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.press("ArrowUp");
  await expect(rows).toContainText("R1# show ip interface brief");
  await page.keyboard.press("ArrowDown");

  // 10/11/12/13. A sequence that reaches an interactive prompt pauses.
  await pasteIntoTerminal(host, "ping\nshow ip route\n");
  await page.getByRole("dialog", { name: /^Paste 2 commands into R1/ })
    .getByRole("button", { name: "Paste Commands" }).click();
  await expect(rows).toContainText("Target IP address:");
  await expect(page.locator(".terminal-paste-run")).toContainText("paused");

  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.type("192.168.10.1");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("terminal-transcript")).toContainText("Success rate", { timeout: 20_000 });
  await page.getByRole("button", { name: "Continue Paste" }).click();
  await expect(page.locator(".terminal-paste-run")).toHaveCount(0, { timeout: 20_000 });

  await page.screenshot({ path: "/tmp/m10-4-1-terminal-paste-1440x900.png", fullPage: true });
});

test("keeps a pasted password invisible and survives presentation changes", async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await loadRouterDemo(page);

  // 14. Configure a console login on R1.
  await closeInspector(page);
  const win = await openDeviceSection(page, {
    hostname: "R1",
    topLevel: "Config",
    section: "Console Access",
  });
  await page.getByTestId("console-mode").selectOption("password-only");
  const consolePassword = page.getByRole("group", { name: /^Console password/ });
  await consolePassword.getByLabel("Console password").fill("paste-secret");
  await consolePassword.getByRole("button", { name: "Set", exact: true }).click();
  await expect(page.getByTestId("console-access-panel")).toContainText("configured");
  // The plaintext password is never shown back.
  await expect(page.getByTestId("console-access-panel")).not.toContainText("paste-secret");

  // 15. Reopen the terminal: the login gate is in front of the CLI.
  await win.getByRole("tab", { name: "CLI" }).click();
  await win.getByRole("button", { name: "Open in Terminal Workspace" }).click();
  const rows = page.locator(".terminal-session.is-active .xterm-rows");
  const host = page.locator(".terminal-session.is-active .xterm-host");
  const transcript = page.getByTestId("terminal-transcript");
  await expect(rows).toContainText(/ssword:/, { timeout: 20_000 });

  // 16/17. Paste the password: it is never echoed, but it authenticates.
  await pasteIntoTerminal(host, "paste-secret");
  await expect(transcript).not.toContainText("paste-secret");
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.press("Enter");
  await expect(rows).toContainText("R1>", { timeout: 20_000 });
  await expect(transcript).not.toContainText("paste-secret");

  // 18/19. Float the terminal and paste another command into the same session.
  await page.getByRole("button", { name: "Float terminal" }).click();
  const terminal = page.locator(".terminal-presentation");
  await expect(terminal).toHaveAttribute("data-presentation-mode", "floating");
  await pasteIntoTerminal(page.locator(".terminal-session.is-active .xterm-host"), "show ip route");
  await expect(rows).toContainText("R1> show ip route");

  // 20. Maximizing keeps the same buffer and session.
  await page.getByRole("button", { name: "Maximize terminal" }).click();
  await expect(terminal).toHaveAttribute("data-presentation-mode", "maximized");
  await expect(rows).toContainText("R1> show ip route");
  await expect(page.getByRole("tab", { name: /R1 terminal/ })).toHaveCount(1);

  // 21. The terminal right-click menu offers the paste actions.
  await page.locator(".terminal-session.is-active .xterm-host").click({ button: "right" });
  const menu = page.getByRole("menu", { name: "R1 terminal actions" });
  await expect(menu).toBeVisible();
  for (const item of ["Copy", "Paste", "Select All", "Clear Terminal", "Search", "Close Tab"]) {
    await expect(menu.getByRole("menuitem", { name: item, exact: true })).toBeVisible();
  }

  // 22. Clear Terminal wipes the visible buffer only: the prompt, the tab, the
  // authenticated session and the pasted-but-unsubmitted input all survive.
  await menu.getByRole("menuitem", { name: "Clear Terminal", exact: true }).click();
  await expect(rows).toContainText("show ip route");
  await expect(page.getByRole("tab", { name: /R1 terminal/ })).toHaveCount(1);
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.press("Enter");
  await expect(rows).toContainText("192.168.10.0", { timeout: 20_000 });
});
