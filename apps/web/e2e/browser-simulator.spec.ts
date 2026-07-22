import { expect, test } from "@playwright/test";

const visualIteration = process.env.VISUAL_ITERATION ?? "final";

test("professional workspace preserves the complete router-on-a-stick workflow", async ({ page }) => {
  const commandInput = () => page.locator('input[aria-label="CLI command"]:visible');
  const sendCommand = () => page.locator('.terminal-command button:visible');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-workspace-mode", "simulate");
  await expect(page.getByRole("navigation", { name: "Topology tools" })).toBeVisible();
  await page.keyboard.press("?");
  const shortcutsDialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(shortcutsDialog).toBeVisible();
  const closeShortcuts = shortcutsDialog.getByRole("button", { name: "Close dialog" });
  await closeShortcuts.focus();
  await expect(closeShortcuts).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(shortcutsDialog).toBeHidden();

  await page.getByRole("button", { name: "Load demo lab", exact: true }).click();
  await expect(page.getByText("VLAN Routing Lab", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  await page.getByLabel("Simulation toolbar").getByLabel("Fit topology").click();

  await page.getByRole("button", { name: "Select SW1" }).click();
  await page.getByRole("tab", { name: "Interfaces" }).click();
  await expect(page.getByRole("cell", { name: "Gi0/8" })).toBeVisible();
  await page.getByRole("button", { name: "Select SW1" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Open CLI/ }).click();
  await expect(page.getByRole("tab", { name: /SW1/ })).toBeVisible();
  await commandInput().fill("show vlan brief");
  await sendCommand().click();
  await expect(page.getByTestId("terminal-transcript")).toContainText("10   STUDENTS");
  await commandInput().fill("enable");
  await sendCommand().click();
  await commandInput().fill("configure terminal");
  await sendCommand().click();
  await commandInput().fill("hostname CORE-SW");
  await sendCommand().click();
  await commandInput().fill("end");
  await sendCommand().click();
  await expect(page.getByRole("button", { name: "Select CORE-SW" })).toBeVisible();

  await page.getByRole("button", { name: "Select PC1" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Open CLI/ }).click();
  await expect(page.getByRole("tab", { name: /PC1/ })).toBeVisible();
  await commandInput().fill("ping 192.168.20.10");
  await sendCommand().click();
  await expect(page.getByTestId("terminal-transcript")).toContainText("Success rate is 100 percent");
  await page.getByRole("tab", { name: /Events/ }).click();
  await expect(page.locator('[data-event-type="ping-success"]').first()).toBeVisible();
  await page.screenshot({ path: `/tmp/simulatornet-m6-${visualIteration}-1440x900.png`, animations: "disabled" });

  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-workspace-mode", "edit");
  const pcNode = page.locator('.react-flow__node[data-id="pc-1"]');
  const box = await pcNode.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 70, box!.y + box!.height / 2 + 25, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByText("Topology changes pending")).toBeVisible();
  await page.getByRole("button", { name: "Simulate" }).click();
  await page.getByRole("button", { name: "Apply & Rebuild" }).last().click();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-workspace-mode", "simulate");
  await expect(page.getByRole("button", { name: "Select CORE-SW" })).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByLabel("Export lab JSON").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("demo-router-on-a-stick.json");
  const savedPath = await download.path();
  expect(savedPath).not.toBeNull();
  await page.locator("#load-lab-file").setInputFiles(savedPath!);
  await expect(page.getByRole("button", { name: "Select CORE-SW" })).toBeVisible();
  await page.getByRole("button", { name: "Select PC1" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Open CLI/ }).click();
  await commandInput().fill("ping 192.168.20.10");
  await sendCommand().click();
  await expect(page.getByTestId("terminal-transcript")).toContainText("Success rate is 100 percent");

  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator("body")).toHaveJSProperty("scrollHeight", 720);
  await page.getByLabel("Simulation toolbar").getByLabel("Fit topology").click();
  await expect.poll(async () => {
    const canvas = await page.locator(".topology-panel").boundingBox();
    const router = await page.locator('.react-flow__node[data-id="router-1"]').boundingBox();
    return canvas && router ? router.x + router.width <= canvas.x + canvas.width + 1 : false;
  }).toBe(true);
  await page.screenshot({ path: `/tmp/simulatornet-m6-${visualIteration}-1280x720.png`, animations: "disabled" });
});
