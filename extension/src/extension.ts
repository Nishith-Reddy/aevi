//updated the file
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { ChildProcess, spawn, execSync, spawnSync } from "child_process";
import { ChatPanel } from "./chatPanel";
import { CompletionProvider } from "./completionProvider";

export function getBackendUrl(): string {
  return vscode.workspace
    .getConfiguration("aevi")
    .get<string>("backendUrl", "http://127.0.0.1:8765");
}

let backendProcess: ChildProcess | null = null;

const AEVI_DIR    = path.join(os.homedir(), ".aevi");
const VENV_DIR    = path.join(AEVI_DIR, "venv");
const MARKER_FILE = path.join(AEVI_DIR, ".installed");

function getVenvPython(): string {
  return os.platform() === "win32"
    ? path.join(VENV_DIR, "Scripts", "python.exe")
    : path.join(VENV_DIR, "bin", "python");
}

function getVenvUv(): string {
  return os.platform() === "win32"
    ? path.join(VENV_DIR, "Scripts", "uv.exe")
    : path.join(VENV_DIR, "bin", "uv");
}

export function getPython(): string | null {
  const candidates = ["python3.11", "python3.12", "python3.13", "python3", "python"];
  for (const cmd of candidates) {
    try {
      const out = execSync(`${cmd} --version 2>&1`).toString().trim();
      const m   = out.match(/Python (\d+)\.(\d+)/);
      if (m && parseInt(m[1]) === 3 && parseInt(m[2]) >= 11) return cmd;
    } catch { /* try next */ }
  }
  return null;
}

export function isInstalled(): boolean {
  return fs.existsSync(MARKER_FILE) && fs.existsSync(getVenvPython());
}

export async function setupBackend(
  context: vscode.ExtensionContext,
  webview: vscode.Webview
): Promise<boolean> {
  const python = getPython();
  if (!python) {
    webview.postMessage({ type: "setupError", message: "Python 3.11+ not found. Please install it from https://python.org" });
    return false;
  }

  const backendSrc = path.join(context.extensionPath, "backend");

  const steps = [
    { msg: "Creating Python environment...", fn: () => {
      fs.mkdirSync(AEVI_DIR, { recursive: true });
      execSync(`${python} -m venv "${VENV_DIR}"`, { stdio: "pipe" });
    }},
    { msg: "Installing uv...", fn: () => {
      const pip = os.platform() === "win32"
        ? path.join(VENV_DIR, "Scripts", "pip.exe")
        : path.join(VENV_DIR, "bin", "pip");
      execSync(`"${pip}" install uv`, { stdio: "pipe" });
    }},
    { msg: "Installing dependencies...", fn: () => {
      const uv = getVenvUv();
      const venvPython = getVenvPython();
      // Get the absolute path to requirements.txt
      const reqPath = path.join(backendSrc, "requirements.txt");
      execSync(
        `"${uv}" pip install --python "${venvPython}" -r "${reqPath}"`,
        { stdio: "pipe", timeout: 300_000 }
      );
    }},
    { msg: "Finishing up...", fn: () => {
      fs.writeFileSync(MARKER_FILE, new Date().toISOString());
    }},
  ];

  for (let i = 0; i < steps.length; i++) {
    const { msg, fn } = steps[i];
    webview.postMessage({ type: "setupProgress", message: msg, step: i + 1, total: steps.length });
    try {
      fn();
    } catch (e) {
      webview.postMessage({ type: "setupError", message: `Setup failed at "${msg}": ${e}` });
      return false;
    }
  }

  webview.postMessage({ type: "setupDone" });
  return true;
}

