import type { DeviceType } from "@sim/contracts";
import {
  useDeviceIconProfile,
  type DeviceIconProfile,
} from "../hooks/useDeviceIconProfile";

// Original SimulatorNet device artwork. The SVG files are the one source of
// geometry used by the topology, palette, windows, inspector, terminal and
// importer UI. Runtime state stays separate from the artwork.
export type DeviceIconState = "stopped" | "starting" | "running" | "stopping" | "error" | "pending";

const ASSET_NAMES = {
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
  "access-point": "access-point.svg",
  laptop: "laptop.svg",
  smartphone: "smartphone.svg",
  "wireless-router": "wireless-router.svg",
} as const satisfies Record<DeviceType, string>;

const DEVICE_ICON_ASSETS = import.meta.glob<string>(
  "../assets/device-icons/**/*.svg",
  // External <use> needs a same-origin file URL. `no-inline` prevents Vite
  // from turning these compact SVGs into data URIs, whose fragment references
  // are intentionally not resolved by Chromium.
  { eager: true, query: "?url&no-inline", import: "default" },
);

export function deviceIconAssetUrl(
  type: DeviceType,
  profile: DeviceIconProfile,
): string | undefined {
  const name = (ASSET_NAMES as Partial<Record<DeviceType, string>>)[type];
  return name ? DEVICE_ICON_ASSETS[`../assets/device-icons/${profile}/${name}`] : undefined;
}

const FALLBACK = (
  <g fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <rect x="10" y="10" width="44" height="44" rx="6" />
    <path d="M23 32h18M32 23v18" />
  </g>
);

const PROFILE_LABELS: Record<DeviceIconProfile, string> = {
  classic: "Classic Lab",
  education: "Education Flat",
  minimal: "Minimal Network",
};

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
  const assetUrl = deviceIconAssetUrl(type, resolvedProfile);
  const assetHref = assetUrl
    ? resolvedProfile === "classic" ? `${assetUrl}#device-icon` : assetUrl
    : undefined;
  return (
    <svg
      className={["device-icon", className].filter(Boolean).join(" ")}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-hidden={title ? undefined : true}
      aria-label={title ?? undefined}
      data-device-type={type}
      data-profile={resolvedProfile}
      data-profile-label={PROFILE_LABELS[resolvedProfile]}
      data-state={state}
      data-asset-name={(ASSET_NAMES as Partial<Record<DeviceType, string>>)[type]}
      data-fallback={assetUrl ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      {assetHref ? <use href={assetHref} /> : FALLBACK}
    </svg>
  );
}

export default DeviceIcon;
