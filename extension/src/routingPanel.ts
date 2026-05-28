import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getBackendUrl } from "./extension";
import { onModelsChanged, onRoutersChanged } from "./panelEvents";

export class RoutingPanel {
  private static current: RoutingPanel | undefined;
  private readonly panel:   vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext) {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (RoutingPanel.current) {
      RoutingPanel.current.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "aeviRouter",
      "Aevi: Semantic Router",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(context.extensionPath, "..", "webview-ui", "dist")),
        ],
      }
    );

    RoutingPanel.current = new RoutingPanel(panel, context);
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel   = panel;
    this.context = context;

    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // When chat settings add/remove a provider or key, refresh the model dropdowns.
    this.disposables.push(onModelsChanged.event(() => this.pushModels()));

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "router:list") {
        try {
          const res  = await fetch(`${getBackendUrl()}/api/router/list`);
          const data = await res.json() as { routers: unknown[] };
          this.panel.webview.postMessage({ type: "router:list", routers: data.routers ?? [] });
        } catch {
          this.panel.webview.postMessage({ type: "router:error", message: "Could not reach backend." });
        }
      }

      if (msg.type === "router:load") {
        try {
          const res = await fetch(`${getBackendUrl()}/api/router/${encodeURIComponent(msg.id)}`);
          if (!res.ok) {
            this.panel.webview.postMessage({ type: "router:load", data: null });
            return;
          }
          const data = await res.json();
          this.panel.webview.postMessage({ type: "router:load", data });
        } catch {
          this.panel.webview.postMessage({ type: "router:error", message: "Could not load router." });
        }
      }

      if (msg.type === "router:save") {
        try {
          const res  = await fetch(`${getBackendUrl()}/api/router/${encodeURIComponent(msg.id)}`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(msg.graph),
          });
          const data = await res.json();
          this.panel.webview.postMessage({ type: "router:saved", data });
          onRoutersChanged.fire();
        } catch {
          this.panel.webview.postMessage({ type: "router:error", message: "Save failed." });
        }
      }

      if (msg.type === "router:create") {
        const name = ((msg.name as string) ?? "").trim();
        if (!name) {
          this.panel.webview.postMessage({ type: "router:error", message: "Name is required." });
          return;
        }
        try {
          const res  = await fetch(`${getBackendUrl()}/api/router/create`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ name }),
          });
          const data = await res.json();
          this.panel.webview.postMessage({ type: "router:created", data });
          onRoutersChanged.fire();
        } catch {
          this.panel.webview.postMessage({ type: "router:error", message: "Create failed." });
        }
      }

      if (msg.type === "router:rename") {
        const current = (msg.currentName as string) ?? "";
        const next = (await vscode.window.showInputBox({
          prompt:         "Rename router",
          value:          current,
          ignoreFocusOut: true,
        }))?.trim();
        if (!next || next === current) return;
        try {
          // If the webview supplied a graph (the row being renamed is currently
          // open in the canvas), use it. Otherwise fetch what's on disk so we
          // don't accidentally blank out its nodes/edges.
          let graph = msg.graph as Record<string, unknown> | null;
          if (!graph) {
            const cur = await fetch(`${getBackendUrl()}/api/router/${encodeURIComponent(msg.id)}`);
            if (!cur.ok) {
              this.panel.webview.postMessage({ type: "router:error", message: "Rename failed: router not found." });
              return;
            }
            graph = await cur.json() as Record<string, unknown>;
          }
          const res  = await fetch(`${getBackendUrl()}/api/router/${encodeURIComponent(msg.id)}`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ ...graph, name: next }),
          });
          const data = await res.json();
          this.panel.webview.postMessage({ type: "router:saved", data, id: msg.id, name: next });
          onRoutersChanged.fire();
        } catch {
          this.panel.webview.postMessage({ type: "router:error", message: "Rename failed." });
        }
      }

      if (msg.type === "router:delete") {
        const label = (msg.name as string) || msg.id;
        const choice = await vscode.window.showWarningMessage(
          `Delete router "${label}"? This cannot be undone.`,
          { modal: true },
          "Delete",
        );
        if (choice !== "Delete") return;
        try {
          await fetch(`${getBackendUrl()}/api/router/${encodeURIComponent(msg.id)}`, { method: "DELETE" });
          this.panel.webview.postMessage({ type: "router:deleted", id: msg.id });
          onRoutersChanged.fire();
        } catch {
          this.panel.webview.postMessage({ type: "router:error", message: "Delete failed." });
        }
      }

      if (msg.type === "router:test") {
        try {
          const res = await fetch(`${getBackendUrl()}/api/router/test`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ task: msg.task, router_id: msg.router_id ?? null, graph: msg.graph ?? null }),
          });
          const data = await res.json();
          this.panel.webview.postMessage({ type: "router:testResult", data });
        } catch {
          this.panel.webview.postMessage({ type: "router:error", message: "Test failed." });
        }
      }

      if (msg.type === "router:getModels") {
        try {
          const res = await fetch(`${getBackendUrl()}/api/models`);
          const data = await res.json();
          this.panel.webview.postMessage({ type: "router:models", data });
        } catch {
          this.panel.webview.postMessage({ type: "router:models", data: { active: "", local: [], api: [] } });
        }
      }
    }, null, this.disposables);
  }

  private dispose() {
    RoutingPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }

  private async pushModels() {
    try {
      const res  = await fetch(`${getBackendUrl()}/api/models`);
      const data = await res.json();
      this.panel.webview.postMessage({ type: "router:models", data });
    } catch { /* backend unreachable — webview keeps current state */ }
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

    // Tell the bundled React app which view to render.
    const viewInjection = `<script>window.__AEVI_VIEW__ = "router";</script>`;
    html = html.replace("</head>", `${viewInjection}</head>`);

    const csp = `<meta http-equiv="Content-Security-Policy" content="
      default-src 'none';
      style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com;
      script-src ${webview.cspSource} 'unsafe-inline';
      img-src ${webview.cspSource} data:;
      font-src ${webview.cspSource} https://fonts.gstatic.com;
    ">`;
    html = html.replace("</head>", `${csp}</head>`);

    return html;
  }
}