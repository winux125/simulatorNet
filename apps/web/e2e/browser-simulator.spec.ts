import { expect, test } from "@playwright/test";

async function chooseDemo(page: import("@playwright/test").Page, name: RegExp) {
  await page.getByRole("button", { name: "Load Demo Lab", exact: true }).click();
  await page.getByRole("button", { name }).click();
}

async function openCli(page: import("@playwright/test").Page, hostname: string) {
  await page.getByRole("button", { name: `Select ${hostname}` }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Open CLI/ }).click();
  await expect(page.getByRole("tab", { name: new RegExp(hostname) })).toBeVisible();
}

async function runCli(page: import("@playwright/test").Page, command: string) {
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

test("M8.3 desktop menus drive the browser lab with an xterm-native CLI", async ({ page }) => {
  const menu = (label: string) => page.getByRole("menuitem", { name: label, exact: true });
  const theme = page.getByLabel("Color theme");
  const shell = page.locator(".app-shell");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  // 1. Welcome workspace.
  await expect(page.getByRole("heading", { name: "SimulatorNet" })).toBeVisible();
  await expect(theme).toHaveValue("system");

  // 2. File → Load Demo Lab.
  await menu("File").click();
  await page.getByRole("menuitem", { name: "Load Demo Lab" }).click();
  await page.getByRole("button", { name: /Router-on-a-stick \+ DHCP/ }).click();
  await expect(page.getByText("VLAN Routing Lab", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".react-flow__minimap")).toHaveCount(0);

  // 3. Lab menu → toggle Edit then Simulate mode.
  await menu("Lab").click();
  await page.getByRole("menuitemradio", { name: "Edit Mode" }).click();
  await expect(shell).toHaveAttribute("data-workspace-mode", "edit");
  await menu("Lab").click();
  await page.getByRole("menuitemradio", { name: "Simulate Mode" }).click();
  await expect(shell).toHaveAttribute("data-workspace-mode", "simulate");

  // 4. Device context menu → open the PC terminal.
  await page.getByRole("button", { name: "Select PC1" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Open CLI/ }).click();
  await expect(page.getByRole("tab", { name: /PC1/ })).toBeVisible();
  await expect(page.getByText("PC1 connected")).toBeVisible();

  // 5-7. Type directly into xterm, repair the octet with ArrowLeft + Backspace, run.
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.type("ping 192.168.20.100");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("terminal-transcript")).toContainText("ping 192.168.20.10");
  await expect(page.getByTestId("terminal-transcript")).toContainText("Success rate is 100 percent");

  // 8. View menu → hide and restore the Inspector.
  await menu("View").click();
  await page.getByRole("menuitem", { name: "Hide Inspector" }).click();
  await expect(page.locator(".inspector-panel")).toHaveCount(0);
  await menu("View").click();
  await page.getByRole("menuitem", { name: "Show Inspector" }).click();
  await expect(page.locator(".inspector-panel").first()).toBeVisible();

  // 9. Simulation menu → Run Until Idle.
  await menu("Simulation").click();
  await page.getByRole("menuitem", { name: /Run Until Idle/ }).click();

  // 10. File menu → export the canonical lab (browser download).
  const download = page.waitForEvent("download");
  await menu("File").click();
  await page.getByRole("menuitem", { name: /Save \/ Export Lab/ }).click();
  expect((await download).suggestedFilename()).toContain(".json");

  // Dark/light review screenshots.
  await theme.selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: "/tmp/m8-3-dark-1440x900.png", animations: "disabled" });
  await theme.selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: "/tmp/m8-3-light-1440x900.png", animations: "disabled" });
});

test("M10.1 Hub and Bridge demos expose deterministic forwarding behavior", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  await chooseDemo(page, /Hub Ethernet Basics/);
  await expect(page.getByText("Hub Ethernet Basics", { exact: true }).first()).toBeVisible();
  await page.getByLabel("Color theme").selectOption("dark");
  await page.screenshot({ path: "/tmp/m10-1-hub-dark-1440x900.png", animations: "disabled" });
  await openCli(page, "PC1");
  await runCli(page, "ping 192.168.10.20");
  await expect(page.getByTestId("terminal-transcript")).toContainText("Success rate is 100 percent");
  await page.getByRole("tab", { name: /Events/ }).click();
  await expect(page.locator('tr[data-event-type="hub-frame-repeated"]').first()).toBeVisible();

  await page.getByRole("menuitem", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Load Demo Lab" }).click();
  await page.getByRole("button", { name: /Bridge MAC Learning/ }).click();
  await openCli(page, "PC1");
  await runCli(page, "ping 192.168.30.20");
  await expect(page.getByTestId("terminal-transcript")).toContainText("Success rate is 100 percent");
  await openCli(page, "BR1");
  await runCli(page, "show mac address-table");
  await expect(page.getByTestId("terminal-transcript").last()).toContainText("Mac Address");
  await expect(page.getByTestId("terminal-transcript").last()).toContainText("Eth0/1");
});

