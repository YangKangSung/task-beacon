import * as vscode from 'vscode';
import { TodoTreeDataProvider } from './todoProvider';
import { HistoryStore, SnapshotRecord } from './historyStore';
import { getAiSettings } from './aiConfig';
import { probeHermesXaiLogin } from './hermesXaiAuth';
import { jiraBrowseUrl } from './jiraConfig';
import { summarizeWithAi } from './aiClient';
import { ModelStats } from './grafanaClient';
import { JiraIssue, WikiTask, CronJob, ShowTodoFull, FilterMode } from './types';

interface SeriesDef {
  label: string;
  color: string;
  get: (r: SnapshotRecord) => number;
}

const JIRA_SERIES: SeriesDef[] = [
  { label: 'Total', color: 'var(--vscode-charts-blue, #3794ff)', get: (r) => r.jira.total },
  { label: 'Overdue', color: 'var(--vscode-charts-red, #f14c4c)', get: (r) => r.jira.overdue },
];

const CRON_SERIES: SeriesDef[] = [
  { label: 'Active', color: 'var(--vscode-charts-orange, #d18616)', get: (r) => r.cron.active },
  { label: 'Failing', color: 'var(--vscode-charts-red, #f14c4c)', get: (r) => r.cron.failing },
];

const WIKI_SERIES: SeriesDef[] = [
  { label: 'Active', color: 'var(--vscode-charts-purple, #b180d7)', get: (r) => r.wiki.active },
  { label: 'Pending', color: 'var(--vscode-charts-yellow, #cca700)', get: (r) => r.wiki.pending },
];

const TIMELINE_DAYS = 14;

/** Panel-area (bottom container, alongside Terminal/Output) dashboard —
 * modeled on GitLens's `gitlensPanel` webview. Consolidates the whole
 * Task Beacon signal (Jira/Wiki/Cron) into one wide surface: KPI tiles
 * with sparklines, priority feed with deep-links, upcoming timeline,
 * AI insights, trend charts, model footer. Single file, no bundler split. */
