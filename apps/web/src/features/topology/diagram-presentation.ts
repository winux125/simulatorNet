import type { PortLabelMode } from "../../state/workspace-store";

export function portLabelsVisible(mode: PortLabelMode, selected: boolean): boolean {
  return mode === "always" || (mode === "selected" && selected);
}
