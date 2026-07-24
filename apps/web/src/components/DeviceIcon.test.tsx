// @vitest-environment jsdom

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { DEVICE_TYPES, type DeviceType } from "@sim/contracts";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEVICE_ICON_PROFILE_STORAGE_KEY,
  setDeviceIconProfile,
  type DeviceIconProfile,
} from "../hooks/useDeviceIconProfile";
import { DeviceIcon } from "./DeviceIcon";

const here = dirname(fileURLToPath(import.meta.url));
const iconsDir = resolve(here, "../assets/device-icons");
const profiles: DeviceIconProfile[] = ["classic", "education", "minimal"];
const assetNames: Record<DeviceType, string> = {
  pc: "pc.svg",
  server: "server.svg",
  hub: "hub.svg",
  bridge: "bridge.svg",
  "l2-switch": "l2-switch.svg",
  "l3-switch": "l3-switch.svg",
  router: "router.svg",
  firewall: "firewall.svg",
  cloud: "cloud.svg",
  "traffic-generator": "traffic-generator.svg",
  "external-appliance": "external-appliance.svg",
};

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function renderIcon(type: DeviceType, profile?: DeviceIconProfile, state = "stopped") {
  const { container } = render(<DeviceIcon type={type} profile={profile} state={state as "stopped"} size={48} />);
  const svg = container.querySelector("svg");
  if (!svg) throw new Error(`no SVG rendered for ${type}`);
  return svg;
}

function allAssetPaths(): string[] {
  return profiles.flatMap((profile) => readdirSync(join(iconsDir, profile))
    .filter((name) => name.endsWith(".svg"))
    .map((name) => join(iconsDir, profile, name)));
}

describe("topology device icon profiles", () => {
  it("provides every device type in all three profiles", () => {
    for (const profile of profiles) {
      expect(readdirSync(join(iconsDir, profile)).sort()).toEqual(Object.values(assetNames).sort());
      for (const type of DEVICE_TYPES) {
        const svg = renderIcon(type, profile);
        expect(svg.dataset.profile).toBe(profile);
        expect(svg.dataset.deviceType).toBe(type);
        expect(svg.dataset.fallback).toBeUndefined();
      }
    }
    expect(allAssetPaths()).toHaveLength(33);
  });

  it("uses a uniform viewBox and theme-aware currentColor", () => {
    for (const path of allAssetPaths()) {
      const body = readFileSync(path, "utf8");
      expect(body).toContain('viewBox="0 0 64 64"');
      expect(body).toContain("currentColor");
      expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}|rgb\(|hsl\(|gradient/i);
    }
  });

  it("contains no proprietary, raster, embedded-text or external assets", () => {
    for (const path of allAssetPaths()) {
      const body = readFileSync(path, "utf8").replace(/xmlns="[^"]*"/g, "");
      expect(body).not.toMatch(/cisco|packet\s*tracer|pnetlab|eve-ng/i);
      expect(body).not.toMatch(/<image\b|<text\b|data:image\/|\.(png|jpe?g|webp|gif)/i);
      expect(body).not.toMatch(/https?:\/\/|xlink:href|href=|url\(/i);
    }
  });

  it("defaults to Classic Lab and persists the visual preference locally", () => {
    expect(renderIcon("router").dataset.profile).toBe("classic");
    setDeviceIconProfile("education");
    expect(window.localStorage.getItem(DEVICE_ICON_PROFILE_STORAGE_KEY)).toBe("education");
    expect(document.documentElement.dataset.deviceIconProfile).toBe("education");
    expect(renderIcon("router").dataset.profile).toBe("education");
  });

  it("keeps runtime power state separate from icon geometry", () => {
    const stopped = renderIcon("router", "classic", "stopped");
    const markup = stopped.innerHTML;
    cleanup();
    const running = renderIcon("router", "classic", "running");
    expect(running.innerHTML).toBe(markup);
    expect(running.dataset.state).toBe("running");
  });

  it("uses a controlled fallback for an unknown device type", () => {
    expect(renderIcon("satellite" as DeviceType, "minimal").dataset.fallback).toBe("true");
  });
});
