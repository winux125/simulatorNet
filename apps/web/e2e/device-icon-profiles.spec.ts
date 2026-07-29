import { expect, test, type Page } from "@playwright/test";

type IconProfile = "Classic Lab" | "Education Flat" | "Minimal Network";
type Theme = "Light" | "Dark";

async function chooseIconProfile(page: Page, profile: IconProfile) {
  await page.getByRole("menuitem", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Device Icon Style", exact: true }).click();
  await page.getByRole("menuitemradio", { name: profile, exact: true }).click();
}

async function chooseTheme(page: Page, theme: Theme) {
  await page.getByRole("menuitem", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Theme", exact: true }).click();
  await page.getByRole("menuitemradio", { name: theme, exact: true }).click();
}

async function fit(page: Page) {
  await page.getByRole("button", { name: "Fit topology" }).click();
  await page.waitForTimeout(80);
}

async function topologyIdentity(page: Page) {
  const nodes = await page.locator(".device-node").evaluateAll((items) => items.map((item) => ({
    id: item.getAttribute("data-device-id"),
    type: item.querySelector("svg[data-device-type]")?.getAttribute("data-device-type"),
  })).sort((left, right) => (left.id ?? "").localeCompare(right.id ?? "")));
  const links = await page.locator(".x6-edge [data-link-id]").evaluateAll((items) => items.map((item) => ({
    id: item.getAttribute("data-link-id"),
    sourceDevice: item.getAttribute("data-source-device"),
    sourceInterface: item.getAttribute("data-source-interface"),
    targetDevice: item.getAttribute("data-target-device"),
    targetInterface: item.getAttribute("data-target-interface"),
  })).sort((left, right) => (left.id ?? "").localeCompare(right.id ?? "")));
  return { nodes, links };
}

async function visiblePortMarkers(page: Page) {
  return page.locator(".topology-graph [port]").evaluateAll((ports) => ports.filter((port) => {
    const shape = port.matches("circle, rect, path, ellipse")
      ? port
      : port.querySelector("circle, rect, path, ellipse");
    if (!shape) return false;
    const style = window.getComputedStyle(shape);
    const painted = (value: string) =>
      value !== "none" && value !== "transparent" && value !== "rgba(0, 0, 0, 0)";
    return style.display !== "none"
      && style.visibility !== "hidden"
      && Number(style.opacity) !== 0
      && (painted(style.fill) || (painted(style.stroke) && Number.parseFloat(style.strokeWidth) > 0));
  }).map((port) => port.getAttribute("port")));
}

async function capture(page: Page, profile: IconProfile, theme: Theme, path: string) {
  await chooseIconProfile(page, profile);
  await chooseTheme(page, theme);
  await fit(page);
  const profileId = profile === "Classic Lab" ? "classic" : profile === "Education Flat" ? "education" : "minimal";
  await expect(page.locator(`.device-node .device-icon[data-profile="${profileId}"]`)).toHaveCount(15);
  await page.screenshot({ path, animations: "disabled" });
}

test("built-in icon profiles remain presentation-only across a running all-devices lab", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem("simulatornet.theme", "light");
    localStorage.setItem("simulatornet.deviceIconProfile", "classic");
    localStorage.setItem("simulatornet.bottomPanelState", "minimized");
    localStorage.setItem("simulatornet.wirelessAssociations", "show");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Load Demo Lab", exact: true }).click();
  const demoDialog = page.getByRole("dialog", { name: "Load demo laboratory" });
  const demoButtons = demoDialog.locator(".demo-lab-list > button");
  await expect(demoDialog.locator(".demo-lab-list .device-icon")).toHaveCount(await demoButtons.count());
  await page.getByRole("button", { name: /All Devices Icon Laboratory/ }).click();
  await expect(page.locator(".device-node")).toHaveCount(15);
  await fit(page);

  const original = await topologyIdentity(page);
  expect(original.nodes.map((node) => node.type).sort()).toEqual([
    "access-point", "bridge", "cloud", "external-appliance", "firewall",
    "hub", "l2-switch", "l3-switch", "laptop", "pc", "router", "server",
    "smartphone", "traffic-generator", "wireless-router",
  ]);
  await expect(page.locator("[data-wireless-association]")).toHaveCount(2);
  expect(await visiblePortMarkers(page)).toEqual([]);

  for (const [profile, profileId] of [
    ["Classic Lab", "classic"],
    ["Education Flat", "education"],
    ["Minimal Network", "minimal"],
  ] as const) {
    await chooseIconProfile(page, profile);
    await expect(page.locator(`.device-icon[data-profile="${profileId}"]`)).toHaveCount(15);
    for (const type of ["router", "l2-switch", "l3-switch", "pc", "server", "access-point", "wireless-router"]) {
      await expect(page.locator(`.device-icon[data-device-type="${type}"][data-profile="${profileId}"] use`))
        .toHaveAttribute("href", new RegExp(`/${profileId}/${type}\\.svg.*#device-icon$`));
    }
    expect(await topologyIdentity(page)).toEqual(original);
    await expect(page.locator("[data-wireless-association]")).toHaveCount(2);
    expect(await visiblePortMarkers(page)).toEqual([]);
  }

  await capture(page, "Classic Lab", "Light", "/tmp/classic-light-1440x900.png");
  await capture(page, "Classic Lab", "Dark", "/tmp/classic-dark-1440x900.png");
  await capture(page, "Education Flat", "Light", "/tmp/education-light-1440x900.png");
  await capture(page, "Education Flat", "Dark", "/tmp/education-dark-1440x900.png");
  await capture(page, "Minimal Network", "Light", "/tmp/minimal-light-1440x900.png");
  await capture(page, "Minimal Network", "Dark", "/tmp/minimal-dark-1440x900.png");
  await page.setViewportSize({ width: 1920, height: 1080 });
  await capture(page, "Classic Lab", "Light", "/tmp/classic-light-1920x1080.png");

  if (await page.getByRole("button", { name: "Start Lab" }).isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Start Lab" }).click();
  }
  await expect(page.getByRole("button", { name: "Stop Lab" })).toBeVisible();
  await page.getByRole("button", { name: "Select PC1" }).click();
  await page.getByRole("region", { name: "Inspector" }).getByRole("button", { name: /Open CLI/ }).click();
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.type("ping 192.168.77.20");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("terminal-transcript")).toContainText("Success rate is 100 percent");

  await chooseIconProfile(page, "Minimal Network");
  await expect(page.getByRole("tab", { name: /PC1 terminal/ })).toBeVisible();
  await expect(page.getByText("Pending topology changes")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Apply Topology" })).toHaveCount(0);
  expect(await topologyIdentity(page)).toEqual(original);
  await expect(page.locator("[data-wireless-association]")).toHaveCount(2);
  expect(await visiblePortMarkers(page)).toEqual([]);

  await page.setViewportSize({ width: 1280, height: 720 });
  await fit(page);
  await expect(page.locator(".device-node .device-icon[data-profile=\"minimal\"]")).toHaveCount(15);
  await expect(page.getByRole("button", { name: "Stop Lab" })).toBeVisible();
  expect(await visiblePortMarkers(page)).toEqual([]);
  await page.screenshot({
    path: "/tmp/icon-profiles-1280x720-review.png",
    animations: "disabled",
  });
});
