import * as vscode from "vscode";
import { getBackendUrl } from "./extension";

interface Message {
  role:    "user" | "assistant";
  content: string;
}

export class ChatPanel implements vscode.WebviewViewProvider {
  private view?:     vscode.WebviewView;
  private history:   Message[] = [];
  private context:   vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.getHtml();

    // Handle messages sent from the WebView UI
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "chat") {
        await this.handleChat(msg.text);
      }
      if (msg.type === "clear") {
        this.history = [];
      }
    });
  }

  private async handleChat(userText: string) {
    if (!this.view) return;

    // Add user message to history
    this.history.push({ role: "user", content: userText });

    // Get current workspace path for RAG
    const workspacePath =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

    // Tell the UI to show a loading indicator
    this.view.webview.postMessage({ type: "start" });

    try {
      const res = await fetch(`${getBackendUrl()}/api/chat`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages:       this.history,
          workspace_path: workspacePath,
        }),
      });

      if (!res.ok || !res.body) {
        this.view.webview.postMessage({
          type:    "error",
          content: "Backend error. Is the server running?",
        });
        return;
      }

      // Stream the response chunk by chunk to the UI
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullResponse = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        fullResponse += chunk;

        // Send each chunk to the WebView as it arrives
        this.view.webview.postMessage({ type: "chunk", content: chunk });
      }

      // Save the full response to history
      this.history.push({ role: "assistant", content: fullResponse });
      this.view.webview.postMessage({ type: "done" });

    } catch {
      this.view?.webview.postMessage({
        type:    "error",
        content: "Could not reach Telivi backend. Is it running?",
      });
    }
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }

  #header {
    padding: 8px 12px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  #clear-btn {
    background: none;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 3px;
  }
  #clear-btn:hover { background: var(--vscode-toolbar-hoverBackground); }

  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .msg { display: flex; flex-direction: column; gap: 3px; }

  .msg-label {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .msg.assistant .msg-label { color: var(--vscode-textLink-foreground); }

  .msg-content {
    padding: 7px 10px;
    border-radius: 4px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .msg.user .msg-content {
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border);
  }

  .msg.assistant .msg-content {
    background: var(--vscode-editor-inactiveSelectionBackground);
  }

  .msg.error .msg-content {
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
    color: var(--vscode-inputValidation-errorForeground);
  }

  /* Blinking cursor while streaming */
  .cursor::after {
    content: "▋";
    animation: blink 0.8s infinite;
  }
  @keyframes blink {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0; }
  }

  #input-area {
    padding: 8px;
    border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
  }

  #input-row {
    display: flex;
    gap: 6px;
    align-items: flex-end;
  }

  #user-input {
    flex: 1;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 4px;
    padding: 6px 10px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    resize: none;
    height: 34px;
    outline: none;
  }
  #user-input:focus { border-color: var(--vscode-focusBorder); }

  #send-btn {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 4px;
    padding: 0 12px;
    height: 34px;
    cursor: pointer;
    font-size: 14px;
  }
  #send-btn:hover   { background: var(--vscode-button-hoverBackground); }
  #send-btn:disabled { opacity: 0.5; cursor: default; }
</style>
</head>
<body>

<div id="header">
  <span>✦ Telivi</span>
  <button id="clear-btn" onclick="clearChat()">Clear</button>
</div>

<div id="messages">
  <div class="msg assistant">
    <span class="msg-label">Telivi</span>
    <div class="msg-content">Hi! I'm Telivi, your AI coding assistant. Ask me anything about your code.</div>
  </div>
</div>

<div id="input-area">
  <div id="input-row">
    <textarea
      id="user-input"
      placeholder="Ask about your code..."
      rows="1"
    ></textarea>
    <button id="send-btn" onclick="sendMessage()">&#x27A4;</button>
  </div>
</div>

<script>
  const vscode   = acquireVsCodeApi();
  const messages = document.getElementById('messages');
  const input    = document.getElementById('user-input');
  const sendBtn  = document.getElementById('send-btn');

  let currentBubble = null;

  // Send on Enter (Shift+Enter for new line)
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  function sendMessage() {
    const text = input.value.trim();
    if (!text) return;

    // Show user message
    appendMessage('user', text);
    input.value = '';
    sendBtn.disabled = true;

    vscode.postMessage({ type: 'chat', text });
  }

  function clearChat() {
    messages.innerHTML = '';
    vscode.postMessage({ type: 'clear' });
  }

  function appendMessage(role, content) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    div.innerHTML =
      '<span class="msg-label">' + (role === 'user' ? 'You' : 'Telivi') + '</span>' +
      '<div class="msg-content">' + escapeHtml(content) + '</div>';
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div.querySelector('.msg-content');
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Handle messages from the extension
  window.addEventListener('message', e => {
    const msg = e.data;

    if (msg.type === 'start') {
      // Create a new assistant bubble for streaming into
      currentBubble = appendMessage('assistant', '');
      currentBubble.classList.add('cursor');
    }

    if (msg.type === 'chunk' && currentBubble) {
      currentBubble.textContent += msg.content;
      messages.scrollTop = messages.scrollHeight;
    }

    if (msg.type === 'done') {
      currentBubble?.classList.remove('cursor');
      currentBubble = null;
      sendBtn.disabled = false;
      input.focus();
    }

    if (msg.type === 'error') {
      const bubble = appendMessage('error', msg.content);
      sendBtn.disabled = false;
    }
  });
</script>
</body>
</html>`;
  }
}