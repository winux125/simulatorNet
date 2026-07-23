// @vitest-environment jsdom

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { DEVICE_TYPES, type DeviceType } from "@sim/contracts";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DeviceIcon } from "./DeviceIcon";

const here = dirname(fileURLToPath(import.meta.url));
const iconsDir = resolve(here, "../assets/device-icons");

afterEach(() => cleanup());

function renderIcon(type: DeviceType, props: Partial<{ state: string; title: string }> = {}) {
  const { container } = render(<DeviceIcon type={type} size={32} {...(props as object)} />);
  const svg = container.querySelector("svg");
  if (!svg) throw new Error(`no svg rendered for ${type}`);
  return svg;
}

const assetFor: Record<DeviceType, string> = {
  pc: "pc.svg",
  server: "server.svg",
  hub: "hub.svg",
  bridge: "bridge.svg",
  "l2-switch": "l2-switch.svg",
  "l3-switch": "l3-switch.svg",
  router: "router.svg",
};

describe("M10.2.2b device icon system", () => {
  it("1. renders a real (non-fallback) icon for every device profile", () => {
    for (const type of DEVICE_TYPES) {
      const svg = renderIcon(type);
      expect(svg.getAttribute("data-device-type")).toBe(type);
      expect(svg.getAttribute("data-fallback")).toBeNull();
      expect(svg.querySelectorAll("rect, circle, path, polygon, line").length).toBeGreaterThan(0);
    }
  });

  it("2. maps every device type to a unique, distinct SVG asset", () => {
    const files = readdirSync(iconsDir).filter((file) => file.endsWith(".svg"));
    expect(new Set(files).size).toBe(files.length);
    expect(files.sort()).toEqual(Object.values(assetFor).sort());
    const bodies = files.map((file) => readFileSync(join(iconsDir, file), "utf8"));
    expect(new Set(bodies).size).toBe(bodies.length);
  });

  it("3. draws every icon with currentColor only", () => {
    for (const type of DEVICE_TYPES) {
      const svg = renderIcon(type);
      expect(svg.getAttribute("stroke")).toBe("currentColor");
    }
    for (const file of Object.values(assetFor)) {
      const body = readFileSync(join(iconsDir, file), "utf8");
      expect(body).toContain('stroke="currentColor"');
      expect(body).not.toMatch(/#[0-9a-fA-F]{3,6}/); // no hard-coded hex palette
      expect(body).not.toMatch(/rgb\(|hsl\(|gradient/i);
    }
  });

  it("4. embeds no raster images", () => {
    for (const file of Object.values(assetFor)) {
      const body = readFileSync(join(iconsDir, file), "utf8");
      expect(body).not.toMatch(/<image\b/i);
      expect(body).not.toMatch(/data:image\//i);
      expect(body).not.toMatch(/\.(png|jpe?g|webp|gif)/i);
    }
  });

  it("5. references no external URLs", () => {
    for (const file of Object.values(assetFor)) {
      const body = readFileSync(join(iconsDir, file), "utf8").replace(/xmlns="[^"]*"/g, "");
      expect(body).not.toMatch(/https?:\/\//i);
      expect(body).not.toMatch(/xlink:href|href=/i);
      expect(body).not.toMatch(/url\(/i);
    }
  });

  it("6. carries no Cisco or Packet Tracer branding", () => {
    for (const file of Object.values(assetFor)) {
      const body = readFileSync(join(iconsDir, file), "utf8");
      expect(body).not.toMatch(/cisco|packet\s*tracer|packettracer/i);
      expect(body).not.toMatch(/<text\b/i); // no embedded text
    }
  });

  it("10. keeps icons legible via currentColor across themes", () => {
    // currentColor inheritance is what makes the icon follow the theme text
    // colour; a fixed fill/stroke would break in the opposite theme.
    for (const file of Object.values(assetFor)) {
      const body = readFileSync(join(iconsDir, file), "utf8");
      expect(body).toContain("currentColor");
      expect(body).not.toMatch(/fill="#|stroke="#/);
    }
  });

  it("11. keeps runtime status separate from the icon geometry", () => {
    const stopped = renderIcon("router", { state: "stopped" }).innerHTML;
    const running = renderIcon("router", { state: "running" }).innerHTML;
    expect(stopped).toBe(running); // geometry does not change with status
    expect(renderIcon("router", { state: "error" }).getAttribute("data-state")).toBe("error");
  });

  it("12. degrades to a controlled fallback for an unknown type", () => {
    const svg = renderIcon("satellite" as DeviceType);
    expect(svg.getAttribute("data-fallback")).toBe("true");
    expect(svg.querySelectorAll("rect, path").length).toBeGreaterThan(0);
  });
});
