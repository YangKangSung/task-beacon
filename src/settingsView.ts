import * as vscode from 'vscode';
import { getContext } from './extensionContext';
import { AiProvider, PROVIDER_PRESETS, getAiSettings } from './aiConfig';
import { jiraUsername } from './jiraConfig';

const JIRA_PASSWORD_SECRET_KEY = 'taskBeacon.jiraPassword';
const GH_TOKEN_SECRET_KEY = 'taskBeacon.ghToken';
const DEFAULT_JIRA_URL = '';

let panel: vscode.WebviewPanel | undefined;

interface FormState {
  jiraBaseUrl: string;
  jiraUsername: string;
  jiraPassword: string;
  aiProvider: AiProvider;
  aiBaseUrl: string;
  aiApiKey: string;
  aiDefaultModel: string;
  llmWikiRoot: string;
  pythonPath: string;
  grafanaUrl: string;
  autoRefreshSec: number;
  updateCheckEnabled: boolean;
  updateCheckIntervalHours: number;
  ghToken: string;
}

async function readState(): Promise<FormState> {
  const cfg = vscode.workspace.getConfiguration('todoView');
  const ai = getAiSettings();
  const secrets = getContext().secrets;
  return {
    jiraBaseUrl: cfg.get<string>('jiraBaseUrl', DEFAULT_JIRA_URL),
    jiraUsername: jiraUsername(),
    jiraPassword: (await secrets.get(JIRA_PASSWORD_SECRET_KEY)) ?? '',
    aiProvider: ai.provider,
    aiBaseUrl: ai.baseUrl,
    aiApiKey: ai.apiKey,
    aiDefaultModel: ai.defaultModel,
    llmWikiRoot: cfg.get<string>('llmWikiRoot', ''),
    pythonPath: cfg.get<string>('pythonPath', 'python'),
    grafanaUrl: cfg.get<string>('grafanaUrl', ''),
    autoRefreshSec: cfg.get<number>('autoRefreshSec', 0),
    updateCheckEnabled: cfg.get<boolean>('updateCheckEnabled', true),
    updateCheckIntervalHours: cfg.get<number>('updateCheckIntervalHours', 24),
    ghToken: (await secrets.get(GH_TOKEN_SECRET_KEY)) ?? '',
  };
}

async function writeState(next: FormState): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('todoView');
  const target = vscode.ConfigurationTarget.Global;
  const secrets = getContext().secrets;

  await cfg.update('jiraBaseUrl', next.jiraBaseUrl.trim() || DEFAULT_JIRA_URL, target);
  await cfg.update('jiraUsername', next.jiraUsername.trim(), target);
  if (next.jiraPassword) {
    await secrets.store(JIRA_PASSWORD_SECRET_KEY, next.jiraPassword);
  }

  await cfg.update('aiProvider', next.aiProvider, target);
  await cfg.update('aiBaseUrl', next.aiBaseUrl.trim() || PROVIDER_PRESETS[next.aiProvider].baseUrl, target);
  await cfg.update('aiApiKey', next.aiApiKey, target);
  await cfg.update('aiDefaultModel', next.aiDefaultModel.trim(), target);

  await cfg.update('llmWikiRoot', next.llmWikiRoot.trim(), target);
  await cfg.update('pythonPath', next.pythonPath.trim() || 'python', target);
  await cfg.update('grafanaUrl', next.grafanaUrl.trim(), target);
  await cfg.update('autoRefreshSec', next.autoRefreshSec, target);

  await cfg.update('updateCheckEnabled', next.updateCheckEnabled, target);
  await cfg.update('updateCheckIntervalHours', next.updateCheckIntervalHours, target);
  if (next.ghToken) {
    await secrets.store(GH_TOKEN_SECRET_KEY, next.ghToken);
  }
}

