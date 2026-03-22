import { useState, useEffect, useRef } from "react";
import ChatMessage from "./components/ChatMessage";
import ModelPicker from "./components/ModelPicker";
import ModeSelector, { type Mode } from "./components/ModeSelector";

// VS Code API
interface VsCodeApi {
  postMessage: (message: unknown) => void;
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

const MODE_HINTS: Record<Mode, string> = {
  chat:    "",
  agent:   "You are in agent mode. The user wants you to autonomously complete a task.",
  explain: "Explain the code or concept clearly. Break it down step by step.",
  fix:     "Find and fix the bug. Show the corrected code and explain what was wrong.",
};

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input,    setInput]    = useState("");
  const [loading,  setLoading]  = useState(false);
  const [mode,     setMode]     = useState<Mode>("chat");
  const [models,   setModels]   = useState<ModelsData>({ active: "", local: [], api: [] });
  const [inline,   setInline]   = useState(true);
  const bottomRef  = useRef<HTMLDivElement>(null);
  const inputRef   = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<{ role: string; content: string }[]>([]);

  // Ask extension for models on load
  useEffect(() => {
    vscode?.postMessage({ type: "getModels" });
  }, []);

  // Listen for all messages from the extension
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;

      if (msg.type === "models") {
        setModels(msg.data as ModelsData);
      }

      if (msg.type === "inlineState") {
        setInline(msg.enabled as boolean);
      }

      if (msg.type === "streamStart") {
        setMessages(prev => [...prev, { role: "assistant", content: "" }]);
      }

      if (msg.type === "streamChunk") {
        setMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role:    "assistant",
            content: updated[updated.length - 1].content + (msg.chunk as string),
          };
          return updated;
        });
      }

      if (msg.type === "streamDone") {
        setLoading(false);
        // Save assistant response to history
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            historyRef.current.push({ role: "assistant", content: last.content });
          }
          return prev;
        });
        inputRef.current?.focus();
      }

      if (msg.type === "streamError") {
        setMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role:    "error",
            content: msg.message as string,
          };
          return updated;
        });
        setLoading(false);
        inputRef.current?.focus();
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function sendMessage() {
    const text = input.trim();
    if (!text || loading) return;

    const fullText = MODE_HINTS[mode]
      ? `[${mode.toUpperCase()}] ${text}`
      : text;

    setMessages(prev => [...prev, { role: "user", content: text }]);
    setInput("");
    setLoading(true);

    historyRef.current.push({ role: "user", content: fullText });

    // Ask extension to send chat request
    vscode?.postMessage({ type: "chat", messages: historyRef.current });
  }

  function switchModel(model: string) {
    setModels(prev => ({ ...prev, active: model }));
    vscode?.postMessage({ type: "selectModel", model });
  }

  function toggleInline() {
    setInline(prev => !prev);
    vscode?.postMessage({ type: "toggleInline" });
  }

  function clearChat() {
    setMessages([]);
    historyRef.current = [];
    vscode?.postMessage({ type: "clear" });
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <div className="app">
      <div className="header">
        <span className="logo">✦ Telivi</span>
        <div className="header-right">
          <div className="inline-toggle" title="Toggle inline completions">
            <span>inline</span>
            <label className="toggle">
              <input type="checkbox" checked={inline} onChange={toggleInline} />
              <span className="slider" />
            </label>
          </div>
          <button className="clear-btn" onClick={clearChat}>Clear</button>
        </div>
      </div>

      <div className="model-bar">
        <ModelPicker
          active={models.active}
          local={models.local}
          api={models.api}
          onChange={switchModel}
        />
      </div>

      <div className="messages">
        {messages.length === 0 && (
          <div className="welcome">
            <p>Hi! I'm Telivi, your AI coding assistant.</p>
            <p>Ask me anything about your code.</p>
          </div>
        )}
        {messages.map((m, i) => (
          <ChatMessage
            key={i}
            role={m.role}
            content={m.content}
            loading={loading && i === messages.length - 1 && m.role === "assistant"}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="input-area">
        <ModeSelector active={mode} onChange={setMode} />
        <div className="input-row">
          <textarea
            ref={inputRef}
            className="input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder={mode === "chat" ? "Ask about your code..." : `${mode} mode — describe the task...`}
            rows={1}
          />
          <button
            className="send-btn"
            onClick={sendMessage}
            disabled={loading || !input.trim()}
          >
            ➤
          </button>
        </div>
      </div>
    </div>
  );
}