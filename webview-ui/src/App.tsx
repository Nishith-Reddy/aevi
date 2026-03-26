import { useState, useEffect, useRef } from "react";
import ChatMessage from "./components/ChatMessage";
import AgentMessage from "./components/AgentMessage";
import ModelPicker from "./components/ModelPicker";
import FileIcon from "./components/FileIcon";
import ModeSelector, { type Mode } from "./components/ModeSelector";

interface VsCodeApi {
  postMessage: (message: unknown) => void;
  getState: () => { messages?: Message[]; history?: { role: string; content: string }[] } | undefined;
  setState: (state: unknown) => void;
}
declare const acquireVsCodeApi: (() => VsCodeApi) | undefined;
const vscode = typeof acquireVsCodeApi !== "undefined" ? acquireVsCodeApi() : null;

interface AgentStep {
  type:            "text" | "tool" | "confirm";
  tool?:           string;
  args?:           Record<string, unknown>;
  result?:         string;
  status?:         "running" | "done" | "error";
  content?:        string;
  path?:           string;
  fname?:          string;
  diff?:           string;
  contentToWrite?: string;
  resumeState?:    unknown;
}

interface Message {
  role:    "user" | "assistant" | "error" | "agent";
  content: string;
  steps?:  AgentStep[];
}

interface ModelsData {
  active: string;
  local:  { name: string; size: string; source: string }[];
  api:    { name: string; source: string }[];
}

interface AgentEvent {
  event:             string;
  tool?:             string;
  args?:             Record<string, unknown>;
  result?:           string;
  content?:          string;
  summary?:          string;
  path?:             string;
  fname?:            string;
  diff?:             string;
  content_to_write?: string;
  resume_state?:     unknown;
}

interface LocalProvider { name: string; url: string; }

const persistedState     = vscode?.getState();
const initialMessages: Message[] = persistedState?.messages ?? [];
const initialHistory              = persistedState?.history  ?? [];