export async function openSettingsPanel(): Promise<void> {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'taskBeaconSettings',
    'Task Beacon: Settings',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  panel.onDidDispose(() => {
    panel = undefined;
  });

  wireSettingsWebview(panel.webview);
  panel.webview.html = renderHtml(panel.webview);
  panel.webview.postMessage({ command: 'state', payload: await readState() });
}

/** Sidebar counterpart to `openSettingsPanel` — same read/write state, docked
 * in the Task Beacon activity-bar container instead of a full editor tab. */
export class TodoSettingsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'todoView.settingsSidebar';
  private view: vscode.WebviewView | undefined;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    wireSettingsWebview(webviewView.webview);
    webviewView.webview.html = renderSidebarHtml(webviewView.webview);
    void readState().then((state) => {
      this.view?.webview.postMessage({ command: 'state', payload: state });
    });
  }
}

function wireSettingsWebview(webview: vscode.Webview): void {
  webview.onDidReceiveMessage(async (msg: { command: string; payload?: unknown }) => {
    if (msg.command === 'save') {
      await writeState(msg.payload as FormState);
      vscode.window.setStatusBarMessage('Beacon: settings saved', 2500);
      webview.postMessage({ command: 'saved', payload: await readState() });
    } else if (msg.command === 'requestState') {
      webview.postMessage({ command: 'state', payload: await readState() });
    }
  });
}

const SECTIONS = [
  { id: 'jira', label: 'Jira' },
  { id: 'ai', label: 'AI Provider' },
  { id: 'paths', label: 'Paths' },
  { id: 'update', label: 'Update Check' },
] as const;

