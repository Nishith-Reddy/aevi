import { Handle, Position, type NodeProps } from "@xyflow/react";

export interface RouteSpec {
  label:    string;
  examples: string[];
}

interface ClassifierData {
  routes:    RouteSpec[];
  __onChange?: (routes: RouteSpec[]) => void;
  __onDelete?: () => void;
}

export default function ClassifierNode({ data }: NodeProps) {
  const d        = data as unknown as ClassifierData;
  const routes   = d.routes ?? [];
  const onChange = d.__onChange ?? (() => {});
  const onDelete = d.__onDelete;

  function updateRoute(i: number, patch: Partial<RouteSpec>) {
    onChange(routes.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRoute() {
    onChange([...routes, { label: `route-${routes.length + 1}`, examples: [""] }]);
  }
  function removeRoute(i: number) {
    onChange(routes.filter((_, idx) => idx !== i));
  }
  function addExample(i: number) {
    updateRoute(i, { examples: [...routes[i].examples, ""] });
  }
  function updateExample(i: number, j: number, val: string) {
    const exs = routes[i].examples.map((e, idx) => (idx === j ? val : e));
    updateRoute(i, { examples: exs });
  }
  function removeExample(i: number, j: number) {
    const exs = routes[i].examples.filter((_, idx) => idx !== j);
    updateRoute(i, { examples: exs.length ? exs : [""] });
  }

  // Distribute handles vertically along the node's right edge.
  const handleTop = (i: number, total: number) => {
    if (total <= 1) return "50%";
    const pad = 12;
    const pct = pad + ((100 - 2 * pad) * i) / (total - 1);
    return `${pct}%`;
  };

  return (
    <div className="rf-node node-classifier">
      <Handle type="target" position={Position.Left} id="in" />
      {onDelete && (
        <button
          className="node-x"
          title="Delete classifier"
          aria-label="Delete classifier"
          onClick={e => { e.stopPropagation(); onDelete(); }}
          onMouseDown={e => e.stopPropagation()}
        >
          ✕
        </button>
      )}
      <div className="node-title">Classifier</div>
      <div className="node-subtitle">Routes the task by semantic similarity</div>

      <div className="routes">
        {routes.map((r, i) => (
          <div key={i} className="route">
            <div className="route-head">
              <input
                className="label-input"
                value={r.label}
                onChange={e => updateRoute(i, { label: e.target.value })}
                placeholder="label"
              />
              <button className="x" onClick={() => removeRoute(i)} title="Remove route">✕</button>
            </div>
            <div className="examples">
              {r.examples.map((ex, j) => (
                <div key={j} className="example-row">
                  <input
                    className="example-input"
                    value={ex}
                    onChange={e => updateExample(i, j, e.target.value)}
                    placeholder="example phrase"
                  />
                  <button className="x small" onClick={() => removeExample(i, j)}>✕</button>
                </div>
              ))}
              <button className="add-ex" onClick={() => addExample(i)}>+ example</button>
            </div>
          </div>
        ))}
        <button className="add-route" onClick={addRoute}>+ Route</button>
      </div>

      {routes.map((r, i) => (
        <Handle
          key={r.label || `route-${i}`}
          type="source"
          position={Position.Right}
          id={r.label}
          style={{ top: handleTop(i, routes.length) }}
        >
          <span className="handle-label">{r.label || `route-${i + 1}`}</span>
        </Handle>
      ))}
    </div>
  );
}