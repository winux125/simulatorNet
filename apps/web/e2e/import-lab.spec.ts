import { expect, test } from "@playwright/test";

const CLAB = [
  "name: office",
  "topology:",
  "  nodes:",
  "    r1: { kind: vr-csr }",
  "    sw1: { kind: bridge }",
  "    fw1: { kind: srl }",
  "  links:",
  '    - endpoints: ["r1:eth1", "sw1:eth1"]',
  '    - endpoints: ["sw1:eth2", "fw1:e1-1"]',
  "",
].join("\n");

function largePnetlabFixture(count: number): string {
  const nodes = Array.from({ length: count }, (_, index) => (
    `<node id="${index + 1}" name="PC${index + 1}" type="qemu" template="vpcs" left="${(index % 10) * 90}" top="${Math.floor(index / 10) * 70}"><interface id="0" name="e0" network_id="${index + 1}"/></node>`
  )).join("");
  const networks = Array.from({ length: count }, (_, index) => `<network id="${index + 1}" type="bridge" name="Net${index + 1}"/>`).join("");
  return `<?xml version="1.0"?><lab name="Large PNETLab" version="1"><topology><nodes>${nodes}</nodes><networks>${networks}</networks></topology></lab>`;
}

async function expectFooterInsideViewport(page: import("@playwright/test").Page) {
  const bounds = await page.getByTestId("import-wizard-footer").boundingBox();
  const viewport = page.viewportSize();
  expect(bounds).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport!.height);
}

test("imports a Containerlab topology through the wizard", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await page.locator("#load-lab-file").setInputFiles({ name: "office.clab.yml", mimeType: "text/yaml", buffer: Buffer.from(CLAB) });

  await expect(page.getByTestId("import-wizard")).toBeVisible();
  await expect(page.getByText(/Inspection complete/i)).toBeVisible();
  await page.getByTestId("import-continue").click();
  await expect(page.getByRole("heading", { name: "Review detected content" })).toBeVisible();
  await page.getByTestId("import-continue").click();
  await expect(page.getByTestId("import-mapping")).toBeVisible();
  // The unknown srl node is offered as a placeholder mapping.
  await expect(page.getByLabel("Map fw1")).toBeVisible();

  await page.getByTestId("import-continue").click();
  await expect(page.getByTestId("import-warnings")).toBeVisible();
  await page.getByTestId("import-confirm").click();
  await expect(page.getByRole("heading", { name: /Imported|Partially Imported/ })).toBeVisible();
  await page.getByTestId("import-open").click();
  await expect(page.getByTestId("import-wizard")).toHaveCount(0);
  // The imported lab opens (stopped) with its devices on the canvas.
  await expect(page.locator(".canvas-statusbar")).toContainText(/\d+ device/);
});

test("large PNETLab mapping keeps its footer and final rows reachable", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.addInitScript(() => localStorage.setItem("simulatornet.theme", "light"));
  await page.goto("/");
  await page.locator("#load-lab-file").setInputFiles({
    name: "large.unl",
    mimeType: "application/xml",
    buffer: Buffer.from(largePnetlabFixture(100)),
  });

  await expect(page.getByText(/Inspection complete/i)).toBeVisible();
  await expectFooterInsideViewport(page);
  await page.getByTestId("import-continue").click();
  await page.getByTestId("import-continue").click();
  await expect(page.getByLabel("Map PC100")).toBeAttached();
  await page.getByLabel("Map PC100").scrollIntoViewIfNeeded();
  await expect(page.getByLabel("Map PC100")).toBeVisible();
  await page.getByLabel("Map PC100").selectOption("device:pc");
  await expectFooterInsideViewport(page);
  await page.screenshot({ path: "/tmp/m10-3-2-import-light-1280x720.png", animations: "disabled" });

  const overflow = await page.getByTestId("import-wizard").evaluate((wizard) => {
    const body = wizard.querySelector<HTMLElement>('[data-scroll-owner="import-wizard-body"]')!;
    const footer = wizard.querySelector<HTMLElement>('[data-testid="import-wizard-footer"]')!;
    const style = getComputedStyle(body);
    return {
      wizardOverflow: getComputedStyle(wizard).overflow,
      bodyOverflowY: style.overflowY,
      footerBottom: footer.getBoundingClientRect().bottom,
      viewportHeight: window.innerHeight,
    };
  });
  expect(overflow.wizardOverflow).toBe("hidden");
  expect(overflow.bodyOverflowY).toBe("auto");
  expect(overflow.footerBottom).toBeLessThanOrEqual(overflow.viewportHeight);

  await page.getByTestId("import-continue").click();
  await expect(page.getByText("Device Mapping Warnings")).toBeVisible();
  await page.getByText("Device Mapping Warnings").click();
  await page.getByTestId("import-confirm").click();
  await expect(page.getByTestId("import-open")).toBeVisible();
});

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
]) {
  test(`import dialog fits ${viewport.width}x${viewport.height} in dark mode`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => localStorage.setItem("simulatornet.theme", "dark"));
    await page.goto("/");
    await page.locator("#load-lab-file").setInputFiles({ name: "office.clab.yml", mimeType: "text/yaml", buffer: Buffer.from(CLAB) });
    await expect(page.getByText(/Inspection complete/i)).toBeVisible();
    await expectFooterInsideViewport(page);
    const wizard = await page.getByTestId("import-wizard").boundingBox();
    expect(wizard).not.toBeNull();
    expect(wizard!.x).toBeGreaterThanOrEqual(0);
    expect(wizard!.x + wizard!.width).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({
      path: `/tmp/m10-3-2-import-dark-${viewport.width}x${viewport.height}.png`,
      animations: "disabled",
    });
  });
}

