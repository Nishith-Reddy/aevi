import { Handle, Position, type NodeProps } from "@xyflow/react";

interface ModelOption {
  value: string;
  label: string;
  group: string;
}

interface ModelData {
  model:       string;
  __models?:   ModelOption[];
  __onChange?: (model: string) => void;
}

export default function ModelNode({ data }: NodeProps) {
  const d        = data as unknown as ModelData;
  const model    = d.model ?? "";
  const options  = d.__models ?? [];
  const onChange = d.__onChange ?? (() => {});

  const grouped: Record<string, ModelOption[]> = {};
  for (const o of options) {
    (grouped[o.group] ??= []).push(o);
  }
  const groups = Object.keys(grouped).sort();

  return (
    <div className="rf-node node-model">
      <Handle type="target" position={Position.Left} id="in" />
      <div className="node-title">Model</div>
      <div className="node-subtitle">Picked when this branch wins</div>

      <select
        className="model-select"
        value={model}
        onChange={e => onChange(e.target.value)}
      >
        <option value="" disabled>— select a model —</option>
        {groups.map(g => (
          <optgroup key={g} label={g}>
            {grouped[g].map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </optgroup>
        ))}
      </select>

      {model && <div className="model-current mono">{model}</div>}

      <Handle type="source" position={Position.Right} id="out" />
    </div>
  );
}