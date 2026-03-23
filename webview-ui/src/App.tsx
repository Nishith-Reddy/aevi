import { useState, useEffect, useRef } from "react";
import ChatMessage from "./components/ChatMessage";
import ModelPicker from "./components/ModelPicker";
import ModeSelector, { type Mode } from "./components/ModeSelector";

interface VsCodeApi {
  postMessage: (message: unknown) => void;
  getState: () => { messages?: Message[]; history?: { role: string; content: string }[] } | undefined;
  setState: (state: unknown) => void;
}
declare const acquireVsCodeApi: (() => VsCodeApi) | undefined;
const vscode = typeof acquireVsCodeApi !== "undefined" ? acquireVsCodeApi() : null;

interface Message {
  role:    "user" | "assistant" | "error";
  content: string;
}

interface ModelsData {
  active: string;
  local:  { name: string; size: string; source: string }[];
  api:    { name: string; source: string }[];
}

interface AgentEvent {
  event:             string;
  tool?:             string;
  args?:             Record<string, string>;
  result?:           string;
  content?:          string;
  summary?:          string;
  path?:             string;
  fname?:            string;
  diff?:             string;
  content_to_write?: string;
}

const MODE_HINTS: Record<Mode, string> = {
  chat:    "",
  agent:   "You are in agent mode. The user wants you to autonomously complete a task.",
  explain: "Explain the code or concept clearly. Break it down step by step.",
  fix:     "Find and fix the bug. Show the corrected code and explain what was wrong.",
};

const persistedState = vscode?.getState();
const initialMessages: Message[] = persistedState?.messages ?? [];
const initialHistory             = persistedState?.history  ?? [];

