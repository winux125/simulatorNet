import type { DeviceType } from "@sim/contracts";
import type { ReactNode } from "react";
import {
  useDeviceIconProfile,
  type DeviceIconProfile,
} from "../hooks/useDeviceIconProfile";

// Original SimulatorNet symbols. Runtime state is intentionally not encoded in
// the geometry: the separate status square remains the sole power indicator.
export type DeviceIconState = "stopped" | "starting" | "running" | "stopping" | "error" | "pending";

const dot = (cx: number, cy: number, r = 1) => <circle cx={cx} cy={cy} r={r} className="device-icon__detail" />;

const MINIMAL: Record<DeviceType, ReactNode> = {
  pc: <><rect x="3" y="4" width="18" height="12" rx="1.4" /><path d="M12 16v4M8 20h8" /></>,
  server: <><rect x="5" y="2.5" width="14" height="19" rx="1.2" /><path d="M5 8.7h14M5 15h14" />{dot(8, 5.6)}{dot(8, 11.9)}</>,
  hub: <><rect x="3" y="8" width="18" height="8" rx="1.2" /><path d="M6 16v3M9 16v3M12 16v3M15 16v3M18 16v3" /></>,
  bridge: <><rect x="3" y="9" width="6" height="6" rx="1" /><rect x="15" y="9" width="6" height="6" rx="1" /><path d="M9 12h6M12 7v10" /></>,
  "l2-switch": <><rect x="2.5" y="7" width="19" height="10" rx="1.5" /><path d="M6 17v2M10 17v2M14 17v2M18 17v2M7 10.5h9l-2-2M17 13.5H8l2 2" /></>,
  "l3-switch": <><rect x="2.5" y="7" width="19" height="10" rx="1.5" /><path d="M6 17v2M10 17v2M14 17v2M18 17v2M8 12h2M16 12h-2M12 9l2.5 3-2.5 3-2.5-3z" /></>,
  router: <><circle cx="12" cy="12" r="8.5" /><path d="M12 5.5v13M5.5 12h13M12 5.5l-2 2M12 5.5l2 2M18.5 12l-2-2M18.5 12l-2 2" /></>,
  firewall: <><path d="M12 2.5 20 6v5.5c0 5.2-3.2 8.4-8 10-4.8-1.6-8-4.8-8-10V6z" /><path d="M7 9h10M7 13h10M9 9v4M15 9v4M12 13v4" /></>,
  cloud: <><path d="M7 18h10.5a4 4 0 0 0 .5-8 6.3 6.3 0 0 0-11.8-1.4A4.8 4.8 0 0 0 7 18z" /><path d="M9 21h6M12 18v3" /></>,
  "traffic-generator": <><rect x="2.5" y="4" width="19" height="16" rx="1.5" /><path d="M5 13h3l2-5 3.5 9 2-4H19M17 7l2 2-2 2" /></>,
};

const EDUCATION: Record<DeviceType, ReactNode> = {
  pc: <><rect className="device-icon__surface" x="2.5" y="3.5" width="19" height="13.5" rx="2" /><path d="M12 17v3M7.5 20h9" />{dot(18.2, 14, 1.1)}</>,
  server: <><rect className="device-icon__surface" x="4.5" y="2" width="15" height="20" rx="2" /><path d="M4.5 8.5h15M4.5 15h15" />{dot(8, 5.3)}{dot(8, 11.8)}{dot(8, 18.2)}</>,
  hub: <><rect className="device-icon__surface" x="2.5" y="7.5" width="19" height="9" rx="2" />{[6,9,12,15,18].map((x) => <rect key={x} x={x - .8} y="11" width="1.6" height="2.5" rx=".3" />)}</>,
  bridge: <><path className="device-icon__surface" d="M3 8h6v8H3zM15 8h6v8h-6z" /><circle cx="12" cy="12" r="3" /><path d="M9 12H7M17 12h-2" /></>,
  "l2-switch": <><rect className="device-icon__surface" x="2" y="6.5" width="20" height="11" rx="2" /><path d="M6.5 10h11l-2-2M17.5 14h-11l2 2" /></>,
  "l3-switch": <><rect className="device-icon__surface" x="2" y="6.5" width="20" height="11" rx="2" /><path d="M6 12h4M18 12h-4" /><path className="device-icon__detail" d="M12 8.5 15 12l-3 3.5L9 12z" /></>,
  router: <><circle className="device-icon__surface" cx="12" cy="12" r="9" /><path d="m12 5 2 2-2 2M19 12l-2 2-2-2M12 19l-2-2 2-2M5 12l2-2 2 2" /></>,
  firewall: <><path className="device-icon__surface" d="M12 2.5 20 6v5.5c0 5.2-3.2 8.4-8 10-4.8-1.6-8-4.8-8-10V6z" /><path d="M7 9h10M7 13h10M9 9v4M15 9v4M12 13v4" /></>,
  cloud: <><path className="device-icon__surface" d="M6.5 18.5h11a4 4 0 0 0 .4-8 6.4 6.4 0 0 0-11.8-1.3 4.8 4.8 0 0 0 .4 9.3z" /><path d="M8.5 14h7M10 11.5 8 14l2 2.5M14 11.5l2 2.5-2 2.5" /></>,
  "traffic-generator": <><rect className="device-icon__surface" x="2.5" y="4" width="19" height="16" rx="2" /><path d="M5 13h3l2-5 3.5 9 2-4H19" /><path className="device-icon__detail" d="M16.5 7 19 9.5 16.5 12" /></>,
};

