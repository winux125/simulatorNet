import type { DeviceType } from "@sim/contracts";
import type { ReactNode } from "react";

// Original SimulatorNet network-device symbols. One visual language: 24x24
// viewBox, 1.6 stroke, round joins, `currentColor` only — no gradients,
// shadows, embedded text, raster images or third-party (Cisco / Packet Tracer)
// assets. The matching provenance assets live in src/assets/device-icons/*.svg
// and are validated by DeviceIcon.test.tsx.

export type DeviceIconState = "stopped" | "starting" | "running" | "stopping" | "error" | "pending";

const DOT = { fill: "currentColor", stroke: "none" } as const;

const SHAPES: Record<DeviceType, ReactNode> = {
  // Monitor + stand/base + one link indicator.
  pc: (
    <>
      <rect x="2.5" y="4" width="19" height="12.5" rx="1.5" />
      <path d="M12 16.5v3.5" />
      <path d="M8.5 20h7" />
      <circle cx="18" cy="13.5" r="1" {...DOT} />
    </>
  ),
  // Vertical rack, three slots, status LEDs and an Ethernet port marker.
  server: (
    <>
      <rect x="5" y="2.5" width="14" height="19" rx="1.5" />
      <path d="M5 8.5h14" />
      <path d="M5 14h14" />
      <circle cx="8" cy="5.4" r="0.9" {...DOT} />
      <circle cx="11" cy="5.4" r="0.9" {...DOT} />
      <rect x="14" y="16.5" width="2.6" height="2.6" rx="0.4" />
    </>
  ),
  // Central block feeding identical, undifferentiated ports (a repeater).
  hub: (
    <>
      <rect x="3" y="8.5" width="18" height="7" rx="1.5" />
      <path d="M6.5 15.5v2.5" />
      <path d="M9.5 15.5v2.5" />
      <path d="M12 15.5v2.5" />
      <path d="M14.5 15.5v2.5" />
      <path d="M17.5 15.5v2.5" />
    </>
  ),
  // Two Ethernet segments joined by a central bridge block.
  bridge: (
    <>
      <rect x="2.5" y="9" width="6.5" height="6" rx="1" />
      <rect x="15" y="9" width="6.5" height="6" rx="1" />
      <rect x="10" y="6.5" width="4" height="11" rx="1" />
      <path d="M9 12h1" />
      <path d="M14 12h1" />
    </>
  ),
  // Horizontal chassis, port row and crossing switching arrows.
  "l2-switch": (
    <>
      <rect x="2.5" y="7.5" width="19" height="9" rx="1.5" />
      <path d="M6 16.5v2" />
      <path d="M9.5 16.5v2" />
      <path d="M13 16.5v2" />
      <path d="M16.5 16.5v2" />
      <path d="M7.5 10.6h7" />
      <path d="M12.6 8.8l1.9 1.8-1.9 1.8" />
      <path d="M16.5 13.4h-7" />
      <path d="M11.4 11.6l-1.9 1.8 1.9 1.8" />
    </>
  ),
  // Switch chassis with a small inter-VLAN routing diamond.
  "l3-switch": (
    <>
      <rect x="2.5" y="7.5" width="19" height="9" rx="1.5" />
      <path d="M6 16.5v2" />
      <path d="M9.5 16.5v2" />
      <path d="M14.5 16.5v2" />
      <path d="M18 16.5v2" />
      <path d="M8 12h3.2" />
      <path d="M16 12h-3.2" />
      <path d="M12 9.2l2.3 2.8-2.3 2.8-2.3-2.8z" />
    </>
  ),
  // Compact routing body with four directional arrows.
  router: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 5.4v4.1" />
      <path d="M10.5 7l1.5-1.6 1.5 1.6" />
      <path d="M12 18.6v-4.1" />
      <path d="M10.5 17l1.5 1.6 1.5-1.6" />
      <path d="M5.4 12h4.1" />
      <path d="M7 10.5 5.4 12 7 13.5" />
      <path d="M18.6 12h-4.1" />
      <path d="M17 10.5 18.6 12 17 13.5" />
    </>
  ),
};

// Neutral fallback so an unknown/missing device type degrades to a generic box
// rather than crashing.
const FALLBACK: ReactNode = (
  <>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <path d="M8 12h8" />
  </>
);

export interface DeviceIconProps {
  type: DeviceType;
  size?: number;
  /** Runtime power/lifecycle state — surfaced as a data attribute only; the
   * SVG geometry never changes with status (status is a separate indicator). */
  state?: DeviceIconState;
  title?: string;
  className?: string;
}

export function DeviceIcon({ type, size = 24, state, title, className }: DeviceIconProps) {
  const shape = SHAPES[type];
  return (
    <svg
      className={["device-icon", className].filter(Boolean).join(" ")}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-hidden={title ? undefined : true}
      aria-label={title}
      data-device-type={type}
      data-state={state}
      data-fallback={shape ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      {shape ?? FALLBACK}
    </svg>
  );
}

export default DeviceIcon;
