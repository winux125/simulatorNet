import type { Node as X6Node } from "@antv/x6";
import { register } from "@antv/x6-react-shape";
import { createElement } from "react";
import { DeviceNode, type DeviceNodeData } from "../DeviceNode";
import { NODE_HEIGHT, NODE_WIDTH, SIM_DEVICE_SHAPE } from "./styles";

// The X6 node cell carries a plain-JSON payload; the React shape renders the
// same accessible DeviceNode used elsewhere in the app.
export interface DeviceCellData {
  device: DeviceNodeData;
  selected: boolean;
}

function DeviceReactNode({ node }: { node: X6Node }) {
  const data = node.getData<DeviceCellData>();
  if (!data) return null;
  return createElement(DeviceNode, { id: node.id, data: data.device, selected: data.selected });
}

let registered = false;

/** Register the device react-shape exactly once per runtime. */
export function registerDeviceNode(): void {
  if (registered) return;
  register({
    shape: SIM_DEVICE_SHAPE,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    effect: ["data"],
    component: DeviceReactNode,
  });
  registered = true;
}
