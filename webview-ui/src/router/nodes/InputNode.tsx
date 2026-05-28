import { Handle, Position } from "@xyflow/react";

export default function InputNode() {
  return (
    <div className="rf-node node-input">
      <div className="node-title">Input</div>
      <div className="node-subtitle">Agent task arrives here</div>
      <Handle type="source" position={Position.Right} id="out" />
    </div>
  );
}