export default function App() {
  const [messages,     setMessages]     = useState<Message[]>(initialMessages);
  const [input,        setInput]        = useState("");
  const [loading,      setLoading]      = useState(false);
  const [mode,         setMode]         = useState<Mode>("chat");
  const [models,       setModels]       = useState<ModelsData>({ active: "", local: [], api: [] });
  const [inline,       setInline]       = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [contextFiles, setContextFiles] = useState<{ fileName: string; language: string; path: string }[]>([]);
  const [saveStatus,   setSaveStatus]   = useState<"idle" | "saving" | "saved">("idle");

  // Settings state
  const [apiKeys,    setApiKeys]    = useState({ anthropic: "", openai: "", groq: "", gemini: "" });
  const [providers,  setProviders]  = useState<LocalProvider[]>([
    { name: "Ollama", url: "http://localhost:11434" },
  ]);

  const bottomRef    = useRef<HTMLDivElement>(null);
  const messagesRef  = useRef<HTMLDivElement>(null);
  const inputRef     = useRef<HTMLTextAreaElement>(null);
  const historyRef   = useRef<{ role: string; content: string }[]>(initialHistory);
  const userScrolled = useRef(false);

  useEffect(() => {
    vscode?.postMessage({ type: "getModels" });
  }, []);

  useEffect(() => {
    vscode?.setState({ messages, history: historyRef.current });
    vscode?.postMessage({ type: "saveState", messages, history: historyRef.current });
  }, [messages]);

  function updateAgentSteps(updater: (steps: AgentStep[]) => AgentStep[]) {
    setMessages(prev => {
      const updated = [...prev];
      for (let i = updated.length - 1; i >= 0; i--) {
        if (updated[i].role === "agent") {
          updated[i] = { ...updated[i], steps: updater([...(updated[i].steps ?? [])]) };
          return updated;
        }
      }
      return prev;
    });
  }

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;

      if (msg.type === "restoreState") {
        const state = msg.state as { messages: Message[]; history: { role: string; content: string }[] };
        if (state.messages?.length > 0) {
          setMessages(state.messages);
          historyRef.current = state.history ?? [];
        }
      }

      // Restore saved settings into the form fields
      if (msg.type === "restoreSettings") {
        setApiKeys(msg.keys as { anthropic: string; openai: string; groq: string; gemini: string });
        setProviders((msg.providers as LocalProvider[]) ?? [{ name: "Ollama", url: "http://localhost:11434" }]);
      }

      if (msg.type === "settingsSaved") {
        setSaveStatus("saved");
        setTimeout(() => setSaveStatus("idle"), 2000);
        // Re-fetch models so additions/removals are reflected immediately
        vscode?.postMessage({ type: "getModels" });
      }

      if (msg.type === "activeFile") {
        const f = { fileName: msg.fileName as string, language: msg.language as string, path: msg.path as string };
        setContextFiles(prev => prev.find(x => x.path === f.path) ? prev : [...prev, f]);
      }
      if (msg.type === "models")      { setModels(msg.data as ModelsData); }
      if (msg.type === "inlineState") { setInline(msg.enabled as boolean); }

      if (msg.type === "agentStart") {
        setMessages(prev => [...prev, { role: "agent", content: "", steps: [] }]);
      }

      if (msg.type === "agentEvent") {
        const ev = msg.event as AgentEvent;

        if (ev.event === "text") {
          updateAgentSteps(steps => {
            const last = steps[steps.length - 1];
            if (last?.type === "text") {
              steps[steps.length - 1] = { ...last, content: (last.content ?? "") + (ev.content ?? "") };
              return steps;
            }
            return [...steps, { type: "text", content: ev.content ?? "" }];
          });
        }
        if (ev.event === "tool_call") {
          updateAgentSteps(steps => [
            ...steps,
            { type: "tool", tool: ev.tool, args: ev.args, status: "running" },
          ]);
        }
        if (ev.event === "tool_result") {
          updateAgentSteps(steps => {
            const copy = [...steps];
            for (let i = copy.length - 1; i >= 0; i--) {
              if (copy[i].type === "tool" && copy[i].status === "running") {
                if (!ev.tool || copy[i].tool === ev.tool) {
                  copy[i] = { ...copy[i], result: ev.result, status: "done" };
                  return copy;
                }
              }
            }
            for (let i = copy.length - 1; i >= 0; i--) {
              if (copy[i].type === "tool" && copy[i].status === "running") {
                copy[i] = { ...copy[i], result: ev.result, status: "done" };
                return copy;
              }
            }
            return copy;
          });
        }
        if (ev.event === "confirm_write") {
          updateAgentSteps(steps => {
            const copy = [...steps];
            for (let i = copy.length - 1; i >= 0; i--) {
              if (copy[i].type === "tool" && copy[i].status === "running" &&
                  ["edit_lines","edit_file","write_file","insert_lines"].includes(copy[i].tool ?? "")) {
                copy[i] = { ...copy[i], status: "done" };
                break;
              }
            }
            return [...copy, {
              type: "confirm" as const,
              path: ev.path, fname: ev.fname, diff: ev.diff,
              contentToWrite: ev.content_to_write, resumeState: ev.resume_state,
            }];
          });
        }
        if (ev.event === "error") {
          setMessages(prev => [...prev, { role: "error", content: msg.message as string }]);
        }
      }

      if (msg.type === "agentDone")    { setLoading(false); inputRef.current?.focus(); }
      if (msg.type === "resetLoading") { setLoading(false); }
      if (msg.type === "agentRejected") {
        updateAgentSteps(steps => [...steps, { type: "text", content: "\n_Stopped — change rejected._" }]);
      }
      if (msg.type === "agentError") {
        setMessages(prev => [...prev, { role: "error", content: msg.message as string }]);
        setLoading(false);
      }
      if (msg.type === "writeApplied") {
        setLoading(true);
        updateAgentSteps(steps => [...steps, { type: "text", content: `✅ Applied \`${msg.path as string}\`` }]);
      }
      if (msg.type === "fileTruncated") {
        const files = (msg.files as string[]).join(", ");
        setMessages(prev => [...prev, {
          role: "error",
          content: `⚠️ ${files} is too large and was truncated.`,
        }]);
      }
      if (msg.type === "streamStart") { setMessages(prev => [...prev, { role: "assistant", content: "" }]); }
      if (msg.type === "streamChunk") {
        setMessages(prev => {
          const u = [...prev];
          u[u.length - 1] = { role: "assistant", content: u[u.length - 1].content + (msg.chunk as string) };
          return u;
        });
      }
      if (msg.type === "streamDone") {
        setLoading(false);
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") historyRef.current.push({ role: "assistant", content: last.content });
          return prev;
        });
        inputRef.current?.focus();
      }
      if (msg.type === "streamError") {
        setMessages(prev => { const u = [...prev]; u[u.length - 1] = { role: "error", content: msg.message as string }; return u; });
        setLoading(false);
        inputRef.current?.focus();
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  // Only auto-scroll if user hasn't scrolled up
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      userScrolled.current = !atBottom;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!userScrolled.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  function refreshModels() { vscode?.postMessage({ type: "getModels" }); }
  function stopGeneration() { vscode?.postMessage({ type: "stop" }); setLoading(false); }

  // ── Provider list helpers ────────────────────────────────────────────────
  function addProvider() {
    setProviders(p => [...p, { name: "", url: "" }]);
  }
  function updateProvider(i: number, field: keyof LocalProvider, val: string) {
    setProviders(p => p.map((x, idx) => idx === i ? { ...x, [field]: val } : x));
  }
  function removeProvider(i: number) {
    setProviders(p => p.filter((_, idx) => idx !== i));
  }

  function saveSettings() {
    setSaveStatus("saving");
    vscode?.postMessage({ type: "saveSettings", keys: apiKeys, providers });
  }

  function sendMessage() {
    const text = input.trim();
    if (!text || loading) return;
    setMessages(prev => [...prev, { role: "user", content: text }]);
    setInput("");
    setLoading(true);
    userScrolled.current = false; // reset so new message scrolls into view
    if (mode === "agent") {
      vscode?.postMessage({ type: "agent", task: text, activeFile: contextFiles[0]?.path ?? null });
      return;
    }
    historyRef.current.push({ role: "user", content: text });
    vscode?.postMessage({ type: "chat", messages: historyRef.current, contextFiles });
  }

  function switchModel(model: string) { setModels(prev => ({ ...prev, active: model })); vscode?.postMessage({ type: "selectModel", model }); }
  function toggleInline() { setInline(prev => !prev); vscode?.postMessage({ type: "toggleInline" }); }
  function clearChat() { setMessages([]); historyRef.current = []; vscode?.setState({ messages: [], history: [] }); vscode?.postMessage({ type: "clear" }); }
  function handleKey(e: React.KeyboardEvent) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }

  const inputStyle: React.CSSProperties = {
    width:        "100%",
    background:   "var(--vscode-input-background)",
    color:        "var(--vscode-input-foreground)",
    border:       "1px solid var(--vscode-input-border)",
    borderRadius: 4,
    padding:      "5px 8px",
    fontSize:     11,
    fontFamily:   "var(--vscode-editor-font-family)",
    outline:      "none",
  };

  return (
    <div className="app">
      {/* Header */}
      <div className="header">
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="logo">✦ Telivi</span>
        </div>
        <div className="header-right">
          <button
            className="icon-btn"
            onClick={() => setShowSettings(s => !s)}
            title="Settings"
            style={{
              background:   showSettings ? "var(--vscode-toolbar-activeBackground)" : "none",
              border:       showSettings ? "1px solid var(--vscode-focusBorder)" : "none",
              borderRadius: 4,
              color:        showSettings ? "var(--vscode-foreground)" : "var(--vscode-descriptionForeground)",
              cursor:       "pointer",
              fontSize:     16,
              padding:      "3px 6px",
              lineHeight:   1,
            }}
          >⚙</button>
          <button className="clear-btn" onClick={clearChat}>Clear</button>
        </div>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div style={{
          padding:      "12px 14px",
          borderBottom: "1px solid var(--vscode-sideBarSectionHeader-border)",
          background:   "var(--vscode-sideBar-background)",
          flexShrink:   0,
          overflowY:    "auto",
          maxHeight:    "60vh",
        }}>

          {/* Inline toggle */}
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            marginBottom: 14, padding: "8px 10px",
            background: "var(--vscode-input-background)",
            border: "1px solid var(--vscode-input-border)", borderRadius: 4,
          }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 500, color: "var(--vscode-foreground)" }}>Inline suggestions</div>
              <div style={{ fontSize: 10, color: "var(--vscode-descriptionForeground)", marginTop: 1 }}>AI completions as you type</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className="beta-badge">beta</span>
              <label className="toggle">
                <input type="checkbox" checked={inline} onChange={toggleInline} />
                <span className="slider" />
              </label>
            </div>
          </div>

          {/* Local providers */}
          <div style={{ fontSize: 11, fontWeight: 500, color: "var(--vscode-descriptionForeground)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
            Local Providers
          </div>

          {providers.map((p, i) => (
            <div key={i} style={{ display: "flex", gap: 4, marginBottom: 6, alignItems: "center" }}>
              <input
                placeholder="Name (e.g. Ollama)"
                value={p.name}
                onChange={e => updateProvider(i, "name", e.target.value)}
                style={{ ...inputStyle, width: "35%" }}
              />
              <input
                placeholder="http://localhost:11434"
                value={p.url}
                onChange={e => updateProvider(i, "url", e.target.value)}
                style={{ ...inputStyle, flex: 1 }}
              />
              <button
                onClick={() => removeProvider(i)}
                title="Remove"
                style={{
                  background: "none", border: "none",
                  color: "var(--vscode-descriptionForeground)",
                  cursor: "pointer", fontSize: 14, padding: "0 4px", flexShrink: 0,
                }}
              >✕</button>
            </div>
          ))}

          <button
            onClick={addProvider}
            style={{
              background: "none",
              border: "1px dashed var(--vscode-input-border)",
              color: "var(--vscode-descriptionForeground)",
              borderRadius: 4, padding: "4px 10px",
              fontSize: 11, cursor: "pointer", marginBottom: 14, width: "100%",
            }}
          >+ Add provider</button>

          {/* API keys */}
          <div style={{ fontSize: 11, fontWeight: 500, color: "var(--vscode-descriptionForeground)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
            API Keys
          </div>

          {(["anthropic", "openai", "groq", "gemini"] as const).map(key => (
            <div key={key} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: "var(--vscode-descriptionForeground)", marginBottom: 3, textTransform: "capitalize" }}>{key}</div>
              <input
                type="password"
                placeholder={key === "anthropic" ? "sk-ant-..." : key === "openai" ? "sk-..." : key === "groq" ? "gsk_..." : "AIza..."}
                value={apiKeys[key]}
                onChange={e => setApiKeys(k => ({ ...k, [key]: e.target.value }))}
                style={inputStyle}
              />
            </div>
          ))}

          <button
            onClick={saveSettings}
            disabled={saveStatus === "saving"}
            style={{
              marginTop:    10,
              width:        "100%",
              background:   saveStatus === "saved" ? "var(--vscode-testing-iconPassed)" : "var(--vscode-button-background)",
              color:        "var(--vscode-button-foreground)",
              border:       "none",
              borderRadius: 4,
              padding:      "6px 0",
              fontSize:     11,
              fontWeight:   500,
              cursor:       saveStatus === "saving" ? "default" : "pointer",
              transition:   "background 0.2s",
            }}
          >
            {saveStatus === "saving" ? "Saving…" : saveStatus === "saved" ? "✓ Saved" : "Save & Refresh Models"}
          </button>
        </div>
      )}

      {/* Model bar */}
      <div className="model-bar">
        <ModelPicker active={models.active} local={models.local} api={models.api} onChange={switchModel} />
        <button className="refresh-btn" onClick={refreshModels} title="Refresh models">⟳</button>
      </div>

      {/* Messages */}
      <div className="messages" ref={messagesRef}>
        {messages.length === 0 && (
          <div className="welcome">
            <p style={{ fontWeight: 500, marginBottom: 4 }}>Hi, I'm Telivi.</p>
            <p>Use <strong>Chat</strong> to ask about your code, or <strong>Agent</strong> to make changes autonomously.</p>
          </div>
        )}
        {messages.map((m, i) => {
          if (m.role === "agent") {
            return (
              <div key={i} className="msg assistant">
                <span className="msg-label">Telivi · agent</span>
                <div className="msg-content">
                  <AgentMessage steps={m.steps ?? []} loading={loading && i === messages.length - 1} vscode={vscode} />
                </div>
              </div>
            );
          }
          return (
            <ChatMessage key={i} role={m.role as "user" | "assistant" | "error"} content={m.content}
              loading={loading && i === messages.length - 1 && m.role === "assistant"}
              vscode={vscode}
            />
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div className="input-area">
        <div className="context-files">
          {contextFiles.length === 0 ? (
            <div className="active-file no-file">
              <FileIcon fileName="" size={14} />
              <span className="active-file-name" style={{ color: "var(--vscode-descriptionForeground)" }}>no file open</span>
            </div>
          ) : (
            contextFiles.map(f => (
              <div key={f.path} className="active-file" title={f.path} style={{ maxWidth: 160 }}>
                <FileIcon fileName={f.fileName} size={20} />
                <span className="active-file-name">{f.fileName}</span>
                <button className="remove-file-btn" onClick={() => {
                  setContextFiles(prev => prev.filter(x => x.path !== f.path));
                  vscode?.postMessage({ type: "removeFile", path: f.path });
                }} title="Remove from context">✕</button>
              </div>
            ))
          )}
          <button className="add-file-btn" onClick={() => vscode?.postMessage({ type: "addFile" })} title="Add file to context">+ Add file</button>
        </div>

        <ModeSelector active={mode} onChange={setMode} />

        <div className="input-row">
          <textarea
            ref={inputRef}
            className="input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder={mode === "chat" ? "Ask about your code..." : "Describe a task for the agent..."}
            rows={1}
          />
          {loading ? (
            <button className="stop-btn" onClick={stopGeneration} title="Stop generation">■</button>
          ) : (
            <button className="send-btn" onClick={sendMessage} disabled={!input.trim()}>➤</button>
          )}
        </div>
      </div>
    </div>
  );
}