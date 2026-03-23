import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getBackendUrl } from "./extension";

export class ChatPanel implements vscode.WebviewViewProvider {
  private view?:            vscode.WebviewView;
  private context:          vscode.ExtensionContext;
  private lastEditor?:      vscode.TextEditor;
  private abortController?: AbortController;

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

    setTimeout(() => {
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

      this.fetchAndSendModels(webviewView.webview);
    }, 600);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "chat") {
        await this.handleChat(msg.messages, msg.contextFiles ?? [], webviewView.webview);
      }
      if (msg.type === "stop") {
        this.abortController?.abort();
        webviewView.webview.postMessage({ type: "streamDone" });
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
        await this.handleAgent(msg.task, webviewView.webview);
      }
      if (msg.type === "applyWrite") {
        try {
          await fetch(`${getBackendUrl()}/api/agent/apply`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ path: msg.path, content: msg.content }),
          });
          webviewView.webview.postMessage({ type: "writeApplied", path: msg.path });
        } catch {
          webviewView.webview.postMessage({ type: "writeError", path: msg.path });
        }
      }
      if (msg.type === "saveApiKeys") {
        const keys = msg.keys as { anthropic: string; openai: string; groq: string };
        try {
          await fetch(`${getBackendUrl()}/api/keys`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(keys),
          });
          await this.fetchAndSendModels(webviewView.webview);
        } catch {
          // backend not running
        }
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

  private async fetchAndSendModels(webview: vscode.Webview) {
    try {
      const res  = await fetch(`${getBackendUrl()}/api/models`);
      const data = await res.json();
      webview.postMessage({ type: "models", data });
    } catch {
      webview.postMessage({ type: "models", data: { active: "", local: [], api: [] } });
    }
  }

  private async handleAgent(task: string, webview: vscode.Webview) {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    const fullTask = workspacePath
      ? `Workspace root: ${workspacePath}\n\n${task}`
      : task;

    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    webview.postMessage({ type: "agentStart" });
    try {
      const res = await fetch(`${getBackendUrl()}/api/agent`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ task: fullTask, workspace_path: workspacePath }),
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
            webview.postMessage({ type: "agentEvent", event });
          } catch { /* ignore */ }
        }
      }
      webview.postMessage({ type: "agentDone" });
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
    const signal = this.abortController.signal;

    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    const filesWithContent = await Promise.all(
      contextFiles.map(async f => {
        try {
          const doc = await vscode.workspace.openTextDocument(f.path);
          return { ...f, code: doc.getText() };
        } catch {
          return { ...f, code: "" };
        }
      })
    );
    const primary     = filesWithContent[0];
    const currentFile = primary?.path     ?? "";
    const currentCode = primary?.code     ?? "";
    const language    = primary?.language ?? "";

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