test("narrow mapping uses cards without clipping its selector", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 720 });
  await page.goto("/");
  await page.locator("#load-lab-file").setInputFiles({ name: "office.clab.yml", mimeType: "text/yaml", buffer: Buffer.from(CLAB) });
  await expect(page.getByText(/Inspection complete/i)).toBeVisible();
  await page.getByTestId("import-continue").click();
  await page.getByTestId("import-continue").click();
  const selector = page.getByLabel("Map fw1");
  await expect(selector).toBeVisible();
  const bounds = await selector.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(800);
  await expectFooterInsideViewport(page);
});

test("workspace scroll ownership stays on the narrow content regions", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await page.getByRole("button", { name: "Load Demo Lab", exact: true }).click();
  await page.getByRole("button", { name: /DNS \+ Web Services/ }).click();

  const pageGeometry = await page.evaluate(() => ({
    bodyOverflow: getComputedStyle(document.body).overflow,
    bodyHeight: document.body.scrollHeight,
    viewportHeight: window.innerHeight,
  }));
  expect(pageGeometry.bodyOverflow).toBe("hidden");
  expect(pageGeometry.bodyHeight).toBeLessThanOrEqual(pageGeometry.viewportHeight);

  // IP Configuration lives under Config; its footer actions must stay on screen
  // at 1280x720 while the form body — not an ancestor — owns the scrolling.
  await page.getByRole("button", { name: "Select PC1" }).dblclick();
  const pcWindow = page.getByRole("dialog", { name: "PC1 device window" });
  await pcWindow.getByRole("tab", { name: "Config", exact: true }).click();
  const ipFooter = pcWindow.locator(".host-ip-config > footer");
  await expect(ipFooter).toBeVisible();
  await expect(ipFooter.getByRole("button", { name: "Apply" })).toBeVisible();
  await expect(pcWindow.locator(".host-ip-config__body")).toHaveCSS("overflow-y", "auto");
  const [windowBounds, footerBounds] = await Promise.all([pcWindow.boundingBox(), ipFooter.boundingBox()]);
  expect(windowBounds).not.toBeNull();
  expect(footerBounds).not.toBeNull();
  expect(footerBounds!.y + footerBounds!.height).toBeLessThanOrEqual(windowBounds!.y + windowBounds!.height);
  expect(footerBounds!.y + footerBounds!.height).toBeLessThanOrEqual(720);
  const ipScrollOwners = await pcWindow.locator(".host-ip-config__body").evaluate((leaf) => {
    const owners: string[] = [];
    let element: HTMLElement | null = leaf as HTMLElement;
    while (element) {
      if (/(auto|scroll)/.test(getComputedStyle(element).overflowY)) owners.push(element.className);
      if (element.getAttribute("role") === "dialog") break;
      element = element.parentElement;
    }
    return owners;
  });
  expect(ipScrollOwners).toEqual(["host-ip-config__body"]);
  await pcWindow.getByRole("button", { name: "Close device window" }).click();

  await page.getByRole("button", { name: "Select PC1" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Open CLI/ }).click();
  await expect(page.locator(".xterm-host")).toBeVisible();
  await expect(page.getByLabel("Workspace bottom panel")).toHaveCSS("overflow", "hidden");
  await expect(page.locator(".terminal-workspace")).toHaveCSS("overflow", "hidden");
  await expect(page.locator(".xterm-host")).toHaveCSS("overflow", "hidden");
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.type("ping 172.20.10.10");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("terminal-transcript")).toContainText("Success rate is 100 percent");

  await page.getByRole("tab", { name: /^Events/ }).click();
  await expect(page.locator(".dock-table-wrap")).toHaveCSS("overflow", "auto");
  await page.getByRole("tab", { name: /Packet trace/ }).click();
  await expect(page.locator(".dock-table-wrap")).toHaveCSS("overflow", "auto");
  await page.getByRole("tab", { name: /^Problems/ }).click();
  if (await page.locator(".problems-view").count()) {
    await expect(page.locator(".problems-view")).toHaveCSS("overflow", "auto");
  } else {
    await expect(page.getByText("No problems detected")).toBeVisible();
  }

  const inspector = page.getByRole("region", { name: "Inspector" });
  if (await inspector.isVisible().catch(() => false)) {
    await inspector.getByRole("button", { name: "Close inspector" }).click();
  }
  await page.getByRole("button", { name: "Select SRV1" }).dblclick();
  const serverWindow = page.getByRole("dialog", { name: "SRV1 device window" });
  await serverWindow.getByRole("tab", { name: "Services" }).click();
  await expect(serverWindow.locator(".device-window__content")).toHaveCSS("overflow", "hidden");
  await expect(serverWindow.locator(".server-services")).toHaveCSS("overflow", "auto");
  const scrollOwners = await serverWindow.locator(".server-services").evaluate((leaf) => {
    const owners: string[] = [];
    let element: HTMLElement | null = leaf as HTMLElement;
    while (element) {
      if (/(auto|scroll)/.test(getComputedStyle(element).overflowY)) owners.push(element.className);
      if (element.getAttribute("role") === "dialog") break;
      element = element.parentElement;
    }
    return owners;
  });
  expect(scrollOwners).toHaveLength(1);
});

test("shows an honest diagnostic for a Packet Tracer file", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await page.locator("#load-lab-file").setInputFiles({ name: "lab.pkt", mimeType: "application/octet-stream", buffer: Buffer.from([0, 1, 2, 3, 0]) });
  await expect(page.getByTestId("import-unsupported")).toContainText(/Packet Tracer/i);
  // No lab was created: the welcome workspace is still shown.
  await expect(page.getByRole("button", { name: "Import Lab" })).toBeVisible();
});
