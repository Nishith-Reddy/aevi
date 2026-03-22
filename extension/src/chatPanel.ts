import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getBackendUrl } from "./extension";

export class ChatPanel implements vscode.WebviewViewProvider {
  private view?:   vscode.WebviewView;
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
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

    // Send initial state after UI loads
    setTimeout(() => {
      const enabled = vscode.workspace
        .getConfiguration("telivi")
        .get<boolean>("enableInlineCompletion", true);
      webviewView.webview.postMessage({ type: "inlineState", enabled });

      // Send models to UI
      this.fetchAndSendModels(webviewView.webview);
    }, 600);

    // Handle all messages from React UI
    webviewView.webview.onDidReceiveMessage(async (msg) => {

      // ── Chat message ──────────────────────────────────────────
      if (msg.type === "chat") {
        await this.handleChat(msg.messages, webviewView.webview);
      }

      // ── Fetch models ──────────────────────────────────────────
      if (msg.type === "getModels") {
        await this.fetchAndSendModels(webviewView.webview);
      }

      // ── Select model ─────────────────────────────────────────
      if (msg.type === "selectModel") {
        await fetch(`${getBackendUrl()}/api/models/select`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ model: msg.model }),
        }).catch(() => {});
      }

      // ── Toggle inline completion ──────────────────────────────
      if (msg.type === "toggleInline") {
        const config  = vscode.workspace.getConfiguration("telivi");
        const current = config.get<boolean>("enableInlineCompletion", true);
        await config.update("enableInlineCompletion", !current, true);
        webviewView.webview.postMessage({ type: "inlineState", enabled: !current });
      }

      // ── Clear history ─────────────────────────────────────────
      if (msg.type === "clear") {
        // history is managed in React, nothing to do here
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

  private async handleChat(
    messages: { role: string; content: string }[],
    webview: vscode.Webview
  ) {
    const workspacePath =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

    webview.postMessage({ type: "streamStart" });

    try {
      const res = await fetch(`${getBackendUrl()}/api/chat`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ messages, workspace_path: workspacePath }),
      });

      if (!res.ok || !res.body) throw new Error("Backend error");

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        webview.postMessage({ type: "streamChunk", chunk });
      }

      webview.postMessage({ type: "streamDone" });
    } catch {
      webview.postMessage({
        type:    "streamError",
        message: "Could not reach Telivi backend. Is it running?",
      });
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

    // CSP — no direct network access needed, extension proxies all API calls
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