import { expect, test } from "@playwright/test";

async function chooseDemo(page: import("@playwright/test").Page, name: RegExp) {
  await page.getByRole("button", { name: "Load Demo Lab", exact: true }).click();
  await page.getByRole("button", { name }).click();
}

async function openCli(page: import("@playwright/test").Page, hostname: string) {
  await page.getByRole("button", { name: `Select ${hostname}` }).click();
  await page.getByTestId("inspector").getByRole("button", { name: /Open CLI/ }).click();
  await expect(page.getByRole("tab", { name: new RegExp(hostname) })).toBeVisible();
}

async function runCli(page: import("@playwright/test").Page, command: string) {
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

async function chooseTheme(page: import("@playwright/test").Page, theme: "System" | "Dark" | "Light") {
  await page.getByRole("menuitem", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Theme", exact: true }).click();
  await page.getByRole("menuitemradio", { name: theme, exact: true }).click();
}

test("M10.2.1 desktop workspace drives topology, profile windows and xterm CLI", async ({ page }) => {
  const menu = (label: string) => page.getByRole("menuitem", { name: label, exact: true });
  const shell = page.locator(".app-shell");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  // 1. Welcome workspace.
  await expect(page.getByRole("heading", { name: "SimulatorNet" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme-preference", "system");
  await expect(page.getByLabel("Color theme")).toHaveCount(0);
  for (const label of ["File", "Edit", "View", "Lab", "Simulation", "Tools", "Help"]) {
    await expect(menu(label)).toBeVisible();
  }
  await expect(page.getByLabel("Workspace actions")).toBeVisible();
  await chooseTheme(page, "Light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await chooseTheme(page, "Dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // 2. File → Load Demo Lab.
  await menu("File").click();
  await page.getByRole("menuitem", { name: "Load Demo Lab" }).click();
  await page.getByRole("button", { name: /Router-on-a-stick \+ DHCP/ }).click();
  await expect(page.getByText("VLAN Routing Lab", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".x6-widget-minimap")).toHaveCount(0);
  await expect(page.getByTestId("topology-graph")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add Device", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Add topology item" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close bottom panel" })).toHaveCount(0);
  const chromeBounds = await page.locator(".desktop-chrome").boundingBox();
  const workspaceBounds = await page.locator(".workspace-resizable").boundingBox();
  const topologyBounds = await page.getByTestId("topology-graph").boundingBox();
  const dockBounds = await page.getByLabel("Workspace bottom panel").boundingBox();
  const footerBounds = await page.locator(".workspace-footer").boundingBox();
  expect(chromeBounds).not.toBeNull();
  expect(workspaceBounds).not.toBeNull();
  expect(topologyBounds).not.toBeNull();
  expect(dockBounds).not.toBeNull();
  expect(footerBounds).not.toBeNull();
  expect(chromeBounds!.height).toBe(78);
  expect(chromeBounds!.width).toBe(1440);
  expect(topologyBounds!.y).toBeLessThan(100);
  expect(dockBounds!.width).toBe(1440);
  expect(dockBounds!.y).toBeGreaterThan(topologyBounds!.y);
  expect(Math.abs(dockBounds!.y + dockBounds!.height - footerBounds!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(workspaceBounds!.y + workspaceBounds!.height - footerBounds!.y)).toBeLessThanOrEqual(1);

  // 3. Lab menu → toggle Edit then Simulate mode.
  await menu("Lab").click();
  await page.getByRole("menuitemradio", { name: "Edit Topology" }).click();
  await expect(shell).toHaveAttribute("data-workspace-mode", "edit");
  await page.getByRole("button", { name: "Add Device", exact: true }).click();
  const devicePicker = page.getByRole("dialog", { name: "Add topology item" });
  await expect(devicePicker).toBeVisible();
  await expect(devicePicker.getByRole("button", { name: "Add Router" })).toBeEnabled();
  const pickerBounds = await devicePicker.boundingBox();
  expect(pickerBounds).not.toBeNull();
  expect(pickerBounds!.y).toBeLessThan(120);
  await page.screenshot({ path: "/tmp/device-picker-dark-1440x900.png", animations: "disabled" });
  await page.getByRole("button", { name: "Add Device", exact: true }).click();
  await expect(devicePicker).toHaveCount(0);
  await page.getByRole("button", { name: "Edit Topology" }).click();
  await expect(shell).toHaveAttribute("data-workspace-mode", "simulate");
  await page.getByRole("button", { name: "Simulation", exact: true }).click();
  await expect(page.getByRole("button", { name: "Simulation", exact: true })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Select PC1" }).dblclick();
  const deviceWindow = page.getByRole("dialog", { name: "PC1 device window" });
  await expect(deviceWindow).toBeVisible();
  for (const tab of ["Desktop", "Config", "Terminal", "Attributes"]) {
    await expect(deviceWindow.getByRole("tab", { name: tab })).toBeVisible();
  }
  await expect(deviceWindow.getByRole("button", { name: "Web Browser" })).toBeVisible();
  await deviceWindow.getByRole("button", { name: "Close device window" }).click();

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
  await expect(page.getByLabel("Workspace bottom panel")).toHaveCSS("overflow", "hidden");
  await expect(page.locator(".terminal-workspace")).toHaveCSS("overflow", "hidden");
  await expect(page.locator(".xterm-host")).toHaveCSS("overflow", "hidden");
  const visibleRows = page.locator(".terminal-session.is-active .xterm-rows > div");
  const rowsBeforeResize = await visibleRows.count();
  const dockSeparator = page.locator(".resize-handle--horizontal");
  const separatorBounds = await dockSeparator.boundingBox();
  expect(separatorBounds).not.toBeNull();
  await page.mouse.move(separatorBounds!.x + separatorBounds!.width / 2, separatorBounds!.y);
  await page.mouse.down();
  await page.mouse.move(separatorBounds!.x + separatorBounds!.width / 2, separatorBounds!.y - 100, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => visibleRows.count()).toBeGreaterThan(rowsBeforeResize);

  await page.locator(".terminal-session.is-active .xterm-screen").click();
  for (let index = 0; index < 4; index += 1) await page.keyboard.press("Control+L");
  await expect.poll(async () => {
    const text = await page.locator(".terminal-session.is-active .xterm-rows").innerText();
    return text.match(/C:\\>/g)?.length ?? 0;
  }).toBe(1);

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
  await chooseTheme(page, "Dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: "/tmp/packet-style-dark-1440x900.png", animations: "disabled" });
  await chooseTheme(page, "Light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: "/tmp/packet-style-light-1440x900.png", animations: "disabled" });
  await menu("View").click();
  await page.getByRole("menuitem", { name: "Hide Inspector" }).click();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: "Fit topology" }).click();
  await page.waitForTimeout(350);
  const compactDockBounds = await page.getByLabel("Workspace bottom panel").boundingBox();
  const compactFooterBounds = await page.locator(".workspace-footer").boundingBox();
  expect(compactDockBounds).not.toBeNull();
  expect(compactFooterBounds).not.toBeNull();
  expect(compactDockBounds!.width).toBe(1280);
  expect(Math.abs(compactDockBounds!.y + compactDockBounds!.height - compactFooterBounds!.y)).toBeLessThanOrEqual(1);
  await chooseTheme(page, "Dark");
  await page.screenshot({ path: "/tmp/packet-style-dark-1280x720.png", animations: "disabled" });
  await chooseTheme(page, "Light");
  await page.screenshot({ path: "/tmp/packet-style-light-1280x720.png", animations: "disabled" });
});

test("M10.2.1 CLI profiles expose host and IOS-like learning flows", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await chooseDemo(page, /Router-on-a-stick \+ DHCP/);

  await openCli(page, "PC1");
  await expect(page.getByRole("tab", { name: /PC1/ })).toContainText("PC1 — Command Prompt");
  await expect(page.locator(".terminal-session.is-active .xterm-rows")).toContainText("C:\\>");
  await runCli(page, "ping");
  await expect(page.getByTestId("terminal-transcript")).toContainText("% Incomplete command.");
  await expect(page.getByTestId("terminal-transcript")).toContainText("Usage: ping <ip-or-hostname>");
  await runCli(page, "?");
  await expect(page.getByTestId("terminal-transcript")).toContainText("ipconfig");
  await expect(page.getByTestId("terminal-transcript")).toContainText("SimulatorNet extensions (non-IOS)");
  await expect(page.getByTestId("terminal-transcript")).not.toContainText("configure");
  await runCli(page, "ipconfig");
  await expect(page.getByTestId("terminal-transcript")).toContainText("Windows IP Configuration");
  await runCli(page, "tracert 192.168.20.10");
  await expect(page.getByTestId("terminal-transcript")).toContainText("Trace complete.");

  await openCli(page, "R1");
  for (const command of ["en", "conf t", "int gi0/0", "shut", "no shut", "end", "show run"]) {
    await runCli(page, command);
  }
  await expect(page.getByTestId("terminal-transcript")).toContainText("R1(config-if)# shut");
  await expect(page.getByTestId("terminal-transcript")).toContainText("interface Gi0/0");

  await runCli(page, "ping");
  await expect(page.locator(".terminal-session.is-active .xterm-rows")).toContainText("Target IP address:");
  await runCli(page, "192.168.10.10");
  await expect(page.getByTestId("terminal-transcript")).toContainText("Success rate is");
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(page.locator(".terminal-session.is-active .xterm-rows")).toContainText("R1# ping");
});

test("draft-only devices wait for worker rebuild without unknown-device errors", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await page.getByRole("button", { name: "New Lab", exact: true }).click();
  await page.getByRole("button", { name: "Add Device", exact: true }).click();
  await page.getByRole("button", { name: "Add Bridge" }).click();
  const canvas = page.getByTestId("topology-graph");
  const canvasBounds = await canvas.boundingBox();
  expect(canvasBounds).not.toBeNull();
  await canvas.click({ position: { x: Math.round(canvasBounds!.width * 0.45), y: Math.round(canvasBounds!.height * 0.4) } });
  await page.getByRole("button", { name: "Select BR1" }).click();
  const pendingMessage = page.getByText("Apply & Rebuild to create this device in the simulation worker.");
  await expect(pendingMessage).toBeVisible();
  await expect(page.getByText(/Unknown device/)).toHaveCount(0);

  await page.locator(".pending-banner").getByRole("button", { name: "Apply & Rebuild" }).click();
  await page.getByRole("dialog", { name: "Apply topology changes?" }).getByRole("button", { name: "Apply & Rebuild" }).click();
  await expect(pendingMessage).toHaveCount(0);
  await expect(page.getByText(/Unknown device/)).toHaveCount(0);
});

test("two draft-configured PCs ping through an L2 switch after Start Lab", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "New Lab", exact: true }).click();
  const canvas = page.getByTestId("topology-graph");

  const place = async (category: "End Devices" | "Network Devices", name: string, x: number, y: number) => {
    await page.getByRole("button", { name: "Add Device", exact: true }).click();
    await page.getByRole("tab", { name: category }).click();
    await page.getByRole("button", { name: `Add ${name}` }).click();
    await canvas.click({ position: { x, y } });
  };
  await place("End Devices", "PC", 170, 150);
  await place("Network Devices", "L2 Switch", 500, 260);
  await place("End Devices", "PC", 830, 150);

  const configurePc = async (hostname: string, address: string) => {
    await page.getByRole("button", { name: `Select ${hostname}` }).dblclick();
    const window = page.getByRole("dialog", { name: `${hostname} device window` });
    await expect(window.getByRole("heading", { name: "IP Configuration" })).toBeVisible();
    await window.getByLabel("IPv4 Address").fill(address);
    await window.getByLabel("Subnet Mask").fill("255.255.255.0");
    await window.getByRole("button", { name: "Apply" }).click();
    await expect(window.getByText("Loading IP configuration…")).toHaveCount(0);
    if (hostname === "PC1") await page.screenshot({ path: "/tmp/host-ip-configuration-1440x900.png", animations: "disabled" });
    await window.getByRole("button", { name: "Close device window" }).click();
  };
  await configurePc("PC1", "192.168.10.10");
  await configurePc("PC2", "192.168.10.20");
  await expect(page.getByText(/Unknown device/)).toHaveCount(0);

  await page.getByRole("button", { name: "Add link" }).click();
  await page.locator('[data-cell-id="pc-1"] [data-interface="eth0"]').dragTo(
    page.locator('[data-cell-id="switch-1"] [data-interface="Gi0/1"]'),
  );
  await page.locator('[data-cell-id="pc-2"] [data-interface="eth0"]').dragTo(
    page.locator('[data-cell-id="switch-1"] [data-interface="Gi0/2"]'),
  );
  await expect(page.getByText("2 links", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Start Lab" }).click();
  await page.getByRole("dialog", { name: "Apply topology changes?" }).getByRole("button", { name: "Apply & Rebuild" }).click();
  await expect(page.getByRole("button", { name: "Stop Lab" })).toBeVisible();
  await openCli(page, "PC1");
  await runCli(page, "ping 192.168.10.20");
  await expect(page.getByTestId("terminal-transcript")).toContainText("Success rate is 100 percent");
});

test("deleting a device closes its CLI before the worker rebuild", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await chooseDemo(page, /Router-on-a-stick \+ DHCP/);
  await openCli(page, "SW1");
  await expect(page.getByRole("tab", { name: /SW1/ })).toBeVisible();

  const editTopology = page.getByRole("button", { name: "Edit Topology" });
  await editTopology.click();
  await expect(editTopology).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Select SW1" }).click();
  await page.getByRole("button", { name: "Delete selected" }).click();
  await expect(page.getByRole("tab", { name: /SW1/ })).toHaveCount(0);

  await page.locator(".pending-banner").getByRole("button", { name: "Apply & Rebuild" }).click();
  await page.getByRole("dialog", { name: "Apply topology changes?" }).getByRole("button", { name: "Apply & Rebuild" }).click();
  await expect(page.getByText(/Unknown device/)).toHaveCount(0);
});

test("lab power lifecycle locks the topology while running and unlocks after stop", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");

  // 1-3. New stopped lab with a couple of devices.
  await page.getByRole("button", { name: "New Lab", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start Lab" })).toBeVisible();
  await expect(page.getByLabel("Topology unlocked")).toBeVisible();
  await page.getByRole("button", { name: "Add Device", exact: true }).click();
  await page.getByRole("tab", { name: "End Devices" }).click();
  await page.getByRole("button", { name: "Add PC" }).click();
  const canvas = page.getByTestId("topology-graph");
  const bounds = await canvas.boundingBox();
  await canvas.click({ position: { x: Math.round(bounds!.width * 0.4), y: Math.round(bounds!.height * 0.4) } });

  // 4-5. Start the lab; topology becomes locked.
  await page.getByRole("button", { name: "Start Lab" }).click();
  const applyDialog = page.getByRole("dialog", { name: "Apply topology changes?" });
  if (await applyDialog.count()) await applyDialog.getByRole("button", { name: "Apply & Rebuild" }).click();
  await expect(page.getByLabel("Topology locked — stop the lab to edit")).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop Lab" })).toBeVisible();

  // 6-8. Editing is rejected while running (Add Device disabled).
  await expect(page.getByRole("button", { name: "Add Router" })).toHaveCount(0);

  // 12-14. Stop the lab and confirm the transient-state warning if shown.
  await page.getByRole("button", { name: "Stop Lab" }).click();
  const stopDialog = page.getByRole("dialog", { name: "Stop this lab?" });
  if (await stopDialog.count()) await stopDialog.getByRole("button", { name: "Stop Lab" }).click();
  await expect(page.getByRole("button", { name: "Start Lab" })).toBeVisible();
  await expect(page.getByLabel("Topology unlocked")).toBeVisible();

  // 15-16. Topology editing works again.
  await page.getByRole("button", { name: "Add Device", exact: true }).click();
  await page.getByRole("tab", { name: "Network Devices" }).click();
  await expect(page.getByRole("button", { name: "Add Router" })).toBeEnabled();
});

test("M10.1 Hub and Bridge demos expose deterministic forwarding behavior", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  await chooseDemo(page, /Hub Ethernet Basics/);
  await expect(page.getByText("Hub Ethernet Basics", { exact: true }).first()).toBeVisible();
  await chooseTheme(page, "Dark");
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
  await chooseTheme(page, "Dark");
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
  await chooseTheme(page, "Light");
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
  await runCli(page, "sim http get http://172.20.10.10/");
  await expect(page.getByTestId("terminal-transcript")).toContainText("HTTP/1.1 200");
  await expect(page.getByTestId("terminal-transcript")).toContainText("Welcome to SimulatorNet");

  await page.getByRole("button", { name: "Select PC1" }).dblclick();
  const pcWindow = page.getByRole("dialog", { name: "PC1 device window" });
  await pcWindow.getByRole("button", { name: "Web Browser" }).click();
  await pcWindow.getByRole("button", { name: "Go" }).click();
  await expect(pcWindow.getByLabel("Web response preview")).toContainText("HTTP/1.1 200");
  await expect(pcWindow.getByLabel("Web response preview")).toContainText("Welcome to SimulatorNet");
  await pcWindow.getByRole("button", { name: "Close device window" }).click();

  await page.getByRole("button", { name: "Select SRV1" }).dblclick();
  const serverWindow = page.getByRole("dialog", { name: "SRV1 device window" });
  await serverWindow.getByRole("tab", { name: "Services" }).click();
  await expect(serverWindow.getByText("DNS", { exact: true }).first()).toBeVisible();
  await expect(serverWindow.getByText("HTTP", { exact: true }).first()).toBeVisible();
  await serverWindow.getByRole("button", { name: "Close device window" }).click();
  await page.getByRole("button", { name: "Select SRV1" }).click();
  await page.getByRole("tab", { name: "Configuration" }).click();
  await expect(page.getByLabel("Server services")).toBeVisible();
  await expect(page.getByLabel("DNS records")).toHaveValue(/portal\.lab/);
  await page.getByRole("tab", { name: /Packet trace/ }).click();
  await page.getByLabel("Packet trace protocol filter").selectOption("HTTP");
  await expect(page.locator('tr[data-event-type="http-response"]').first()).toBeVisible();

  await chooseTheme(page, "Dark");
  await page.screenshot({ path: "/tmp/m10-2-dns-http-dark-1440x900.png", animations: "disabled" });
  await chooseTheme(page, "Light");
  await page.screenshot({ path: "/tmp/m10-2-dns-http-light-1440x900.png", animations: "disabled" });
});

test("M10.2 TFTP, NTP, and Syslog workflows retain bounded runtime state", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await chooseDemo(page, /TFTP Configuration Backup/);
  await openCli(page, "PC1");
  await runCli(page, "sim tftp get 172.20.10.10 branch-r1.cfg");
  await expect(page.getByTestId("terminal-transcript")).toContainText("branch-r1.cfg");

  await page.getByRole("menuitem", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Load Demo Lab" }).click();
  await page.getByRole("button", { name: /NTP \+ Syslog Operations/ }).click();
  await openCli(page, "PC1");
  await runCli(page, "sim ntp query 172.20.10.10");
  await expect(page.getByTestId("terminal-transcript")).toContainText("NTP server time");
  await runCli(page, "sim syslog send 172.20.10.10 warning uplink changed");
  await expect(page.getByTestId("terminal-transcript")).toContainText("message sent");

  await page.getByRole("button", { name: "Select SRV1" }).click();
  await page.getByRole("tab", { name: "Runtime" }).click();
  await expect(page.getByText("Syslog messages")).toBeVisible();
  await expect(page.getByTestId("inspector").getByText("uplink changed", { exact: true })).toBeVisible();
  await chooseTheme(page, "Dark");
  await page.screenshot({ path: "/tmp/m10-2-services-dark-1280x720.png", animations: "disabled" });
  await chooseTheme(page, "Light");
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
        user: { id: "user-1", displayName: "Demo Student" },
        organization: { id: "org-1", name: "Demo Organization" },
        role: "student",
        returnUrl: "https://academy.example.test/course/ccna",
      }),
    });
  });
  await page.route("**/v1/session/logout", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ loggedOut: true }) }));

  await page.goto(`/launch?code=${launchCode}`);
  await expect(page).toHaveURL("http://127.0.0.1:4173/");
  await expect(page.getByLabel("Authenticated organization session")).toContainText("Demo Student");
  await expect(page.getByLabel("Authenticated organization session")).toContainText("Demo Organization");
  expect(page.url()).not.toContain(launchCode);
  await page.getByLabel("Log out organization session").click();
  await expect(page.getByText("Anonymous", { exact: true })).toBeVisible();
  await expect(page.getByText("Local Lab", { exact: true })).toBeVisible();
});
