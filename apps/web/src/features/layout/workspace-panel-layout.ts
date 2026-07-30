/**
 * Versioned, panel-id-aware persistence for the resizable workspace.
 *
 * react-resizable-panels layouts are maps keyed by Panel id. Keeping the
 * explicit DOM order beside every stored layout prevents an old two-panel
 * value from being applied to a different mounted panel set.
 */

export type PanelLayout = Record<string, number>;

export interface PanelLayoutConstraint {
  minPercent?: number;
  maxPercent?: number;
}

export interface PanelLayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const WORKSPACE_LAYOUT_STORAGE_KEY = "simulatornet.workspaceLayout.v2";
export const LEGACY_WORKSPACE_LAYOUT_STORAGE_KEY = "react-resizable-panels:workspace-layout";

export const WORKSPACE_PANEL_GROUP_ID = "workspace-layout-v2";
export const WORKSPACE_MAIN_PANEL_ID = "workspace-main";
export const WORKSPACE_BOTTOM_PANEL_ID = "workspace-bottom-dock";
export const WORKSPACE_BOTTOM_SEPARATOR_ID = "workspace-bottom-separator";
export const WORKSPACE_PANEL_IDS = [
  WORKSPACE_MAIN_PANEL_ID,
  WORKSPACE_BOTTOM_PANEL_ID,
] as const;

export const WORKSPACE_PANEL_CONSTRAINTS: Readonly<Record<string, PanelLayoutConstraint>> = {
  [WORKSPACE_MAIN_PANEL_ID]: { minPercent: 52, maxPercent: 85 },
  [WORKSPACE_BOTTOM_PANEL_ID]: { minPercent: 15, maxPercent: 48 },
};

const LAYOUT_VERSION = 2;
const SUM_TOLERANCE = 0.25;
const PRECISION = 1_000_000;

interface StoredPanelLayout {
  orderedPanelIds: string[];
  layout: PanelLayout;
}

interface StoredWorkspaceLayouts {
  version: typeof LAYOUT_VERSION;
  groups: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function round(value: number): number {
  return Math.round(value * PRECISION) / PRECISION;
}

function tryNormalizePanelLayout(
  orderedPanelIds: readonly string[],
  candidateLayout: unknown,
  constraints: Readonly<Record<string, PanelLayoutConstraint>>,
): PanelLayout | undefined {
  if (!isRecord(candidateLayout) || orderedPanelIds.length === 0) return undefined;
  if (new Set(orderedPanelIds).size !== orderedPanelIds.length) return undefined;

  const candidateIds = Object.keys(candidateLayout);
  if (candidateIds.length !== orderedPanelIds.length) return undefined;
  if (!candidateIds.every((id) => orderedPanelIds.includes(id))) return undefined;

  const values: number[] = [];
  for (const id of orderedPanelIds) {
    const value = candidateLayout[id];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
    values.push(value);
  }

  const sum = values.reduce((total, value) => total + value, 0);
  if (!Number.isFinite(sum) || Math.abs(sum - 100) > SUM_TOLERANCE) return undefined;

  const normalizedValues = values.map((value) => round((value / sum) * 100));
  normalizedValues[normalizedValues.length - 1] = round(
    100 - normalizedValues.slice(0, -1).reduce((total, value) => total + value, 0),
  );

  const normalized: PanelLayout = {};
  for (let index = 0; index < orderedPanelIds.length; index += 1) {
    const id = orderedPanelIds[index]!;
    const value = normalizedValues[index]!;
    const constraint = constraints[id];
    if (constraint?.minPercent !== undefined && value < constraint.minPercent) return undefined;
    if (constraint?.maxPercent !== undefined && value > constraint.maxPercent) return undefined;
    normalized[id] = value;
  }
  return normalized;
}

function equalLayout(orderedPanelIds: readonly string[]): PanelLayout {
  const share = round(100 / orderedPanelIds.length);
  const layout: PanelLayout = {};
  orderedPanelIds.forEach((id, index) => {
    layout[id] = index === orderedPanelIds.length - 1
      ? round(100 - share * (orderedPanelIds.length - 1))
      : share;
  });
  return layout;
}

export function normalizePanelLayout(options: {
  orderedPanelIds: readonly string[];
  candidateLayout: unknown;
  defaultLayout: PanelLayout;
  constraints?: Readonly<Record<string, PanelLayoutConstraint>>;
}): PanelLayout {
  const constraints = options.constraints ?? {};
  const safeDefault = tryNormalizePanelLayout(
    options.orderedPanelIds,
    options.defaultLayout,
    constraints,
  ) ?? equalLayout(options.orderedPanelIds);
  return tryNormalizePanelLayout(
    options.orderedPanelIds,
    options.candidateLayout,
    constraints,
  ) ?? safeDefault;
}

export function createDefaultWorkspacePanelLayout(
  bottomPanelHeight: number,
  viewportHeight: number,
): PanelLayout {
  const safeViewportHeight = Number.isFinite(viewportHeight) && viewportHeight > 0
    ? viewportHeight
    : 900;
  const requestedBottom = Number.isFinite(bottomPanelHeight) && bottomPanelHeight > 0
    ? (bottomPanelHeight / safeViewportHeight) * 100
    : 26.667;
  const bottom = round(Math.min(48, Math.max(15, requestedBottom)));
  return {
    [WORKSPACE_MAIN_PANEL_ID]: round(100 - bottom),
    [WORKSPACE_BOTTOM_PANEL_ID]: bottom,
  };
}

function parseStoredLayouts(raw: string | null): StoredWorkspaceLayouts | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== LAYOUT_VERSION || !isRecord(parsed.groups)) {
      return undefined;
    }
    return {
      version: LAYOUT_VERSION,
      groups: { ...parsed.groups },
    };
  } catch {
    return undefined;
  }
}

