import {
  MAX_DEVICE_RACK_UNIT_SPAN,
  MIN_DEVICE_RACK_UNIT_SPAN,
  placementLastRackUnit,
  type DevicePhysicalPlacement,
  type DeviceType,
  type LabDocument,
  type PhysicalRack,
} from "@sim/contracts";
import type { LabUiNode } from "@sim/sim-worker";
import { Boxes, Building2, DoorOpen, Info, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { DeviceIcon } from "../../components/DeviceIcon";
import { Button } from "../../ui";
import { diagramAssetDataUrl } from "../topology/diagram-image-assets";
import {
  classifyCanvasWheel,
  IDENTITY_CANVAS_VIEWPORT,
  panViewport,
  wheelZoomMultiplier,
  zoomViewportAtPoint,
  type CanvasViewport,
} from "../topology/canvas-navigation";
import {
  addPhysicalRack,
  addPhysicalRoom,
  addPhysicalSite,
  devicesInRack,
  findRoom,
  firstFreeRackUnit,
  freeDevicesInRoom,
  physicalConnectionOverlay,
  physicalViewOf,
  placeDeviceInRack,
  placeDeviceInRoom,
  placementOf,
  PhysicalPlacementError,
  removePhysicalRack,
  removePhysicalRoom,
  removePhysicalSite,
  renamePhysicalRack,
  renamePhysicalRoom,
  renamePhysicalSite,
  unplaceDevice,
  unplacedDeviceIds,
  withDeviceRackUnitSpan,
  type PhysicalConnectionOverlay,
} from "./physical-layout";

/** Drawn height of one rack unit, in room coordinates. Not a hardware value. */
const RACK_UNIT_HEIGHT = 22;
const RACK_HEADER_HEIGHT = 26;

interface PhysicalWorkspaceProps {
  document: LabDocument;
  /** Runtime nodes, when the lab is running, purely for the status indicator. */
  nodes: readonly LabUiNode[];
  /**
   * Placement is presentation by construction, so the impact is a literal:
   * this workspace cannot ask for a configuration or structural change.
   */
  onChange(document: LabDocument, impact: "presentation"): void;
  onOpenDevice(deviceId: string): void;
  onError(message: string): void;
}

type Selection =
  | { kind: "site"; id: string }
  | { kind: "room"; id: string }
  | { kind: "rack"; id: string }
  | { kind: "device"; id: string };

/**
 * The Physical view of a lab: where the equipment is, not how it is wired.
 *
 * Everything it writes lands in `LabDocument.physical`, which is presentation
 * metadata. Moving a device here never rebuilds the worker, never resets ARP,
 * TCP or the packet trace, never shows Apply Topology, and stays available
 * while the lab is running.
 */
export function PhysicalWorkspace(props: PhysicalWorkspaceProps) {
  const { document, onChange, onError } = props;
  const layout = useMemo(() => physicalViewOf(document), [document]);
  const [selection, setSelection] = useState<Selection>();
  const [activeRoomId, setActiveRoomId] = useState<string>();
  const [connectionsShown, setConnectionsShown] = useState(false);
  const [viewport, setViewport] = useState<CanvasViewport>(IDENTITY_CANVAS_VIEWPORT);
  const [dragged, setDragged] = useState<string>();
  const stageRef = useRef<HTMLDivElement>(null);

  const roomIds = layout.sites.flatMap((site) => site.rooms.map((room) => room.id));
  const currentRoomId = activeRoomId && roomIds.includes(activeRoomId) ? activeRoomId : roomIds[0];
  const current = currentRoomId ? findRoom(layout, currentRoomId) : undefined;

  /**
   * Every mutation funnels through here, so a rejected placement (a rack-unit
   * collision, a full rack, an unknown reference) surfaces as a Problem instead
   * of a thrown render.
   */
  const apply = useCallback((next: () => LabDocument) => {
    try {
      onChange(next(), "presentation");
    } catch (error) {
      onError(error instanceof Error ? error.message : "Physical placement failed");
    }
  }, [onChange, onError]);

  // One viewport, one classifier: the wheel listener is bound to the stage
  // container (never to document) and reuses the shared trackpad heuristics.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const onWheel = (event: WheelEvent) => {
      const intent = classifyCanvasWheel(event);
      if (intent.type === "ignore") return;
      event.preventDefault();
      const bounds = stage.getBoundingClientRect();
      setViewport((currentViewport) => intent.type === "pan"
        ? panViewport(currentViewport, intent.deltaX, intent.deltaY)
        : zoomViewportAtPoint(
            currentViewport,
            currentViewport.scale * wheelZoomMultiplier(intent.delta),
            intent.clientX - bounds.left,
            intent.clientY - bounds.top,
          ));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, []);

  const hostnames = useMemo(() => new Map(document.topology.nodes.map((node) => [
    node.id,
    document.configurations[node.id]?.hostname ?? node.name ?? node.id,
  ])), [document]);
  const kinds = useMemo(
    () => new Map<string, DeviceType>(document.topology.nodes.map((node) => [node.id, node.kind])),
    [document],
  );
  const statuses = useMemo(() => new Map(props.nodes.map((node) => [node.id, node.status])), [props.nodes]);
  const unplaced = useMemo(() => unplacedDeviceIds(document), [document]);
  const overlay = useMemo(
    () => currentRoomId ? physicalConnectionOverlay(document, currentRoomId) : undefined,
    [document, currentRoomId],
  );

  const background = current?.room.backgroundAssetId
    ? (document.diagram?.assets ?? []).find((asset) => asset.id === current.room.backgroundAssetId)
    : undefined;

  const dropOnRack = (rackId: string, rackUnit: number) => {
    const deviceId = dragged;
    setDragged(undefined);
    if (!deviceId) return;
    apply(() => placeDeviceInRack(document, deviceId, rackId, rackUnit));
  };

  /** A free spot clear of the racks, so a desk device is never drawn behind one. */
  const nextFreeSpot = () => {
    const racks = current?.room.racks ?? [];
    const clearOfRacks = racks.reduce((right, rack) => Math.max(right, rack.position.x + rack.width), 0);
    const existing = current ? freeDevicesInRoom(layout, current.room.id).length : 0;
    return { x: clearOfRacks + 40 + (existing % 4) * 100, y: 40 + Math.floor(existing / 4) * 100 };
  };

  const dropOnRoom = (event: DragEvent<HTMLDivElement>) => {
    const deviceId = dragged;
    setDragged(undefined);
    if (!deviceId || !currentRoomId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    apply(() => placeDeviceInRoom(document, deviceId, currentRoomId, {
      x: Math.round((event.clientX - bounds.left - viewport.translateX) / viewport.scale),
      y: Math.round((event.clientY - bounds.top - viewport.translateY) / viewport.scale),
    }));
  };

  return (
    <section className="physical-workspace" aria-label="Physical workspace">
      <aside className="physical-tree" aria-label="Physical hierarchy">
        <div className="physical-tree__actions">
          <Button
            size="sm"
            onClick={() => apply(() => addPhysicalSite(document, `Site ${layout.sites.length + 1}`))}
          >
            <Plus size={12} /> Site
          </Button>
        </div>
        <ul className="physical-tree__list">
          {layout.sites.map((site) => (
            <li key={site.id}>
              <button
                type="button"
                className={selection?.kind === "site" && selection.id === site.id ? "is-active" : ""}
                onClick={() => setSelection({ kind: "site", id: site.id })}
              >
                <Building2 size={13} aria-hidden="true" /> {site.name}
              </button>
              <ul>
                {site.rooms.map((room) => (
                  <li key={room.id}>
                    <button
                      type="button"
                      aria-current={room.id === currentRoomId}
                      className={room.id === currentRoomId ? "is-active" : ""}
                      onClick={() => { setActiveRoomId(room.id); setSelection({ kind: "room", id: room.id }); }}
                    >
                      <DoorOpen size={13} aria-hidden="true" /> {room.name}
                    </button>
                    <ul>
                      {room.racks.map((rack) => (
                        <li key={rack.id}>
                          <button
                            type="button"
                            className={selection?.kind === "rack" && selection.id === rack.id ? "is-active" : ""}
                            onClick={() => { setActiveRoomId(room.id); setSelection({ kind: "rack", id: rack.id }); }}
                          >
                            <Boxes size={13} aria-hidden="true" /> {rack.name}
                          </button>
                        </li>
                      ))}
                      <li>
                        <button
                          type="button"
                          className="physical-tree__add"
                          onClick={() => apply(() => addPhysicalRack(document, room.id, `Rack ${room.racks.length + 1}`))}
                        >
                          <Plus size={11} aria-hidden="true" /> Rack
                        </button>
                      </li>
                    </ul>
                  </li>
                ))}
                <li>
                  <button
                    type="button"
                    className="physical-tree__add"
                    onClick={() => apply(() => addPhysicalRoom(document, site.id, `Room ${site.rooms.length + 1}`))}
                  >
                    <Plus size={11} aria-hidden="true" /> Room
                  </button>
                </li>
              </ul>
            </li>
          ))}
        </ul>
      </aside>

      <div className="physical-stage-shell">
        <div className="physical-stage-bar">
          <strong>{current ? `${current.site.name} · ${current.room.name}` : "No room"}</strong>
          <label className="physical-toggle">
            <input
              type="checkbox"
              checked={connectionsShown}
              onChange={(event) => setConnectionsShown(event.target.checked)}
            />
            Show Connections
          </label>
        </div>
        <div
          className="physical-stage"
          ref={stageRef}
          role="group"
          aria-label="Room layout"
          onDragOver={(event) => { if (dragged) event.preventDefault(); }}
          onDrop={dropOnRoom}
        >
          <div
            className="physical-stage__scene"
            style={{
              transform: `translate(${viewport.translateX}px, ${viewport.translateY}px) scale(${viewport.scale})`,
            }}
          >
            {background && <img
              className="physical-stage__background"
              src={diagramAssetDataUrl(background)}
              alt=""
              width={background.width}
              height={background.height}
            />}
            {current?.room.racks.map((rack) => (
              <RackView
                key={rack.id}
                rack={rack}
                placements={devicesInRack(layout, rack.id)}
                hostnames={hostnames}
                kinds={kinds}
                statuses={statuses}
                selectedDeviceId={selection?.kind === "device" ? selection.id : undefined}
                dragging={dragged !== undefined}
                onSelectRack={() => setSelection({ kind: "rack", id: rack.id })}
                onSelectDevice={(deviceId) => setSelection({ kind: "device", id: deviceId })}
                onOpenDevice={props.onOpenDevice}
                onDragDevice={setDragged}
                onDropUnit={dropOnRack}
              />
            ))}
            {current && freeDevicesInRoom(layout, current.room.id).map((placement) => (
              <button
                key={placement.deviceId}
                type="button"
                className="physical-free-device"
                style={{ left: `${placement.x ?? 0}px`, top: `${placement.y ?? 0}px` }}
                draggable
                aria-label={`${hostnames.get(placement.deviceId)} in ${current.room.name}`}
                onDragStart={() => setDragged(placement.deviceId)}
                onDragEnd={() => setDragged(undefined)}
                onClick={() => setSelection({ kind: "device", id: placement.deviceId })}
                onDoubleClick={() => props.onOpenDevice(placement.deviceId)}
              >
                <DeviceIcon
                  type={kinds.get(placement.deviceId) ?? "pc"}
                  size={28}
                  state={statuses.get(placement.deviceId) === "up" ? "running" : "stopped"}
                />
                <span>{hostnames.get(placement.deviceId)}</span>
              </button>
            ))}
          </div>
          {connectionsShown && overlay && <ConnectionSummary overlay={overlay} hostnames={hostnames} />}
        </div>
        <p className="physical-note">
          <Info size={12} aria-hidden="true" />
          Physical placement is visual only. Wireless coverage and cable length are not calculated in
          this version.
        </p>
      </div>

      <aside className="physical-properties" aria-label="Physical properties">
        {!selection && <p className="section-note">Select a site, room, rack or device.</p>}
        {selection?.kind === "site" && (() => {
          const site = layout.sites.find((candidate) => candidate.id === selection.id);
          if (!site) return null;
          return <>
            <p className="section-eyebrow">Site</p>
            <label>Name<input
              value={site.name}
              onChange={(event) => apply(() => renamePhysicalSite(document, site.id, event.target.value))}
            /></label>
            <Button
              size="sm"
              variant="danger"
              onClick={() => { apply(() => removePhysicalSite(document, site.id)); setSelection(undefined); }}
            >
              <Trash2 size={12} /> Delete site
            </Button>
          </>;
        })()}
        {selection?.kind === "room" && (() => {
          const found = findRoom(layout, selection.id);
          if (!found) return null;
          return <>
            <p className="section-eyebrow">Room</p>
            <label>Name<input
              value={found.room.name}
              onChange={(event) => apply(() => renamePhysicalRoom(document, found.room.id, event.target.value))}
            /></label>
            <p className="section-note">
              Background images reuse the diagram editor's validated PNG, JPEG and WebP assets.
              {found.room.backgroundAssetId ? " A floor plan is attached." : " No floor plan is attached."}
            </p>
            <Button
              size="sm"
              variant="danger"
              onClick={() => { apply(() => removePhysicalRoom(document, found.room.id)); setSelection(undefined); }}
            >
              <Trash2 size={12} /> Delete room
            </Button>
          </>;
        })()}
        {selection?.kind === "rack" && (() => {
          const rack = current?.room.racks.find((candidate) => candidate.id === selection.id);
          if (!rack) return null;
          return <>
            <p className="section-eyebrow">Rack</p>
            <label>Name<input
              value={rack.name}
              onChange={(event) => apply(() => renamePhysicalRack(document, rack.id, event.target.value))}
            /></label>
            <dl className="property-list"><div><dt>Rack units</dt><dd>{rack.rackUnits} U</dd></div></dl>
            <Button
              size="sm"
              variant="danger"
              onClick={() => { apply(() => removePhysicalRack(document, rack.id)); setSelection(undefined); }}
            >
              <Trash2 size={12} /> Delete rack
            </Button>
          </>;
        })()}
        {selection?.kind === "device" && (
          <DeviceProperties
            deviceId={selection.id}
            hostname={hostnames.get(selection.id) ?? selection.id}
            placement={placementOf(layout, selection.id)}
            racks={current?.room.racks ?? []}
            roomName={current?.room.name}
            onSpan={(span) => apply(() => withDeviceRackUnitSpan(document, selection.id, span))}
            onUnplace={() => apply(() => unplaceDevice(document, selection.id))}
            onToRoom={() => currentRoomId && apply(
              () => placeDeviceInRoom(document, selection.id, currentRoomId, nextFreeSpot()),
            )}
            onToRack={(rackId) => apply(() => {
              const span = placementOf(layout, selection.id)?.rackUnitSpan ?? MIN_DEVICE_RACK_UNIT_SPAN;
              const unit = firstFreeRackUnit(layout, rackId, span);
              if (unit === undefined) throw new PhysicalPlacementError("This rack has no free unit for that size.");
              return placeDeviceInRack(document, selection.id, rackId, unit);
            })}
          />
        )}
      </aside>

      <section className="physical-tray" aria-label="Unplaced Devices">
        <strong>Unplaced Devices <small>{unplaced.length}</small></strong>
        <div className="physical-tray__items">
          {unplaced.length === 0 && <span className="section-note">Every device has a place.</span>}
          {unplaced.map((deviceId) => (
            <button
              key={deviceId}
              type="button"
              className="physical-tray__device"
              draggable
              aria-label={`Unplaced ${hostnames.get(deviceId)}`}
              onDragStart={() => setDragged(deviceId)}
              onDragEnd={() => setDragged(undefined)}
              onClick={() => setSelection({ kind: "device", id: deviceId })}
              onDoubleClick={() => props.onOpenDevice(deviceId)}
            >
              <DeviceIcon type={kinds.get(deviceId) ?? "pc"} size={20} state="stopped" />
              {hostnames.get(deviceId)}
            </button>
          ))}
        </div>
      </section>
    </section>
  );
}

function RackView({
  rack,
  placements,
  hostnames,
  kinds,
  statuses,
  selectedDeviceId,
  dragging,
  onSelectRack,
  onSelectDevice,
  onOpenDevice,
  onDragDevice,
  onDropUnit,
}: {
  rack: PhysicalRack;
  placements: readonly DevicePhysicalPlacement[];
  hostnames: ReadonlyMap<string, string>;
  kinds: ReadonlyMap<string, DeviceType>;
  statuses: ReadonlyMap<string, string>;
  selectedDeviceId?: string;
  dragging: boolean;
  onSelectRack(): void;
  onSelectDevice(deviceId: string): void;
  onOpenDevice(deviceId: string): void;
  onDragDevice(deviceId: string | undefined): void;
  onDropUnit(rackId: string, rackUnit: number): void;
}) {
  const occupants = new Map<number, DevicePhysicalPlacement>();
  for (const placement of placements) {
    for (let unit = placement.rackUnit ?? 1; unit <= placementLastRackUnit(placement); unit++) {
      occupants.set(unit, placement);
    }
  }
  const units = Array.from({ length: rack.rackUnits }, (_, index) => index + 1);
  return (
    <section
      className="physical-rack"
      aria-label={`Rack ${rack.name}`}
      style={{
        left: `${rack.position.x}px`,
        top: `${rack.position.y}px`,
        width: `${rack.width}px`,
        height: `${rack.height ?? RACK_HEADER_HEIGHT + rack.rackUnits * RACK_UNIT_HEIGHT}px`,
      }}
    >
      <header>
        <button type="button" onClick={onSelectRack}>{rack.name}</button>
        <small>{rack.rackUnits} U</small>
      </header>
      <ol className="physical-rack__units">
        {units.map((unit) => {
          const placement = occupants.get(unit);
          const isFirstUnit = placement?.rackUnit === unit;
          return (
            <li
              key={unit}
              className={placement ? "is-occupied" : ""}
              data-unit={unit}
              onDragOver={(event) => { if (dragging) event.preventDefault(); }}
              onDrop={(event) => { event.preventDefault(); event.stopPropagation(); onDropUnit(rack.id, unit); }}
            >
              <span className="physical-rack__u">U{String(unit).padStart(2, "0")}</span>
              {isFirstUnit && placement && (
                <button
                  type="button"
                  className={`physical-rack__device${selectedDeviceId === placement.deviceId ? " is-selected" : ""}`}
                  style={{ height: `${placement.rackUnitSpan * RACK_UNIT_HEIGHT - 4}px` }}
                  draggable
                  aria-label={`${hostnames.get(placement.deviceId)} in ${rack.name} U${placement.rackUnit}`}
                  onDragStart={() => onDragDevice(placement.deviceId)}
                  onDragEnd={() => onDragDevice(undefined)}
                  onClick={() => onSelectDevice(placement.deviceId)}
                  onDoubleClick={() => onOpenDevice(placement.deviceId)}
                >
                  <DeviceIcon
                    type={kinds.get(placement.deviceId) ?? "pc"}
                    size={16}
                    state={statuses.get(placement.deviceId) === "up" ? "running" : "stopped"}
                  />
                  <span>{hostnames.get(placement.deviceId)}</span>
                  <i
                    className="physical-rack__status"
                    data-status={statuses.get(placement.deviceId) ?? "unknown"}
                    aria-hidden="true"
                  />
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function DeviceProperties({
  deviceId,
  hostname,
  placement,
  racks,
  roomName,
  onSpan,
  onUnplace,
  onToRoom,
  onToRack,
}: {
  deviceId: string;
  hostname: string;
  placement: DevicePhysicalPlacement | undefined;
  racks: readonly PhysicalRack[];
  roomName: string | undefined;
  onSpan(span: number): void;
  onUnplace(): void;
  onToRoom(): void;
  onToRack(rackId: string): void;
}) {
  return <>
    <p className="section-eyebrow">Device placement</p>
    <h3>{hostname}</h3>
    <dl className="property-list">
      <div><dt>Device</dt><dd><code>{deviceId}</code></dd></div>
      <div><dt>Placement</dt><dd>{placement
        ? placement.rackId ? `Rack · U${placement.rackUnit}` : "Free in room"
        : "Unplaced"}</dd></div>
    </dl>
    <label>Size (U)<select
      aria-label="Rack units occupied"
      value={placement?.rackUnitSpan ?? MIN_DEVICE_RACK_UNIT_SPAN}
      disabled={!placement}
      onChange={(event) => onSpan(Number(event.target.value))}
    >
      {Array.from({ length: MAX_DEVICE_RACK_UNIT_SPAN }, (_, index) => index + 1).map((span) => (
        <option key={span} value={span}>{span} U</option>
      ))}
    </select></label>
    {racks.length > 0 && <label>Move to rack<select
      aria-label="Move to rack"
      value=""
      onChange={(event) => { if (event.target.value) onToRack(event.target.value); }}
    >
      <option value="">Choose a rack…</option>
      {racks.map((rack) => <option key={rack.id} value={rack.id}>{rack.name}</option>)}
    </select></label>}
    <div className="physical-properties__actions">
      <Button size="sm" disabled={!roomName} onClick={onToRoom}>Place in room</Button>
      <Button size="sm" variant="ghost" disabled={!placement} onClick={onUnplace}>Return to Unplaced</Button>
    </div>
    <p className="section-note">
      Placement is presentation only: it never changes interfaces, links, routing, wireless signal or
      grading, and it does not rebuild the running lab.
    </p>
  </>;
}

/**
 * Connections are drawn from the *logical* links, never from separate physical
 * cables. A peer outside this room is summarized instead of being routed
 * across the drawing.
 */
function ConnectionSummary({
  overlay,
  hostnames,
}: {
  overlay: PhysicalConnectionOverlay;
  hostnames: ReadonlyMap<string, string>;
}) {
  return (
    <div className="physical-connections" aria-label="Connection summary">
      <strong>Connections</strong>
      {overlay.inRoom.length === 0 && overlay.offRoom.length === 0 && <span>No links reach this room.</span>}
      {overlay.inRoom.map((entry) => (
        <span key={entry.linkId}>{hostnames.get(entry.a)} ↔ {hostnames.get(entry.b)}</span>
      ))}
      {overlay.offRoom.map((entry) => (
        <span key={`${entry.linkId}:${entry.deviceId}`} className="is-off-room">
          {hostnames.get(entry.deviceId)} → {hostnames.get(entry.peerDeviceId)} ({entry.peerLocation})
        </span>
      ))}
    </div>
  );
}

export default PhysicalWorkspace;