export class TodoPanelViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'todoView.panelDashboard';
  private view: vscode.WebviewView | undefined;
  private lastInsights: { markdown: string; ts: number } | undefined;
  private insightsInFlight = false;
  private searchTerm = '';
  private lastData: ShowTodoFull | undefined;

  constructor(
    private readonly historyStore: HistoryStore,
    private readonly provider: TodoTreeDataProvider
  ) {
    this.provider.onLoaded(() => this.render());
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('todoView.aiProvider') ||
        e.affectsConfiguration('todoView.aiDefaultModel') ||
        e.affectsConfiguration('todoView.grafanaUrl')
      ) {
        this.render();
      }
    });
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

  private handleMessage(msg: {
    command: string;
    value?: string;
    key?: string;
    id?: string;
    file?: string;
  }): void {
    switch (msg.command) {
      case 'refresh':
        this.provider.refresh();
        return;
      case 'openOfficialFilter':
        vscode.commands.executeCommand('todoView.filterOfficial');
        vscode.commands.executeCommand('todoView.focus');
        this.render();
        return;
      case 'openPrivateFilter':
        vscode.commands.executeCommand('todoView.filterPrivate');
        vscode.commands.executeCommand('todoView.focus');
        this.render();
        return;
      case 'openAgentFilter':
        vscode.commands.executeCommand('todoView.filterAgent');
        vscode.commands.executeCommand('todoView.focus');
        this.render();
        return;
      case 'openAllFilter':
        vscode.commands.executeCommand('todoView.filterAll');
        vscode.commands.executeCommand('todoView.focus');
        this.render();
        return;
      case 'selectAiModel':
        vscode.commands.executeCommand('todoView.selectAiModel');
        return;
      case 'openAiSettings':
        vscode.commands.executeCommand('todoView.openSettings');
        return;
      case 'openJiraIssue':
        if (msg.key) {
          vscode.env.openExternal(vscode.Uri.parse(jiraBrowseUrl(msg.key)));
        }
        return;
      case 'openWikiFile':
        if (msg.file) {
          vscode.commands.executeCommand('todoView.openTaskFileByPath', msg.file);
        }
        return;
      case 'openCronScript':
        if (msg.id) {
          vscode.commands.executeCommand('todoView.openCronScriptById', msg.id);
        }
        return;
      case 'search':
        this.searchTerm = (msg.value ?? '').trim().toLowerCase();
        this.postSearchUpdate();
        return;
      case 'requestAiInsights':
        void this.runAiInsights();
        return;
    }
  }

  private render(): void {
    if (!this.view) return;
    const data = this.provider.getData();
    this.lastData = data;
    const history = this.historyStore.readHistory();
    this.view.webview.html = this.wrapHtml(this.renderBody(data, history));
  }

  private postSearchUpdate(): void {
    if (!this.view || !this.lastData) return;
    const feed = renderPriorityFeed(this.lastData, this.searchTerm);
    this.view.webview.postMessage({ command: 'feedUpdate', html: feed });
  }

  private async runAiInsights(): Promise<void> {
    if (!this.view) return;
    if (this.insightsInFlight) return;
    const data = this.lastData;
    if (!data) {
      this.view.webview.postMessage({
        command: 'aiInsightsResult',
        markdown: '_No data loaded yet._',
      });
      return;
    }
    this.insightsInFlight = true;
    this.view.webview.postMessage({ command: 'aiInsightsLoading' });
    try {
      const settings = getAiSettings();
      const context = buildInsightsContext(data);
      const markdown = await summarizeWithAi(settings, 'insights', context);
      this.lastInsights = { markdown, ts: Date.now() };
      this.view.webview.postMessage({ command: 'aiInsightsResult', markdown });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view.webview.postMessage({
        command: 'aiInsightsResult',
        markdown: `**AI request failed:** ${message}`,
      });
    } finally {
      this.insightsInFlight = false;
    }
  }

  private renderBody(data: ShowTodoFull | undefined, history: SnapshotRecord[]): string {
    if (!data) {
      return `
        <div class="hero">
          <div class="hero-title">Task Beacon</div>
          <div class="hero-sub empty">No data loaded yet.</div>
          <div class="actions">
            <button data-action="refresh">Refresh</button>
          </div>
        </div>
      `;
    }
    const ai = getAiSettings();
    const cachedInsights = this.lastInsights
      ? { markdown: this.lastInsights.markdown, ts: this.lastInsights.ts }
      : undefined;

    return `
      ${renderHero(data)}
      ${renderKpiTiles(data, history)}
      ${renderFilterBar(this.searchTerm, this.provider.getFilter())}
      ${renderPriorityFeed(data, this.searchTerm)}
      ${renderTimeline(data)}
      ${renderAiInsights(ai.defaultModel, cachedInsights)}
      ${renderTrendCharts(history)}
      ${renderFooter(ai)}
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

//
// ── Section renderers ─────────────────────────────────────────────
//

function renderHero(data: ShowTodoFull): string {
  const failedChannels = [
    !data.jira.ok && 'Official',
    !data.wiki.ok && 'Private',
    !data.cron.ok && 'Automated',
  ].filter((c): c is string => !!c);
  const now = new Date();
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const health = failedChannels.length
    ? `<span class="hero-health err">⚠ ${failedChannels.length} channel${failedChannels.length > 1 ? 's' : ''} down</span>`
    : `<span class="hero-health ok">● all channels healthy</span>`;
  return `
    <div class="hero">
      <div class="hero-row">
        <div class="hero-brand">
          <span class="sigil">◈</span>
          <span class="hero-title">Task Beacon</span>
          <span class="hero-version">v0.9.9</span>
        </div>
        <div class="hero-meta">
          ${health}
          <span class="hero-stamp">${esc(stamp)}</span>
          <button class="icon-btn" data-action="refresh" title="Refresh all channels">↻</button>
        </div>
      </div>
    </div>
  `;
}

function renderKpiTiles(data: ShowTodoFull, history: SnapshotRecord[]): string {
  const jiraTotal = data.jira.ok ? data.jira.total : 0;
  const jiraOverdue = data.jira.ok
    ? data.jira.in_progress.concat(data.jira.to_do).filter((i) => isOverdue(i.due)).length
    : 0;
  const jiraInProg = data.jira.ok ? data.jira.in_progress.length : 0;
  const wikiActive = data.wiki.ok ? data.wiki.active.length : 0;
  const wikiPending = data.wiki.ok ? data.wiki.pending.length : 0;
  const wikiDone = data.wiki.ok ? data.wiki.completed.length : 0;
  const cronActive = data.cron.ok ? data.cron.jobs.filter((j) => j.state === 'active').length : 0;
  const cronFailing = data.cron.ok
    ? data.cron.jobs.filter((j) => isFail(j.last_status)).length
    : 0;
  const cronTotal = data.cron.ok ? data.cron.jobs.length : 0;

  const jiraSpark = sparkline(history.slice(-30).map((r) => r.jira.total), 'var(--vscode-charts-blue, #3794ff)');
  const jiraOverdueSpark = sparkline(
    history.slice(-30).map((r) => r.jira.overdue),
    'var(--vscode-charts-red, #f14c4c)'
  );
  const wikiSpark = sparkline(
    history.slice(-30).map((r) => r.wiki.active + r.wiki.pending),
    'var(--vscode-charts-purple, #b180d7)'
  );
  const cronSpark = sparkline(
    history.slice(-30).map((r) => r.cron.active),
    'var(--vscode-charts-orange, #d18616)'
  );

  return `
    <div class="kpi-grid">
      <div class="kpi" data-action="openOfficialFilter">
        <div class="kpi-head">
          <span class="kpi-label">JIRA</span>
          <span class="kpi-tag"><span class="kpi-dot jira"></span>Official</span>
        </div>
        <div class="kpi-value">${jiraTotal}</div>
        <div class="kpi-sub">${jiraInProg} in-progress · ${data.jira.ok ? data.jira.to_do.length : 0} to-do</div>
        ${jiraOverdue ? `<div class="kpi-alert">⚠ ${jiraOverdue} overdue</div>` : `<div class="kpi-sub-thin">no overdue</div>`}
        <div class="kpi-spark">${jiraSpark}</div>
        <div class="kpi-spark-sub">${jiraOverdueSpark}</div>
      </div>
      <div class="kpi" data-action="openPrivateFilter">
        <div class="kpi-head">
          <span class="kpi-label">WIKI</span>
          <span class="kpi-tag"><span class="kpi-dot wiki"></span>Private</span>
        </div>
        <div class="kpi-value">${wikiActive + wikiPending}</div>
        <div class="kpi-sub">${wikiActive} active · ${wikiPending} pending</div>
        <div class="kpi-sub-thin">${wikiDone} completed lifetime</div>
        <div class="kpi-spark">${wikiSpark}</div>
      </div>
      <div class="kpi" data-action="openAgentFilter">
        <div class="kpi-head">
          <span class="kpi-label">CRON</span>
          <span class="kpi-tag"><span class="kpi-dot cron"></span>Agent</span>
        </div>
        <div class="kpi-value">${cronActive}</div>
        <div class="kpi-sub">${cronActive}/${cronTotal} scheduled</div>
        ${cronFailing ? `<div class="kpi-alert">⚠ ${cronFailing} failing</div>` : `<div class="kpi-sub-thin">no failures</div>`}
        <div class="kpi-spark">${cronSpark}</div>
      </div>
    </div>
  `;
}

function renderFilterBar(searchTerm: string, activeFilter: FilterMode): string {
  const active = (mode: FilterMode) => (mode === activeFilter ? ' active' : '');
  return `
    <div class="filter-bar">
      <div class="filter-chips">
        <button class="chip${active('all')}" data-action="openAllFilter" title="Sidebar filter: all">All</button>
        <button class="chip jira${active('official')}" data-action="openOfficialFilter" title="Sidebar filter: Official">Official</button>
        <button class="chip wiki${active('private')}" data-action="openPrivateFilter" title="Sidebar filter: Private">Private</button>
        <button class="chip cron${active('agent')}" data-action="openAgentFilter" title="Sidebar filter: Agent">Agent</button>
      </div>
      <input type="text" id="feed-search" class="search-input" placeholder="Search feed…" value="${esc(searchTerm)}" />
    </div>
  `;
}

interface FeedRow {
  kind: 'jira' | 'wiki' | 'cron';
  priority: number;
  key: string;
  title: string;
  status: string;
  meta: string;
  action: string;
  actionKey: string;
  epicKey?: string;
  alert?: string;
}

function collectFeedRows(data: ShowTodoFull): FeedRow[] {
  const rows: FeedRow[] = [];
  const today = startOfToday();

  if (data.jira.ok) {
    for (const iss of data.jira.in_progress) {
      const overdue = isOverdue(iss.due);
      rows.push({
        kind: 'jira',
        priority: overdue ? 100 : 60,
        key: iss.key,
        title: iss.summary,
        status: iss.status,
        meta: `${iss.priority} · ${iss.epic_key ? 'epic ' + iss.epic_key + ' · ' : ''}due ${iss.due ?? '—'}`,
        action: 'openJiraIssue',
        actionKey: iss.key,
        epicKey: iss.epic_key ?? undefined,
        alert: overdue ? `overdue ${daysDelta(iss.due, today)}d` : undefined,
      });
    }
    for (const iss of data.jira.to_do) {
      const overdue = isOverdue(iss.due);
      rows.push({
        kind: 'jira',
        priority: overdue ? 90 : 30,
        key: iss.key,
        title: iss.summary,
        status: iss.status,
        meta: `${iss.priority} · ${iss.epic_key ? 'epic ' + iss.epic_key + ' · ' : ''}due ${iss.due ?? '—'}`,
        action: 'openJiraIssue',
        actionKey: iss.key,
        epicKey: iss.epic_key ?? undefined,
        alert: overdue ? `overdue ${daysDelta(iss.due, today)}d` : undefined,
      });
    }
  }
  if (data.wiki.ok) {
    for (const t of data.wiki.active) {
      rows.push({
        kind: 'wiki',
        priority: 55,
        key: t.file,
        title: t.title,
        status: 'active',
        meta: t.note ? truncate(t.note, 80) : t.file,
        action: 'openWikiFile',
        actionKey: t.file,
        epicKey: t.epicKey,
      });
    }
    for (const t of data.wiki.pending) {
      rows.push({
        kind: 'wiki',
        priority: 25,
        key: t.file,
        title: t.title,
        status: 'pending',
        meta: t.note ? truncate(t.note, 80) : t.file,
        action: 'openWikiFile',
        actionKey: t.file,
        epicKey: t.epicKey,
      });
    }
  }
  if (data.cron.ok) {
    for (const j of data.cron.jobs) {
      const failing = isFail(j.last_status);
      if (!failing && j.state !== 'active') continue;
      rows.push({
        kind: 'cron',
        priority: failing ? 95 : 40,
        key: j.id,
        title: j.name,
        status: j.state,
        meta: `${j.schedule} · last ${j.last_status} · next ${j.next_run ?? '—'}`,
        action: 'openCronScript',
        actionKey: j.id,
        alert: failing ? `last run ${j.last_status}` : undefined,
      });
    }
  }
  rows.sort((a, b) => b.priority - a.priority);
  return rows;
}

function renderPriorityFeed(data: ShowTodoFull, searchTerm: string): string {
  const rows = collectFeedRows(data);
  const term = searchTerm.trim().toLowerCase();
  const filtered = term
    ? rows.filter(
        (r) =>
          r.title.toLowerCase().includes(term) ||
          r.key.toLowerCase().includes(term) ||
          r.status.toLowerCase().includes(term) ||
          (r.epicKey ?? '').toLowerCase().includes(term)
      )
    : rows;

  if (filtered.length === 0) {
    return `
      <div class="section card" id="feed-section">
        <div class="section-head">
          <h3><span class="section-icon">◆</span>Priority feed</h3>
          <span class="section-sub" id="feed-count">0 items${term ? ` (search: ${esc(term)})` : ''}</span>
        </div>
        <div class="feed empty">Nothing matches.</div>
      </div>
    `;
  }

  const items = filtered.map(renderFeedRow).join('');
  return `
    <div class="section card" id="feed-section">
      <div class="section-head">
        <h3><span class="section-icon">◆</span>Priority feed</h3>
        <span class="section-sub" id="feed-count">${filtered.length} items${term ? ` (search: ${esc(term)})` : ''}</span>
      </div>
      <div class="feed" id="feed-list">${items}</div>
    </div>
  `;
}

function renderFeedRow(r: FeedRow): string {
  const icon = r.kind === 'jira' ? '🔷' : r.kind === 'wiki' ? '📝' : '⚙';
  const alert = r.alert
    ? `<span class="row-alert">${esc(r.alert)}</span>`
    : '';
  return `
    <div class="row row-${r.kind}" data-action="${r.action}" data-key="${esc(r.actionKey)}" data-id="${esc(r.actionKey)}" data-file="${esc(r.actionKey)}">
      <span class="row-icon">${icon}</span>
      <div class="row-body">
        <div class="row-title">
          <span class="row-key">${esc(r.key)}</span>
          <span class="row-summary">${esc(r.title)}</span>
        </div>
        <div class="row-meta">
          <span class="row-status status-${esc(r.status)}">${esc(r.status)}</span>
          <span class="row-sub">${esc(r.meta)}</span>
          ${alert}
        </div>
      </div>
    </div>
  `;
}

function renderTimeline(data: ShowTodoFull): string {
  const today = startOfToday();
  const days: { label: string; ts: number; entries: string[]; danger: boolean }[] = [];
  for (let i = -1; i < TIMELINE_DAYS; i++) {
    const ts = today + i * 86400000;
    const d = new Date(ts);
    days.push({
      label: `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`,
      ts,
      entries: [],
      danger: i < 0,
    });
  }
  const overdueBucket: string[] = [];

  if (data.jira.ok) {
    for (const iss of data.jira.in_progress.concat(data.jira.to_do)) {
      if (!iss.due) continue;
      const parsed = Date.parse(iss.due);
      if (Number.isNaN(parsed)) continue;
      const d = new Date(parsed);
      const dayTs = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      if (dayTs < today) {
        overdueBucket.push(`${iss.key} · ${iss.summary}`);
        continue;
      }
      const bucket = days.find((b) => b.ts === dayTs);
      if (bucket) {
        bucket.entries.push(`${iss.key}: ${iss.summary}`);
      }
    }
  }
  if (data.cron.ok) {
    for (const j of data.cron.jobs) {
      if (!j.next_run) continue;
      const parsed = Date.parse(j.next_run);
      if (Number.isNaN(parsed)) continue;
      const d = new Date(parsed);
      const dayTs = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      const bucket = days.find((b) => b.ts === dayTs);
      if (bucket) {
        bucket.entries.push(`⚙ ${j.name}`);
      }
    }
  }

  const cells = days
    .map((day) => {
      const count = day.entries.length;
      const heat = count >= 3 ? 'heat-hot' : count >= 1 ? 'heat-warm' : 'heat-cold';
      const isToday = day.ts === today ? ' cell-today' : '';
      const tooltip = day.entries.length ? day.entries.join('\n') : 'no due items';
      return `
        <div class="cell ${heat}${isToday}" title="${esc(tooltip)}">
          <div class="cell-label">${day.label}</div>
          <div class="cell-count">${count || ''}</div>
        </div>
      `;
    })
    .join('');

  const overdueSummary = overdueBucket.length
    ? `<div class="timeline-overdue">⚠ ${overdueBucket.length} overdue: ${esc(overdueBucket.slice(0, 3).join(' · '))}${overdueBucket.length > 3 ? ' …' : ''}</div>`
    : '';

  return `
    <div class="section card">
      <div class="section-head">
        <h3><span class="section-icon">◷</span>Upcoming ${TIMELINE_DAYS} days</h3>
        <span class="section-sub">Official due · Automated next-run</span>
      </div>
      <div class="timeline">${cells}</div>
      ${overdueSummary}
    </div>
  `;
}

function renderAiInsights(
  model: string,
  cached: { markdown: string; ts: number } | undefined
): string {
  const body = cached
    ? `<div class="ai-body">${escMd(cached.markdown)}</div>
       <div class="ai-stamp">generated ${new Date(cached.ts).toLocaleString()}</div>`
    : `<div class="ai-body empty">Click <b>Generate</b> to ask ${esc(model)} for a tactical digest.</div>`;
  return `
    <div class="section card">
      <div class="section-head">
        <h3><span class="section-icon">✦</span>AI Insights</h3>
        <span class="section-sub">${esc(model)}</span>
      </div>
      <div class="ai-actions">
        <button data-action="requestAiInsights">${cached ? 'Regenerate' : 'Generate'}</button>
        <button class="secondary" data-action="selectAiModel">Change model…</button>
      </div>
      <div id="ai-content">${body}</div>
    </div>
  `;
}

function renderTrendCharts(history: SnapshotRecord[]): string {
  if (history.length < 2) {
    return `
      <div class="section card">
        <div class="section-head"><h3><span class="section-icon">📈</span>Trends</h3></div>
        <p class="empty">Not enough history yet — trend lines appear after a few refreshes.</p>
      </div>
    `;
  }
  return `
    <div class="section card">
      <div class="section-head">
        <h3><span class="section-icon">📈</span>Trends</h3>
        <span class="section-sub">${history.length} snapshots</span>
      </div>
      <div class="charts">
        ${renderChartBlock('Official', history, JIRA_SERIES)}
        ${renderChartBlock('Private', history, WIKI_SERIES)}
        ${renderChartBlock('Automated', history, CRON_SERIES)}
      </div>
    </div>
  `;
}

/** Renders vLLM per-model stat cards from data fetched via
 * grafanaClient.fetchVllmModelStats (Prometheus datasource-proxy query,
 * client-side). Grafana's image-renderer plugin isn't installed on this
 * server (not user-administered) and the configured panelIds are
 * non-renderable "row" section headers, so server-side PNG embedding
 * (the previous approach) never worked — this replaces it entirely. */
export function renderGrafanaEmbed(
  stats: ModelStats[] | undefined,
  loading: boolean,
  error: string | undefined
): string {
  const cfg = vscode.workspace.getConfiguration('todoView');
  const url = cfg.get<string>('grafanaUrl', '').trim();
  if (!url) return '';

  if (error) {
    return `
      <div class="section card">
        <div class="section-head"><h3><span class="section-icon">▦</span>vLLM Metrics</h3></div>
        <p class="error">Grafana query failed: ${esc(error)}</p>
      </div>
    `;
  }
  if (loading && !stats) {
    return `
      <div class="section card">
        <div class="section-head"><h3><span class="section-icon">▦</span>vLLM Metrics</h3></div>
        <p class="empty">Loading…</p>
      </div>
    `;
  }
  const visible = (stats ?? []).filter((s) => !/qwen|gemma/i.test(s.model));
  if (!visible.length) return '';

  const cards = visible.map((s) => renderModelStatCard(s)).join('\n');

  return `
    <div class="section card">
      <div class="section-head"><h3><span class="section-icon">▦</span>vLLM Metrics</h3></div>
      <div class="stat-grid">${cards}</div>
    </div>
  `;
}

function renderModelStatCard(s: ModelStats): string {
  const shortName = s.model.replace(/^hosted_vllm\//, '');
  const tile = (label: string, value: string, level: 'ok' | 'warn' | 'danger') => `
    <div class="metric-tile ${level}">
      <div class="metric-value">${value}</div>
      <div class="metric-label">${label}</div>
    </div>
  `;
  return `
    <div class="stat-card">
      <div class="stat-card-title">${esc(shortName)}</div>
      <div class="metric-grid">
        ${tile('Running', `${s.running}`, 'ok')}
        ${tile('Queue', `${s.queue}`, level(s.queue, 3, 10))}
        ${tile('KV Cache', `${s.kvCachePct.toFixed(1)}%`, level(s.kvCachePct, 70, 90))}
        ${tile('Requests 1h', s.requests1h.toFixed(0), 'ok')}
        ${tile('Prompt tok/s', s.promptTokensPerSec.toFixed(0), 'ok')}
        ${tile('Gen tok/s', s.genTokensPerSec.toFixed(0), 'ok')}
        ${tile('Queue p99', formatSeconds(s.queueLatencyP99), level(s.queueLatencyP99, 1, 5))}
        ${tile('Prefill p99', formatSeconds(s.prefillP99), level(s.prefillP99, 2, 8))}
        ${tile('Decode p99', formatSeconds(s.decodeP99), level(s.decodeP99, 0.5, 2))}
      </div>
    </div>
  `;
}

/** NaN happens when Prometheus has no samples for that dimension (e.g. no recent
 * requests) — histogram_quantile returns NaN rather than 0 in that case. */
function level(v: number, warnAt: number, dangerAt: number): 'ok' | 'warn' | 'danger' {
  if (Number.isNaN(v)) return 'ok';
  return v >= dangerAt ? 'danger' : v >= warnAt ? 'warn' : 'ok';
}

function formatSeconds(v: number): string {
  if (Number.isNaN(v)) return '—';
  return v < 1 ? `${(v * 1000).toFixed(0)}ms` : `${v.toFixed(2)}s`;
}

function renderFooter(ai: ReturnType<typeof getAiSettings>): string {
  const login = ai.provider === 'xai' ? probeHermesXaiLogin() : undefined;
  const authHint =
    login?.state === 'ok'
      ? ' · Hermes login'
      : login?.state === 'expired'
        ? ' · login expired'
        : login?.state === 'missing'
          ? ' · not logged in'
          : '';
  return `
    <div class="footer">
      <span class="ai-model" data-action="selectAiModel" title="Click to change default model">
        <span class="ai-model-dot"></span><b>${esc(ai.defaultModel)}</b> <span class="ai-provider">(${esc(ai.provider)}${esc(authHint)})</span>
      </span>
      <span class="footer-actions">
        <button class="icon-btn" data-action="openAiSettings" title="AI provider settings">⚙</button>
      </span>
    </div>
  `;
}

//
// ── Charting ──────────────────────────────────────────────────────
//

function renderChartBlock(title: string, history: SnapshotRecord[], series: SeriesDef[]): string {
  const width = 560;
  const height = 90;
  const pad = 18;

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

  const x = (ts: number): number => pad + ((ts - minTs) / tsSpan) * (width - 2 * pad);
  const y = (v: number): number => height - pad - ((v - minVal) / valSpan) * (height - 2 * pad);

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
        ${polylines}
      </svg>
      <div class="legend">${legend}</div>
    </div>
  `;
}

