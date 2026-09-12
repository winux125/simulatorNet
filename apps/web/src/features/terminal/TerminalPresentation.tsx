import type { ConsoleAccessConfiguration } from "@sim/contracts";
import type { LabUiNode } from "@sim/sim-worker";
import {
  Maximize2,
  Minimize2,
  Minus,
  PanelBottom,
  PictureInPicture2,
  TerminalSquare,
  X,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { SimulatorClient } from "../../app/simulator-client";
import type { ResolvedTheme } from "../../hooks/useTheme";
import type { WorkspaceMode } from "../../state/workspace-store";
import { IconButton } from "../../ui";
import { TerminalWorkspace } from "./TerminalPanel";
import type { TerminalAppearance } from "./terminal-appearance";
import {
  clampTerminalBounds,
  TERMINAL_DOCK_SLOT_ID,
  type TerminalFloatingBounds,
  type TerminalPresentationMode,
  type TerminalWorkspaceSize,
} from "./terminal-presentation-state";

type DockBounds = TerminalFloatingBounds;

interface TerminalPresentationProps {
  client: SimulatorClient;
  tabs: string[];
  activeDeviceId: string | undefined;
  nodes: LabUiNode[];
  workspaceMode: WorkspaceMode;
  theme: ResolvedTheme;
  appearance: TerminalAppearance;
  presentationMode: TerminalPresentationMode;
  visible: boolean;
  /**
   * False while the bottom panel is collapsed or showing another tab: a docked
   * terminal then has no measurable slot. The session stays mounted; only its
   * presentation and xterm fitting are suspended.
   */
  dockAvailable: boolean;
  minimized: boolean;
  floatingBounds: TerminalFloatingBounds;
  consoleAccessFor(deviceId: string): ConsoleAccessConfiguration | undefined;
  onActivate(deviceId: string): void;
  onCloseTab(deviceId: string): void;
  onReorder(fromIndex: number, toIndex: number): void;
  onCloseOthers(deviceId: string): void;
  onCloseToRight(deviceId: string): void;
  onPresentationMode(mode: TerminalPresentationMode): void;
  onRestore(): void;
  onVisible(visible: boolean): void;
  onMinimized(minimized: boolean): void;
  onFloatingBounds(bounds: TerminalFloatingBounds): void;
  onDockHeight(height: number): void;
  onError(message: string): void;
}

function sameBounds(left: TerminalFloatingBounds, right: TerminalFloatingBounds): boolean {
  return left.x === right.x && left.y === right.y
    && left.width === right.width && left.height === right.height;
}

export function TerminalPresentation(props: TerminalPresentationProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLElement>(null);
  const draggingRef = useRef(false);
  const dragCleanupRef = useRef<() => void>(() => undefined);
  const [dockBounds, setDockBounds] = useState<DockBounds>();

  const workspaceSize = (): TerminalWorkspaceSize => {
    const width = layerRef.current?.clientWidth;
    const height = layerRef.current?.clientHeight;
    return {
      width: width && width > 1 ? width : window.innerWidth,
      height: height && height > 1 ? height : window.innerHeight,
    };
  };

  // A docked terminal is only on screen when the bottom panel gives it a slot.
  const onScreen = props.visible
    && (props.presentationMode !== "docked" || props.dockAvailable);

  useEffect(() => () => dragCleanupRef.current(), []);

  useEffect(() => {
    if (!onScreen && shellRef.current?.contains(document.activeElement)) {
      (document.activeElement as HTMLElement | null)?.blur();
    }
  }, [onScreen]);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    let observer: ResizeObserver | undefined;
    let dockHeightTimer: number | undefined;
    const update = (): boolean => {
      const dock = document.getElementById(TERMINAL_DOCK_SLOT_ID);
      if (!dock) return false;
      observer?.observe(dock);
      const layerRect = layer.getBoundingClientRect();
      const dockRect = dock.getBoundingClientRect();
      const next = {
        x: dockRect.left - layerRect.left,
        y: dockRect.top - layerRect.top,
        width: dockRect.width,
        height: dockRect.height,
      };
      setDockBounds((current) => current && sameBounds(current, next) ? current : next);
      if (dockRect.height > 0) {
        if (dockHeightTimer !== undefined) window.clearTimeout(dockHeightTimer);
        dockHeightTimer = window.setTimeout(
          () => props.onDockHeight(Math.round(dockRect.height)),
          120,
        );
      }
      return true;
    };
    observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    const dockFound = update();
    observer?.observe(layer);
    const mutationObserver = !dockFound && typeof MutationObserver !== "undefined"
      ? new MutationObserver(() => {
          if (update()) mutationObserver?.disconnect();
        })
      : undefined;
    mutationObserver?.observe(layer.parentElement ?? layer, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      mutationObserver?.disconnect();
      if (dockHeightTimer !== undefined) window.clearTimeout(dockHeightTimer);
      window.removeEventListener("resize", update);
    };
    // Re-measure when the dock slot appears or disappears with the panel state.
  }, [props.dockAvailable, props.onDockHeight]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const clamp = () => {
      if (props.presentationMode !== "floating") return;
      const next = clampTerminalBounds(props.floatingBounds, workspaceSize());
      if (!sameBounds(next, props.floatingBounds)) props.onFloatingBounds(next);
    };
    clamp();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(clamp);
    observer?.observe(layer);
    window.addEventListener("resize", clamp);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", clamp);
    };
  }, [props.floatingBounds, props.onFloatingBounds, props.presentationMode]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const observer = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(() => {
          if (props.presentationMode !== "floating" || draggingRef.current || props.minimized) return;
          const next = clampTerminalBounds({
            ...props.floatingBounds,
            width: Math.round(shell.offsetWidth),
            height: Math.round(shell.offsetHeight),
          }, workspaceSize());
          if (!sameBounds(next, props.floatingBounds)) props.onFloatingBounds(next);
        });
    observer?.observe(shell);
    return () => observer?.disconnect();
  }, [props.floatingBounds, props.minimized, props.onFloatingBounds, props.presentationMode]);

  const beginDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (props.presentationMode !== "floating" || event.button !== 0
      || (event.target as HTMLElement).closest("button, input")) return;
    event.preventDefault();
    draggingRef.current = true;
    const start = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      bounds: props.floatingBounds,
    };
    const move = (pointer: PointerEvent) => {
      const next = clampTerminalBounds({
        ...start.bounds,
        x: start.bounds.x + pointer.clientX - start.pointerX,
        y: start.bounds.y + pointer.clientY - start.pointerY,
      }, workspaceSize());
      props.onFloatingBounds(next);
    };
    const finish = () => {
      draggingRef.current = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      dragCleanupRef.current = () => undefined;
    };
    dragCleanupRef.current();
    dragCleanupRef.current = finish;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  };

  const style = ((): CSSProperties => {
    if (props.presentationMode === "docked") {
      const bounds = dockBounds ?? { x: 0, y: 0, width: 0, height: 0 };
      return {
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height,
      };
    }
    if (props.presentationMode === "floating") {
      const bounds = clampTerminalBounds(props.floatingBounds, workspaceSize());
      return {
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: props.minimized ? 28 : bounds.height,
      };
    }
    return props.minimized
      ? { right: 8, bottom: 8, width: 400, height: 28 }
      : { inset: 6 };
  })();

  const docked = props.presentationMode === "docked";
  const title = docked ? "Docked" : props.presentationMode === "floating" ? "Floating" : "Maximized";
  const layoutSignal = `${props.presentationMode}:${onScreen}:${props.minimized}:${style.width ?? "auto"}:${style.height ?? "auto"}`;

  // One set of presentation controls, rendered in the titlebar when the shell
  // has one and in the tab strip when it is docked. There is no second copy of
  // "close this tab" here: every tab already carries its own close control.
  const windowActions = <>
    <IconButton label="Dock terminal at bottom" icon={<PanelBottom size={12} />} disabled={docked} onClick={() => props.onPresentationMode("docked")} />
    <IconButton label="Float terminal" icon={<PictureInPicture2 size={12} />} disabled={props.presentationMode === "floating"} onClick={() => props.onPresentationMode("floating")} />
    <IconButton
      label={props.presentationMode === "maximized" ? "Restore terminal" : "Maximize terminal"}
      icon={props.presentationMode === "maximized" ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
      onClick={() => props.presentationMode === "maximized" ? props.onRestore() : props.onPresentationMode("maximized")}
    />
    {/* Docked, the bottom panel's own Minimize already collapses this surface. */}
    {!docked && <IconButton label={props.minimized ? "Restore minimized terminal" : "Minimize terminal"} icon={<Minus size={12} />} onClick={() => props.onMinimized(!props.minimized)} />}
    <IconButton label="Close terminal window" icon={<X size={12} />} onClick={() => props.onVisible(false)} />
  </>;

  return (
    <div ref={layerRef} className="terminal-presentation-layer" aria-hidden={!onScreen}>
      <section
        ref={shellRef}
        className={[
          "terminal-presentation",
          `terminal-presentation--${props.presentationMode}`,
          onScreen ? "is-visible" : "is-hidden",
          props.minimized ? "is-minimized" : "",
        ].filter(Boolean).join(" ")}
        style={style}
        role="region"
        aria-label="Terminal workspace"
        data-presentation-mode={props.presentationMode}
        data-terminal-visible={String(props.visible)}
        data-terminal-on-screen={String(onScreen)}
      >
        <header
          className="terminal-presentation__titlebar"
          onPointerDown={beginDrag}
          onDoubleClick={(event) => {
            if ((event.target as HTMLElement).closest("button, input")) return;
            if (props.presentationMode === "maximized") props.onRestore();
            else props.onPresentationMode("maximized");
          }}
        >
          <span className="terminal-presentation__identity">
            <TerminalSquare size={13} aria-hidden="true" />
            <strong>Terminal Workspace</strong>
            <small>{title} · {props.tabs.length} session{props.tabs.length === 1 ? "" : "s"}</small>
          </span>
          <span className="terminal-presentation__actions">{windowActions}</span>
        </header>
        <div className="terminal-presentation__content" hidden={props.minimized}>
          <TerminalWorkspace
            client={props.client}
            tabs={props.tabs}
            activeDeviceId={props.activeDeviceId}
            nodes={props.nodes}
            mode={props.workspaceMode}
            theme={props.theme}
            appearance={props.appearance}
            layoutSignal={layoutSignal}
            measurable={onScreen && !props.minimized}
            windowActions={docked ? windowActions : undefined}
            consoleAccessFor={props.consoleAccessFor}
            onActivate={props.onActivate}
            onClose={props.onCloseTab}
            onReorder={props.onReorder}
            onCloseOthers={props.onCloseOthers}
            onCloseToRight={props.onCloseToRight}
            onError={props.onError}
          />
        </div>
      </section>
    </div>
  );
}

export default TerminalPresentation;