const CLASSIC: Record<DeviceType, ReactNode> = {
  pc: <><path className="device-icon__chassis" d="M3 4h18v12H3z" /><path className="device-icon__highlight" d="M4.5 5.5h15v8.7h-15z" /><path d="M12 16v3M8 20h8" /></>,
  server: <><path className="device-icon__chassis" d="M5 2.5h14v19H5z" /><path className="device-icon__highlight" d="M6.5 4h11v4H6.5zM6.5 10h11v4H6.5zM6.5 16h11v4H6.5z" />{dot(8, 6)}{dot(8, 12)}{dot(8, 18)}</>,
  hub: <><path className="device-icon__chassis" d="m3 8 2-2h14l2 2v9H3z" /><path className="device-icon__highlight" d="M5 9h14v5H5z" />{[7,10,13,16].map((x) => <rect key={x} x={x - .7} y="11" width="1.4" height="2" />)}</>,
  bridge: <><path className="device-icon__chassis" d="M2.5 8h7v8h-7zM14.5 8h7v8h-7zM10 6h4v12h-4z" /><path className="device-icon__highlight" d="M4 10h4v4H4zM16 10h4v4h-4z" /></>,
  "l2-switch": <><path className="device-icon__chassis" d="m2 7 2-2h16l2 2v11H2z" /><path className="device-icon__highlight" d="M4 8h16v6H4z" /><path d="M7 10h9l-2-2M17 12H8l2 2" />{dot(6, 16)}{dot(9, 16)}{dot(12, 16)}{dot(15, 16)}{dot(18, 16)}</>,
  "l3-switch": <><path className="device-icon__chassis" d="m2 7 2-2h16l2 2v11H2z" /><path className="device-icon__highlight" d="M4 8h16v6H4z" /><path className="device-icon__detail" d="M12 8.5 15 11l-3 2.5L9 11z" />{dot(6, 16)}{dot(9, 16)}{dot(12, 16)}{dot(15, 16)}{dot(18, 16)}</>,
  router: <><ellipse className="device-icon__chassis" cx="12" cy="12" rx="10" ry="7.5" /><ellipse className="device-icon__highlight" cx="12" cy="10.5" rx="8.2" ry="5" /><path d="M12 6v11M5 12h14M12 6l-2 2M12 6l2 2M19 12l-2-2M19 12l-2 2" /></>,
  firewall: <><path className="device-icon__chassis" d="M12 2.5 20 6v6c0 5-3.2 8-8 9.5C7.2 20 4 17 4 12V6z" /><path className="device-icon__highlight" d="M6.2 7.2h11.6v7.5H6.2z" /><path d="M6.5 10h11M6.5 13h11M9 7.5v5.5M15 10v5" /></>,
  cloud: <><path className="device-icon__chassis" d="M6 18.5h11.5a4 4 0 0 0 .3-8A6.4 6.4 0 0 0 6 9.2a4.8 4.8 0 0 0 0 9.3z" /><path className="device-icon__highlight" d="M7.5 16h9.5a2.2 2.2 0 0 0 0-4.4h-1A4.4 4.4 0 0 0 8 11a2.6 2.6 0 0 0-.5 5z" /></>,
  "traffic-generator": <><path className="device-icon__chassis" d="m3 5 2-2h14l2 2v15H3z" /><path className="device-icon__highlight" d="M5 6h14v11H5z" /><path d="M6 13h3l2-5 3 8 2-4h2M16 7l2 2-2 2" /></>,
};

const SHAPES: Record<DeviceIconProfile, Record<DeviceType, ReactNode>> = {
  classic: CLASSIC,
  education: EDUCATION,
  minimal: MINIMAL,
};
const FALLBACK = <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 12h8" /></>;

export interface DeviceIconProps {
  type: DeviceType;
  size?: number;
  state?: DeviceIconState;
  title?: string;
  className?: string;
  profile?: DeviceIconProfile;
}

export function DeviceIcon({ type, size = 24, state, title, className, profile }: DeviceIconProps) {
  const preferredProfile = useDeviceIconProfile();
  const resolvedProfile = profile ?? preferredProfile;
  const shape = (SHAPES[resolvedProfile] as Partial<Record<DeviceType, ReactNode>>)[type];
  return (
    <svg
      className={["device-icon", className].filter(Boolean).join(" ")}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={resolvedProfile === "classic" ? 1.25 : 1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-hidden={title ? undefined : true}
      aria-label={title}
      data-device-type={type}
      data-profile={resolvedProfile}
      data-state={state}
      data-fallback={shape ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      {shape ?? FALLBACK}
    </svg>
  );
}

export default DeviceIcon;
