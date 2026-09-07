import * as vscode from 'vscode';

let ctx: vscode.ExtensionContext | undefined;

/** Set once from activate() so modules outside the activation call chain
 * (fetchTodo.ts, jiraConfig.ts) can reach context.secrets without threading
 * ExtensionContext through every function signature. */
export function setContext(context: vscode.ExtensionContext): void {
  ctx = context;
}

export function getContext(): vscode.ExtensionContext {
  if (!ctx) {
    throw new Error('Extension context not initialized — setContext() must run first in activate()');
  }
  return ctx;
}