export default function App() {
  const [messages,      setMessages]     = useState<Message[]>(initialMessages);
  const [input,         setInput]        = useState("");
  const [loading,       setLoading]      = useState(false);
  const [mode,          setMode]         = useState<Mode>("chat");
  const [models,        setModels]       = useState<ModelsData>({ active: "", local: [], api: [] });
  const [inline,        setInline]       = useState(false);
  const [showSettings,  setShowSettings] = useState(false);
  const [contextFiles,  setContextFiles] = useState<{ fileName: string; language: string; path: string }[]>([]);
  const [apiKeys,       setApiKeys]      = useState({ anthropic: "", openai: "", groq: "" });
  const bottomRef  = useRef<HTMLDivElement>(null);
  const inputRef   = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<{ role: string; content: string }[]>(initialHistory);

  useEffect(() => {
    vscode?.postMessage({ type: "getModels" });
    const interval = setInterval(() => {
      if (models.local.length === 0 && models.api.length === 0) {
        vscode?.postMessage({ type: "getModels" });
      }
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    vscode?.setState({ messages, history: historyRef.current });
    vscode?.postMessage({ type: "saveState", messages, history: historyRef.current });
  }, [messages]);

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
      if (msg.type === "activeFile") {
        const f = { fileName: msg.fileName as string, language: msg.language as string, path: msg.path as string };
        setContextFiles(prev => prev.find(x => x.path === f.path) ? prev : [...prev, f]);
      }
      if (msg.type === "models")      { setModels(msg.data as ModelsData); }
      if (msg.type === "inlineState") { setInline(msg.enabled as boolean); }

      if (msg.type === "agentStart") {
        setMessages(prev => [...prev, { role: "assistant", content: "🤖 Agent started...\n" }]);
      }
      if (msg.type === "agentEvent") {
        const ev = msg.event as AgentEvent;
        setMessages(prev => {
          const updated = [...prev];
          const last    = updated[updated.length - 1];
          if (last?.role !== "assistant") return prev;
          if (ev.event === "tool_call")    updated[updated.length - 1] = { ...last, content: last.content + `\n🔧 \`${ev.tool}\`(${JSON.stringify(ev.args)})\n` };
          if (ev.event === "tool_result")  updated[updated.length - 1] = { ...last, content: last.content + `\n✅ Result: ${ev.result}\n` };
          if (ev.event === "text")         updated[updated.length - 1] = { ...last, content: last.content + (ev.content ?? "") };
          if (ev.event === "confirm_write") updated[updated.length - 1] = { ...last, content: last.content + `\n📝 Wants to write \`${ev.fname}\`\n\`\`\`diff\n${ev.diff}\n\`\`\`\n__CONFIRM__:${ev.path}:${ev.content_to_write}` };
          if (ev.event === "done")         updated[updated.length - 1] = { ...last, content: last.content + `\n\n✅ ${ev.summary}` };
          return updated;
        });
      }
      if (msg.type === "agentDone")  { setLoading(false); inputRef.current?.focus(); }
      if (msg.type === "agentError") { setMessages(prev => [...prev, { role: "error", content: msg.message as string }]); setLoading(false); }
      if (msg.type === "writeApplied") { setMessages(prev => [...prev, { role: "assistant", content: `✅ Applied changes to \`${msg.path}\`` }]); }

      if (msg.type === "streamStart") { setMessages(prev => [...prev, { role: "assistant", content: "" }]); }
      if (msg.type === "streamChunk") {
        setMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: "assistant", content: updated[updated.length - 1].content + (msg.chunk as string) };
          return updated;
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

  function refreshModels() { vscode?.postMessage({ type: "getModels" }); }

  function stopGeneration() { vscode?.postMessage({ type: "stop" }); setLoading(false); }

  function saveApiKeys() {
    vscode?.postMessage({ type: "saveApiKeys", keys: apiKeys });
    setShowSettings(false);
  }

  function sendMessage() {
    const text = input.trim();
    if (!text || loading) return;
    setMessages(prev => [...prev, { role: "user", content: text }]);
    setInput("");
    setLoading(true);
    if (mode === "agent") { vscode?.postMessage({ type: "agent", task: text }); return; }
    const fullText = MODE_HINTS[mode] ? `[${mode.toUpperCase()}] ${text}` : text;
    historyRef.current.push({ role: "user", content: fullText });
    vscode?.postMessage({ type: "chat", messages: historyRef.current, contextFiles });
  }

  function switchModel(model: string) { setModels(prev => ({ ...prev, active: model })); vscode?.postMessage({ type: "selectModel", model }); }
  function toggleInline() { setInline(prev => !prev); vscode?.postMessage({ type: "toggleInline" }); }
  function clearChat() { setMessages([]); historyRef.current = []; vscode?.setState({ messages: [], history: [] }); vscode?.postMessage({ type: "clear" }); }
  function handleKey(e: React.KeyboardEvent) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }

  return (
    <div className="app">
      <div className="header">
        <span className="logo">✦ Telivi</span>
        <div className="header-right">
          <div className="inline-toggle" title="Toggle inline completions (Beta)">
            <span>inline</span>
            <span className="beta-badge">beta</span>
            <label className="toggle">
              <input type="checkbox" checked={inline} onChange={toggleInline} />
              <span className="slider" />
            </label>
          </div>
          <button className="icon-btn" onClick={() => setShowSettings(s => !s)} title="Settings">⚙</button>
          <button className="clear-btn" onClick={clearChat}>Clear</button>
        </div>
      </div>

      {showSettings && (
        <div className="settings-panel">
          <p className="settings-title">API Keys</p>
          <div className="settings-field">
            <label>Anthropic</label>
            <input type="password" placeholder="sk-ant-..." value={apiKeys.anthropic} onChange={e => setApiKeys(k => ({ ...k, anthropic: e.target.value }))} />
          </div>
          <div className="settings-field">
            <label>OpenAI</label>
            <input type="password" placeholder="sk-..." value={apiKeys.openai} onChange={e => setApiKeys(k => ({ ...k, openai: e.target.value }))} />
          </div>
          <div className="settings-field">
            <label>Groq</label>
            <input type="password" placeholder="gsk_..." value={apiKeys.groq} onChange={e => setApiKeys(k => ({ ...k, groq: e.target.value }))} />
          </div>
          <button className="save-keys-btn" onClick={saveApiKeys}>Save & Refresh Models</button>
        </div>
      )}

      <div className="model-bar">
        <ModelPicker active={models.active} local={models.local} api={models.api} onChange={switchModel} />
        <button className="refresh-btn" onClick={refreshModels} title="Refresh models">⟳</button>
      </div>

      <div className="messages">
        {messages.length === 0 && (
          <div className="welcome">
            <p>Hi! I'm Telivi, your AI coding assistant.</p>
            <p>Ask me anything about your code.</p>
          </div>
        )}
        {messages.map((m, i) => (
          <ChatMessage key={i} role={m.role} content={m.content}
            loading={loading && i === messages.length - 1 && m.role === "assistant"}
            vscode={vscode}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="input-area">
        <div className="context-files">
          {contextFiles.length === 0 ? (
            <div className="active-file no-file">
              <span className="active-file-icon">📄</span>
              <span className="active-file-name" style={{color: "var(--vscode-descriptionForeground)"}}>no file open</span>
            </div>
          ) : (
            contextFiles.map(f => (
              <div key={f.path} className="active-file">
                <span className="active-file-icon">📄</span>
                <span className="active-file-name">{f.fileName}</span>
                <span className="active-file-lang">{f.language}</span>
                <button className="remove-file-btn" onClick={() => setContextFiles(prev => prev.filter(x => x.path !== f.path))} title="Remove from context">✕</button>
              </div>
            ))
          )}
          <button className="add-file-btn" onClick={() => vscode?.postMessage({ type: "addFile" })} title="Add file to context">+ Add file</button>
        </div>
        <ModeSelector active={mode} onChange={setMode} />
        <div className="input-row">
          <textarea ref={inputRef} className="input" value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKey}
            placeholder={mode === "chat" ? "Ask about your code..." : `${mode} mode — describe the task...`} rows={1} />
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