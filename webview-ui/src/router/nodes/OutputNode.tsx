import { Handle, Position } from "@xyflow/react";

export default function OutputNode() {
  return (
    <div className="rf-node node-output">
      <Handle type="target" position={Position.Left} id="in" />
      <div className="node-title">Output</div>
      <div className="node-subtitle">Routed model answers from here</div>
    </div>
  );
}