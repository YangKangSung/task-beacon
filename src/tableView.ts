import * as vscode from 'vscode';
import { TodoTreeDataProvider } from './todoProvider';
import { jiraBrowseUrl } from './jiraConfig';
import { CronJob, JiraIssue, ShowTodoFull, WikiTask } from './types';

const MS_DAY = 86400000;

type Row = {
  kind: 'jira' | 'wiki' | 'cron';
  id: string;
  title: string;
  status: string;
  priority: string;
  due: string;
  age: string;
  extra: string;
  overdue: boolean;
  failing: boolean;
  sortKey: number;
  /** 4-category classification (added 2026-07-25).
   * Values: 'official' | 'private' | 'agent-task' | 'agent-cron' | 'unknown' | undefined */
  category?: string;
};

export class TodoTableViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'todoView.table';
  private view: vscode.WebviewView | undefined;

  constructor(private readonly provider: TodoTreeDataProvider) {
    this.provider.onLoaded((data) => this.renderIfReady(data));
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    this.renderIfReady(this.provider.getData());
  }

  private renderIfReady(data: ShowTodoFull | undefined): void {
    if (!this.view) return;
    this.view.webview.html = this.renderHtml(data);
  }

  private handleMessage(msg: { command: string; payload?: unknown }): void {
    switch (msg.command) {
      case 'refresh':
        this.provider.refresh();
        break;
      case 'openJira': {
        const key = (msg.payload as { key?: string })?.key;
        if (key) vscode.env.openExternal(vscode.Uri.parse(jiraBrowseUrl(key)));
        break;
      }
      case 'openTask': {
        const file = (msg.payload as { file?: string })?.file;
        if (file) vscode.commands.executeCommand('todoView.openTaskFileByPath', file);
        break;
      }
      case 'openCron': {
        const id = (msg.payload as { id?: string })?.id;
        if (id) vscode.commands.executeCommand('todoView.openCronScriptById', id);
        break;
      }
    }
  }

  private renderHtml(data: ShowTodoFull | undefined): string {
    if (!data) {
      return this.wrapHtml('<p class="empty">Loading…</p>');
    }
    const rows: Row[] = [];
    if (data.jira.ok) {
      data.jira.in_progress.forEach((i) => rows.push(jiraRow(i, 'In Progress')));
      data.jira.to_do.forEach((i) => rows.push(jiraRow(i, 'To Do')));
    }
    if (data.wiki.ok) {
      data.wiki.active.forEach((t) => rows.push(wikiRow(t, 'active')));
      data.wiki.pending.forEach((t) => rows.push(wikiRow(t, 'pending')));
    }
    if (data.cron.ok) {
      data.cron.jobs.forEach((j) => rows.push(cronRow(j)));
    }

    rows.sort((a, b) => b.sortKey - a.sortKey);

    const stats = summarize(data);

    if (rows.length === 0) {
      return this.wrapHtml(`
        ${statsBanner(stats)}
        <p class="empty">$(sparkle) Inbox zero — nothing to worry about.</p>
      `);
    }

    const tbody = rows.map(renderRow).join('\n');
    return this.wrapHtml(`
      ${statsBanner(stats)}
      <div class="toolbar">
        <input id="filter" type="text" placeholder="Filter (key, title, status)…" />
        <div class="chips">
          <button data-kind="all" class="chip active">All</button>
          <button data-kind="jira" class="chip">Jira</button>
          <button data-kind="wiki" class="chip">Wiki</button>
          <button data-kind="cron" class="chip">Cron</button>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th class="col-kind">Type</th>
            <th class="col-id">Key / Title</th>
            <th class="col-status">Status</th>
            <th class="col-prio">Prio</th>
            <th class="col-due">Due / Age</th>
          </tr>
        </thead>
        <tbody>
          ${tbody}
        </tbody>
      </table>
    `);
  }

  private wrapHtml(body: string): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<style>
  html, body { margin: 0; padding: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: var(--vscode-font-size); }
  body { padding: 6px 8px; }
  .stats { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; font-size: 0.85em; }
  .stats .chip { padding: 2px 8px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .stats .chip.warn { background: var(--vscode-inputValidation-warningBackground, #f14c4c33); color: var(--vscode-errorForeground); }
  .toolbar { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
  .toolbar input { flex: 1; padding: 3px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; font-family: inherit; font-size: inherit; }
  .toolbar input:focus { outline: 1px solid var(--vscode-focusBorder); }
  .chips { display: flex; gap: 3px; }
  .chip { padding: 2px 8px; border-radius: 10px; border: 1px solid var(--vscode-widget-border, transparent); background: transparent; color: var(--vscode-foreground); cursor: pointer; font-size: 0.85em; font-family: inherit; }
  .chip:hover { background: var(--vscode-toolbar-hoverBackground); }
  .chip.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
  th { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); color: var(--vscode-descriptionForeground); font-weight: normal; position: sticky; top: 0; background: var(--vscode-sideBar-background); }
  td { padding: 4px 6px; border-bottom: 1px solid var(--vscode-widget-border, #33333322); vertical-align: top; }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  tr.row-overdue td { background: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent); }
  tr.row-failing td { background: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent); }
  .col-kind { width: 46px; }
  .col-status { width: 90px; }
  .col-prio { width: 40px; text-align: center; }
  .col-due { width: 85px; white-space: nowrap; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 0.75em; font-weight: bold; letter-spacing: 0.03em; color: #fff; }
  .badge.jira { background: var(--vscode-charts-blue, #3794ff); }
  .badge.wiki { background: var(--vscode-charts-purple, #b180d7); }
  .badge.cron { background: var(--vscode-charts-orange, #d18616); }
  /* Category badges — 4-category classification (added 2026-07-25) */
  .cat-badge { display: inline-block; padding: 0px 5px; border-radius: 3px; font-size: 0.7em; margin-left: 6px; vertical-align: middle; letter-spacing: 0.02em; font-weight: 500; }
  .cat-badge.cat-official { background: var(--vscode-charts-blue, #3794ff); color: #fff; }
  .cat-badge.cat-private { background: var(--vscode-charts-purple, #b180d7); color: #fff; }
  .cat-badge.cat-agent-task { background: var(--vscode-charts-orange, #d18616); color: #fff; }
  .cat-badge.cat-agent-cron { background: var(--vscode-charts-yellow, #cca700); color: #fff; }
  .cat-badge.cat-unknown { background: var(--vscode-disabledForeground, #888); color: #fff; }
  .key { color: var(--vscode-textLink-foreground); font-family: var(--vscode-editor-font-family); }
  .title { color: var(--vscode-foreground); }
  .sub { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 2px; }
  .status { font-family: var(--vscode-editor-font-family); font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  .status.fail { color: var(--vscode-errorForeground); font-weight: bold; }
  .status.ok { color: var(--vscode-charts-green, #89d185); }
  .prio { font-family: var(--vscode-editor-font-family); }
  .prio.highest { color: var(--vscode-errorForeground); font-weight: bold; }
  .prio.high { color: var(--vscode-charts-orange, #d18616); }
  .prio.medium { color: var(--vscode-charts-yellow, #cca700); }
  .prio.low { color: var(--vscode-disabledForeground); }
  .due-tag { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 0.85em; }
  .due-tag.overdue { background: var(--vscode-errorForeground); color: #fff; font-weight: bold; }
  .due-tag.soon { color: var(--vscode-charts-orange, #d18616); }
  .empty { color: var(--vscode-descriptionForeground); padding: 12px; text-align: center; }
  .clickable { cursor: pointer; }
  .clickable:hover .title, .clickable:hover .key { text-decoration: underline; }
</style>
</head>
<body>
${body}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const filterInput = document.getElementById('filter');
  const chipButtons = document.querySelectorAll('.chips .chip');
  let activeKind = 'all';
  let query = '';

  function applyFilter() {
    document.querySelectorAll('tbody tr').forEach((tr) => {
      const kind = tr.dataset.kind;
      const text = (tr.dataset.text || '').toLowerCase();
      const kindMatch = activeKind === 'all' || kind === activeKind;
      const textMatch = !query || text.includes(query);
      tr.style.display = kindMatch && textMatch ? '' : 'none';
    });
  }

  if (filterInput) {
    filterInput.addEventListener('input', (e) => {
      query = e.target.value.toLowerCase().trim();
      applyFilter();
    });
  }

  chipButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      chipButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      activeKind = btn.dataset.kind;
      applyFilter();
    });
  });

  document.querySelectorAll('tbody tr.clickable').forEach((tr) => {
    tr.addEventListener('click', () => {
      const kind = tr.dataset.kind;
      const ref = tr.dataset.ref;
      if (kind === 'jira') vscode.postMessage({ command: 'openJira', payload: { key: ref } });
      else if (kind === 'wiki') vscode.postMessage({ command: 'openTask', payload: { file: ref } });
      else if (kind === 'cron') vscode.postMessage({ command: 'openCron', payload: { id: ref } });
    });
  });
</script>
</body>
</html>`;
  }
}

function jiraRow(issue: JiraIssue, statusLabel: string): Row {
  const overdue = isOverdue(issue);
  const age = daysSince(issue.updated);
  return {
    kind: 'jira',
    id: issue.key,
    title: issue.summary,
    status: statusLabel,
    priority: issue.priority,
    due: issue.due ?? '',
    age: age !== null ? `${age}d` : '',
    extra: [issue.labels.join(' '), issue.components.join(' ')].filter(Boolean).join(' · '),
    overdue,
    failing: false,
    sortKey: overdue ? 9000 + (daysUntilNeg(issue.due) || 0) : statusLabel === 'In Progress' ? 5000 : 3000,
  };
}

function wikiRow(t: WikiTask, state: 'active' | 'pending'): Row {
  return {
    kind: 'wiki',
    id: t.file,
    title: t.title,
    status: state,
    priority: '',
    due: '',
    age: '',
    extra: t.note,
    overdue: false,
    failing: false,
    sortKey: state === 'active' ? 6000 : 2500,
    category: t.category, // Added 2026-07-25
  };
}

function cronRow(job: CronJob): Row {
  const failing = isFail(job.last_status);
  const age = job.last_run ? daysSince(job.last_run) : null;
  return {
    kind: 'cron',
    id: job.id,
    title: job.name,
    status: job.last_status || 'never',
    priority: '',
    due: '',
    age: age !== null ? `${age}d ago` : job.schedule,
    extra: job.schedule,
    overdue: false,
    failing,
    sortKey: failing ? 8000 : job.state === 'active' ? 4000 : 1000,
  };
}

function renderRow(r: Row): string {
  const rowClass = [
    'clickable',
    r.overdue ? 'row-overdue' : '',
    r.failing ? 'row-failing' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const badge = `<span class="badge ${r.kind}">${r.kind.toUpperCase()}</span>`;
  // Category badge (added 2026-07-25) — 4-category classification
  const catBadge = r.category ? ` <span class="cat-badge cat-${r.category}">${esc(r.category)}</span>` : '';
  const idCell =
    r.kind === 'jira'
      ? `<div class="key">${esc(r.id)}</div><div class="title">${esc(r.title)}</div>`
      : `<div class="title">${esc(r.title)}${catBadge}</div><div class="sub">${esc(r.extra)}</div>`;

  const statusClass =
    r.failing || r.status === 'failed' || r.status === 'error'
      ? 'fail'
      : r.status === 'success' || r.status === 'ok'
      ? 'ok'
      : '';
  const statusCell = `<span class="status ${statusClass}">${esc(r.status)}</span>`;

  const prioClass = prioClassOf(r.priority);
  const prioCell = r.priority
    ? `<span class="prio ${prioClass}">${esc(prioSymbol(r.priority))}</span>`
    : '';

  let dueCell = '';
  if (r.overdue && r.due) {
    dueCell = `<span class="due-tag overdue">${daysOverdue(r.due)}d overdue</span>`;
  } else if (r.due) {
    dueCell = `<span class="due-tag">${esc(r.due)}</span>`;
  } else if (r.age) {
    dueCell = `<span class="sub">${esc(r.age)}</span>`;
  }

  const searchText = `${r.id} ${r.title} ${r.status} ${r.priority} ${r.extra}`.toLowerCase();

  return `<tr class="${rowClass}" data-kind="${r.kind}" data-ref="${esc(r.id)}" data-text="${esc(searchText)}">
    <td class="col-kind">${badge}</td>
    <td class="col-id">${idCell}</td>
    <td class="col-status">${statusCell}</td>
    <td class="col-prio">${prioCell}</td>
    <td class="col-due">${dueCell}</td>
  </tr>`;
}

function statsBanner(stats: ReturnType<typeof summarize>): string {
  const chips: string[] = [];
  chips.push(`<span class="chip">Jira ${stats.jira}</span>`);
  chips.push(`<span class="chip">Wiki ${stats.wiki}</span>`);
  chips.push(`<span class="chip">Cron ${stats.cronActive}/${stats.cronTotal}</span>`);
  if (stats.overdue > 0) chips.push(`<span class="chip warn">${stats.overdue} overdue</span>`);
  if (stats.failing > 0) chips.push(`<span class="chip warn">${stats.failing} failing</span>`);
  return `<div class="stats">${chips.join('')}</div>`;
}

function summarize(data: ShowTodoFull): {
  jira: number;
  wiki: number;
  cronActive: number;
  cronTotal: number;
  overdue: number;
  failing: number;
} {
  const jira = data.jira.ok ? data.jira.total : 0;
  const wiki = data.wiki.ok ? data.wiki.active.length + data.wiki.pending.length : 0;
  const cronActive = data.cron.ok ? data.cron.jobs.filter((j) => j.state === 'active').length : 0;
  const cronTotal = data.cron.ok ? data.cron.jobs.length : 0;
  const overdue = data.jira.ok
    ? data.jira.in_progress.concat(data.jira.to_do).filter(isOverdue).length
    : 0;
  const failing = data.cron.ok ? data.cron.jobs.filter((j) => isFail(j.last_status)).length : 0;
  return { jira, wiki, cronActive, cronTotal, overdue, failing };
}

function isOverdue(issue: JiraIssue): boolean {
  if (!issue.due) return false;
  const d = Date.parse(issue.due);
  return !Number.isNaN(d) && d < startOfToday();
}

function daysUntilNeg(due: string | null): number {
  if (!due) return 0;
  const d = Date.parse(due);
  if (Number.isNaN(d)) return 0;
  return Math.floor((startOfToday() - d) / MS_DAY);
}

function daysOverdue(due: string): number {
  const d = Date.parse(due);
  if (Number.isNaN(d)) return 0;
  return Math.floor((startOfToday() - d) / MS_DAY);
}

function daysSince(dateStr: string): number | null {
  if (!dateStr) return null;
  const d = Date.parse(dateStr);
  if (Number.isNaN(d)) return null;
  return Math.floor((Date.now() - d) / MS_DAY);
}

function startOfToday(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function isFail(status: string): boolean {
  const s = (status || '').toLowerCase();
  return s === 'failed' || s === 'error' || s === 'fail';
}

function prioSymbol(priority: string): string {
  const p = priority.toLowerCase();
  if (p.includes('highest') || p.includes('critical') || p.includes('block')) return '↑↑';
  if (p.includes('high')) return '↑';
  if (p.includes('medium')) return '=';
  if (p.includes('low')) return '↓';
  return priority || '·';
}

function prioClassOf(priority: string): string {
  const p = priority.toLowerCase();
  if (p.includes('highest') || p.includes('critical') || p.includes('block')) return 'highest';
  if (p.includes('high')) return 'high';
  if (p.includes('medium')) return 'medium';
  if (p.includes('low')) return 'low';
  return '';
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