function sparkline(values: number[], color: string): string {
  if (values.length < 2) {
    return `<svg viewBox="0 0 100 24" preserveAspectRatio="none"></svg>`;
  }
  const width = 100;
  const height = 24;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  const dx = width / (values.length - 1);
  const points = values
    .map((v, i) => `${(i * dx).toFixed(1)},${(height - ((v - min) / span) * (height - 2) - 1).toFixed(1)}`)
    .join(' ');
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" />
  </svg>`;
}

//
// ── AI insights payload ───────────────────────────────────────────
//

function buildInsightsContext(data: ShowTodoFull): string {
  const parts: string[] = [];
  const today = startOfToday();

  if (data.jira.ok) {
    parts.push('## JIRA — In Progress');
    parts.push(...formatJira(data.jira.in_progress, today));
    parts.push('## JIRA — To Do');
    parts.push(...formatJira(data.jira.to_do, today));
  } else {
    parts.push(`## JIRA — fetch failed: ${data.jira.error ?? 'unknown'}`);
  }
  if (data.wiki.ok) {
    parts.push('## LLMWiki — Active');
    parts.push(...formatWiki(data.wiki.active));
    parts.push('## LLMWiki — Pending');
    parts.push(...formatWiki(data.wiki.pending));
  } else {
    parts.push(`## LLMWiki — fetch failed: ${data.wiki.error ?? 'unknown'}`);
  }
  if (data.cron.ok) {
    parts.push('## Cron — Active');
    parts.push(...formatCron(data.cron.jobs.filter((j) => j.state === 'active')));
    parts.push('## Cron — Failing');
    parts.push(...formatCron(data.cron.jobs.filter((j) => isFail(j.last_status))));
  } else {
    parts.push(`## Cron — fetch failed: ${data.cron.error ?? 'unknown'}`);
  }
  return parts.filter(Boolean).join('\n');
}

