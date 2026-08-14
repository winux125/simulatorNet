import { expect, test, type Page } from "@playwright/test";
import { openDeviceCli, openDeviceSection } from "./helpers/device-window";

const ESI_A = "0000:0000:0000:0000:0001";
const ESI_B = "0000:0000:0000:0000:0002";

async function loadDemo(page: Page, name: string) {
  await page.getByRole("button", { name: "Load Demo Lab", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Load demo laboratory" });
  await dialog.getByRole("button").filter({ hasText: name }).click();
  await expect(page.getByRole("button", { name: "Load Demo Lab", exact: true })).toBeHidden();
}

async function runCli(page: Page, command: string) {
  const terminalTab = page.getByRole("tab", { name: /^Terminal/ });
  if (await terminalTab.count()) await terminalTab.first().click();
  await page.locator(".terminal-session.is-active .xterm-screen").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

async function expectTerminal(page: Page, pattern: RegExp) {
  await expect.poll(async () => page.locator(".terminal-session.is-active").innerText(), {
    timeout: 20_000,
  }).toMatch(pattern);
}

/** Drain the bounded deterministic events the operation needs, then continue. */
async function runAuto(page: Page) {
  await page.getByRole("tab", { name: /Packet trace/ }).click();
  const runAll = page.getByRole("button", { name: /Run All|Run until idle/i });
  if (await runAll.count() && await runAll.first().isEnabled()) await runAll.first().click();
}

/**
 * Re-run a `show` command until the fabric reports the state being waited for.
 *
 * The pattern must describe the *converged* row specifically, because a terminal
 * transcript accumulates: asserting the absence of an old value would never
 * settle, while a row that can only exist after convergence settles exactly once
 * the fabric has converged — which is the real readiness condition, not a sleep.
 */
async function pollShow(page: Page, command: string, converged: RegExp, timeout = 25_000) {
  await expect.poll(async () => {
    await runCli(page, command);
    return page.locator(".terminal-session.is-active").innerText();
  }, { timeout }).toMatch(converged);
}

/** Assert a Packet Trace filter, immediately after the action that fills it. */
async function expectTrace(page: Page, filter: string, pattern: RegExp) {
  await page.getByRole("tab", { name: /Packet trace/ }).click();
  await page.getByLabel("Packet trace protocol filter").selectOption(filter);
  await expect(page.locator(".packet-table")).toContainText(pattern);
}

test.describe("M10.17 EVPN All-Active multihoming", () => {
  test("aliasing gives a remote leaf two paths and survives losing one", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, "EVPN All-Active Aliasing");
    await runAuto(page);

    // Both leaves carry the same segment, in all-active mode.
    for (const leaf of ["LEAF1", "LEAF2"]) {
      const dialog = await openDeviceSection(page, {
        hostname: leaf,
        topLevel: "Monitor",
        section: "Ethernet Segments",
      });
      const segments = dialog.getByRole("tabpanel", { name: "VXLAN ethernet-segments" });
      await expect(segments.getByRole("row", { name: /ES-CE1/ })).toContainText(ESI_A);
      await expect(segments.getByRole("row", { name: /ES-CE1/ })).toContainText("All Active");
      await dialog.getByRole("button", { name: "Close device window", exact: true }).click();
    }

    // Traffic across the fabric, which is what puts the address in the tables.
    await openDeviceCli(page, "HOST-A");
    await runCli(page, "ping 192.168.10.20");
    await expectTerminal(page, /Success rate is 100 percent/);

    // The aliasing decision is walkable in Packet Trace straight afterwards.
    await expectTrace(page, "Aliasing", /evpn-aliasing-/);
    await expectTrace(page, "All-Active", /evpn-/);

    // The remote leaf holds one advertised address with *two* eligible leaves —
    // that is aliasing, and it is what Single-Active cannot do.
    const leaf3 = await openDeviceSection(page, {
      hostname: "LEAF3",
      topLevel: "Monitor",
      section: "Aliasing Paths",
    });
    const row = leaf3.getByRole("tabpanel", { name: "VXLAN aliasing" })
      .getByRole("row", { name: new RegExp(ESI_A) });
    await expect(row).toContainText("10.255.0.1");
    await expect(row).toContainText("10.255.0.2");
    await expect(row).toContainText("all-active-aliasing");
    await leaf3.getByRole("button", { name: "Close device window", exact: true }).click();

    // Take down the attachment on the leaf that is not carrying the flow.
    await openDeviceCli(page, "LEAF2");
    await runCli(page, "enable");
    await runCli(page, "configure terminal");
    await runCli(page, "interface Gi0/3");
    await runCli(page, "shutdown");
    await runCli(page, "end");
    await runAuto(page);

    // The local attachment is down first — that is what withdraws LEAF2's
    // Ethernet A-D per-EVI route and so removes it from every alias set.
    await pollShow(page, "show evpn ethernet-segment", /attachment-down/);

    // Connectivity is uninterrupted across the change, and the traffic is also
    // what carries the withdrawal through the fabric.
    await openDeviceCli(page, "HOST-A");
    await runCli(page, "ping 192.168.10.20");
    await expectTerminal(page, /Success rate is 100 percent/);

    // Wait on the explicit convergence condition: the aliasing row now offers
    // one eligible leaf, which is also the one already selected.
    await openDeviceCli(page, "LEAF3");
    await runCli(page, "enable");
    await pollShow(
      page,
      "show evpn aliasing",
      /10010\s+10\.255\.0\.1\s+10\.255\.0\.1\s+10\.255\.0\.1\s+all-active-aliasing/,
    );

    // The address itself never left the table, so nothing had to be relearned.
    await runCli(page, "show mac address-table remote");
    await expectTerminal(page, new RegExp(ESI_A));
  });

  test("a station move increments the mobility sequence and HRW elects the forwarder", async ({ page }) => {
    await page.goto("/");
    await loadDemo(page, "EVPN MAC Mobility and HRW DF Election");
    await runAuto(page);

    // ES-A elects a Designated Forwarder and a backup with HRW. The first
    // matching row is the election; the table below it carries the weights that
    // election was computed from — and a weight only ever comes from HRW.
    const leaf1 = await openDeviceSection(page, {
      hostname: "LEAF1",
      topLevel: "Monitor",
      section: "DF Election",
    });
    const df = leaf1.getByRole("tabpanel", { name: "VXLAN df-election" });
    const dfRow = df.getByRole("row", { name: new RegExp(ESI_A) }).first();
    await expect(dfRow).toContainText("HRW");
    await expect(dfRow).toContainText("10.255.0.1");
    await expect(dfRow).toContainText("10.255.0.2");
    await expect(df).toContainText("=");
    await leaf1.getByRole("button", { name: "Close device window", exact: true }).click();

    // Both participants reach the same answer without telling each other.
    const leaf2 = await openDeviceSection(page, {
      hostname: "LEAF2",
      topLevel: "Monitor",
      section: "DF Election",
    });
    await expect(leaf2.getByRole("tabpanel", { name: "VXLAN df-election" })
      .getByRole("row", { name: new RegExp(ESI_A) }).first()).toContainText("HRW");
    await leaf2.getByRole("button", { name: "Close device window", exact: true }).click();

    // The station talks from its first location.
    await openDeviceCli(page, "STATION-A");
    await runCli(page, "ping 192.168.10.40");
    await expectTerminal(page, /Success rate is 100 percent/);

    // The fabric records it behind ES-A, stable at its first sequence.
    await openDeviceCli(page, "LEAF-R");
    await runCli(page, "enable");
    await pollShow(page, "show evpn mac-mobility", new RegExp(`0\\s+10\\.255\\.0\\.\\d+\\s+${ESI_A}`));

    // Move the station: unplug it from the CE — which leaves the CE-to-leaf
    // uplinks up, so ES-A still advertises the address — then bring the ES-B
    // attachment up and let the station talk from its new place.
    await openDeviceCli(page, "CE-M");
    await runCli(page, "enable");
    await runCli(page, "configure terminal");
    await runCli(page, "interface Gi0/1");
    await runCli(page, "shutdown");
    await runCli(page, "end");

    await openDeviceCli(page, "LEAF3");
    await runCli(page, "enable");
    await runCli(page, "configure terminal");
    await runCli(page, "interface Gi0/3");
    await runCli(page, "no shutdown");
    await runCli(page, "end");
    await runAuto(page);

    await openDeviceCli(page, "STATION-B");
    await runCli(page, "ping 192.168.10.40");
    await expectTerminal(page, /Success rate is 100 percent/);

    // The Packet Trace classification of the mobility events is asserted in the
    // BottomDock unit tests rather than here: the workspace keeps a bounded
    // window of the most recent events, and a Type 2 update with a new sequence
    // floods the whole fabric, so the events that *caused* it are legitimately
    // pushed out of that window before this point in the flow.

    // Wait on the explicit mobility convergence condition: the address is owned
    // by LEAF3 behind ES-B at sequence 1, in state `moved` — so the earlier
    // advertisement lost the comparison and no longer holds the address.
    await openDeviceCli(page, "LEAF-R");
    await runCli(page, "enable");
    await pollShow(
      page,
      "show evpn mac-mobility",
      new RegExp(`\\s1\\s+10\\.255\\.0\\.3\\s+${ESI_B}\\s+\\S+\\s+moved`),
    );

    // ES-B runs the same HRW election on its own segment.
    const leaf3 = await openDeviceSection(page, {
      hostname: "LEAF3",
      topLevel: "Monitor",
      section: "DF Election",
    });
    await expect(leaf3.getByRole("tabpanel", { name: "VXLAN df-election" })
      .getByRole("row", { name: new RegExp(ESI_B) }).first()).toContainText("HRW");
  });
});
