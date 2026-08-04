import { ArrowUpRight, Cable, Circle, Grid3X3, Hand, ImagePlus, Magnet, Minus, MousePointer2, Square, Type } from "lucide-react";
import type { WorkspaceMode, WorkspaceTool } from "../state/workspace-store";
import { IconButton } from "../ui";

interface ToolRailProps {
  mode: WorkspaceMode;
  activeTool: WorkspaceTool;
  structuralEditable: boolean;
  snapToGrid: boolean;
  smartGuides: boolean;
  onTool(tool: WorkspaceTool): void;
  onImage(): void;
  onSnapToGrid(value: boolean): void;
  onSmartGuides(value: boolean): void;
}

/**
 * Compact, presentation-only diagram tools. Primary lab actions stay in the
 * application toolbar; this rail is an overlay and never reserves canvas rows.
 */
export function ToolRail(props: ToolRailProps) {
  const editing = props.mode === "edit";
  return (
    <nav className="tool-rail" role="toolbar" aria-label="Diagram tools">
      <IconButton label="Select" title="Select (Escape)" icon={<MousePointer2 size={16} />} active={props.activeTool === "select"} onClick={() => props.onTool("select")} />
      <IconButton label="Hand" title="Hand / Pan" icon={<Hand size={16} />} active={props.activeTool === "pan"} onClick={() => props.onTool("pan")} />
      {editing && <>
        <span className="tool-rail__divider" />
        <IconButton label="Connection" title={props.structuralEditable ? "Connect devices" : "Stop the lab to edit connectivity"} icon={<Cable size={16} />} active={props.activeTool === "add-link"} disabled={!props.structuralEditable} onClick={() => props.onTool("add-link")} />
        <IconButton label="Text" icon={<Type size={16} />} active={props.activeTool === "annotation-text"} onClick={() => props.onTool("annotation-text")} />
        <IconButton label="Rectangle" icon={<Square size={16} />} active={props.activeTool === "annotation-rectangle"} onClick={() => props.onTool("annotation-rectangle")} />
        <IconButton label="Ellipse" icon={<Circle size={16} />} active={props.activeTool === "annotation-ellipse"} onClick={() => props.onTool("annotation-ellipse")} />
        <IconButton label="Line" icon={<Minus size={16} />} active={props.activeTool === "annotation-line"} onClick={() => props.onTool("annotation-line")} />
        <IconButton label="Arrow" icon={<ArrowUpRight size={16} />} active={props.activeTool === "annotation-arrow"} onClick={() => props.onTool("annotation-arrow")} />
        <IconButton label="Image" icon={<ImagePlus size={16} />} active={props.activeTool === "annotation-image"} onClick={props.onImage} />
        <span className="tool-rail__divider" />
        <IconButton label="Grid snap" title="Snap diagram items to the grid" icon={<Grid3X3 size={16} />} active={props.snapToGrid} onClick={() => props.onSnapToGrid(!props.snapToGrid)} />
        <IconButton label="Smart guides" title="Align diagram items with nearby objects" icon={<Magnet size={16} />} active={props.smartGuides} onClick={() => props.onSmartGuides(!props.smartGuides)} />
      </>}
    </nav>
  );
}
