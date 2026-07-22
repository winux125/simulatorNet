/**
 * Branded string IDs: compile-time distinct, zero runtime overhead.
 * A `DeviceId` cannot be passed where an `InterfaceId` is expected.
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type DeviceId = Brand<string, "DeviceId">;
export type InterfaceId = Brand<string, "InterfaceId">;
export type LinkId = Brand<string, "LinkId">;

export const asDeviceId = (v: string): DeviceId => v as DeviceId;
export const asInterfaceId = (v: string): InterfaceId => v as InterfaceId;
export const asLinkId = (v: string): LinkId => v as LinkId;
