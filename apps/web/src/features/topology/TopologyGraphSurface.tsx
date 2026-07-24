import type { LabDocument } from "@sim/contracts";
import { useEffect, useRef, type DragEvent } from "react";
import { createTopologyGraphController } from "./x6/graph-controller";
import type { Point, TopologyGraphController, TopologyView } from "./x6/types";

// Thin React binding between the topology view models and the imperative X6
// controller. This module is the only place React touches the controller, and
// it is what tests mock (X6 needs real DOM measurement jsdom does not provide).

export interface TopologyGraphSurfaceProps {
  document: LabDocument;
  view: TopologyView;
  readonly: boolean;
  draggable: boolean;
  connectable: boolean;
  fitRequest: number;
  zoomResetRequest: number;
  zoomInRequest: number;
  zoomOutRequest: number;
  onReady(handle: { clientToLocal(point: Point): Point; fit(): void }): void;
  onNodeMoved(id: string, position: Point): void;
  onSelectNode(id: string): void;
  onOpenDevice(id: string): void;
  onConnectionIntent(source: string, target: string, sourcePort?: string, targetPort?: string): void;
  onConnect(source: string, sourcePort: string, target: string, targetPort: string): void;
  onConnectionRejected(message: string): void;
  onSelectLink(id: string): void;
  onLinkContextMenu(id: string, clientX: number, clientY: number): void;
  onSelectAnnotation(id: string): void;
  onEditAnnotation(id: string): void;
  onAnnotationMoved(id: string, position: Point): void;
  onPaneClick(local: Point): void;
  onPaneContextMenu(clientX: number, clientY: number): void;
  onDropDevice(kind: string, local: Point): void;
}

export function TopologyGraphSurface(props: TopologyGraphSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<TopologyGraphController | undefined>(undefined);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const controller = createTopologyGraphController({
      container,
      callbacks: {
        onNodeMoved: (id, position) => propsRef.current.onNodeMoved(id, position),
        onSelectNode: (id) => propsRef.current.onSelectNode(id),
        onOpenDevice: (id) => propsRef.current.onOpenDevice(id),
        onConnectionIntent: (source, target, sourcePort, targetPort) => propsRef.current.onConnectionIntent(source, target, sourcePort, targetPort),
        onConnect: (source, sourcePort, target, targetPort) => propsRef.current.onConnect(source, sourcePort, target, targetPort),
        onConnectionRejected: (message) => propsRef.current.onConnectionRejected(message),
        onSelectLink: (id) => propsRef.current.onSelectLink(id),
        onLinkContextMenu: (id, x, y) => propsRef.current.onLinkContextMenu(id, x, y),
        onSelectAnnotation: (id) => propsRef.current.onSelectAnnotation(id),
        onEditAnnotation: (id) => propsRef.current.onEditAnnotation(id),
        onAnnotationMoved: (id, position) => propsRef.current.onAnnotationMoved(id, position),
        onPaneClick: (local) => propsRef.current.onPaneClick(local),
        onPaneContextMenu: (x, y) => propsRef.current.onPaneContextMenu(x, y),
        onDropDevice: (kind, local) => propsRef.current.onDropDevice(kind, local),
      },
    });
    controllerRef.current = controller;
    controller.updateReadonlyState(propsRef.current.readonly);
    controller.updateDraggable(propsRef.current.draggable);
    controller.updateConnectable(propsRef.current.connectable);
    controller.loadDocument(propsRef.current.document);
    controller.applyView(propsRef.current.view);
    propsRef.current.onReady({
      clientToLocal: (point) => controller.clientToLocal(point),
      fit: () => controller.fitToContent(),
    });
    return () => {
      controller.destroy();
      controllerRef.current = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    controller.updateReadonlyState(props.readonly);
    controller.updateDraggable(props.draggable);
    controller.updateConnectable(props.connectable);
  }, [props.readonly, props.draggable, props.connectable]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    controller.loadDocument(props.document);
    controller.applyView(props.view);
  }, [props.document, props.view]);

  useEffect(() => { if (props.fitRequest > 0) controllerRef.current?.fitToContent(); }, [props.fitRequest]);
  useEffect(() => { if (props.zoomResetRequest > 0) controllerRef.current?.resetZoom(); }, [props.zoomResetRequest]);
  useEffect(() => { if (props.zoomInRequest > 0) controllerRef.current?.zoomIn(); }, [props.zoomInRequest]);
  useEffect(() => { if (props.zoomOutRequest > 0) controllerRef.current?.zoomOut(); }, [props.zoomOutRequest]);

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const kind = event.dataTransfer.getData("application/x-simulator-device");
    const controller = controllerRef.current;
    if (!kind || !controller) return;
    props.onDropDevice(kind, controller.clientToLocal({ x: event.clientX, y: event.clientY }));
  };

  return (
    <div
      className="topology-graph"
      data-testid="topology-graph"
      ref={containerRef}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
      onDrop={onDrop}
    />
  );
}

export default TopologyGraphSurface;
