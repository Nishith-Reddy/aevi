import * as vscode from "vscode";
import { CompletionProvider } from "./completionProvider";
import { ChatPanel } from "./chatPanel";

export function getBackendUrl(): string {
  return vscode.workspace
    .getConfiguration("telivi")
    .get<string>("backendUrl", "http://127.0.0.1:8765");
}

export function activate(context: vscode.ExtensionContext) {
  console.log("Telivi is now active!");

  // ── 1. Inline completion provider ──────────────────────────────
  const completionProvider = new CompletionProvider();
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      completionProvider
    )
  );

  // ── 2. Chat sidebar ─────────────────────────────────────────────
  const chatPanel = new ChatPanel(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("telivi.chatView", chatPanel)
  );

  // ── 3. Push saved settings to backend on startup ─────────────────
  // Small delay to let the backend finish booting
  setTimeout(() => {
    chatPanel.pushSettingsToBackend();
  }, 2000);

  // ── 4. Command: Open Chat ───────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("telivi.openChat", () => {
      vscode.commands.executeCommand("telivi.chatView.focus");
    })
  );

  // ── 5. Command: Index Workspace ─────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("telivi.indexWorkspace", async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showWarningMessage("Telivi: No workspace folder open.");
        return;
      }
      const workspacePath = folders[0].uri.fsPath;
      vscode.window.showInformationMessage("Telivi: Indexing workspace...");
      try {
        const res  = await fetch(`${getBackendUrl()}/api/index`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ workspace_path: workspacePath }),
        });
        const data = await res.json() as { indexed_chunks: number };
        vscode.window.showInformationMessage(`Telivi: Indexed ${data.indexed_chunks} code chunks.`);
      } catch {
        vscode.window.showErrorMessage("Telivi: Could not reach backend. Is it running?");
      }
    })
  );

  // ── 6. Command: Select Model ────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("telivi.selectModel", async () => {
      try {
        const res  = await fetch(`${getBackendUrl()}/api/models`);
        const data = await res.json() as {
          active: string;
          local:  { name: string; size: string }[];
          api:    { name: string; source: string }[];
        };
        const items = [
          ...data.local.map(m => ({ label: m.name, description: `${m.size} — local` })),
          ...data.api.map(m =>   ({ label: m.name, description: `cloud — ${m.source}` })),
        ];
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: `Current model: ${data.active}`,
          title:       "Telivi: Select Model",
        });
        if (!picked) return;
        await fetch(`${getBackendUrl()}/api/models/select`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ model: picked.label }),
        });
        vscode.window.showInformationMessage(`Telivi: Switched to ${picked.label}`);
      } catch {
        vscode.window.showErrorMessage("Telivi: Could not reach backend. Is it running?");
      }
    })
  );

  // ── 7. Command: Toggle Inline Completion ───────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("telivi.toggleInlineCompletion", () => {
      const config  = vscode.workspace.getConfiguration("telivi");
      const current = config.get<boolean>("enableInlineCompletion", false);
      config.update("enableInlineCompletion", !current, true);
      vscode.window.showInformationMessage(
        current ? "Telivi: Inline completions disabled." : "Telivi: Inline completions enabled (Beta)."
      );
    })
  );

  // ── 8. Auto-index workspace on startup ──────────────────────────
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    const workspacePath = folders[0].uri.fsPath;
    fetch(`${getBackendUrl()}/api/index`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ workspace_path: workspacePath }),
    }).catch(() => {});
  }
}

export function deactivate() {
  console.log("Telivi deactivated.");
}