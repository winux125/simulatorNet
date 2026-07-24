import { useSyncExternalStore } from "react";

export type DeviceIconProfile = "classic" | "education" | "minimal";

export const DEVICE_ICON_PROFILE_STORAGE_KEY = "simulatornet.deviceIconProfile";
const PROFILE_EVENT = "simulatornet:device-icon-profile";
const PROFILES: readonly DeviceIconProfile[] = ["classic", "education", "minimal"];

function isProfile(value: string | null): value is DeviceIconProfile {
  return value !== null && PROFILES.includes(value as DeviceIconProfile);
}

export function getDeviceIconProfile(): DeviceIconProfile {
  if (typeof window === "undefined") return "classic";
  const saved = window.localStorage.getItem(DEVICE_ICON_PROFILE_STORAGE_KEY);
  return isProfile(saved) ? saved : "classic";
}

export function setDeviceIconProfile(profile: DeviceIconProfile): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(DEVICE_ICON_PROFILE_STORAGE_KEY, profile);
  document.documentElement.dataset.deviceIconProfile = profile;
  window.dispatchEvent(new Event(PROFILE_EVENT));
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === DEVICE_ICON_PROFILE_STORAGE_KEY) listener();
  };
  window.addEventListener(PROFILE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(PROFILE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function initializeDeviceIconProfile(): DeviceIconProfile {
  const profile = getDeviceIconProfile();
  if (typeof document !== "undefined") document.documentElement.dataset.deviceIconProfile = profile;
  return profile;
}

export function useDeviceIconProfile(): DeviceIconProfile {
  return useSyncExternalStore(subscribe, getDeviceIconProfile, () => "classic");
}
