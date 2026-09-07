import * as vscode from 'vscode';
import { TodoTreeDataProvider } from './todoProvider';
import { HistoryStore, SnapshotRecord } from './historyStore';

interface SeriesDef {
  label: string;
  color: string;
  get: (r: SnapshotRecord) => number;
}

const OFFICIAL_SERIES: SeriesDef[] = [
  { label: 'Open', color: 'var(--vscode-charts-blue, #3794ff)', get: (r) => r.owners?.official ?? r.jira.total },
  { label: 'Overdue', color: 'var(--vscode-charts-red, #f14c4c)', get: (r) => r.owners?.officialOverdue ?? r.jira.overdue },
];

const PRIVATE_SERIES: SeriesDef[] = [
  { label: 'Open', color: 'var(--vscode-charts-purple, #b180d7)', get: (r) => r.owners?.private ?? r.wiki.active + r.wiki.pending },
];

const AGENT_SERIES: SeriesDef[] = [
  { label: 'Open', color: 'var(--vscode-charts-orange, #d18616)', get: (r) => r.owners?.agent ?? r.cron.active },
  { label: 'Failing', color: 'var(--vscode-charts-red, #f14c4c)', get: (r) => r.owners?.agentFailing ?? r.cron.failing },
];

export class TodoChartViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'todoView.chart';
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly historyStore: HistoryStore,
    private readonly provider: TodoTreeDataProvider
  ) {
    this.provider.onLoaded(() => this.render());
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    this.render();
  }

  refresh(): void {
    this.render();
  }

  private handleMessage(msg: { command: string }): void {
    if (msg.command === 'refresh') {
      this.provider.refresh();
    }
  }

  private render(): void {
    if (!this.view) return;
    const history = this.historyStore.readHistory();
    this.view.webview.html = this.wrapHtml(this.renderBody(history));
  }

  private renderBody(history: SnapshotRecord[]): string {
    if (history.length === 0) {
      return `<p class="empty">No history yet — snapshots accumulate on every refresh from now on.<br/>Trend lines will appear once a few data points exist.</p>`;
    }

    const first = new Date(history[0].ts).toLocaleString();
    const caption = `<p class="caption">${history.length} snapshot${history.length === 1 ? '' : 's'} since ${esc(first)}</p>`;

    if (history.length === 1) {
      return `${caption}<p class="empty">Only one snapshot so far — trend lines need at least two.</p>`;
    }

    return `
      ${caption}
      ${renderChartBlock('Official', history, OFFICIAL_SERIES)}
      ${renderChartBlock('Private', history, PRIVATE_SERIES)}
      ${renderChartBlock('Agent', history, AGENT_SERIES)}
    `;
  }

  private wrapHtml(body: string): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<style>
  html, body { margin: 0; padding: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: var(--vscode-font-size); }
  body { padding: 8px 10px; }
  .caption { margin: 0 0 8px 0; font-size: 0.8em; color: var(--vscode-descriptionForeground); }
  .empty { color: var(--vscode-descriptionForeground); padding: 16px 4px; text-align: center; line-height: 1.6; }
  .chart-block { margin-bottom: 16px; }
  .chart-title { font-size: 0.85em; font-weight: bold; margin-bottom: 4px; color: var(--vscode-foreground); }
  svg { width: 100%; height: auto; display: block; }
  .grid-line { stroke: var(--vscode-widget-border, var(--vscode-panel-border)); stroke-width: 1; }
  .legend { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 4px; font-size: 0.78em; }
  .legend .item { display: flex; align-items: center; gap: 4px; color: var(--vscode-descriptionForeground); }
  .legend .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .axis-label { font-size: 8px; fill: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
${body}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
</script>
</body>
</html>`;
  }
}

function renderChartBlock(title: string, history: SnapshotRecord[], series: SeriesDef[]): string {
  const width = 560;
  const height = 130;
  const pad = 20;

  const minTs = history[0].ts;
  const maxTs = history[history.length - 1].ts;
  const tsSpan = maxTs - minTs || 1;

  let minVal = 0;
  let maxVal = 1;
  for (const s of series) {
    for (const r of history) {
      const v = s.get(r);
      if (v > maxVal) maxVal = v;
      if (v < minVal) minVal = v;
    }
  }
  const valSpan = maxVal - minVal || 1;

  const x = (ts: number) => pad + ((ts - minTs) / tsSpan) * (width - 2 * pad);
  const y = (v: number) => height - pad - ((v - minVal) / valSpan) * (height - 2 * pad);

  const gridLines = [0, 0.5, 1]
    .map((f) => {
      const gy = pad + f * (height - 2 * pad);
      return `<line class="grid-line" x1="${pad}" y1="${gy}" x2="${width - pad}" y2="${gy}" />`;
    })
    .join('');

  const polylines = series
    .map((s) => {
      const points = history.map((r) => `${x(r.ts).toFixed(1)},${y(s.get(r)).toFixed(1)}`).join(' ');
      return `<polyline points="${points}" fill="none" stroke="${s.color}" stroke-width="1.75" />`;
    })
    .join('');

  const maxLabel = `<text class="axis-label" x="${pad}" y="${pad - 4}">${maxVal}</text>`;
  const minLabel = `<text class="axis-label" x="${pad}" y="${height - pad + 10}">${minVal}</text>`;

  const legend = series
    .map((s) => {
      const last = s.get(history[history.length - 1]);
      return `<div class="item"><span class="dot" style="background:${s.color}"></span>${esc(s.label)}: ${last}</div>`;
    })
    .join('');

  return `
    <div class="chart-block">
      <div class="chart-title">${esc(title)}</div>
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
        ${gridLines}
        ${maxLabel}
        ${minLabel}
        ${polylines}
      </svg>
      <div class="legend">${legend}</div>
    </div>
  `;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
