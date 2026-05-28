import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
  type OnConnect,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import InputNode from "./nodes/InputNode";
import ClassifierNode, { type RouteSpec } from "./nodes/ClassifierNode";
import ModelNode from "./nodes/ModelNode";
import OutputNode from "./nodes/OutputNode";
import "./router.css";

interface VsCodeApi {
  postMessage: (m: unknown) => void;
  getState:    () => unknown;
  setState:    (s: unknown) => void;
}
declare const acquireVsCodeApi: (() => VsCodeApi) | undefined;
const vscode = typeof acquireVsCodeApi !== "undefined" ? acquireVsCodeApi() : null;

interface ModelsData {
  active: string;
  local:  { name: string; size: string; source: string }[];
  api:    { name: string; source: string }[];
}

interface RouterSummary {
  id:      string;
  name:    string;
  enabled: boolean;
}

interface RouterGraph {
  id:      string;
  name:    string;
  enabled: boolean;
  nodes:   Node[];
  edges:   Edge[];
}

interface TestResult {
  model:  string | null;
  path:   string[];
  reason: string;
}

const STARTER_NODES: Node[] = [
  { id: "input-1",      type: "input",      position: { x:  60, y: 200 }, data: {} },
  {
    id: "classifier-1",
    type: "classifier",
    position: { x: 320, y: 160 },
    data: {
      routes: [
        { label: "simple",  examples: ["fix typo", "rename variable", "add print statement"] },
        { label: "medium",  examples: ["refactor this function", "add error handling"] },
        { label: "complex", examples: ["redesign the architecture", "implement a new feature across files"] },
      ] satisfies RouteSpec[],
    },
  },
  { id: "model-simple",  type: "model",  position: { x: 680, y:  60 }, data: { model: "" } },
  { id: "model-medium",  type: "model",  position: { x: 680, y: 220 }, data: { model: "" } },
  { id: "model-complex", type: "model",  position: { x: 680, y: 380 }, data: { model: "" } },
  { id: "output-1",      type: "output", position: { x: 980, y: 220 }, data: {} },
];

const STARTER_EDGES: Edge[] = [
  { id: "e1", source: "input-1", target: "classifier-1" },
  { id: "e2", source: "classifier-1", sourceHandle: "simple",  target: "model-simple" },
  { id: "e3", source: "classifier-1", sourceHandle: "medium",  target: "model-medium" },
  { id: "e4", source: "classifier-1", sourceHandle: "complex", target: "model-complex" },
  { id: "e5", source: "model-simple",  target: "output-1" },
  { id: "e6", source: "model-medium",  target: "output-1" },
  { id: "e7", source: "model-complex", target: "output-1" },
];

let idCounter = Date.now();
const newId = (prefix: string) => `${prefix}-${++idCounter}`;