function renderHtml(webview: vscode.Webview): string {
  const nonce = getNonce();
  const csp = [
    `default-src 'none'`,
    `style-src 'unsafe-inline' ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  const providerOptions = (Object.keys(PROVIDER_PRESETS) as AiProvider[])
    .map((id) => `<option value="${id}">${esc(PROVIDER_PRESETS[id].label)}</option>`)
    .join('');

  const tabButtons = SECTIONS.map(
    (s, i) => `<button class="tab${i === 0 ? ' active' : ''}" data-tab="${s.id}">${esc(s.label)}</button>`
  ).join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  html, body { margin: 0; padding: 0; height: 100%; font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: var(--vscode-font-size); }
  * { box-sizing: border-box; }
  body { display: flex; flex-direction: column; height: 100vh; }

  .header { display: flex; align-items: baseline; justify-content: space-between; padding: 0.9em 1.4em; border-bottom: 1px solid var(--vscode-widget-border); flex-shrink: 0; }
  .header h1 { font-size: 1.15em; margin: 0; }
  .header .sub { color: var(--vscode-descriptionForeground); font-size: 0.85em; }

  .layout { display: flex; flex: 1; overflow: hidden; }

  .tablist { width: 170px; flex-shrink: 0; display: flex; flex-direction: column; border-right: 1px solid var(--vscode-widget-border); overflow-y: auto; padding: 0.6em 0; }
  .tab { text-align: left; background: transparent; border: none; border-left: 2px solid transparent; color: var(--vscode-foreground); opacity: 0.75; padding: 0.55em 1em; cursor: pointer; font-family: inherit; font-size: 0.92em; }
  .tab:hover { background: color-mix(in srgb, var(--vscode-foreground) 7%, transparent); }
  .tab.active { opacity: 1; border-left-color: var(--vscode-focusBorder); background: color-mix(in srgb, var(--vscode-focusBorder) 10%, transparent); }

  .content { flex: 1; overflow-y: auto; padding: 1.2em 1.6em 2em; }
  .pane { display: none; max-width: 560px; }
  .pane.active { display: block; }

  label { display: block; font-size: 0.9em; color: var(--vscode-descriptionForeground); margin-bottom: 0.3em; margin-top: 0.8em; }
  label:first-of-type { margin-top: 0; }
  input[type="text"], input[type="password"], input[type="number"], select {
    width: 100%; padding: 4px 8px; background: var(--vscode-input-background);
    color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 3px; font-family: inherit; font-size: inherit;
  }
  input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); }
  .hint { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin-top: 0.2em; }
  .row { display: flex; align-items: center; gap: 0.5em; margin-top: 0.8em; }
  .row label { margin: 0; }

  .actions { position: sticky; bottom: 0; background: var(--vscode-editor-background); padding: 0.7em 1.6em; border-top: 1px solid var(--vscode-widget-border); display: flex; align-items: center; gap: 0.8em; flex-shrink: 0; }
  button.save { padding: 5px 14px; border-radius: 3px; border: none; cursor: pointer; font-family: inherit; font-size: inherit; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.save:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button.save:disabled { opacity: 0.5; cursor: default; }
  #savedTag { color: var(--vscode-charts-green, #89d185); font-size: 0.9em; opacity: 0; transition: opacity 0.2s; }
  #dirtyTag { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
</style>
</head>
<body>
  <div class="header">
    <h1>Task Beacon</h1>
    <span class="sub">Settings</span>
  </div>

  <div class="layout">
    <div class="tablist" id="tablist">${tabButtons}</div>

    <div class="content">
      <div class="pane active" data-pane="jira">
        <label for="jiraBaseUrl">Base URL</label>
        <input id="jiraBaseUrl" type="text" placeholder="${esc(DEFAULT_JIRA_URL)}" />
        <label for="jiraUsername">Username</label>
        <input id="jiraUsername" type="text" />
        <label for="jiraPassword">Password</label>
        <input id="jiraPassword" type="password" placeholder="(unchanged if left blank)" />
        <div class="hint">Password stored encrypted via VS Code SecretStorage — never written to settings.json.</div>
      </div>

      <div class="pane" data-pane="ai">
        <label for="aiProvider">Provider</label>
        <select id="aiProvider">${providerOptions}</select>
        <label for="aiBaseUrl">Base URL</label>
        <input id="aiBaseUrl" type="text" />
        <label for="aiApiKey">API Key</label>
        <input id="aiApiKey" type="password" />
        <div class="hint">Grok: key from console.x.ai. Local proxy: use a proxy key, not a cloud secret.</div>
        <label for="aiDefaultModel">Default model</label>
        <input id="aiDefaultModel" type="text" placeholder="e.g. grok-4.6" />
      </div>

      <div class="pane" data-pane="paths">
        <label for="llmWikiRoot">LLMWiki repo root</label>
        <input id="llmWikiRoot" type="text" />
        <label for="pythonPath">Python executable</label>
        <input id="pythonPath" type="text" />
        <label for="grafanaUrl">Grafana URL</label>
        <input id="grafanaUrl" type="text" placeholder="(leave empty to hide)" />
        <label for="autoRefreshSec">Auto-refresh interval (seconds, 0 = disabled)</label>
        <input id="autoRefreshSec" type="number" min="0" />
      </div>

      <div class="pane" data-pane="update">
        <div class="row">
          <input id="updateCheckEnabled" type="checkbox" />
          <label for="updateCheckEnabled" style="margin:0">Enabled</label>
        </div>
        <label for="updateCheckIntervalHours">Check interval (hours)</label>
        <input id="updateCheckIntervalHours" type="number" min="1" />
        <label for="ghToken">GHES personal access token</label>
        <input id="ghToken" type="password" placeholder="(unchanged if left blank)" />
        <div class="hint">repo:read scope — stored encrypted via SecretStorage.</div>
      </div>
    </div>
  </div>

  <div class="actions">
    <button class="save" id="save" disabled>Save</button>
    <span id="dirtyTag">No changes</span>
    <span id="savedTag">Saved ✓</span>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();

  document.getElementById('tablist').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.tab');
    if (!btn) return;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === btn));
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === btn.dataset.tab));
  });

  ${formScript()}
</script>
</body>
</html>`;
}

const FIELD_IDS = [
  'jiraBaseUrl', 'jiraUsername', 'jiraPassword',
  'aiProvider', 'aiBaseUrl', 'aiApiKey', 'aiDefaultModel',
  'llmWikiRoot', 'pythonPath', 'grafanaUrl', 'autoRefreshSec',
  'updateCheckEnabled', 'updateCheckIntervalHours', 'ghToken',
] as const;

/** Shared client-side state machine (collect/apply/dirty-tracking/save) used
 * by both the editor-tab panel and the sidebar view — behavior must stay
 * identical between the two, so this is generated once, not duplicated. */
function formScript(): string {
  return `
  const fieldIds = ${JSON.stringify(FIELD_IDS)};
  const providerPresets = ${JSON.stringify(
    Object.fromEntries(
      (Object.keys(PROVIDER_PRESETS) as AiProvider[]).map((id) => [id, PROVIDER_PRESETS[id].baseUrl])
    )
  )};
  const presetUrls = new Set(Object.values(providerPresets));
  let baseline = null;

  function collect() {
    const v = {};
    for (const id of fieldIds) {
      const el = document.getElementById(id);
      if (el.type === 'checkbox') v[id] = el.checked;
      else if (el.type === 'number') v[id] = Number(el.value) || 0;
      else v[id] = el.value;
    }
    return v;
  }

  function applyState(s) {
    for (const id of fieldIds) {
      const el = document.getElementById(id);
      if (id === 'jiraPassword' || id === 'ghToken') continue; // secrets: never populate the input, blank = unchanged
      if (el.type === 'checkbox') el.checked = !!s[id];
      else el.value = s[id];
    }
  }

  function refreshDirtyState() {
    if (!baseline) return;
    const current = collect();
    const dirty = fieldIds.some((id) => {
      if (id === 'jiraPassword' || id === 'ghToken') return current[id] !== ''; // any typed value counts as a change
      return current[id] !== baseline[id];
    });
    document.getElementById('save').disabled = !dirty;
    document.getElementById('dirtyTag').textContent = dirty ? 'Unsaved changes' : 'No changes';
  }

  for (const id of fieldIds) {
    document.getElementById(id).addEventListener('input', refreshDirtyState);
    document.getElementById(id).addEventListener('change', refreshDirtyState);
  }

  document.getElementById('aiProvider').addEventListener('change', () => {
    const url = document.getElementById('aiBaseUrl');
    if (!url.value || presetUrls.has(url.value)) {
      url.value = providerPresets[document.getElementById('aiProvider').value] || url.value;
    }
    refreshDirtyState();
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.command === 'state' || msg.command === 'saved') {
      applyState(msg.payload);
      baseline = collect();
      refreshDirtyState();
      if (msg.command === 'saved') {
        const tag = document.getElementById('savedTag');
        tag.style.opacity = '1';
        setTimeout(() => { tag.style.opacity = '0'; }, 1800);
      }
    }
  });

  document.getElementById('save').addEventListener('click', () => {
    vscode.postMessage({ command: 'save', payload: collect() });
  });

  vscode.postMessage({ command: 'requestState' });
  `;
}

function renderSidebarHtml(webview: vscode.Webview): string {
  const nonce = getNonce();
  const csp = [
    `default-src 'none'`,
    `style-src 'unsafe-inline' ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  const providerOptions = (Object.keys(PROVIDER_PRESETS) as AiProvider[])
    .map((id) => `<option value="${id}">${esc(PROVIDER_PRESETS[id].label)}</option>`)
    .join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  html, body { margin: 0; padding: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: var(--vscode-font-size); }
  * { box-sizing: border-box; }
  body { padding: 0 0 3.2em; }

  details { border-bottom: 1px solid var(--vscode-widget-border); }
  summary { padding: 0.7em 0.9em; cursor: pointer; font-size: 0.92em; font-weight: 600; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  summary::before { content: '▸'; display: inline-block; width: 1em; opacity: 0.7; }
  details[open] summary::before { content: '▾'; }
  .section-body { padding: 0 0.9em 0.9em; }

  label { display: block; font-size: 0.85em; color: var(--vscode-descriptionForeground); margin-bottom: 0.3em; margin-top: 0.7em; }
  label:first-of-type { margin-top: 0; }
  input[type="text"], input[type="password"], input[type="number"], select {
    width: 100%; padding: 4px 6px; background: var(--vscode-input-background);
    color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 3px; font-family: inherit; font-size: inherit;
  }
  input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); }
  .hint { font-size: 0.76em; color: var(--vscode-descriptionForeground); margin-top: 0.2em; }
  .row { display: flex; align-items: center; gap: 0.5em; margin-top: 0.7em; }
  .row label { margin: 0; }

  .actions { position: fixed; bottom: 0; left: 0; right: 0; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); padding: 0.6em 0.9em; border-top: 1px solid var(--vscode-widget-border); display: flex; align-items: center; gap: 0.7em; }
  button.save { padding: 4px 12px; border-radius: 3px; border: none; cursor: pointer; font-family: inherit; font-size: inherit; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.save:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button.save:disabled { opacity: 0.5; cursor: default; }
  #savedTag { color: var(--vscode-charts-green, #89d185); font-size: 0.85em; opacity: 0; transition: opacity 0.2s; }
  #dirtyTag { color: var(--vscode-descriptionForeground); font-size: 0.8em; }
</style>
</head>
<body>
  <details open>
    <summary>Jira</summary>
    <div class="section-body">
      <label for="jiraBaseUrl">Base URL</label>
      <input id="jiraBaseUrl" type="text" placeholder="${esc(DEFAULT_JIRA_URL)}" />
      <label for="jiraUsername">Username</label>
      <input id="jiraUsername" type="text" />
      <label for="jiraPassword">Password</label>
      <input id="jiraPassword" type="password" placeholder="(unchanged if left blank)" />
      <div class="hint">Stored encrypted via SecretStorage — never written to settings.json.</div>
    </div>
  </details>

  <details>
    <summary>AI Provider</summary>
    <div class="section-body">
      <label for="aiProvider">Provider</label>
      <select id="aiProvider">${providerOptions}</select>
      <label for="aiBaseUrl">Base URL</label>
      <input id="aiBaseUrl" type="text" />
      <label for="aiApiKey">API Key</label>
      <input id="aiApiKey" type="password" />
      <div class="hint">Grok: key from console.x.ai. Local proxy: use a proxy key, not a cloud secret.</div>
      <label for="aiDefaultModel">Default model</label>
      <input id="aiDefaultModel" type="text" placeholder="e.g. grok-4.6" />
    </div>
  </details>

  <details>
    <summary>Paths</summary>
    <div class="section-body">
      <label for="llmWikiRoot">LLMWiki repo root</label>
      <input id="llmWikiRoot" type="text" />
      <label for="pythonPath">Python executable</label>
      <input id="pythonPath" type="text" />
      <label for="grafanaUrl">Grafana URL</label>
      <input id="grafanaUrl" type="text" placeholder="(leave empty to hide)" />
      <label for="autoRefreshSec">Auto-refresh interval (sec, 0 = disabled)</label>
      <input id="autoRefreshSec" type="number" min="0" />
    </div>
  </details>

  <details>
    <summary>Update Check</summary>
    <div class="section-body">
      <div class="row">
        <input id="updateCheckEnabled" type="checkbox" />
        <label for="updateCheckEnabled" style="margin:0">Enabled</label>
      </div>
      <label for="updateCheckIntervalHours">Check interval (hours)</label>
      <input id="updateCheckIntervalHours" type="number" min="1" />
      <label for="ghToken">GHES personal access token</label>
      <input id="ghToken" type="password" placeholder="(unchanged if left blank)" />
      <div class="hint">repo:read scope — stored encrypted via SecretStorage.</div>
    </div>
  </details>

  <div class="actions">
    <button class="save" id="save" disabled>Save</button>
    <span id="dirtyTag">No changes</span>
    <span id="savedTag">Saved ✓</span>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  ${formScript()}
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
