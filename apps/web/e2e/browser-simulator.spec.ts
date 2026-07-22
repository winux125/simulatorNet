import { expect, test } from "@playwright/test";

test("demo lab runs DHCP, routed ping, trace, CLI and canonical export", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Load demo" }).click();
  await expect(page.getByText(/Worker: ready/i)).toBeVisible();

  await page.getByRole("button", { name: "Select PC1" }).click();
  await expect(page.getByLabel("CLI command")).toBeEnabled();
  await expect(page.getByText("192.168.10.10", { exact: true })).toBeVisible();
  await page.getByLabel("CLI command").fill("ping 192.168.20.10");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("terminal-transcript")).toContainText("Success rate is 100 percent");
  await expect(page.locator('[data-event-type="ping-success"]').first()).toBeVisible();

  await page.getByRole("button", { name: "Select SW1" }).click();
  await page.getByLabel("CLI command").fill("show vlan brief");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("terminal-transcript")).toContainText("10   STUDENTS");
  await expect(page.getByTestId("terminal-transcript")).toContainText("20   SERVERS");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save JSON" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("demo-router-on-a-stick.json");

  const savedPath = await download.path();
  expect(savedPath).not.toBeNull();
  await page.locator("#load-lab-file").setInputFiles(savedPath!);
  await expect(page.getByText("Select a running device")).toBeVisible();
  await page.getByRole("button", { name: "Select PC1" }).click();
  await page.getByLabel("CLI command").fill("ping 192.168.20.10");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("terminal-transcript")).toContainText("Success rate is 100 percent");
});