export default function RouterApp() {
  const [routers,    setRouters]    = useState<RouterSummary[]>([]);
  const [activeId,   setActiveId]   = useState<string | null>(null);
  const [name,       setName]       = useState("");
  const [nodes,      setNodes]      = useState<Node[]>(STARTER_NODES);
  const [edges,      setEdges]      = useState<Edge[]>(STARTER_EDGES);
  const [enabled,    setEnabled]    = useState(false);
  const [models,     setModels]     = useState<ModelsData>({ active: "", local: [], api: [] });
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [testInput,  setTestInput]  = useState("");
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [loaded,     setLoaded]     = useState(false);
  const [adding,     setAdding]     = useState(false);
  const [pendingName, setPendingName] = useState("");
  const [testOpen,   setTestOpen]   = useState(false);
  const initialized = useRef(false);
  const addInputRef = useRef<HTMLInputElement | null>(null);
  const activeIdRef = useRef<string | null>(null);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  useEffect(() => { if (adding) addInputRef.current?.focus(); }, [adding]);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    vscode?.postMessage({ type: "router:list" });
    vscode?.postMessage({ type: "router:getModels" });
  }, []);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === "router:list") {
        const list = (msg.routers as RouterSummary[]) ?? [];
        setRouters(list);
        // Auto-select the first router if none picked yet
        setActiveId(prev => prev ?? (list[0]?.id ?? null));
        setLoaded(true);
      }
      if (msg.type === "router:load") {
        const g = msg.data as RouterGraph | null;
        if (g) {
          setName(g.name);
          setNodes(g.nodes ?? []);
          setEdges(g.edges ?? []);
          setEnabled(!!g.enabled);
        }
      }
      if (msg.type === "router:models") {
        setModels(msg.data as ModelsData);
      }
      if (msg.type === "router:saved") {
        setSaveStatus("saved");
        setTimeout(() => setSaveStatus("idle"), 1800);
        // Only adopt the new name locally if the rename targeted the
        // router currently open in the canvas.
        if (typeof msg.name === "string" && (!msg.id || msg.id === activeIdRef.current)) {
          setName(msg.name);
        }
        // Refresh the sidebar (in case name changed)
        vscode?.postMessage({ type: "router:list" });
      }
      if (msg.type === "router:created") {
        const created = msg.data as RouterGraph;
        vscode?.postMessage({ type: "router:list" });
        setActiveId(created.id);
        setAdding(false);
        setPendingName("");
      }
      if (msg.type === "router:deleted") {
        vscode?.postMessage({ type: "router:list" });
        setActiveId(null);
      }
      if (msg.type === "router:testResult") {
        const d = (msg.data ?? {}) as Partial<TestResult>;
        setTestResult({
          model:  typeof d.model === "string" ? d.model : null,
          path:   Array.isArray(d.path) ? d.path : [],
          reason: typeof d.reason === "string" ? d.reason : "no response",
        });
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // Load the active router's graph whenever activeId changes.
  useEffect(() => {
    if (!activeId) return;
    setTestResult(null);
    vscode?.postMessage({ type: "router:load", id: activeId });
  }, [activeId]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setNodes(nds => applyNodeChanges(changes, nds)),
    [],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges(eds => applyEdgeChanges(changes, eds)),
    [],
  );
  const onConnect: OnConnect = useCallback(
    (c: Connection) => setEdges(eds => addEdge({ ...c, id: newId("e") }, eds)),
    [],
  );

  const allModelOptions = useMemo(() => {
    return [
      ...models.local.map(m => ({ value: m.name, label: m.name, group: `local (${m.source})` })),
      ...models.api.map(m =>   ({ value: m.name, label: m.name, group: `cloud (${m.source})` })),
    ];
  }, [models]);

  function updateNodeData<T extends Record<string, unknown>>(id: string, patch: T) {
    setNodes(prev => prev.map(n => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
  }

  function deleteNode(id: string) {
    setNodes(prev => prev.filter(n => n.id !== id));
    setEdges(prev => prev.filter(e => e.source !== id && e.target !== id));
  }

  function addClassifier() {
    setNodes(prev => [...prev, {
      id: newId("classifier"),
      type: "classifier",
      position: { x: 260 + Math.random() * 120, y: 280 + Math.random() * 80 },
      data: {
        routes: [{ label: "default", examples: [""] }] satisfies RouteSpec[],
      },
    }]);
  }

  function addModel() {
    setNodes(prev => [...prev, {
      id: newId("model"),
      type: "model",
      position: { x: 700 + Math.random() * 120, y: 280 + Math.random() * 80 },
      data: { model: "" },
    }]);
  }

  function deleteSelected() {
    setNodes(prev => prev.filter(n => !n.selected || n.type === "input" || n.type === "output"));
    setEdges(prev => prev.filter(e => !e.selected));
  }

  function resetGraph() {
    setNodes(STARTER_NODES);
    setEdges(STARTER_EDGES);
  }

  function saveGraph() {
    if (!activeId) return;
    setSaveStatus("saving");
    vscode?.postMessage({
      type:  "router:save",
      id:    activeId,
      graph: { name, enabled, nodes, edges },
    });
  }

  function addRouter() {
    setPendingName("");
    setAdding(true);
  }

  function commitAdd() {
    const name = pendingName.trim();
    if (!name) { setAdding(false); return; }
    vscode?.postMessage({ type: "router:create", name });
    // The router:created handler closes the input via the effect below.
  }

  function cancelAdd() {
    setAdding(false);
    setPendingName("");
  }

  function renameRouter(r: RouterSummary) {
    // When renaming the currently-loaded router we already have the latest
    // (possibly unsaved) graph in state; otherwise let the backend keep the
    // saved graph and only swap the name.
    const isActive = r.id === activeId;
    vscode?.postMessage({
      type:        "router:rename",
      id:          r.id,
      currentName: isActive ? name : r.name,
      graph:       isActive ? { enabled, nodes, edges } : null,
    });
  }

  function deleteRouter(r: RouterSummary) {
    vscode?.postMessage({ type: "router:delete", id: r.id, name: r.name });
  }

  function runTest() {
    if (!testInput.trim() || !activeId) return;
    setTestResult(null);
    vscode?.postMessage({
      type:      "router:test",
      task:      testInput.trim(),
      router_id: activeId,
      graph:     { name, enabled: true, nodes, edges },
    });
  }

  const nodesWithCallbacks = useMemo(() => {
    return nodes.map(n => {
      if (n.type === "input" || n.type === "output") {
        return { ...n, deletable: false };
      }
      if (n.type === "classifier") {
        return {
          ...n,
          data: {
            ...n.data,
            __onChange: (routes: RouteSpec[]) => updateNodeData(n.id, { routes }),
            __onDelete: () => deleteNode(n.id),
          },
        };
      }
      if (n.type === "model") {
        return {
          ...n,
          data: {
            ...n.data,
            __models:  allModelOptions,
            __onChange: (modelId: string) => updateNodeData(n.id, { model: modelId }),
            __onDelete: () => deleteNode(n.id),
          },
        };
      }
      return n;
    });
  }, [nodes, allModelOptions]);

  const nodeTypes = useMemo(() => ({
    input:      InputNode,
    classifier: ClassifierNode,
    model:      ModelNode,
    output:     OutputNode,
  }), []);

  const matchedNodes = new Set(testResult?.path ?? []);
  const styledNodes  = nodesWithCallbacks.map(n => matchedNodes.has(n.id)
    ? { ...n, className: "node-matched" }
    : n);

  const hasActive = !!activeId && routers.some(r => r.id === activeId);

  return (
    <div className="router-app">
      <header className="router-header">
        <div className="router-title">
          <span className="brand">aev<span className="i">i</span></span>
          <span className="subtitle">· semantic router</span>
        </div>
        <div className="router-actions">
          {hasActive && (
            <label className="toggle-row">
              <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
              <span>{enabled ? "Enabled" : "Disabled"}</span>
            </label>
          )}
          <button
            className="btn ghost"
            onClick={() => vscode?.postMessage({ type: "router:getModels" })}
            title="Refresh model list"
            aria-label="Refresh model list"
          >
            ↻
          </button>
          <button className="btn" onClick={addClassifier} disabled={!hasActive}>+ Classifier</button>
          <button className="btn" onClick={addModel} disabled={!hasActive}>+ Model</button>
          <button className="btn ghost" onClick={deleteSelected} disabled={!hasActive} title="Delete selected (Input/Output cannot be removed)">Delete selected</button>
          <button className="btn ghost" onClick={resetGraph} disabled={!hasActive} title="Reset to starter graph">Reset</button>
          <button
            className="btn primary"
            disabled={saveStatus === "saving" || !hasActive}
            onClick={saveGraph}
          >
            {saveStatus === "saving" ? "Saving…" : saveStatus === "saved" ? "✓ Saved" : "Save"}
          </button>
        </div>
      </header>

      <div className="router-body" style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Left sidebar — router list */}
        <aside
          style={{
            width:        220,
            flexShrink:   0,
            borderRight:  "1px solid var(--vscode-sideBarSectionHeader-border)",
            display:      "flex",
            flexDirection:"column",
            background:   "var(--vscode-sideBar-background)",
          }}
        >
          <div style={{
            padding:        "10px 12px",
            display:        "flex",
            alignItems:     "center",
            justifyContent: "space-between",
            borderBottom:   adding ? "none" : "1px solid var(--vscode-sideBarSectionHeader-border)",
          }}>
            <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--vscode-descriptionForeground)" }}>
              Routers
            </span>
            <button
              className="btn"
              style={{ padding: "2px 8px", fontSize: 12 }}
              onClick={addRouter}
              disabled={adding}
            >
              + Add
            </button>
          </div>

          {adding && (
            <div style={{
              padding:      "8px 12px 10px",
              borderBottom: "1px solid var(--vscode-sideBarSectionHeader-border)",
              display:      "flex",
              flexDirection:"column",
              gap:          6,
            }}>
              <input
                ref={addInputRef}
                className="test-input"
                style={{ padding: "4px 6px", fontSize: 12 }}
                placeholder="Name this router"
                value={pendingName}
                onChange={e => setPendingName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter")  { e.preventDefault(); commitAdd(); }
                  if (e.key === "Escape") { e.preventDefault(); cancelAdd(); }
                }}
              />
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  className="btn primary"
                  style={{ flex: 1, fontSize: 11 }}
                  onClick={commitAdd}
                  disabled={!pendingName.trim()}
                >
                  Create
                </button>
                <button
                  className="btn ghost"
                  style={{ flex: 1, fontSize: 11 }}
                  onClick={cancelAdd}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div style={{ overflowY: "auto", flex: 1 }}>
            {routers.length === 0 && (
              <div style={{ padding: 12, fontSize: 11, color: "var(--vscode-descriptionForeground)" }}>
                No routers yet. Click <strong>+ Add</strong> to create one.
              </div>
            )}
            {routers.map(r => {
              const isActive = r.id === activeId;
              return (
                <div
                  key={r.id}
                  onClick={() => setActiveId(r.id)}
                  className={`router-row${isActive ? " active" : ""}`}
                >
                  <span className="router-row-name">{r.name}</span>
                  {r.enabled && <span className="router-row-on">● on</span>}
                  <span className="router-row-actions">
                    <button
                      className="row-icon"
                      title="Rename"
                      aria-label="Rename router"
                      onClick={e => { e.stopPropagation(); renameRouter(r); }}
                    >
                      ✎
                    </button>
                    <button
                      className="row-icon"
                      title="Delete"
                      aria-label="Delete router"
                      onClick={e => { e.stopPropagation(); deleteRouter(r); }}
                    >
                      ✕
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </aside>

        <div className="canvas-wrap" style={{ flex: 1, position: "relative" }}>
          {hasActive ? (
            <ReactFlow
              nodes={styledNodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              nodeTypes={nodeTypes}
              fitView
              proOptions={{ hideAttribution: true }}
              defaultEdgeOptions={{ animated: true }}
            >
              <Background gap={16} />
              <MiniMap pannable zoomable />
              <Controls />
            </ReactFlow>
          ) : (
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              height: "100%", color: "var(--vscode-descriptionForeground)", fontSize: 12,
            }}>
              {routers.length === 0 ? "Create your first router from the sidebar." : "Pick a router from the sidebar to edit."}
            </div>
          )}
          {!loaded && <div className="canvas-overlay">loading…</div>}
        </div>

        <aside className={`router-sidebar${testOpen ? "" : " collapsed"}`}>
          {!testOpen && (
            <button
              className="sidebar-toggle vertical"
              title="Show test panel"
              onClick={() => setTestOpen(true)}
            >
              Test ◂
            </button>
          )}
          {testOpen && (
            <>
              <div className="sidebar-head">
                <h3>Test a prompt</h3>
                <button
                  className="collapse-x"
                  title="Hide test panel"
                  aria-label="Hide test panel"
                  onClick={() => setTestOpen(false)}
                >
                  ▸
                </button>
              </div>
              <textarea
                className="test-input"
                rows={2}
                placeholder="e.g. Refactor the auth middleware…"
                value={testInput}
                onChange={e => setTestInput(e.target.value)}
                disabled={!hasActive}
              />
              <button
                className="btn primary block"
                onClick={runTest}
                disabled={!testInput.trim() || !hasActive}
              >
                Test route
              </button>

              {testResult && (
                <div className={`test-result ${testResult.model ? "ok" : "warn"}`}>
                  <div className="result-row">
                    <span className="label">Model</span>
                    <span className="value mono">{testResult.model ?? "— no match —"}</span>
                  </div>
                  <div className="result-row">
                    <span className="label">Reason</span>
                    <span className="value">{testResult.reason}</span>
                  </div>
                  <div className="result-row">
                    <span className="label">Path</span>
                    <span className="value mono">{testResult.path.join(" → ")}</span>
                  </div>
                </div>
              )}

              <details style={{ marginTop: 14 }}>
                <summary style={{
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: "var(--vscode-descriptionForeground)",
                }}>
                  How it works
                </summary>
                <ol className="how" style={{ marginTop: 6 }}>
                  <li>Each router lives in its own graph. Pick one from the left sidebar, or <strong>+ Add</strong> a new one.</li>
                  <li>The <strong>Input</strong> node receives the agent task.</li>
                  <li>Each <strong>Classifier</strong> route has example phrases; the task is embedded and matched to the closest route.</li>
                  <li>The matched edge leads to a <strong>Model</strong> node — that model handles this task.</li>
                  <li>In the chat panel's model picker, pick this router to use it for agent tasks.</li>
                </ol>
              </details>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
