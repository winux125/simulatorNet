import { expect, type Locator, type Page } from "@playwright/test";

export type DeviceWindowTopLevel =
  | "Physical"
  | "Config"
  | "CLI"
  | "Monitor"
  | "Attributes"
  | "Desktop"
  | "Terminal"
  | "Services"
  | "Wireless"
  | "Apps";

export interface OpenDeviceSectionOptions {
  hostname: string;
  topLevel: DeviceWindowTopLevel;
  section?: string;
}

async function closeInspector(page: Page) {
  const inspector = page.getByRole("region", { name: "Inspector" });
  if (await inspector.isVisible().catch(() => false)) {
    await inspector.getByRole("button", { name: "Close inspector" }).click();
  }
}

export async function openDeviceWindow(page: Page, hostname: string): Promise<Locator> {
  const dialog = page.getByRole("dialog", { name: `${hostname} device window` });
  if (!await dialog.isVisible().catch(() => false)) {
    await closeInspector(page);
    await page.getByRole("button", { name: `Select ${hostname}`, exact: true }).dblclick();
  }
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function openDeviceSection(
  page: Page,
  { hostname, topLevel, section }: OpenDeviceSectionOptions,
): Promise<Locator> {
  const dialog = await openDeviceWindow(page, hostname);
  await dialog.getByRole("tab", { name: topLevel, exact: true }).click();
  if (!section) return dialog;

  const workspace = topLevel === "Config"
    ? "Configuration"
    : topLevel === "Monitor"
      ? "Monitor"
      : undefined;
  if (workspace) {
    const compact = dialog.getByRole("combobox", { name: `${workspace} section`, exact: true });
    if (await compact.isVisible().catch(() => false)) {
      // A grouped section renders as "<group> · <label>" in the compact select
      // but as a bare label on the rail, so callers always name the bare label.
      const value = await compact.evaluate((element, wanted) => {
        const options = [...(element as HTMLSelectElement).options];
        const match = options.find((option) => option.textContent?.trim() === wanted)
          ?? options.find((option) => option.textContent?.trim().endsWith(`· ${wanted}`));
        return match?.value;
      }, section);
      await compact.selectOption(value ?? { label: section });
      return dialog;
    }
    const navigation = dialog.getByRole("navigation", { name: `${workspace} sections` });
    if (await navigation.isVisible().catch(() => false)) {
      await navigation.getByRole("button", { name: section, exact: true }).click();
      return dialog;
    }
  }

  const sectionButton = dialog.getByRole("button", { name: section, exact: true });
  if (await sectionButton.first().isVisible().catch(() => false)) {
    await sectionButton.first().click();
    return dialog;
  }

  await expect(dialog.getByText(section, { exact: true }).first()).toBeVisible();
  return dialog;
}

export async function openDeviceCli(page: Page, hostname: string): Promise<void> {
  await closeInspector(page);
  await page.getByRole("button", { name: `Select ${hostname}`, exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Open CLI/ }).click();
  await expect(page.getByRole("tab", { name: new RegExp(`${hostname} terminal`, "i") })).toBeVisible();
}

export async function openDeviceInspector(page: Page, hostname: string): Promise<Locator> {
  await page.getByRole("button", { name: `Select ${hostname}`, exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Inspect", exact: true }).click();
  const inspector = page.getByRole("region", { name: "Inspector" });
  await expect(inspector).toBeVisible();
  await expect(inspector).toContainText(hostname);
  return inspector;
}
