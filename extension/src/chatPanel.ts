import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getBackendUrl } from "./extension";

interface LocalProvider {
  name: string;
  url:  string;
}

type ApiKeys = { anthropic: string; openai: string; groq: string; gemini: string };

export class ChatPanel implements vscode.WebviewViewProvider {
  private view?:             vscode.WebviewView;
  private context:           vscode.ExtensionContext;
  private lastEditor?:       vscode.TextEditor;
  private abortController?:  AbortController;
  private resumeState:       Record<string, unknown> | null = null;
  private pendingTask        = "";
  private pendingWorkspace   = "";

  constructor(context: vscode.ExtensionContext) {
    this.context = context;

    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor && editor.document.uri.scheme === "file") {
        this.lastEditor = editor;
        this.view?.webview.postMessage({
          type:     "activeFile",
          fileName: editor.document.fileName.split("/").pop() ?? "",
          language: editor.document.languageId,
          path:     editor.document.fileName,
        });
      }
    });

    const current = vscode.window.activeTextEditor;
    if (current && current.document.uri.scheme === "file") {
      this.lastEditor = current;
    }
  }

  // ── Push saved settings to backend ─────────────────────────────────────────
  async pushSettingsToBackend() {
    const secrets   = this.context.secrets;
    const anthropic = (await secrets.get("telivi.anthropic")) ?? "";
    const openai    = (await secrets.get("telivi.openai"))    ?? "";
    const groq      = (await secrets.get("telivi.groq"))      ?? "";
    const gemini    = (await secrets.get("telivi.gemini"))    ?? "";

    const providers: LocalProvider[] =
      this.context.globalState.get<LocalProvider[]>("telivi.providers") ?? [
        { name: "Ollama", url: "http://localhost:11434" },
      ];

    try {
      await fetch(`${getBackendUrl()}/api/keys`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ anthropic, openai, groq, gemini, providers }),
      });
    } catch {
      // Backend not running yet — will be pushed again once the webview opens
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(
          path.join(this.context.extensionPath, "..", "webview-ui", "dist")
        ),
      ],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && !this.abortController) {
        webviewView.webview.postMessage({ type: "resetLoading" });
      }
    });

    setTimeout(async () => {
      const enabled = vscode.workspace
        .getConfiguration("telivi")
        .get<boolean>("enableInlineCompletion", false);
      webviewView.webview.postMessage({ type: "inlineState", enabled });

      if (this.lastEditor) {
        webviewView.webview.postMessage({
          type:     "activeFile",
          fileName: this.lastEditor.document.fileName.split("/").pop() ?? "",
          language: this.lastEditor.document.languageId,
          path:     this.lastEditor.document.fileName,
        });
      }

      const saved = this.context.globalState.get<{
        messages: unknown[];
        history:  unknown[];
      }>("chatState");
      if (saved) {
        webviewView.webview.postMessage({ type: "restoreState", state: saved });
      }

      // Restore saved settings into the UI
      await this.sendSavedSettingsToWebview(webviewView.webview);

      // Push to backend (keys may have loaded after initial startup)
      await this.pushSettingsToBackend();

      this.fetchAndSendModels(webviewView.webview);
    }, 600);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "chat") {
        await this.handleChat(msg.messages, msg.contextFiles ?? [], webviewView.webview);
      }

      if (msg.type === "stop") {
        this.abortController?.abort();
        this.resumeState = null;
        webviewView.webview.postMessage({ type: "streamDone" });
        webviewView.webview.postMessage({ type: "agentDone" });
      }

      if (msg.type === "getModels") {
        await this.fetchAndSendModels(webviewView.webview);
      }

      if (msg.type === "selectModel") {
        await fetch(`${getBackendUrl()}/api/models/select`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ model: msg.model }),
        }).catch(() => {});
      }

      if (msg.type === "toggleInline") {
        const config  = vscode.workspace.getConfiguration("telivi");
        const current = config.get<boolean>("enableInlineCompletion", false);
        await config.update("enableInlineCompletion", !current, true);
        webviewView.webview.postMessage({ type: "inlineState", enabled: !current });
      }

      if (msg.type === "addFile") {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany:  false,
          canSelectFiles: true,
          title:          "Add file to Telivi context",
          filters:        { "Code files": ["py","ts","js","tsx","jsx","go","rs","java","cpp","c","md"] }
        });
        if (uris && uris[0]) {
          const doc = await vscode.workspace.openTextDocument(uris[0]);
          webviewView.webview.postMessage({
            type:     "activeFile",
            fileName: uris[0].fsPath.split("/").pop() ?? "",
            language: doc.languageId,
            path:     uris[0].fsPath,
          });
        }
      }

      if (msg.type === "agent") {
        this.resumeState = null;
        await this.handleAgent(msg.task, msg.activeFile as string | undefined, webviewView.webview);
      }

      if (msg.type === "applyWrite") {
        const savedState = this.resumeState;
        const savedTask  = this.pendingTask;
        this.resumeState = null;

        try {
          await fetch(`${getBackendUrl()}/api/agent/apply`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ path: msg.path, content: msg.content }),
          });

          webviewView.webview.postMessage({ type: "writeApplied", path: msg.path });

          if (savedState) {
            Promise.resolve().then(() => {
              if (this.view) {
                this.handleAgent(savedTask, undefined, this.view.webview, savedState, true);
              }
            });
          } else {
            webviewView.webview.postMessage({ type: "agentDone" });
          }
        } catch {
          webviewView.webview.postMessage({ type: "writeError", path: msg.path });
          webviewView.webview.postMessage({ type: "agentDone" });
        }
      }

      if (msg.type === "rejectWrite") {
        this.resumeState = null;
        webviewView.webview.postMessage({ type: "agentDone" });
        webviewView.webview.postMessage({ type: "agentRejected" });
      }

      if (msg.type === "removeFile") {
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
        fetch(`${getBackendUrl()}/api/remove-file`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ file_path: msg.path, workspace_path: workspacePath }),
        }).catch(() => {});
      }

      // ── Save settings ────────────────────────────────────────────────────────
      if (msg.type === "saveSettings") {
        const keys      = msg.keys      as ApiKeys;
        const providers = msg.providers as LocalProvider[];

        // Store API keys in SecretStorage (encrypted)
        await this.context.secrets.store("telivi.anthropic", keys.anthropic ?? "");
        await this.context.secrets.store("telivi.openai",    keys.openai    ?? "");
        await this.context.secrets.store("telivi.groq",      keys.groq      ?? "");
        await this.context.secrets.store("telivi.gemini",    keys.gemini    ?? "");

        // Store provider URLs in globalState (not sensitive)
        await this.context.globalState.update("telivi.providers", providers);

        // Push everything to the backend
        try {
          await fetch(`${getBackendUrl()}/api/keys`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ ...keys, providers }),
          });
        } catch { /* backend not running */ }

        await this.fetchAndSendModels(webviewView.webview);
        webviewView.webview.postMessage({ type: "settingsSaved" });
      }

      if (msg.type === "clear") {
        this.context.globalState.update("chatState", undefined);
      }

      if (msg.type === "saveState") {
        this.context.globalState.update("chatState", {
          messages: msg.messages,
          history:  msg.history,
        });
      }
    });
  }

  // ── Send stored settings back to the webview so fields are pre-filled ──────
  private async sendSavedSettingsToWebview(webview: vscode.Webview) {
    const secrets   = this.context.secrets;
    const anthropic = (await secrets.get("telivi.anthropic")) ?? "";
    const openai    = (await secrets.get("telivi.openai"))    ?? "";
    const groq      = (await secrets.get("telivi.groq"))      ?? "";
    const gemini    = (await secrets.get("telivi.gemini"))    ?? "";

    const providers: LocalProvider[] =
      this.context.globalState.get<LocalProvider[]>("telivi.providers") ?? [
        { name: "Ollama", url: "http://localhost:11434" },
      ];

    webview.postMessage({
      type: "restoreSettings",
      keys: { anthropic, openai, groq, gemini },
      providers,
    });
  }

  private async fetchAndSendModels(webview: vscode.Webview) {
    try {
      const res  = await fetch(`${getBackendUrl()}/api/models`);
      const data = await res.json();
      webview.postMessage({ type: "models", data });
    } catch {
      webview.postMessage({ type: "models", data: { active: "", local: [], api: [] } });
    }
  }

  private async handleAgent(
    task: string,
    activeFile: string | undefined,
    webview: vscode.Webview,
    resumeState?: Record<string, unknown>,
    isResume = false
  ) {
    const workspacePath   = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    this.pendingTask      = task;
    this.pendingWorkspace = workspacePath;
    this.abortController  = new AbortController();
    const signal          = this.abortController.signal;

    const taskWithContext = activeFile
      ? `Active file: ${activeFile}\n\nTask: ${task}`
      : task;

    if (!isResume) {
      webview.postMessage({ type: "agentStart" });
    }

    try {
      const res = await fetch(`${getBackendUrl()}/api/agent`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ task: taskWithContext, workspace_path: workspacePath, resume_state: resumeState ?? null }),
        signal,
      });
      if (!res.ok || !res.body) throw new Error("Backend error");

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buffer  = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.event === "confirm_write" && event.resume_state) {
              this.resumeState = event.resume_state;
            }
            webview.postMessage({ type: "agentEvent", event });
          } catch { /* ignore malformed lines */ }
        }
      }

      if (!this.resumeState) {
        webview.postMessage({ type: "agentDone" });
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") {
        webview.postMessage({ type: "agentDone" });
      } else {
        webview.postMessage({ type: "agentError", message: "Could not reach Telivi backend. Is it running?" });
      }
    }
  }

  private async handleChat(
    messages: { role: string; content: string }[],
    contextFiles: { fileName: string; language: string; path: string }[],
    webview: vscode.Webview
  ) {
    this.abortController = new AbortController();
    const signal         = this.abortController.signal;
    const workspacePath  = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    const lastUserMsg    = [...messages].reverse().find(m => m.role === "user")?.content ?? "";

    let ragContext = "";
    if (lastUserMsg && workspacePath) {
      try {
        const res = await fetch(`${getBackendUrl()}/api/retrieve`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ query: lastUserMsg, workspace_path: workspacePath }),
        });
        if (res.ok) {
          const data = await res.json() as { chunks: string[]; chunks_found: number };
          if (data.chunks_found > 0) ragContext = data.chunks.join("\n\n---\n\n");
        }
      } catch { /* RAG unavailable */ }
    }

    let currentFile = "";
    let currentCode = "";
    let language    = "";

    if (ragContext) {
      currentCode = ragContext;
      currentFile = workspacePath;
      language    = contextFiles[0]?.language ?? "";
    } else if (contextFiles.length > 0) {
      const SMALL_FILE = 6_000;
      try {
        const doc  = await vscode.workspace.openTextDocument(contextFiles[0].path);
        const full = doc.getText();
        currentFile = contextFiles[0].path;
        language    = contextFiles[0].language;
        if (full.length <= SMALL_FILE) {
          currentCode = full;
        } else {
          const cut   = full.lastIndexOf("\n", SMALL_FILE);
          currentCode = full.slice(0, cut) + `\n// ... [file too large for context]`;
          webview.postMessage({ type: "fileTruncated", files: [contextFiles[0].fileName] });
        }
      } catch { /* ignore */ }
    }

    webview.postMessage({ type: "streamStart" });
    try {
      const res = await fetch(`${getBackendUrl()}/api/chat`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ messages, workspace_path: workspacePath, current_file: currentFile, current_code: currentCode, language }),
        signal,
      });
      if (!res.ok || !res.body) throw new Error("Backend error");
      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        webview.postMessage({ type: "streamChunk", chunk: decoder.decode(value, { stream: true }) });
      }
      webview.postMessage({ type: "streamDone" });
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") {
        webview.postMessage({ type: "streamDone" });
      } else {
        webview.postMessage({ type: "streamError", message: "Could not reach Telivi backend. Is it running?" });
      }
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const distPath  = path.join(this.context.extensionPath, "..", "webview-ui", "dist");
    const indexPath = path.join(distPath, "index.html");
    let html        = fs.readFileSync(indexPath, "utf8");

    const assetsDir = path.join(distPath, "assets");
    const files     = fs.readdirSync(assetsDir);
    const jsFile    = files.find(f => f.endsWith(".js"));
    const cssFile   = files.find(f => f.endsWith(".css"));

    if (jsFile) {
      const uri = webview.asWebviewUri(vscode.Uri.file(path.join(assetsDir, jsFile)));
      html = html.replace(`/assets/${jsFile}`, uri.toString());
    }
    if (cssFile) {
      const uri = webview.asWebviewUri(vscode.Uri.file(path.join(assetsDir, cssFile)));
      html = html.replace(`/assets/${cssFile}`, uri.toString());
    }

    const csp = `<meta http-equiv="Content-Security-Policy" content="
      default-src 'none';
      style-src ${webview.cspSource} 'unsafe-inline';
      script-src ${webview.cspSource} 'unsafe-inline';
      img-src ${webview.cspSource} data:;
      font-src ${webview.cspSource};
    ">`;
    html = html.replace("</head>", `${csp}</head>`);

    return html;
  }
}