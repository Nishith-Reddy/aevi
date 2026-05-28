import * as vscode from "vscode";

// Fires when the set of routers changes (created, renamed, deleted, or saved).
// Listeners: ChatPanel re-fetches /api/models so the model picker reflects the new router list.
export const onRoutersChanged = new vscode.EventEmitter<void>();

// Fires when the set of available models changes (e.g. user saves provider keys
// or local provider URLs in the chat settings panel).
// Listeners: RoutingPanel re-fetches /api/models so the per-node Model dropdowns refresh.
export const onModelsChanged = new vscode.EventEmitter<void>();