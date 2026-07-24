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

test("imports a Containerlab topology through the wizard", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await page.locator("#load-lab-file").setInputFiles({ name: "office.clab.yml", mimeType: "text/yaml", buffer: Buffer.from(CLAB) });

  await expect(page.getByTestId("import-wizard")).toBeVisible();
  await expect(page.getByTestId("import-mapping")).toBeVisible();
  // The unknown srl node is offered as a placeholder mapping.
  await expect(page.getByLabel("Map fw1")).toBeVisible();

  await page.getByTestId("import-confirm").click();
  await expect(page.getByTestId("import-wizard")).toHaveCount(0);
  // The imported lab opens (stopped) with its devices on the canvas.
  await expect(page.locator(".canvas-statusbar")).toContainText(/\d+ device/);
});

test("shows an honest diagnostic for a Packet Tracer file", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await page.locator("#load-lab-file").setInputFiles({ name: "lab.pkt", mimeType: "application/octet-stream", buffer: Buffer.from([0, 1, 2, 3, 0]) });
  await expect(page.getByTestId("import-unsupported")).toContainText(/Packet Tracer/i);
  // No lab was created: the welcome workspace is still shown.
  await expect(page.getByRole("button", { name: "Import Lab" })).toBeVisible();
});
