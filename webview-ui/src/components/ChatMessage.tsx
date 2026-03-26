import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";

interface VsCodeApi { postMessage: (msg: unknown) => void; }

interface Props {
  role:     "user" | "assistant" | "error";
  content:  string;
  loading?: boolean;
  vscode:   VsCodeApi | null;
}

export default function ChatMessage({ role, content, loading, vscode }: Props) {
  const confirmIdx   = content.indexOf("__CONFIRM__:");
  const mainContent  = confirmIdx >= 0 ? content.slice(0, confirmIdx) : content;
  const confirmBlock = confirmIdx >= 0 ? content.slice(confirmIdx + "__CONFIRM__:".length) : null;

  let confirmPath    = "";
  let confirmContent = "";
  if (confirmBlock) {
    const colonIdx = confirmBlock.indexOf(":");
    confirmPath    = confirmBlock.slice(0, colonIdx);
    confirmContent = confirmBlock.slice(colonIdx + 1);
  }

  return (
    <div className={`msg ${role}`}>
      <span className="msg-label">
        {role === "user" ? "You" : role === "error" ? "Error" : "aevi"}
      </span>
      <div className="msg-content">
        {role === "user" || role === "error" ? (
          <span>{mainContent}{loading && <span className="cursor"> ▋</span>}</span>
        ) : (
          <>
            <ReactMarkdown
              components={{
                code({ className, children, ...props }) {
                  const match   = /language-(\w+)/.exec(className || "");
                  const codeStr = String(children).replace(/\n$/, "");
                  return match ? (
                    <div className="code-block-wrap">
                      <div className="code-block-header">
                        <span>{match[1]}</span>
                        <button
                          className="copy-btn"
                          onClick={() => navigator.clipboard.writeText(codeStr)}
                        >
                          Copy
                        </button>
                      </div>
                      <SyntaxHighlighter style={vscDarkPlus} language={match[1]} PreTag="div">
                        {codeStr}
                      </SyntaxHighlighter>
                    </div>
                  ) : (
                    <code className="inline-code" {...props}>{children}</code>
                  );
                },
              }}
            >
              {mainContent}
            </ReactMarkdown>

            {confirmBlock && (
              <div className="confirm-write">
                <p className="confirm-title">
                  ⚠️ Agent wants to write <code>{confirmPath.split("/").pop()}</code>
                </p>
                <div className="confirm-actions">
                  <button
                    className="confirm-btn apply"
                    onClick={() => vscode?.postMessage({
                      type:    "applyWrite",
                      path:    confirmPath,
                      content: confirmContent,
                    })}
                  >
                    ✅ Apply
                  </button>
                  <button
                    className="confirm-btn reject"
                    onClick={() => vscode?.postMessage({ type: "rejectWrite" })}
                  >
                    ❌ Reject
                  </button>
                </div>
              </div>
            )}

            {loading && <span className="cursor"> ▋</span>}
          </>
        )}
      </div>
    </div>
  );
}