function writeStoredLayouts(storage: PanelLayoutStorage, value: StoredWorkspaceLayouts): void {
  if (Object.keys(value.groups).length === 0) {
    storage.removeItem(WORKSPACE_LAYOUT_STORAGE_KEY);
  } else {
    storage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify(value));
  }
}

function candidateFromLegacy(
  parsed: unknown,
  orderedPanelIds: readonly string[],
): PanelLayout | undefined {
  const fromArray = (layout: unknown): PanelLayout | undefined => {
    if (!Array.isArray(layout) || layout.length !== orderedPanelIds.length) return undefined;
    const candidate: PanelLayout = {};
    orderedPanelIds.forEach((id, index) => {
      candidate[id] = layout[index] as number;
    });
    return candidate;
  };

  const arrayCandidate = fromArray(parsed);
  if (arrayCandidate) return arrayCandidate;
  if (!isRecord(parsed)) return undefined;

  if (Object.values(parsed).every((value) => typeof value === "number")) {
    return parsed as PanelLayout;
  }

  const orderedKey = orderedPanelIds.join(",");
  const keyedEntry = parsed[orderedKey];
  if (isRecord(keyedEntry)) {
    const keyedCandidate = fromArray(keyedEntry.layout);
    if (keyedCandidate) return keyedCandidate;
  }
  return fromArray(parsed.layout);
}

export function persistWorkspacePanelLayout(options: {
  storage: PanelLayoutStorage;
  groupId: string;
  orderedPanelIds: readonly string[];
  candidateLayout: unknown;
  constraints?: Readonly<Record<string, PanelLayoutConstraint>>;
}): PanelLayout | undefined {
  const normalized = tryNormalizePanelLayout(
    options.orderedPanelIds,
    options.candidateLayout,
    options.constraints ?? {},
  );
  if (!normalized) return undefined;

  const stored = parseStoredLayouts(options.storage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)) ?? {
    version: LAYOUT_VERSION,
    groups: {},
  };
  const entry: StoredPanelLayout = {
    orderedPanelIds: [...options.orderedPanelIds],
    layout: normalized,
  };
  stored.groups[options.groupId] = entry;
  writeStoredLayouts(options.storage, stored);
  return normalized;
}

export function readWorkspacePanelLayout(options: {
  storage: PanelLayoutStorage;
  groupId: string;
  orderedPanelIds: readonly string[];
  defaultLayout: PanelLayout;
  constraints?: Readonly<Record<string, PanelLayoutConstraint>>;
  legacyStorageKeys?: readonly string[];
  onInvalid?: (reason: string) => void;
}): PanelLayout {
  const constraints = options.constraints ?? {};
  const safeDefault = normalizePanelLayout({
    orderedPanelIds: options.orderedPanelIds,
    candidateLayout: options.defaultLayout,
    defaultLayout: options.defaultLayout,
    constraints,
  });
  const rawV2 = options.storage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY);
  const stored = parseStoredLayouts(rawV2);

  if (rawV2 !== null && !stored) {
    options.storage.removeItem(WORKSPACE_LAYOUT_STORAGE_KEY);
    options.onInvalid?.(`Discarded invalid ${options.groupId} layout preference.`);
  } else if (stored) {
    const rawEntry = stored.groups[options.groupId];
    if (rawEntry !== undefined) {
      const entry = isRecord(rawEntry) ? rawEntry : undefined;
      const ids = entry?.orderedPanelIds;
      const candidate = entry?.layout;
      const normalized = Array.isArray(ids) && ids.every((id) => typeof id === "string")
        && sameIds(ids, options.orderedPanelIds)
        ? tryNormalizePanelLayout(options.orderedPanelIds, candidate, constraints)
        : undefined;
      if (normalized) return normalized;

      delete stored.groups[options.groupId];
      writeStoredLayouts(options.storage, stored);
      options.onInvalid?.(`Discarded stale ${options.groupId} panel set.`);
      return safeDefault;
    }
  }

  for (const key of options.legacyStorageKeys ?? []) {
    const rawLegacy = options.storage.getItem(key);
    if (rawLegacy === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLegacy);
    } catch {
      parsed = undefined;
    }
    const candidate = candidateFromLegacy(parsed, options.orderedPanelIds);
    const normalized = tryNormalizePanelLayout(
      options.orderedPanelIds,
      candidate,
      constraints,
    );
    options.storage.removeItem(key);
    if (!normalized) {
      options.onInvalid?.(`Discarded stale ${options.groupId} legacy layout.`);
      return safeDefault;
    }
    persistWorkspacePanelLayout({
      storage: options.storage,
      groupId: options.groupId,
      orderedPanelIds: options.orderedPanelIds,
      candidateLayout: normalized,
      constraints,
    });
    return normalized;
  }

  return safeDefault;
}
