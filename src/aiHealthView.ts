import * as vscode from 'vscode';
import { getAiSettings, LITELLM_MODELS, discoverModels } from './aiConfig';
import { fetchModelHealthMap, ModelHealthStatus } from './aiClient';
import { fetchVllmModelStats, ModelStats } from './grafanaClient';
import { esc, renderGrafanaEmbed } from './panelView';

/** Panel-area sibling to TodoPanelViewProvider — registered in the same
 * `todoViewPanel` viewsContainer so VS Code lays them out side by side,
 * mirroring GitLens's multi-webview panel layout. Right half: AI model
 * registry + health probe, plus the Grafana embed. Single file, no
 * bundler split — same convention as panelView.ts. */
export class TodoAiHealthViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'todoView.panelAiHealth';
  private view: vscode.WebviewView | undefined;
  private health: Map<string, ModelHealthStatus> | undefined;
  private healthError: string | undefined;
  private loading = false;
  private grafanaStats: ModelStats[] | undefined;
  private grafanaLoading = false;
  private grafanaError: string | undefined;

  constructor() {
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('todoView.aiProvider') ||
        e.affectsConfiguration('todoView.aiBaseUrl') ||
        e.affectsConfiguration('todoView.aiApiKey') ||
        e.affectsConfiguration('todoView.aiDefaultModel') ||
        e.affectsConfiguration('todoView.grafanaUrl')
      ) {
        this.refresh();
      }
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    this.render();
    void this.loadHealth();
    void this.loadGrafanaStats();
  }

  refresh(): void {
    this.render();
    void this.loadHealth();
    void this.loadGrafanaStats();
  }

  private handleMessage(msg: { command: string }): void {
    switch (msg.command) {
      case 'refresh':
        this.refresh();
        return;
      case 'selectAiModel':
        vscode.commands.executeCommand('todoView.selectAiModel');
        return;
      case 'openAiSettings':
        vscode.commands.executeCommand('todoView.openSettings');
        return;
    }
  }

  private async loadHealth(): Promise<void> {
    if (!this.view) return;
    const settings = getAiSettings();
    if (settings.provider !== 'litellm') {
      this.health = undefined;
      this.healthError = undefined;
      this.render();
      return;
    }
    this.loading = true;
    this.render();
    try {
      this.health = await fetchModelHealthMap(settings);
      this.healthError = undefined;
    } catch (err) {
      this.health = undefined;
      this.healthError = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async loadGrafanaStats(): Promise<void> {
    if (!this.view) return;
    const url = vscode.workspace.getConfiguration('todoView').get<string>('grafanaUrl', '').trim();
    if (!url) {
      this.grafanaStats = undefined;
      this.grafanaError = undefined;
      this.render();
      return;
    }
    this.grafanaLoading = true;
    this.render();
    try {
      this.grafanaStats = await fetchVllmModelStats(url);
      this.grafanaError = undefined;
    } catch (err) {
      this.grafanaStats = undefined;
      this.grafanaError = err instanceof Error ? err.message : String(err);
    } finally {
      this.grafanaLoading = false;
      this.render();
    }
  }

  private render(): void {
    if (!this.view) return;
    this.view.webview.html = this.wrapHtml(this.renderBody());
  }

  private renderBody(): string {
    const ai = getAiSettings();
    return `
      ${renderHeader(this.loading)}
      ${renderGrafanaEmbed(this.grafanaStats, this.grafanaLoading, this.grafanaError)}
      ${renderModelList(ai.provider, ai.defaultModel, this.health, this.healthError)}
    `;
  }

  private wrapHtml(body: string): string {
    const cspSource = this.view?.webview.cspSource ?? '';
    const csp = [
      `default-src 'none'`,
      `style-src ${cspSource} 'unsafe-inline'`,
      `script-src ${cspSource} 'unsafe-inline'`,
      `img-src ${cspSource} data: http: https:`,
      `font-src ${cspSource}`,
      `connect-src ${cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>${STYLES}</style>
</head>
<body>
${body}
<script>${SCRIPT}</script>
</body>
</html>`;
  }
}

function renderHeader(loading: boolean): string {
  return `
    <div class="hero">
      <div class="hero-row">
        <div class="hero-brand">
          <span class="sigil">✦</span>
          <div class="hero-title">AI Models</div>
        </div>
        <div class="actions">
          <button data-action="refresh">${loading ? 'Checking…' : 'Refresh'}</button>
          <button class="secondary" data-action="openAiSettings">Provider settings…</button>
        </div>
      </div>
    </div>
  `;
}

function statusBadge(status: ModelHealthStatus | undefined): string {
  if (status === 'healthy') return `<span class="badge healthy"><span class="badge-dot"></span>healthy</span>`;
  if (status === 'unhealthy') return `<span class="badge unhealthy"><span class="badge-dot"></span>unhealthy</span>`;
  return `<span class="badge unknown"><span class="badge-dot"></span>unknown</span>`;
}

function renderModelList(
  provider: string,
  defaultModel: string,
  health: Map<string, ModelHealthStatus> | undefined,
  healthError: string | undefined
): string {
  if (provider !== 'litellm') {
    return `
      <div class="section card">
        <div class="section-head"><h3><span class="section-icon">▤</span>Registry</h3></div>
        <p class="empty">Health probe only supported for the LiteLLM provider (current: ${esc(provider)}).</p>
      </div>
    `;
  }

  // Dynamic discovery: whatever the proxy's /model/info reports, plus any
  // statically configured picker entries. Falls back to the static list when
  // the proxy is unreachable (health is undefined).
  const groups = groupModelsByFamily(discoverModels(LITELLM_MODELS, health));

  const groupBlocks = groups.map(({ family, models }) => {
    const rows = models.map((m) => {
      const active = m === defaultModel ? ' active' : '';
      return `
        <div class="row model-row${active}" data-action="selectAiModel">
          <div class="row-body">
            <div class="row-title"><span class="row-summary">${esc(shortenModelId(m, family))}</span></div>
          </div>
          ${statusBadge(health?.get(m))}
        </div>
      `;
    }).join('\n');
    const healthyCount = models.filter((m) => health?.get(m) === 'healthy').length;
    return `
      <div class="model-group">
        <div class="model-group-head">
          <span class="model-group-name">${esc(family)}</span>
          <span class="model-group-count">${healthyCount}/${models.length}</span>
        </div>
        <div class="feed">${rows}</div>
      </div>
    `;
  }).join('\n');

  const errNote = healthError
    ? `<p class="error">Health check failed: ${esc(healthError)}</p>`
    : '';

  const discoveredCount = groups.reduce((n, g) => n + g.models.length, 0);
  const emptyNote = discoveredCount === 0
    ? '<p class="empty">No models discovered. Start your LiteLLM proxy or add entries to LITELLM_MODELS in src/aiConfig.ts.</p>'
    : '';

  return `
    <div class="section card">
      <div class="section-head">
        <h3><span class="section-icon">&#9636;</span>Registry</h3>
        <span class="section-sub">${discoveredCount} models</span>
      </div>
      ${errNote}
      ${emptyNote}
      ${groupBlocks}
    </div>
  `;
}

/** "providerA-model1" -> "providerA", "providerB-foo" -> "providerB" */
function groupModelsByFamily(models: readonly string[]): { family: string; models: string[] }[] {
  const order: string[] = [];
  const buckets = new Map<string, string[]>();
  for (const m of models) {
    const family = m.split('-')[0];
    if (!buckets.has(family)) {
      buckets.set(family, []);
      order.push(family);
    }
    buckets.get(family)!.push(m);
  }
  return order.map((family) => ({ family, models: buckets.get(family)! }));
}

/** Drop the family prefix in the row label since the group header already shows it. */
function shortenModelId(model: string, family: string): string {
  const rest = model.slice(family.length + 1);
  return rest || model;
}

const SCRIPT = `
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      vscode.postMessage({ command: el.dataset.action });
    });
  });
`;

const STYLES = `
  html, body { margin: 0; padding: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: var(--vscode-font-size); background: transparent; }
  body { padding: 10px 14px 20px; }
  .empty { color: var(--vscode-descriptionForeground); }
  .error { color: var(--vscode-errorForeground); font-size: 0.82em; }
  h3 { margin: 0; font-weight: 600; }
  * { box-sizing: border-box; }

  .hero { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); padding-bottom: 10px; margin-bottom: 12px; }
  .hero-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; }
  .hero-brand { display: flex; align-items: center; gap: 7px; }
  .sigil { color: var(--vscode-charts-blue, #3794ff); font-size: 1.15em; }
  .hero-title { font-size: 1em; font-weight: 600; letter-spacing: 0.01em; }
  .actions { display: flex; gap: 6px; }

  .section { margin-bottom: 12px; }
  .section.card { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 6px; padding: 10px 12px; background: color-mix(in srgb, var(--vscode-editor-background, #1e1e1e) 97%, var(--vscode-foreground) 3%); }
  .section-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
  .section-head h3 { display: flex; align-items: center; gap: 6px; font-size: 0.82em; letter-spacing: 0.04em; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
  .section-icon { opacity: 0.75; font-size: 0.95em; }
  .section-sub { font-size: 0.72em; color: var(--vscode-descriptionForeground); }

  .model-group { margin-bottom: 10px; }
  .model-group:last-child { margin-bottom: 0; }
  .model-group-head { display: flex; align-items: center; justify-content: space-between; padding: 3px 2px; margin-bottom: 3px; }
  .model-group-name { font-size: 0.72em; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--vscode-charts-blue, #3794ff); opacity: 0.85; }
  .model-group-count { font-size: 0.68em; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); }

  .feed { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 4px; max-height: 420px; overflow-y: auto; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 10px; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); cursor: pointer; }
  .row:last-child { border-bottom: 0; }
  .row:hover { background: color-mix(in srgb, var(--vscode-foreground) 7%, transparent); }
  .row.active { background: color-mix(in srgb, var(--vscode-focusBorder) 12%, transparent); }
  .row-summary { font-size: 0.9em; font-family: var(--vscode-editor-font-family); }

  .badge { display: inline-flex; align-items: center; gap: 5px; font-size: 0.68em; letter-spacing: 0.04em; text-transform: uppercase; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
  .badge-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; background: var(--vscode-foreground); opacity: 0.4; }
  .badge.healthy { color: var(--vscode-testing-iconPassed, #73c991); }
  .badge.healthy .badge-dot { background: var(--vscode-testing-iconPassed, #73c991); opacity: 1; }
  .badge.unhealthy { color: var(--vscode-errorForeground, #f14c4c); }
  .badge.unhealthy .badge-dot { background: var(--vscode-errorForeground, #f14c4c); opacity: 1; }
  .badge.unknown { color: var(--vscode-descriptionForeground); }

  button { padding: 4px 11px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-radius: 3px; cursor: pointer; font-family: inherit; font-size: 0.85em; transition: background 0.1s ease; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }

  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 0.6em; }
  .stat-card { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 5px; padding: 8px; background: color-mix(in srgb, var(--vscode-editor-background, #1e1e1e) 96%, var(--vscode-foreground) 4%); }
  .stat-card-title { font-size: 0.78em; font-weight: 600; color: var(--vscode-charts-blue, #3794ff); margin-bottom: 6px; word-break: break-word; }

  .metric-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
  .metric-tile { border-radius: 4px; padding: 5px 4px; text-align: center; background: color-mix(in srgb, var(--vscode-charts-green, #89d185) 16%, transparent); }
  .metric-value { font-family: var(--vscode-editor-font-family); font-size: 1.05em; font-weight: 700; line-height: 1.2; }
  .metric-label { font-size: 0.62em; letter-spacing: 0.02em; color: var(--vscode-descriptionForeground); margin-top: 1px; }

  .metric-tile.ok { background: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 16%, transparent); }
  .metric-tile.ok .metric-value { color: var(--vscode-testing-iconPassed, #73c991); }
  .metric-tile.warn { background: color-mix(in srgb, var(--vscode-charts-yellow, #cca700) 20%, transparent); }
  .metric-tile.warn .metric-value { color: var(--vscode-charts-yellow, #cca700); }
  .metric-tile.danger { background: color-mix(in srgb, var(--vscode-errorForeground, #f14c4c) 22%, transparent); }
  .metric-tile.danger .metric-value { color: var(--vscode-errorForeground, #f14c4c); }
`;
