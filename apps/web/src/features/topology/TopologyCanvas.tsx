import type { LabDocument } from "@sim/contracts";
import type { LabUiSnapshot } from "@sim/sim-worker";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type NodeChange,
} from "@xyflow/react";
import { useMemo } from "react";
import { allocateId, removeDraftDevice, withNodePosition } from "../lab/document";
import { DeviceNode, type DeviceFlowNode } from "./DeviceNode";

interface TopologyCanvasProps {
  document: LabDocument | undefined;
  snapshot: LabUiSnapshot | undefined;
  selectedNodeId: string | undefined;
  onSelect(id: string | undefined): void;
  onChange(document: LabDocument): void;
}

const nodeTypes = { device: DeviceNode };

function endpointKey(node: string, iface: string): string {
  return `${node}\u0000${iface}`;
}

export function TopologyCanvas({ document, snapshot, selectedNodeId, onSelect, onChange }: TopologyCanvasProps) {
  const status = useMemo(() => new Map(snapshot?.nodes.map((node) => [node.id, node])), [snapshot]);
  if (!document) {
    return (
      <section className="topology-empty" aria-label="Topology canvas">
        <div><span>◇</span><h2>No laboratory loaded</h2><p>Load the built-in demo or import a LabDocument JSON file.</p></div>
      </section>
    );
  }

  const nodes: DeviceFlowNode[] = document.topology.nodes.map((node) => {
    const live = status.get(node.id);
    return {
      id: node.id,
      type: "device",
      position: node.position ?? { x: 0, y: 0 },
      selected: selectedNodeId === node.id,
      data: {
        hostname: live?.hostname ?? document.configurations[node.id]?.hostname ?? node.name ?? node.id,
        deviceType: node.kind,
        status: live?.status ?? "down",
        interfaces: node.interfaces.map((iface) => iface.id),
        onActivate: onSelect,
      },
    };
  });
  const edges: Edge[] = document.topology.links.map((link) => ({
    id: link.id,
    source: link.a.node,
    sourceHandle: link.a.iface,
    target: link.b.node,
    targetHandle: `target:${link.b.iface}`,
    className: "topology-link",
  }));

  const handleNodesChange = (changes: NodeChange<DeviceFlowNode>[]) => {
    let next = document;
    for (const change of changes) {
      if (change.type === "position" && change.position) next = withNodePosition(next, change.id, change.position);
      if (change.type === "remove") next = removeDraftDevice(next, change.id);
      if (change.type === "select" && change.selected) onSelect(change.id);
    }
    if (next !== document) onChange(next);
  };

  const connect = (connection: Connection) => {
    if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return;
    const sourceInterface = connection.sourceHandle;
    const targetInterface = connection.targetHandle.replace(/^target:/, "");
    if (connection.source === connection.target && sourceInterface === targetInterface) return;
    const used = new Set(document.topology.links.flatMap((link) => [
      endpointKey(link.a.node, link.a.iface),
      endpointKey(link.b.node, link.b.iface),
    ]));
    if (used.has(endpointKey(connection.source, sourceInterface)) || used.has(endpointKey(connection.target, targetInterface))) return;
    const id = allocateId("link", document.topology.links.map((link) => link.id));
    onChange({
      ...document,
      topology: {
        ...document.topology,
        links: [...document.topology.links, {
          id,
          a: { node: connection.source, iface: sourceInterface },
          b: { node: connection.target, iface: targetInterface },
        }],
      },
    });
  };

  const deleteEdges = (deleted: Edge[]) => {
    const ids = new Set(deleted.map((edge) => edge.id));
    onChange({
      ...document,
      topology: { ...document.topology, links: document.topology.links.filter((link) => !ids.has(link.id)) },
    });
  };

  return (
    <section className="topology-panel" aria-label="Topology canvas">
      <div className="canvas-title"><span>{document.title}</span><small>{document.topology.nodes.length} devices · {document.topology.links.length} links</small></div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onConnect={connect}
        onEdgesDelete={deleteEdges}
        onPaneClick={() => onSelect(undefined)}
        fitView
        minZoom={0.35}
        maxZoom={1.8}
        deleteKeyCode={["Backspace", "Delete"]}
      >
        <Background color="#2a3140" gap={24} size={1} />
        <MiniMap pannable zoomable nodeColor={(node) => node.selected ? "#7dd3fc" : "#48566d"} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </section>
  );
}
