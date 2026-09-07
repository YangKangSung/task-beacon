import * as vscode from 'vscode';
import { TodoTreeDataProvider } from './todoProvider';
import { CronRunsStore, CronRun, JobRuns } from './cronRunsStore';

const MAX_RUNS_SHOWN = 40;
const CHART_WIDTH = 560;
const ROW_HEIGHT = 22;
const BAR_HEIGHT = 12;
const LABEL_WIDTH = 140;

/** Per-job Gantt-style timeline of cron runs. Time axis shared across jobs so
 * bursts, gaps, and current in-flight runs line up vertically. Refreshes on
 * TodoTreeDataProvider.onLoaded and via message from the webview. */
export class CronChartViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'todoView.cronChart';
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly runsStore: CronRunsStore,
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
      this.render();
    }
  }

  private render(): void {
    if (!this.view) return;
    const jobs = this.runsStore.listJobs().filter((j) => j.runs.length > 0);
    this.view.webview.html = this.wrapHtml(this.renderBody(jobs));
  }

  private renderBody(jobs: JobRuns[]): string {
    if (jobs.length === 0) {
      return `<p class="empty">No cron runs found under the Hermes profile cron output directory..</p>`;
    }

    let minTs = Number.POSITIVE_INFINITY;
    let maxTs = 0;
    for (const j of jobs) {
      for (const r of j.runs.slice(-MAX_RUNS_SHOWN)) {
        if (r.startTs < minTs) minTs = r.startTs;
        const end = r.endTs ?? Date.now();
        if (end > maxTs) maxTs = end;
      }
    }
    if (!Number.isFinite(minTs)) return `<p class="empty">No runs to plot.</p>`;
    if (maxTs <= minTs) maxTs = minTs + 60_000;

    const sorted = jobs
      .slice()
      .sort((a, b) => runTail(b).startTs - runTail(a).startTs);

    const rows = sorted
      .map((j, i) => renderRow(j, i, minTs, maxTs, this.runsStore))
      .join('');

    const totalHeight = sorted.length * ROW_HEIGHT + 40;
    const axis = renderAxis(minTs, maxTs, totalHeight);

    const caption = `<p class="caption">${sorted.length} job${sorted.length === 1 ? '' : 's'} · last ${MAX_RUNS_SHOWN} runs each · ${new Date(minTs).toLocaleString()} → ${new Date(maxTs).toLocaleString()}</p>`;

    return `
      ${caption}
      <div class="chart">
        <svg viewBox="0 0 ${CHART_WIDTH} ${totalHeight}" preserveAspectRatio="xMinYMin meet" role="img" aria-label="Cron run timeline">
          ${axis}
          ${rows}
        </svg>
      </div>
      ${renderLegend()}
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
  .caption { margin: 0 0 8px 0; font-size: 0.78em; color: var(--vscode-descriptionForeground); }
  .empty { color: var(--vscode-descriptionForeground); padding: 16px 4px; text-align: center; }
  .chart svg { width: 100%; height: auto; display: block; }
  .label { font-size: 9px; fill: var(--vscode-foreground); }
  .label.sub { fill: var(--vscode-descriptionForeground); }
  .axis { stroke: var(--vscode-widget-border, var(--vscode-panel-border)); stroke-width: 1; }
  .axis-tick { font-size: 8px; fill: var(--vscode-descriptionForeground); }
  .row-bg { fill: transparent; }
  .row-bg:hover { fill: var(--vscode-list-hoverBackground); }
  .run { cursor: default; }
  .run.ok { fill: var(--vscode-charts-green, #89d185); }
  .run.failed { fill: var(--vscode-charts-red, #f14c4c); }
  .run.silent { fill: var(--vscode-charts-yellow, #cca700); }
  .run.running { fill: var(--vscode-charts-blue, #3794ff); }
  .run.unknown { fill: var(--vscode-disabledForeground, #888); }
  .running-pulse { animation: pulse 1.4s ease-in-out infinite; transform-origin: center; }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }
  .legend { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 6px; font-size: 0.78em; color: var(--vscode-descriptionForeground); }
  .legend .item { display: flex; align-items: center; gap: 4px; }
  .legend .swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  .stage { font-size: 0.75em; color: var(--vscode-descriptionForeground); margin-top: 6px; }
  .stage-list { margin: 0; padding-left: 16px; }
  .stage-list li { margin-bottom: 2px; }
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

function runTail(j: JobRuns): CronRun {
  return j.runs[j.runs.length - 1];
}

function renderRow(
  job: JobRuns,
  index: number,
  minTs: number,
  maxTs: number,
  store: CronRunsStore
): string {
  const rowY = 20 + index * ROW_HEIGHT;
  const barY = rowY + (ROW_HEIGHT - BAR_HEIGHT) / 2;
  const span = maxTs - minTs;
  const usable = CHART_WIDTH - LABEL_WIDTH - 8;

  const runs = job.runs.slice(-MAX_RUNS_SHOWN);
  const bars = runs
    .map((r) => {
      const start = r.startTs;
      const end = r.endTs ?? Math.min(Date.now(), maxTs);
      const x = LABEL_WIDTH + ((start - minTs) / span) * usable;
      const w = Math.max(2, ((end - start) / span) * usable);
      const tooltip = buildTooltip(r);
      const pulse = r.status === 'running' ? ' running-pulse' : '';
      return `<rect class="run ${r.status}${pulse}" x="${x.toFixed(1)}" y="${barY}" width="${w.toFixed(1)}" height="${BAR_HEIGHT}" rx="2" ry="2"><title>${esc(tooltip)}</title></rect>`;
    })
    .join('');

  const nameRaw = store.jobName(job.jobId) ?? job.jobId;
  const name = nameRaw.length > 22 ? nameRaw.slice(0, 21) + '…' : nameRaw;
  const tail = runTail(job);
  const sub =
    tail.status === 'running'
      ? 'running…'
      : `${runs.length} · ${tail.status}`;

  return `
    <g>
      <rect class="row-bg" x="0" y="${rowY}" width="${CHART_WIDTH}" height="${ROW_HEIGHT}"><title>${esc(nameRaw)}\n${runs.length} runs shown</title></rect>
      <text class="label" x="4" y="${rowY + 12}">${esc(name)}</text>
      <text class="label sub" x="4" y="${rowY + 21}">${esc(sub)}</text>
      ${bars}
    </g>
  `;
}

function renderAxis(minTs: number, maxTs: number, totalHeight: number): string {
  const span = maxTs - minTs;
  const usable = CHART_WIDTH - LABEL_WIDTH - 8;
  const ticks = 5;
  const parts: string[] = [];
  for (let i = 0; i <= ticks; i++) {
    const t = minTs + (span * i) / ticks;
    const x = LABEL_WIDTH + (usable * i) / ticks;
    parts.push(`<line class="axis" x1="${x.toFixed(1)}" y1="18" x2="${x.toFixed(1)}" y2="${totalHeight - 4}" opacity="0.35" />`);
    parts.push(`<text class="axis-tick" x="${x.toFixed(1)}" y="12" text-anchor="middle">${esc(formatTick(t, span))}</text>`);
  }
  return parts.join('');
}

function formatTick(t: number, span: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (span < 2 * 24 * 3600 * 1000) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function buildTooltip(r: CronRun): string {
  const startStr = new Date(r.startTs).toLocaleString();
  const durStr = r.durationSec
    ? formatDuration(r.durationSec)
    : r.status === 'running'
      ? 'in progress'
      : 'unknown';
  const parts = [`Start: ${startStr}`, `Duration: ${durStr}`, `Status: ${r.status}`];
  if (r.stage) parts.push(`Stage: ${r.stage}`);
  return parts.join('\n');
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

function renderLegend(): string {
  return `<div class="legend">
    <div class="item"><span class="swatch" style="background:var(--vscode-charts-green,#89d185)"></span>ok</div>
    <div class="item"><span class="swatch" style="background:var(--vscode-charts-red,#f14c4c)"></span>failed</div>
    <div class="item"><span class="swatch" style="background:var(--vscode-charts-yellow,#cca700)"></span>silent</div>
    <div class="item"><span class="swatch" style="background:var(--vscode-charts-blue,#3794ff)"></span>running</div>
    <div class="item"><span class="swatch" style="background:var(--vscode-disabledForeground,#888)"></span>unknown</div>
  </div>`;
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
