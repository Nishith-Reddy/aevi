import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";

interface Props {
  role:    "user" | "assistant" | "error";
  content: string;
  loading?: boolean;
}

export default function ChatMessage({ role, content, loading }: Props) {
  return (
    <div className={`msg ${role}`}>
      <span className="msg-label">
        {role === "user" ? "You" : role === "error" ? "Error" : "Telivi"}
      </span>
      <div className="msg-content">
        {role === "user" || role === "error" ? (
          // User messages and errors render as plain text
          <span>{content}{loading && <span className="cursor"> ▋</span>}</span>
        ) : (
          // Assistant messages render as markdown with code highlighting
          <ReactMarkdown
            components={{
              code({ className, children, ...props }) {
                const match = /language-(\w+)/.exec(className || "");
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
                    <SyntaxHighlighter
                      style={vscDarkPlus}
                      language={match[1]}
                      PreTag="div"
                    >
                      {codeStr}
                    </SyntaxHighlighter>
                  </div>
                ) : (
                  <code className="inline-code" {...props}>
                    {children}
                  </code>
                );
              },
            }}
          >
            {content}
          </ReactMarkdown>
        )}
        {loading && role === "assistant" && (
          <span className="cursor"> ▋</span>
        )}
      </div>
    </div>
  );
}