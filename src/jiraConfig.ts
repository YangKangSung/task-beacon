import * as vscode from 'vscode';
import { getContext } from './extensionContext';

const PASSWORD_SECRET_KEY = 'taskBeacon.jiraPassword';
// No built-in default: configure todoView.jiraBaseUrl for your Jira instance.
const DEFAULT_BASE_URL = '';

function cfg() {
  return vscode.workspace.getConfiguration('todoView');
}

export function jiraBaseUrl(): string {
  const url = cfg().get<string>('jiraBaseUrl', DEFAULT_BASE_URL);
  return url.replace(/\/+$/, '') || DEFAULT_BASE_URL;
}

export function jiraBrowseUrl(key: string): string {
  const base = jiraBaseUrl();
  if (!base) {
    void vscode.window.showWarningMessage(
      `Task Beacon: Jira base URL is not configured. Set 'todoView.jiraBaseUrl' to open ${key}.`
    );
    return '';
  }
  return `${base}/browse/${key}`;
}

export function jiraUsername(): string {
  return cfg().get<string>('jiraUsername', '');
}

export async function jiraPassword(): Promise<string | undefined> {
  return getContext().secrets.get(PASSWORD_SECRET_KEY);
}

/** "user:pass" for show_todo.py's SHOW_TODO_JIRA_AUTH env var, or undefined
 * if either half is unset — callers fall back to show_todo.py's own default
 * built-in default) so an unconfigured install keeps working as before. */
export async function jiraAuthEnv(): Promise<string | undefined> {
  const user = jiraUsername();
  const pass = await jiraPassword();
  if (!user || !pass) return undefined;
  return `${user}:${pass}`;
}