test("M10.1 L3 Switch CLI configures SVIs and routes inter-VLAN ping", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await chooseDemo(page, /L3 Switch Inter-VLAN Routing/);
  await page.getByLabel("Color theme").selectOption("dark");
  await page.screenshot({ path: "/tmp/m10-1-l3-dark-1280x720.png", animations: "disabled" });
  await openCli(page, "DSW1");

  for (const command of [
    "enable",
    "configure terminal",
    "interface Gi0/1",
    "switchport",
    "switchport mode access",
    "switchport access vlan 10",
    "no shutdown",
    "exit",
    "interface Gi0/2",
    "switchport",
    "switchport mode access",
    "switchport access vlan 20",
    "no shutdown",
    "exit",
    "interface vlan 10",
    "ip address 192.168.10.1 255.255.255.0",
    "no shutdown",
    "exit",
    "interface vlan 20",
    "ip address 192.168.20.1 255.255.255.0",
    "no shutdown",
    "exit",
    "ip routing",
    "end",
    "show ip route",
  ]) await runCli(page, command);

  await expect(page.getByTestId("terminal-transcript")).toContainText("192.168.10.0/24");
  await expect(page.getByTestId("terminal-transcript")).toContainText("Vlan10");
  await openCli(page, "PC1");
  await runCli(page, "ping 192.168.20.10");
  await expect(page.getByTestId("terminal-transcript").last()).toContainText("Success rate is 100 percent");
  await page.getByLabel("Color theme").selectOption("light");
  await page.screenshot({ path: "/tmp/m10-1-l3-light-1280x720.png", animations: "disabled" });
});

test("M10.2 DNS and HTTP traverse UDP/TCP and expose Server service UI", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await chooseDemo(page, /DNS \+ Web Services/);
  await expect(page.getByLabel("Enabled services: DNS, HTTP")).toBeVisible();

  await openCli(page, "PC1");
  await runCli(page, "nslookup portal.lab");
  await expect(page.getByTestId("terminal-transcript")).toContainText("Address: 172.20.10.10");
  await runCli(page, "http get http://172.20.10.10/");
  await expect(page.getByTestId("terminal-transcript")).toContainText("HTTP/1.1 200");
  await expect(page.getByTestId("terminal-transcript")).toContainText("Welcome to SimulatorNet");

  await page.getByRole("button", { name: "Select SRV1" }).click();
  await page.getByRole("tab", { name: "Configuration" }).click();
  await expect(page.getByLabel("Server services")).toBeVisible();
  await expect(page.getByLabel("DNS records")).toHaveValue(/portal\.lab/);
  await page.getByRole("tab", { name: /Packet trace/ }).click();
  await page.getByLabel("Packet trace protocol filter").selectOption("HTTP");
  await expect(page.locator('tr[data-event-type="http-response"]').first()).toBeVisible();

  await page.getByLabel("Color theme").selectOption("dark");
  await page.screenshot({ path: "/tmp/m10-2-dns-http-dark-1440x900.png", animations: "disabled" });
  await page.getByLabel("Color theme").selectOption("light");
  await page.screenshot({ path: "/tmp/m10-2-dns-http-light-1440x900.png", animations: "disabled" });
});

test("M10.2 TFTP, NTP, and Syslog workflows retain bounded runtime state", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await chooseDemo(page, /TFTP Configuration Backup/);
  await openCli(page, "PC1");
  await runCli(page, "tftp get 172.20.10.10 branch-r1.cfg");
  await expect(page.getByTestId("terminal-transcript")).toContainText("branch-r1.cfg");

  await page.getByRole("menuitem", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Load Demo Lab" }).click();
  await page.getByRole("button", { name: /NTP \+ Syslog Operations/ }).click();
  await openCli(page, "PC1");
  await runCli(page, "ntp query 172.20.10.10");
  await expect(page.getByTestId("terminal-transcript")).toContainText("NTP server time");
  await runCli(page, "syslog send 172.20.10.10 warning uplink changed");
  await expect(page.getByTestId("terminal-transcript")).toContainText("message sent");

  await page.getByRole("button", { name: "Select SRV1" }).click();
  await page.getByRole("tab", { name: "Runtime" }).click();
  await expect(page.getByText("Syslog messages")).toBeVisible();
  await expect(page.getByTestId("inspector").getByText("uplink changed", { exact: true })).toBeVisible();
  await page.getByLabel("Color theme").selectOption("dark");
  await page.screenshot({ path: "/tmp/m10-2-services-dark-1280x720.png", animations: "disabled" });
  await page.getByLabel("Color theme").selectOption("light");
  await page.screenshot({ path: "/tmp/m10-2-services-light-1280x720.png", animations: "disabled" });
});

test("M8 launch exchange strips the code and exposes organization session controls", async ({ page }) => {
  const launchCode = "launch-secret-that-must-disappear";
  await page.route("**/v1/session/launch-exchange", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ code: launchCode });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "set-cookie": "simulatornet_session=opaque; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800" },
      body: JSON.stringify({
        user: { id: "user-1", displayName: "KAI Student" },
        organization: { id: "org-1", name: "KAI Development" },
        role: "student",
        returnUrl: "https://academy.kai.kz/course/ccna",
      }),
    });
  });
  await page.route("**/v1/session/logout", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ loggedOut: true }) }));

  await page.goto(`/launch?code=${launchCode}`);
  await expect(page).toHaveURL("http://127.0.0.1:4173/");
  await expect(page.getByLabel("Authenticated organization session")).toContainText("KAI Student");
  await expect(page.getByLabel("Authenticated organization session")).toContainText("KAI Development");
  expect(page.url()).not.toContain(launchCode);
  await page.getByLabel("Log out organization session").click();
  await expect(page.getByText("Anonymous", { exact: true })).toBeVisible();
  await expect(page.getByText("Local Lab", { exact: true })).toBeVisible();
});