function formatJira(items: JiraIssue[], today: number): string[] {
  if (items.length === 0) return ['(none)'];
  return items.slice(0, 20).map((i) => {
    const flag = isOverdue(i.due) ? ' [OVERDUE]' : '';
    const daysOverdue = isOverdue(i.due) ? ` ${daysDelta(i.due, today)}d late` : '';
    return `- ${i.key} [${i.priority}${flag}${daysOverdue}] ${i.summary} — status ${i.status}, due ${i.due ?? '—'}${i.epic_key ? `, epic ${i.epic_key}` : ''}`;
  });
}

function formatWiki(items: WikiTask[]): string[] {
  if (items.length === 0) return ['(none)'];
  return items.slice(0, 20).map((t) => {
    // Category badge added 2026-07-25 (4-category classification system)
    const catBadge = t.category ? `[${t.category}] ` : '';
    return `- ${catBadge}${t.title}${t.epicKey ? ` (epic ${t.epicKey})` : ''} — ${t.note || t.file}`;
  });
}

function formatCron(items: CronJob[]): string[] {
  if (items.length === 0) return ['(none)'];
  return items.slice(0, 20).map(
    (j) =>
      `- ${j.name} [${j.state}] schedule ${j.schedule}, last ${j.last_status} @ ${j.last_run ?? '—'}, next ${j.next_run ?? '—'}`
  );
}

