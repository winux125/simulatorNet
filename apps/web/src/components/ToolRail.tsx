import { Cable, Grid3X3, Maximize2, MousePointer2, Plus, Trash2 } from "lucide-react";
import type { WorkspaceMode, WorkspaceTool } from "../state/workspace-store";
import { IconButton } from "../ui";

interface ToolRailProps {
  mode: WorkspaceMode;
  activeTool: WorkspaceTool;
  dirty: boolean;
  canDelete: boolean;
  onTool(tool: WorkspaceTool): void;
  onDelete(): void;
  onFit(): void;
  onArrange(): void;
  onApply(): void;
}

export function ToolRail(props: ToolRailProps) {
  const editable = props.mode === "edit";
  return (
    <nav className="tool-rail" aria-label="Topology tools">
      <IconButton label="Select tool" icon={<MousePointer2 size={17} />} active={props.activeTool === "select"} onClick={() => props.onTool("select")} />
      <IconButton label="Add device" icon={<Plus size={18} />} active={props.activeTool === "add-device"} disabled={!editable} onClick={() => props.onTool("add-device")} />
      <IconButton label="Add link" icon={<Cable size={17} />} active={props.activeTool === "add-link"} disabled={!editable} onClick={() => props.onTool("add-link")} />
      <IconButton label="Delete selected" icon={<Trash2 size={17} />} active={props.activeTool === "delete"} disabled={!editable || !props.canDelete} onClick={props.onDelete} />
      <span className="tool-rail__divider" />
      <IconButton label="Fit topology" icon={<Maximize2 size={17} />} onClick={props.onFit} />
      <IconButton label="Auto arrange" icon={<Grid3X3 size={17} />} disabled={!editable} onClick={props.onArrange} />
      <span className="tool-rail__spacer" />
      {props.dirty && <button type="button" className="tool-rail__apply tooltip-anchor" data-tooltip="Apply & Rebuild" aria-label="Apply & Rebuild" onClick={props.onApply}><span>!</span></button>}
    </nav>
  );
}
