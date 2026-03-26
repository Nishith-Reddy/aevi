import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";

interface VsCodeApi { postMessage: (msg: unknown) => void; }

interface AgentStep {
  type:    "text" | "tool" | "confirm";
  // tool
  tool?:   string;
  args?:   Record<string, unknown>;
  result?: string;
  status?: "running" | "done" | "error";
  // confirm
  path?:             string;
  fname?:            string;
  diff?:             string;
  contentToWrite?:   string;
  resumeState?:      unknown;
  // text
  content?: string;
}

interface Props {
  steps:   AgentStep[];
  loading: boolean;
  vscode:  VsCodeApi | null;
}

const TOOL_ICONS: Record<string, string> = {
  read_file:    "📄",
  write_file:   "💾",
  edit_file:    "✏️",
  edit_lines:   "✏️",
  find_in_file: "🔍",
  file_outline: "🗂",
  goto_line:    "↗",
  list_dir:     "📁",
  run_command:  "⚡",
};

function ToolBadge({ step }: { step: AgentStep }) {
  const [expanded, setExpanded] = useState(false);
  const icon   = TOOL_ICONS[step.tool ?? ""] ?? "🔧";
  const status = step.status === "running" ? "⏳" : step.status === "error" ? "✗" : "✓";
  const statusColor = step.status === "error"
    ? "var(--vscode-testing-iconFailed)"
    : step.status === "running"
    ? "var(--vscode-descriptionForeground)"
    : "var(--vscode-testing-iconPassed)";

  return (
    <div style={{ margin: "2px 0" }}>
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          display:        "inline-flex",
          alignItems:     "center",
          gap:            6,
          padding:        "2px 8px",
          borderRadius:   4,
          border:         "0.5px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.2))",
          background:     "var(--vscode-editorWidget-background, rgba(128,128,128,0.08))",
          cursor:         "pointer",
          fontSize:       12,
          color:          "var(--vscode-descriptionForeground)",
          fontFamily:     "var(--vscode-editor-font-family, monospace)",
        }}
      >
        <span style={{ fontSize: 11 }}>{icon}</span>
        <span>{step.tool}</span>
        <span style={{ color: statusColor, fontSize: 11, fontWeight: 500 }}>{status}</span>
        <span style={{ fontSize: 10, opacity: 0.6 }}>{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div style={{
          marginTop:    4,
          marginLeft:   8,
          padding:      "8px 10px",
          borderLeft:   "2px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.2))",
          fontSize:     12,
          fontFamily:   "var(--vscode-editor-font-family, monospace)",
          color:        "var(--vscode-descriptionForeground)",
        }}>
          {step.args && (
            <div style={{ marginBottom: step.result ? 6 : 0, opacity: 0.8 }}>
              {Object.entries(step.args).map(([k, v]) => (
                <div key={k}>
                  <span style={{ color: "var(--vscode-symbolIcon-variableForeground)" }}>{k}</span>
                  <span style={{ opacity: 0.5 }}>=</span>
                  <span style={{ color: "var(--vscode-symbolIcon-stringForeground)" }}>
                    {typeof v === "string" && v.length > 80 ? v.slice(0, 80) + "…" : String(v)}
                  </span>
                </div>
              ))}
            </div>
          )}
          {step.result && (
            <div style={{
              marginTop:  4,
              padding:    "4px 8px",
              borderRadius: 3,
              background: "var(--vscode-textCodeBlock-background)",
              whiteSpace: "pre-wrap",
              maxHeight:  120,
              overflowY:  "auto",
              fontSize:   11,
            }}>
              {step.result.length > 400 ? step.result.slice(0, 400) + "\n…" : step.result}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DiffConfirm({ step, vscode }: { step: AgentStep; vscode: VsCodeApi | null }) {
  const lines       = (step.diff ?? "").split("\n");
  const additions   = lines.filter(l => l.startsWith("+") && !l.startsWith("+++")).length;
  const deletions   = lines.filter(l => l.startsWith("-") && !l.startsWith("---")).length;

  return (
    <div style={{
      margin:       "8px 0",
      borderRadius: 6,
      border:       "0.5px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.25))",
      overflow:     "hidden",
      fontSize:     12,
    }}>
      <div style={{
        display:        "flex",
        alignItems:     "center",
        gap:            8,
        padding:        "6px 12px",
        background:     "var(--vscode-editorWidget-background, rgba(128,128,128,0.08))",
        borderBottom:   "0.5px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.2))",
      }}>
        <span style={{ fontFamily: "var(--vscode-editor-font-family, monospace)", fontWeight: 500, color: "var(--vscode-foreground)" }}>
          {step.fname}
        </span>
        <span style={{ color: "var(--vscode-gitDecoration-addedResourceForeground, #81b88b)", fontSize: 11 }}>+{additions}</span>
        <span style={{ color: "var(--vscode-gitDecoration-deletedResourceForeground, #c74e39)", fontSize: 11 }}>-{deletions}</span>
      </div>

      <div style={{
        maxHeight:  320,
        overflowY:  "auto",
        fontFamily: "var(--vscode-editor-font-family, monospace)",
        fontSize:   12,
        lineHeight: 1.6,
      }}>
        {lines.map((line, i) => {
          const isAdd = line.startsWith("+") && !line.startsWith("+++");
          const isDel = line.startsWith("-") && !line.startsWith("---");
          const isHdr = line.startsWith("@@");
          return (
            <div key={i} style={{
              padding:    "0 12px",
              background: isAdd ? "rgba(70,170,85,0.12)"
                        : isDel ? "rgba(199,78,57,0.12)"
                        : isHdr ? "var(--vscode-editorWidget-background)"
                        : "transparent",
              color:      isAdd ? "var(--vscode-gitDecoration-addedResourceForeground, #81b88b)"
                        : isDel ? "var(--vscode-gitDecoration-deletedResourceForeground, #c74e39)"
                        : isHdr ? "var(--vscode-descriptionForeground)"
                        : "var(--vscode-editor-foreground)",
              whiteSpace: "pre",
            }}>
              {line || " "}
            </div>
          );
        })}
      </div>

      <div style={{
        display:        "flex",
        justifyContent: "flex-end",
        gap:            6,
        padding:        "6px 12px",
        borderTop:      "0.5px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.2))",
        background:     "var(--vscode-editorWidget-background, rgba(128,128,128,0.08))",
      }}>
        <button
          onClick={() => vscode?.postMessage({ type: "rejectWrite" })}
          style={{
            padding:      "3px 10px",
            borderRadius: 3,
            border:       "0.5px solid var(--vscode-button-secondaryBorder, rgba(128,128,128,0.4))",
            background:   "transparent",
            color:        "var(--vscode-foreground)",
            cursor:       "pointer",
            fontSize:     11,
          }}
        >
          Reject
        </button>
        <button
          onClick={() => vscode?.postMessage({ type: "applyWrite", path: step.path, content: step.contentToWrite })}
          style={{
            padding:      "3px 10px",
            borderRadius: 3,
            border:       "none",
            background:   "var(--vscode-button-background, #0e639c)",
            color:        "var(--vscode-button-foreground, #fff)",
            cursor:       "pointer",
            fontSize:     11,
            fontWeight:   500,
          }}
        >
          Accept
        </button>
      </div>
    </div>
  );
}

export default function AgentMessage({ steps, loading, vscode }: Props) {
  return (
    <div style={{ fontSize: 13, lineHeight: 1.6 }}>
      {steps.map((step, i) => {
        if (step.type === "tool") {
          return <ToolBadge key={i} step={step} />;
        }
        if (step.type === "confirm") {
          return <DiffConfirm key={i} step={step} vscode={vscode} />;
        }
        if (step.type === "text" && step.content) {
          return (
            <ReactMarkdown
              key={i}
              components={{
                code({ className, children }) {
                  const match   = /language-(\w+)/.exec(className || "");
                  const codeStr = String(children).replace(/\n$/, "");
                  return match ? (
                    <div style={{ margin: "6px 0", borderRadius: 4, overflow: "hidden", border: "0.5px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.2))" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 10px", background: "var(--vscode-editorWidget-background)", fontSize: 11, color: "var(--vscode-descriptionForeground)" }}>
                        <span>{match[1]}</span>
                        <button style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", fontSize: 11 }} onClick={() => navigator.clipboard.writeText(codeStr)}>Copy</button>
                      </div>
                      <SyntaxHighlighter style={vscDarkPlus} language={match[1]} PreTag="div" customStyle={{ margin: 0, borderRadius: 0, fontSize: 12 }}>
                        {codeStr}
                      </SyntaxHighlighter>
                    </div>
                  ) : (
                    <code style={{ fontFamily: "var(--vscode-editor-font-family, monospace)", fontSize: 12, padding: "1px 4px", borderRadius: 3, background: "var(--vscode-textCodeBlock-background)" }}>{children}</code>
                  );
                },
              }}
            >
              {step.content}
            </ReactMarkdown>
          );
        }
        return null;
      })}
      {loading && <span style={{ opacity: 0.5, fontSize: 12 }}>▋</span>}
    </div>
  );
}