export async function startBackend(context: vscode.ExtensionContext): Promise<boolean> {
  // Already running?
  try {
    const res = await fetch(`${getBackendUrl()}/health`);
    if (res.ok) { console.log("[Aevi] Backend already running."); return true; }
  } catch { /* not running */ }

  const venvPython = getVenvPython();
  const mainPy     = path.join(context.extensionPath, "backend", "main.py");
  const backendDir = path.join(context.extensionPath, "backend");

  backendProcess = spawn(venvPython, [mainPy], {
    cwd:   backendDir,
    stdio: "ignore",
    env:   { ...process.env, PYTHONUNBUFFERED: "1" },
  });

  backendProcess.on("error", err =>
    vscode.window.showErrorMessage(`Aevi: Backend failed — ${err.message}`)
  );
  backendProcess.on("exit", code => {
    if (code !== 0 && code !== null)
      vscode.window.showErrorMessage(`Aevi: Backend crashed (code ${code}). Run "Aevi: Reinstall Backend" from the command palette.`);
  });

  // Poll until ready (30s)
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    try {
      const res = await fetch(`${getBackendUrl()}/health`);
      if (res.ok) { console.log("[Aevi] Backend ready."); return true; }
    } catch { /* waiting */ }
    await new Promise(r => setTimeout(r, 500));
  }
  vscode.window.showWarningMessage("Aevi: Backend is taking longer than expected.");
  return false;
}

export function activate(context: vscode.ExtensionContext) {
  console.log("Aevi is now active!");

  const chatPanel = new ChatPanel(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("aevi.chatView", chatPanel)
  );

  // If already installed, start backend immediately
  if (isInstalled()) {
    startBackend(context).then(ok => {
      if (ok) {
        chatPanel.pushSettingsToBackend();
        const folders = vscode.workspace.workspaceFolders;
        if (folders?.[0]) {
          fetch(`${getBackendUrl()}/api/index`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ workspace_path: folders[0].uri.fsPath }),
          }).catch(() => {});
        }
      }
    });
  }

  // ── Commands ─────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**" }, new CompletionProvider()
    ),

    vscode.commands.registerCommand("aevi.openChat", () =>
      vscode.commands.executeCommand("aevi.chatView.focus")
    ),

    vscode.commands.registerCommand("aevi.indexWorkspace", async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders?.length) { vscode.window.showWarningMessage("Aevi: No workspace open."); return; }
      vscode.window.showInformationMessage("Aevi: Indexing workspace...");
      try {
        const res  = await fetch(`${getBackendUrl()}/api/index`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspace_path: folders[0].uri.fsPath }),
        });
        const data = await res.json() as { indexed_chunks: number };
        vscode.window.showInformationMessage(`Aevi: Indexed ${data.indexed_chunks} chunks.`);
      } catch { vscode.window.showErrorMessage("Aevi: Could not reach backend."); }
    }),

    vscode.commands.registerCommand("aevi.selectModel", async () => {
      try {
        const res  = await fetch(`${getBackendUrl()}/api/models`);
        const data = await res.json() as { active: string; local: { name: string; size: string }[]; api: { name: string; source: string }[] };
        const items = [
          ...data.local.map(m => ({ label: m.name, description: `${m.size} — local` })),
          ...data.api.map(m =>   ({ label: m.name, description: `cloud — ${m.source}` })),
        ];
        const picked = await vscode.window.showQuickPick(items, { placeHolder: `Current: ${data.active}`, title: "Aevi: Select Model" });
        if (!picked) return;
        await fetch(`${getBackendUrl()}/api/models/select`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: picked.label }),
        });
        vscode.window.showInformationMessage(`Aevi: Switched to ${picked.label}`);
      } catch { vscode.window.showErrorMessage("Aevi: Could not reach backend."); }
    }),

    vscode.commands.registerCommand("aevi.toggleInlineCompletion", () => {
      const config  = vscode.workspace.getConfiguration("aevi");
      const current = config.get<boolean>("enableInlineCompletion", false);
      config.update("enableInlineCompletion", !current, true);
      vscode.window.showInformationMessage(
        current ? "Aevi: Inline completions disabled." : "Aevi: Inline completions enabled (Beta)."
      );
    }),

    vscode.commands.registerCommand("aevi.reinstallBackend", async () => {
      if (fs.existsSync(MARKER_FILE)) fs.unlinkSync(MARKER_FILE);
      if (fs.existsSync(VENV_DIR))    fs.rmSync(VENV_DIR, { recursive: true });
      vscode.window.showInformationMessage("Aevi: Marker cleared. Reload VS Code to reinstall.");
    })
  );
}

export function deactivate() {
  if (backendProcess) { backendProcess.kill(); backendProcess = null; }
}