//
// ── Utility ───────────────────────────────────────────────────────
//

function isOverdue(due: string | null): boolean {
  if (!due) return false;
  const d = Date.parse(due);
  return !Number.isNaN(d) && d < startOfToday();
}

function startOfToday(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function isFail(status: string): boolean {
  const s = (status || '').toLowerCase();
  return s === 'failed' || s === 'error' || s === 'fail';
}

function daysDelta(due: string | null, today: number): number {
  if (!due) return 0;
  const d = Date.parse(due);
  if (Number.isNaN(d)) return 0;
  return Math.floor((today - d) / 86400000);
}

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Extremely minimal markdown → HTML: bold, italic, inline code, bullets, headers.
 * The AI insights prompt is constrained to markdown bullets + bold headers, so
 * we only need the small subset — no need for a full parser dep. */
function escMd(md: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inList = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line) {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      out.push('');
      continue;
    }
    const bulletMatch = line.match(/^\s*[-*]\s+(.*)$/);
    if (bulletMatch) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inlineMd(bulletMatch[1])}</li>`);
      continue;
    }
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
    const h3 = line.match(/^###\s+(.*)$/);
    const h2 = line.match(/^##\s+(.*)$/);
    if (h3) {
      out.push(`<h4>${inlineMd(h3[1])}</h4>`);
    } else if (h2) {
      out.push(`<h3>${inlineMd(h2[1])}</h3>`);
    } else {
      out.push(`<p>${inlineMd(line)}</p>`);
    }
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}

function inlineMd(s: string): string {
  const escaped = esc(s);
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*\s][^*]*[^*\s]|\S)\*(?!\*)/g, '<em>$1</em>');
}

//
// ── Client-side script + styles ───────────────────────────────────
//

const SCRIPT = `
  const vscode = acquireVsCodeApi();
  function bindActions(root) {
    root.querySelectorAll('[data-action]').forEach((el) => {
      if (el.dataset.bound === '1') return;
      el.dataset.bound = '1';
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const payload = { command: el.dataset.action };
        if (el.dataset.key) payload.key = el.dataset.key;
        if (el.dataset.id) payload.id = el.dataset.id;
        if (el.dataset.file) payload.file = el.dataset.file;
        vscode.postMessage(payload);
      });
    });
  }
  bindActions(document);

  const searchInput = document.getElementById('feed-search');
  if (searchInput) {
    let timer;
    searchInput.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        vscode.postMessage({ command: 'search', value: searchInput.value });
      }, 150);
    });
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg) return;
    if (msg.command === 'feedUpdate') {
      const section = document.getElementById('feed-section');
      if (section) {
        section.outerHTML = msg.html;
        const fresh = document.getElementById('feed-section');
        if (fresh) bindActions(fresh);
      }
    } else if (msg.command === 'aiInsightsLoading') {
      const c = document.getElementById('ai-content');
      if (c) c.innerHTML = '<div class="ai-body empty">Thinking…</div>';
    } else if (msg.command === 'aiInsightsResult') {
      const c = document.getElementById('ai-content');
      if (c) {
        const stamp = new Date().toLocaleString();
        c.innerHTML = '<div class="ai-body">' + renderMarkdown(msg.markdown) + '</div>' +
          '<div class="ai-stamp">generated ' + stamp + '</div>';
      }
    }
  });

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function inlineMd(s) {
    return esc(s)
      .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
      .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  }
  function renderMarkdown(md) {
    const lines = md.split(/\\r?\\n/);
    let out = '';
    let inList = false;
    for (const raw of lines) {
      const line = raw.replace(/\\s+$/, '');
      if (!line) { if (inList) { out += '</ul>'; inList = false; } continue; }
      const bm = line.match(/^\\s*[-*]\\s+(.*)$/);
      if (bm) {
        if (!inList) { out += '<ul>'; inList = true; }
        out += '<li>' + inlineMd(bm[1]) + '</li>';
        continue;
      }
      if (inList) { out += '</ul>'; inList = false; }
      const h3 = line.match(/^###\\s+(.*)$/);
      const h2 = line.match(/^##\\s+(.*)$/);
      if (h3) out += '<h4>' + inlineMd(h3[1]) + '</h4>';
      else if (h2) out += '<h3>' + inlineMd(h2[1]) + '</h3>';
      else out += '<p>' + inlineMd(line) + '</p>';
    }
    if (inList) out += '</ul>';
    return out;
  }
`;

const STYLES = `
  html, body { margin: 0; padding: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: var(--vscode-font-size); background: transparent; }
  body { padding: 10px 14px 20px; }
  .empty { color: var(--vscode-descriptionForeground); }
  h3, h4 { margin: 0; font-weight: 600; }
  * { box-sizing: border-box; }

  /* Hero */
  .hero { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 10px; margin-bottom: 12px; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
  .hero-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; }
  .hero-brand { display: flex; align-items: center; gap: 7px; }
  .sigil { color: var(--vscode-charts-blue, #3794ff); font-size: 1.15em; }
  .hero-title { font-size: 1em; font-weight: 600; letter-spacing: 0.01em; }
  .hero-version { font-size: 0.68em; color: var(--vscode-descriptionForeground); background: color-mix(in srgb, var(--vscode-foreground) 7%, transparent); padding: 1px 6px; border-radius: 8px; }
  .hero-meta { display: flex; align-items: center; gap: 10px; font-size: 0.76em; color: var(--vscode-descriptionForeground); }
  .hero-health { display: flex; align-items: center; gap: 4px; }
  .hero-health.ok { color: var(--vscode-testing-iconPassed, #73c991); }
  .hero-health.err { color: var(--vscode-errorForeground); }
  .hero-stamp { font-family: var(--vscode-editor-font-family); opacity: 0.8; }

  /* KPI */
  .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin-bottom: 12px; }
  .kpi { position: relative; padding: 10px 12px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 6px; cursor: pointer; background: color-mix(in srgb, var(--vscode-editor-background, #1e1e1e) 96%, var(--vscode-foreground) 4%); overflow: hidden; transition: background 0.1s ease; }
  .kpi:hover { background: color-mix(in srgb, var(--vscode-editor-background, #1e1e1e) 90%, var(--vscode-foreground) 10%); }
  .kpi-head { display: flex; align-items: center; justify-content: space-between; }
  .kpi-label { font-size: 0.7em; letter-spacing: 0.14em; color: var(--vscode-descriptionForeground); }
  .kpi-tag { display: inline-flex; align-items: center; gap: 5px; font-size: 0.68em; color: var(--vscode-descriptionForeground); }
  .kpi-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .kpi-dot.jira { background: var(--vscode-charts-blue, #3794ff); }
  .kpi-dot.wiki { background: var(--vscode-charts-purple, #b180d7); }
  .kpi-dot.cron { background: var(--vscode-charts-orange, #d18616); }
  .kpi-value { font-size: 1.9em; font-weight: 700; line-height: 1.1; }
  .kpi-sub { font-size: 0.78em; color: var(--vscode-descriptionForeground); }
  .kpi-sub-thin { font-size: 0.72em; color: var(--vscode-descriptionForeground); opacity: 0.7; }
  .kpi-alert { font-size: 0.78em; color: var(--vscode-errorForeground); font-weight: 600; }
  .kpi-spark { margin-top: 4px; height: 24px; }
  .kpi-spark-sub { height: 18px; opacity: 0.7; }

  /* Filter bar */
  .filter-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .filter-chips { display: flex; gap: 4px; }
  .chip { padding: 3px 10px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); background: transparent; color: var(--vscode-descriptionForeground); border-radius: 12px; font-size: 0.76em; cursor: pointer; transition: background 0.1s ease, color 0.1s ease; }
  .chip:hover { background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent); color: var(--vscode-foreground); }
  .chip.active { background: color-mix(in srgb, var(--vscode-focusBorder) 18%, transparent); border-color: var(--vscode-focusBorder, #0078d4); color: var(--vscode-foreground); font-weight: 600; }
  .search-input { flex: 1; min-width: 100px; padding: 4px 9px; font-size: 0.85em; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; font-family: inherit; }
  .search-input:focus { outline: 1px solid var(--vscode-focusBorder); }

  /* Sections */
  .section { margin-bottom: 12px; }
  .section.card { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 6px; padding: 10px 12px; background: color-mix(in srgb, var(--vscode-editor-background, #1e1e1e) 97%, var(--vscode-foreground) 3%); }
  .section-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
  .section-head h3 { display: flex; align-items: center; gap: 6px; font-size: 0.82em; letter-spacing: 0.04em; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
  .section-icon { opacity: 0.75; font-size: 0.95em; }
  .section-sub { font-size: 0.72em; color: var(--vscode-descriptionForeground); }

  /* Feed rows */
  .feed { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 4px; max-height: 320px; overflow-y: auto; }
  .row { display: flex; align-items: flex-start; gap: 8px; padding: 7px 10px; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-left: 3px solid transparent; cursor: pointer; }
  .row:last-child { border-bottom: 0; }
  .row:hover { background: color-mix(in srgb, var(--vscode-foreground) 7%, transparent); }
  .row-icon { flex-shrink: 0; width: 16px; text-align: center; opacity: 0.85; }
  .row-body { flex: 1; min-width: 0; }
  .row-title { display: flex; gap: 6px; align-items: baseline; }
  .row-key { font-family: var(--vscode-editor-font-family); font-size: 0.76em; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
  .row-summary { font-size: 0.88em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-meta { display: flex; gap: 6px; flex-wrap: wrap; font-size: 0.71em; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  .row-status { text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.8; }
  .row-alert { color: var(--vscode-errorForeground); font-weight: 600; }
  .row-jira { border-left-color: var(--vscode-charts-blue, #3794ff); }
  .row-wiki { border-left-color: var(--vscode-charts-purple, #b180d7); }
  .row-cron { border-left-color: var(--vscode-charts-orange, #d18616); }

  /* Timeline */
  .timeline { display: grid; grid-template-columns: repeat(auto-fit, minmax(40px, 1fr)); gap: 4px; }
  .cell { padding: 6px 4px; text-align: center; border-radius: 5px; font-size: 0.7em; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); transition: background 0.1s ease; }
  .cell-label { color: var(--vscode-descriptionForeground); }
  .cell-count { font-weight: 700; font-size: 1.1em; margin-top: 2px; min-height: 1em; }
  .heat-cold { background: color-mix(in srgb, var(--vscode-editor-background, #1e1e1e) 97%, var(--vscode-foreground) 3%); }
  .heat-warm { background: color-mix(in srgb, var(--vscode-charts-yellow, #cca700) 16%, transparent); border-color: color-mix(in srgb, var(--vscode-charts-yellow, #cca700) 35%, transparent); }
  .heat-hot { background: color-mix(in srgb, var(--vscode-errorForeground, #f14c4c) 18%, transparent); border-color: color-mix(in srgb, var(--vscode-errorForeground, #f14c4c) 40%, transparent); color: var(--vscode-foreground); }
  .cell-today { border-color: var(--vscode-focusBorder); }
  .timeline-overdue { margin-top: 8px; font-size: 0.75em; color: var(--vscode-errorForeground); }

  /* AI panel */
  .ai-actions { display: flex; gap: 6px; margin-bottom: 8px; }
  .ai-body { font-size: 0.85em; line-height: 1.5; }
  .ai-body h3, .ai-body h4 { margin-top: 8px; margin-bottom: 4px; font-size: 0.85em; text-transform: none; letter-spacing: normal; color: var(--vscode-foreground); }
  .ai-body ul { margin: 4px 0; padding-left: 18px; }
  .ai-body li { margin-bottom: 3px; }
  .ai-body code { background: var(--vscode-textCodeBlock-background); padding: 0.05em 0.35em; border-radius: 2px; font-size: 0.92em; }
  .ai-body p { margin: 4px 0; }
  .ai-stamp { font-size: 0.7em; color: var(--vscode-descriptionForeground); margin-top: 6px; }

  /* Charts */
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
  .chart-block { }
  .chart-title { font-size: 0.72em; letter-spacing: 0.04em; text-transform: uppercase; font-weight: 600; margin-bottom: 4px; color: var(--vscode-descriptionForeground); }
  svg { width: 100%; height: auto; display: block; }
  .grid-line { stroke: var(--vscode-widget-border, var(--vscode-panel-border)); stroke-width: 1; opacity: 0.5; }
  .legend { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 5px; font-size: 0.72em; color: var(--vscode-descriptionForeground); }
  .legend .item { display: flex; align-items: center; gap: 5px; }
  .legend .dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }

  /* Footer */
  .footer { display: flex; align-items: center; justify-content: space-between; padding-top: 8px; margin-top: 2px; border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); font-size: 0.78em; color: var(--vscode-descriptionForeground); }
  .footer-actions { display: flex; align-items: center; gap: 6px; }
  .ai-model { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
  .ai-model:hover { color: var(--vscode-foreground); }
  .ai-model-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-charts-green, #89d185); flex-shrink: 0; }
  .ai-provider { opacity: 0.7; }

  /* Buttons */
  button { padding: 4px 11px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-radius: 3px; cursor: pointer; font-family: inherit; font-size: 0.85em; transition: background 0.1s ease; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .icon-btn { padding: 2px 8px; background: transparent; color: var(--vscode-descriptionForeground); border-color: transparent; }
  .icon-btn:hover { color: var(--vscode-foreground); background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent); }

  .actions { display: flex; gap: 6px; margin: 10px 0; }
`;
