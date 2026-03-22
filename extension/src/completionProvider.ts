import * as vscode from "vscode";
import { getBackendUrl } from "./extension";

// How long to wait after the user stops typing before sending a request
const DEBOUNCE_MS = 700;

// Debug output channel — shows logs in VS Code Output panel
const output = vscode.window.createOutputChannel("Telivi");

export class CompletionProvider
  implements vscode.InlineCompletionItemProvider
{
  private debounceTimer: NodeJS.Timeout | undefined;

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionList | null> {

    output.appendLine(`[completion] triggered at line ${position.line}`);

    // Check if inline completion is enabled in settings
    const enabled = vscode.workspace
      .getConfiguration("telivi")
      .get<boolean>("enableInlineCompletion", true);
    if (!enabled) {
      output.appendLine("[completion] disabled in settings");
      return null;
    }

    // Only trigger at end of a line — not mid-word
    const lineText = document.lineAt(position.line).text;
    const charAfterCursor = lineText[position.character];
    if (charAfterCursor && charAfterCursor.trim() !== "") {
      output.appendLine("[completion] cursor is mid-word, skipping");
      return null;
    }

    // Don't trigger on very short lines
    const currentLine = lineText.trim();
    if (currentLine.length < 3) {
      output.appendLine("[completion] line too short, skipping");
      return null;
    }

    // Don't trigger on comment lines
    if (currentLine.startsWith("#") || currentLine.startsWith("//")) {
      output.appendLine("[completion] comment line, skipping");
      return null;
    }

    // Wait for the user to stop typing (debounce)
    await this.debounce();

    // If the request was cancelled while waiting, bail out
    if (token.isCancellationRequested) {
      output.appendLine("[completion] cancelled");
      return null;
    }

    // Only send the last 50 lines as prefix (not the whole file)
    const startLine = Math.max(0, position.line - 50);
    const prefix = document.getText(
      new vscode.Range(new vscode.Position(startLine, 0), position)
    );

    // Only send next 10 lines as suffix
    const endLine = Math.min(document.lineCount - 1, position.line + 10);
    const suffix = document.getText(
      new vscode.Range(position, new vscode.Position(endLine, 0))
    );

    const language = document.languageId;

    output.appendLine(`[completion] sending request for language: ${language}`);

    try {
      const res = await fetch(`${getBackendUrl()}/api/complete`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefix, suffix, language }),
      });

      if (!res.ok) {
        output.appendLine(`[completion] backend error: ${res.status}`);
        return null;
      }

      const data = await res.json() as { completion: string };
      const completion = data.completion?.trim();
      output.appendLine(`[completion] got: "${completion}"`);

      if (!completion) return null;

      return {
        items: [
          new vscode.InlineCompletionItem(
            completion,
            new vscode.Range(position, position)
          ),
        ],
      };
    } catch (err) {
      output.appendLine(`[completion] error: ${err}`);
      return null;
    }
  }

  // Waits DEBOUNCE_MS after the last keystroke before firing
  private debounce(): Promise<void> {
    return new Promise((resolve) => {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(resolve, DEBOUNCE_MS);
    });
  }
}