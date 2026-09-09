/**
 * Native Packet Tracer import, end to end in a real browser.
 *
 * The fixtures are synthetic-format containers — real container geometry
 * carrying XML this project authored — so these flows run in CI without
 * redistributing any Cisco file. The decode happens in a Web Worker in the
 * page; nothing is uploaded, and no network request carries the file.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/packet-tracer/", import.meta.url));

function fixture(name: string): { name: string; mimeType: string; buffer: Buffer } {
  return { name, mimeType: "application/octet-stream", buffer: readFileSync(FIXTURES + name) };
}

async function openFixture(page: Page, name: string) {
  await page.goto("/");
  await page.locator("#load-lab-file").setInputFiles(fixture(name));
  const card = page.getByTestId("packet-tracer-import");
  await expect(card).toBeVisible();
  // The old boundary must never appear for a container that decodes.
  await expect(page.getByTestId("packet-tracer-migration")).toHaveCount(0);
  return card;
}

test("PKT Basic Import: decodes a lab and opens it on the canvas", async ({ page }) => {
  test.setTimeout(60_000);
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") requests.push(`${request.method()} ${request.url()}`);
  });

  const card = await openFixture(page, "basic-lab.pkt");
  await expect(card).toContainText("Packet Tracer file decoded");
  await expect(page.getByTestId("packet-tracer-version")).toHaveText("8.2.0.0400");
  await expect(card).toContainText("never sent to a server");
  // A .pkt holds one network, so there is nothing to choose.
  await expect(page.getByTestId("packet-tracer-networks")).toHaveCount(0);

  await page.getByTestId("packet-tracer-import-lab").click();
  await expect(page.getByRole("heading", { name: /Imported|Partially Imported/ })).toBeVisible();
  await page.getByTestId("import-open").click();

  await expect(page.getByTestId("import-wizard")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Select Switch0", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Select PC0", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Select PC1", exact: true })).toBeVisible();
  await expect(page.locator(".workspace-footer")).toContainText("3 devices");

  // The container was decoded in the page. Nothing was posted anywhere.
  expect(requests).toEqual([]);
});

test("PKT Configured Network: imported configuration reaches the device CLI", async ({ page }) => {
  test.setTimeout(90_000);
  const card = await openFixture(page, "configured-lab.pkt");
  // Two running-configs plus two addressed hosts.
  await expect(card.getByText("Configurations")).toBeVisible();

  await page.getByTestId("packet-tracer-review").click();
  await expect(page.getByTestId("import-mapping")).toBeVisible();
  await expect(page.getByLabel("Map R1")).toBeVisible();
  await expect(page.getByLabel("Map Switch0")).toBeVisible();

  await page.getByTestId("import-continue").click();
  await expect(page.getByTestId("import-warnings")).toBeVisible();
  await page.getByTestId("import-confirm").click();
  await expect(page.getByRole("heading", { name: /Imported|Partially Imported/ })).toBeVisible();
  await page.getByTestId("import-open").click();

  // An imported lab always opens stopped; starting it builds the runtime from
  // the configuration the import produced.
  await page.getByRole("button", { name: "Start Lab" }).click();

  // The address came from the source running-config, through the shared IOS
  // parser, and is present on the device the CLI actually runs.
  await page.getByRole("button", { name: "Select R1", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Open CLI/ }).click();
  await expect(page.locator(".xterm-host")).toBeVisible();
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.type("show ip interface brief");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("terminal-transcript")).toContainText("192.168.10.1");
  await expect(page.getByTestId("terminal-transcript")).toContainText("10.20.0.1");
});

test("PKA Activity Import: offers each network and never defaults to the answer", async ({ page }) => {
  test.setTimeout(90_000);
  const card = await openFixture(page, "activity.pka");
  await expect(card).toContainText("Connect two hosts through a switch");

  const chooser = page.getByTestId("packet-tracer-networks");
  await expect(chooser).toBeVisible();
  await expect(chooser).toContainText("Initial network");
  await expect(chooser).toContainText("Answer network");
  await expect(chooser).toContainText("Contains the completed solution");
  // The initial network is pre-selected; the answer never is.
  await expect(chooser.getByRole("radio").first()).toBeChecked();
  await expect(chooser.locator("label.is-selected")).toContainText("Initial network");

  // Choosing the answer re-decodes and says plainly what is being imported.
  await chooser.getByRole("radio").nth(1).check();
  await expect(page.getByText("This is the activity's answer network.", { exact: false })).toBeVisible();

  await page.getByTestId("packet-tracer-import-lab").click();
  await expect(page.getByRole("heading", { name: /Imported|Partially Imported/ })).toBeVisible();
  await page.getByTestId("import-open").click();
  // The answer network carries the third host the initial network lacks.
  await expect(page.locator(".workspace-footer")).toContainText("3 devices");
});
