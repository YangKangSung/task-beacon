import * as vscode from 'vscode';
import { fetchJiraDetail, readCronScriptPreview, readWikiTaskDetail } from './fetchTodo';
import { getAiSettings } from './aiConfig';
import { jiraBrowseUrl } from './jiraConfig';
import { summarizeWithAi, SummaryKind } from './aiClient';
import { CronJob, JiraIssue, TodoNode, WikiTask } from './types';

const MS_DAY = 86400000;

interface AiSummaryState {
  status: 'loading' | 'done' | 'error';
  text?: string;
}

export class TodoSummaryViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'todoView.summary';
  private view: vscode.WebviewView | undefined;
  private currentNode: TodoNode | undefined;
  private readonly jiraDetailCache = new Map<string, string>();
  private readonly jiraDetailError = new Map<string, string>();
  private readonly aiSummaryCache = new Map<string, AiSummaryState>();

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    this.render();
  }

  setSelectedNode(node: TodoNode | undefined): void {
    this.currentNode = node;
    this.render();

    const key = node?.jiraIssue?.key;
    if (key && !this.jiraDetailCache.has(key) && !this.jiraDetailError.has(key)) {
      fetchJiraDetail(key)
        .then((detail) => {
          if (detail) this.jiraDetailCache.set(key, detail);
          if (this.currentNode?.jiraIssue?.key === key) this.render();
        })
        .catch((e: Error) => {
          this.jiraDetailError.set(key, e.message);
          if (this.currentNode?.jiraIssue?.key === key) this.render();
        });
    }
  }

  private handleMessage(msg: { command: string; payload?: unknown }): void {
    switch (msg.command) {
      case 'openJira': {
        const key = (msg.payload as { key?: string })?.key;
        if (key) vscode.env.openExternal(vscode.Uri.parse(jiraBrowseUrl(key)));
        break;
      }
      case 'openEpic': {
        const key = (msg.payload as { key?: string })?.key;
        if (key) vscode.commands.executeCommand('todoView.openEpic', key);
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
      case 'copyId': {
        const value = (msg.payload as { value?: string })?.value;
        if (value) {
          vscode.env.clipboard.writeText(value);
          vscode.window.setStatusBarMessage(`Copied: ${value}`, 1500);
        }
        break;
      }
      case 'summarize': {
        this.triggerSummary();
        break;
      }
    }
  }

  private nodeCacheKey(node: TodoNode | undefined): string | undefined {
    return node?.jiraIssue?.key ?? node?.wikiTask?.file ?? node?.cronJob?.id ?? node?.epicKey;
  }

  private async triggerSummary(): Promise<void> {
    const node = this.currentNode;
    const cacheKey = this.nodeCacheKey(node);
    if (!node || !cacheKey) return;

    let kind: SummaryKind;
    let content: string | undefined;
    if (node.jiraIssue) {
      kind = 'jira';
      content =
        this.jiraDetailCache.get(node.jiraIssue.key) ??
        `${node.jiraIssue.summary}\n\nStatus: ${node.jiraIssue.status}`;
    } else if (node.wikiTask) {
      kind = 'wiki';
      const detail = readWikiTaskDetail(node.wikiTask.file);
      content = detail?.body || node.wikiTask.note || undefined;
    } else if (node.cronJob) {
      kind = 'cron';
      content = readCronScriptPreview(node.cronJob.id);
    } else {
      return;
    }
    if (!content || !content.trim()) return;

    this.aiSummaryCache.set(cacheKey, { status: 'loading' });
    this.render();
    try {
      const settings = getAiSettings();
      const text = await summarizeWithAi(settings, kind, content);
      this.aiSummaryCache.set(cacheKey, { status: 'done', text });
    } catch (e) {
      this.aiSummaryCache.set(cacheKey, { status: 'error', text: (e as Error).message });
    }
    if (this.nodeCacheKey(this.currentNode) === cacheKey) this.render();
  }

  private render(): void {
    if (!this.view) return;
    this.view.webview.html = this.wrapHtml(this.renderBody());
  }

  private renderBody(): string {
    const node = this.currentNode;
    if (!node) {
      return renderEmptyState();
    }

    const aiState = this.aiSummaryCache.get(this.nodeCacheKey(node) ?? '');
    if (node.jiraIssue)
      return renderJira(
        node.jiraIssue,
        this.jiraDetailCache.get(node.jiraIssue.key),
        aiState,
        this.jiraDetailError.get(node.jiraIssue.key)
      );
    if (node.wikiTask) return renderWiki(node.wikiTask, node.wikiTaskState, aiState);
    if (node.cronJob) return renderCron(node.cronJob, aiState);
    if (node.kind === 'epic' && node.epicKey) return renderEpic(node.epicKey, node.children ?? []);

    return `<div class="empty">
      <h2>${esc(node.label)}</h2>
      <p class="sub">${esc(node.description || '')}</p>
    </div>`;
  }

  private wrapHtml(body: string): string {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<style>
  html, body { margin: 0; padding: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: var(--vscode-font-size); }
  body { padding: 10px 12px; line-height: 1.5; }
  .empty { text-align: center; padding: 30px 12px; color: var(--vscode-descriptionForeground); position: relative; overflow: hidden; min-height: 260px; }
  .empty-icon { font-size: 2em; margin-bottom: 8px; opacity: 0.5; }
  .empty-hero { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 260px; padding: 28px 20px; position: relative; }
  .empty-hero .panel { position: relative; padding: 26px 28px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); background:
      linear-gradient(var(--vscode-widget-border, var(--vscode-panel-border)) 1px, transparent 1px) 0 0 / 100% 12px,
      linear-gradient(90deg, var(--vscode-widget-border, var(--vscode-panel-border)) 1px, transparent 1px) 0 0 / 12px 100%;
    background-color: color-mix(in srgb, var(--vscode-editor-background, #1e1e1e) 96%, var(--vscode-foreground) 4%);
    background-blend-mode: normal; }
  .empty-hero .panel::before, .empty-hero .panel::after,
  .empty-hero .corner-tl, .empty-hero .corner-br { content: ''; position: absolute; width: 10px; height: 10px; border-color: var(--vscode-charts-orange, #d18616); }
  .empty-hero .panel::before { top: -1px; left: -1px; border-top: 2px solid; border-left: 2px solid; }
  .empty-hero .panel::after { top: -1px; right: -1px; border-top: 2px solid; border-right: 2px solid; }
  .empty-hero .corner-tl { bottom: -1px; left: -1px; border-bottom: 2px solid; border-left: 2px solid; }
  .empty-hero .corner-br { bottom: -1px; right: -1px; border-bottom: 2px solid; border-right: 2px solid; }
  .empty-hero .kicker { display: flex; align-items: center; justify-content: center; gap: 6px; font-family: var(--vscode-editor-font-family); font-size: 0.7em; letter-spacing: 0.18em; text-transform: uppercase; color: var(--vscode-charts-orange, #d18616); }
  .empty-hero .kicker .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-charts-orange, #d18616); box-shadow: 0 0 0 2px color-mix(in srgb, var(--vscode-charts-orange, #d18616) 25%, transparent); }
  .empty-hero .sigil { width: 46px; height: 46px; color: var(--vscode-foreground); opacity: 0.8; margin: 14px 0 10px 0; }
  .empty-hero .title { margin: 0 0 6px 0; font-family: var(--vscode-editor-font-family); font-size: 1em; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--vscode-foreground); }
  .empty-hero .sub { margin: 0; font-size: 0.85em; color: var(--vscode-descriptionForeground); max-width: 220px; line-height: 1.5; }
  .empty-hero .rule { width: 100%; height: 1px; margin: 14px 0; background: repeating-linear-gradient(90deg, var(--vscode-widget-border, var(--vscode-panel-border)) 0 4px, transparent 4px 8px); }
  .empty-hero .hint-row { display: flex; gap: 8px; justify-content: center; }
  .empty-hero .hint-chip { padding: 3px 10px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); font-size: 0.7em; letter-spacing: 0.08em; }
  .header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 0.7em; font-weight: bold; letter-spacing: 0.05em; color: #fff; flex-shrink: 0; }
  .badge.jira { background: var(--vscode-charts-blue, #3794ff); }
  .badge.wiki { background: var(--vscode-charts-purple, #b180d7); }
  .badge.cron { background: var(--vscode-charts-orange, #d18616); }
  .badge.epic { background: var(--vscode-charts-purple, #b180d7); }
  .key { font-family: var(--vscode-editor-font-family); font-weight: bold; font-size: 1.05em; }
  h2 { margin: 4px 0 8px 0; font-size: 1.05em; font-weight: normal; color: var(--vscode-foreground); }
  .alert { padding: 6px 10px; border-radius: 3px; margin: 8px 0; font-size: 0.9em; }
  .alert.overdue { background: color-mix(in srgb, var(--vscode-errorForeground) 20%, transparent); color: var(--vscode-errorForeground); font-weight: bold; }
  .alert.failing { background: color-mix(in srgb, var(--vscode-errorForeground) 20%, transparent); color: var(--vscode-errorForeground); font-weight: bold; }
  dl { margin: 8px 0; display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; font-size: 0.9em; }
  dt { color: var(--vscode-descriptionForeground); }
  dd { margin: 0; word-break: break-word; }
  code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; font-size: 0.9em; font-family: var(--vscode-editor-font-family); }
  .chip { display: inline-block; padding: 1px 6px; margin: 1px 2px 1px 0; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 0.8em; }
  .chip.epic { cursor: pointer; background: var(--vscode-charts-purple, #b180d7); color: #fff; font-weight: 600; }
  .chip.epic:hover { opacity: 0.85; }
  .note { margin-top: 10px; padding: 8px 10px; background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.1)); border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-charts-blue)); border-radius: 2px; font-size: 0.9em; white-space: pre-wrap; }
  .excerpt { margin-top: 10px; padding: 10px 12px; background: color-mix(in srgb, var(--vscode-editor-background, #1e1e1e) 96%, var(--vscode-foreground) 4%); border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 2px; font-size: 0.88em; line-height: 1.6; max-height: 260px; overflow-y: auto; }
  .excerpt.error { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
  .ai-block { margin-top: 10px; }
  .ai-summary { padding: 8px 10px; border-left: 3px solid var(--vscode-charts-purple, #b180d7); background: color-mix(in srgb, var(--vscode-charts-purple, #b180d7) 10%, transparent); border-radius: 2px; font-size: 0.9em; line-height: 1.55; margin-bottom: 6px; }
  .ai-summary.loading { color: var(--vscode-descriptionForeground); font-style: italic; }
  .ai-summary.error { color: var(--vscode-errorForeground); border-left-color: var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent); }
  .actions { display: flex; gap: 6px; margin-top: 12px; flex-wrap: wrap; }
  button { padding: 4px 10px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-radius: 2px; cursor: pointer; font-family: inherit; font-size: 0.85em; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .status-pill { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.8em; font-weight: bold; }
  .status-pill.ok { background: color-mix(in srgb, var(--vscode-charts-green, #89d185) 25%, transparent); color: var(--vscode-charts-green, #89d185); }
  .status-pill.fail { background: color-mix(in srgb, var(--vscode-errorForeground) 25%, transparent); color: var(--vscode-errorForeground); }
  .status-pill.running { background: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 25%, transparent); color: var(--vscode-charts-blue, #3794ff); }
  .status-pill.neutral { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .prio { font-family: var(--vscode-editor-font-family); font-weight: bold; }
  .prio.highest { color: var(--vscode-errorForeground); }
  .prio.high { color: var(--vscode-charts-orange, #d18616); }
  .prio.medium { color: var(--vscode-charts-yellow, #cca700); }
  .prio.low { color: var(--vscode-disabledForeground); }
</style>
</head>
<body>
${body}
<script>
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const value = btn.dataset.value;
      vscode.postMessage({ command: action, payload: { key: value, file: value, id: value, value } });
    });
  });
</script>
</body>
</html>`;
  }
}

function renderEmptyState(): string {
  const beaconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 21 L10.5 10 H13.5 L15 21 Z" fill="currentColor" fill-opacity="0.15"/>
    <circle cx="12" cy="7" r="1.8" fill="currentColor" fill-opacity="0.6"/>
    <path d="M8.5 7 A3.5 3.5 0 0 1 12 3.5"/>
    <path d="M15.5 7 A3.5 3.5 0 0 0 12 3.5"/>
    <path d="M6.5 8.5 A5.5 5.5 0 0 1 12 1.5" opacity="0.5"/>
    <path d="M17.5 8.5 A5.5 5.5 0 0 0 12 1.5" opacity="0.5"/>
  </svg>`;

  return `<div class="empty">
    <div class="empty-hero">
      <div class="panel">
        <span class="corner-tl"></span>
        <span class="corner-br"></span>
        <div class="kicker"><span class="dot"></span>BEACON STANDBY</div>
        <div class="sigil">${beaconSvg}</div>
        <p class="title">Task Beacon</p>
        <div class="rule"></div>
        <p class="sub">Select an item in the Tree to see its details here.</p>
        <div class="hint-row">
          <span class="hint-chip">JIRA</span>
          <span class="hint-chip">WIKI</span>
          <span class="hint-chip">CRON</span>
        </div>
      </div>
    </div>
  </div>`;
}

function renderAiBlock(aiState: AiSummaryState | undefined): string {
  if (!aiState) {
    return `<div class="ai-block">
      <button class="secondary" data-action="summarize">✨ Summarize with AI</button>
    </div>`;
  }
  if (aiState.status === 'loading') {
    return `<div class="ai-block"><div class="ai-summary loading">Summarizing…</div></div>`;
  }
  if (aiState.status === 'error') {
    return `<div class="ai-block">
      <div class="ai-summary error">AI summary failed: ${esc(aiState.text || 'unknown error')}</div>
      <button class="secondary" data-action="summarize">Retry</button>
    </div>`;
  }
  return `<div class="ai-block">
    <div class="ai-summary">${esc(aiState.text || '').replace(/\n/g, '<br/>')}</div>
    <button class="secondary" data-action="summarize">Regenerate</button>
  </div>`;
}

function renderJira(
  issue: JiraIssue,
  detail: string | undefined,
  aiState?: AiSummaryState,
  detailError?: string
): string {
  const overdue = isOverdue(issue);
  const url = jiraBrowseUrl(issue.key);
  const alert = overdue
    ? `<div class="alert overdue">⚠ ${daysOverdue(issue.due!)}d overdue (due ${esc(issue.due!)})</div>`
    : '';
  const labels = issue.labels.length
    ? issue.labels.map((l) => `<span class="chip">${esc(l)}</span>`).join('')
    : '<span class="sub">—</span>';
  const components = issue.components.length
    ? issue.components.map((c) => `<span class="chip">${esc(c)}</span>`).join('')
    : '<span class="sub">—</span>';
  const age = daysSince(issue.updated);
  const excerpt = detail
    ? `<div class="excerpt">${esc(detail).replace(/\n/g, '<br/>')}</div>`
    : detailError
      ? `<div class="excerpt error">⚠ Failed to load description: ${esc(detailError)}</div>`
      : `<div class="excerpt sub">Loading description, comments, links…</div>`;

  return `
    <div class="header">
      <span class="badge jira">JIRA</span>
      <span class="key">${esc(issue.key)}</span>
    </div>
    <h2>${esc(issue.summary)}</h2>
    ${alert}
    <dl>
      <dt>Status</dt><dd><span class="status-pill neutral">${esc(issue.status)}</span></dd>
      <dt>Priority</dt><dd><span class="prio ${prioClass(issue.priority)}">${esc(issue.priority || '—')}</span></dd>
      <dt>Due</dt><dd>${issue.due ? `<code>${esc(issue.due)}</code>` : '<span class="sub">—</span>'}</dd>
      <dt>Updated</dt><dd>${esc(issue.updated)}${age !== null ? ` <span class="sub">(${age}d ago)</span>` : ''}</dd>
      <dt>Labels</dt><dd>${labels}</dd>
      <dt>Components</dt><dd>${components}</dd>
      ${issue.epic_key ? `<dt>Epic</dt><dd><span class="chip epic" data-action="openJira" data-value="${esc(issue.epic_key)}">${esc(issue.epic_key)}</span></dd>` : ''}
      <dt>Link</dt><dd><code>${esc(url)}</code></dd>
    </dl>
    ${renderAiBlock(aiState)}
    ${excerpt}
    <div class="actions">
      <button data-action="openJira" data-value="${esc(issue.key)}">Open in Jira</button>
      <button class="secondary" data-action="copyId" data-value="${esc(issue.key)}">Copy Key</button>
      ${issue.epic_key ? `<button class="secondary" data-action="openJira" data-value="${esc(issue.epic_key)}">Open Epic</button>` : ''}
    </div>
  `;
}

function renderWiki(t: WikiTask, state: string | undefined, aiState?: AiSummaryState): string {
  const stateLabel = state || 'unknown';
  const stateClass =
    stateLabel === 'active' ? 'running' : stateLabel === 'completed' ? 'ok' : 'neutral';
  const detail = readWikiTaskDetail(t.file);
  const fm = detail?.frontmatter ?? {};

  const epicKey = t.epicKey ?? fm.epic_link;

  const extraRows = [
    fm.priority ? `<dt>Priority</dt><dd><span class="prio ${prioClass(fm.priority)}">${esc(fm.priority)}</span></dd>` : '',
    fm.due ? `<dt>Due</dt><dd><code>${esc(fm.due)}</code></dd>` : '',
    fm.channel ? `<dt>Channel</dt><dd>${esc(fm.channel)}</dd>` : '',
    fm.created ? `<dt>Created</dt><dd>${esc(fm.created)}</dd>` : '',
    epicKey ? `<dt>Epic</dt><dd><span class="chip epic" data-action="openJira" data-value="${esc(epicKey)}">${esc(epicKey)}</span></dd>` : '',
    // Category row — 4-category classification (added 2026-07-25)
    t.category ? `<dt>Category</dt><dd><span class="cat-badge cat-${esc(t.category)}">${esc(t.category)}</span></dd>` : '',
  ].join('');

  const tags = detail?.tags.length
    ? `<dt>Tags</dt><dd>${detail.tags.map((tag) => `<span class="chip">${esc(tag)}</span>`).join('')}</dd>`
    : '';

  const excerpt = detail?.body ? bodyExcerpt(detail.body) : '';

  return `
    <div class="header">
      <span class="badge wiki">WIKI</span>
      <span class="key">${esc(t.title)}</span>
    </div>
    <dl>
      <dt>State</dt><dd><span class="status-pill ${stateClass}">${esc(stateLabel)}</span></dd>
      ${extraRows}
      <dt>File</dt><dd><code>${esc(t.file)}</code></dd>
      ${tags}
    </dl>
    ${t.note ? `<div class="note">${esc(t.note)}</div>` : ''}
    ${renderAiBlock(aiState)}
    ${excerpt ? `<div class="excerpt">${excerpt}</div>` : ''}
    <div class="actions">
      <button data-action="openTask" data-value="${esc(t.file)}">Open Task File</button>
      <button class="secondary" data-action="copyId" data-value="${esc(t.file)}">Copy Path</button>
      ${epicKey ? `<button class="secondary" data-action="openJira" data-value="${esc(epicKey)}">Open Epic</button>` : ''}
    </div>
  `;
}

/** Renders a plain-text excerpt of a task .md body: strips markdown table/
 * heading noise down to readable lines, caps length, preserves paragraph
 * breaks. Deliberately not a full markdown renderer — this is a summary
 * glance, not a doc viewer (Open Task File covers the rest). */
function bodyExcerpt(body: string, maxLen = 700): string {
  const lines = body
    .split(/\r?\n/)
    .filter((l) => !/^\s*\|/.test(l))
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .filter((l) => l.length > 0);

  let text = lines.join('\n');
  let truncated = false;
  if (text.length > maxLen) {
    text = text.slice(0, maxLen);
    truncated = true;
  }
  return esc(text).replace(/\n/g, '<br/>') + (truncated ? ' …' : '');
}

function renderCron(job: CronJob, aiState?: AiSummaryState): string {
  const failing = isFail(job.last_status);
  const alert = failing
    ? `<div class="alert failing">⚠ Failing — last run status: <code>${esc(job.last_status)}</code></div>`
    : '';
  const statusClass = failing
    ? 'fail'
    : job.last_status === 'success' || job.last_status === 'ok'
    ? 'ok'
    : job.last_status === 'running'
    ? 'running'
    : 'neutral';
  const lastAge = job.last_run ? daysSinceIso(job.last_run) : null;
  const preview = readCronScriptPreview(job.id);

  return `
    <div class="header">
      <span class="badge cron">CRON</span>
      <span class="key">${esc(job.name)}</span>
    </div>
    ${alert}
    <dl>
      <dt>ID</dt><dd><code>${esc(job.id)}</code></dd>
      <dt>State</dt><dd><span class="status-pill neutral">${esc(job.state)}</span></dd>
      <dt>Schedule</dt><dd><code>${esc(job.schedule)}</code></dd>
      <dt>Last status</dt><dd><span class="status-pill ${statusClass}">${esc(job.last_status || 'never')}</span></dd>
      <dt>Last run</dt><dd>${job.last_run ? esc(job.last_run) + (lastAge !== null ? ` <span class="sub">(${lastAge}d ago)</span>` : '') : '<span class="sub">—</span>'}</dd>
      <dt>Next run</dt><dd>${job.next_run ? `<code>${esc(job.next_run)}</code>` : '<span class="sub">—</span>'}</dd>
    </dl>
    ${preview ? `<div class="note">${esc(preview).replace(/\n/g, '<br/>')}</div>` : ''}
    ${renderAiBlock(aiState)}
    <div class="actions">
      <button data-action="openCron" data-value="${esc(job.id)}">Open Script</button>
      <button class="secondary" data-action="copyId" data-value="${esc(job.id)}">Copy ID</button>
    </div>
  `;
}

function renderEpic(epicKey: string, children: TodoNode[]): string {
  const isTaskFile = epicKey.endsWith('.md');
  const childRows = children.length
    ? children
        .map((c) => {
          const badge = c.jiraIssue ? 'jira' : c.wikiTask ? 'wiki' : 'cron';
          const label = c.jiraIssue?.key ?? c.wikiTask?.title ?? c.cronJob?.name ?? c.label;
          return `<li><span class="badge ${badge}">${badge.toUpperCase()}</span> ${esc(label)}</li>`;
        })
        .join('')
    : '<li class="sub">—</li>';

  return `
    <div class="header">
      <span class="badge epic">EPIC</span>
      <span class="key">${esc(epicKey)}</span>
    </div>
    <dl>
      <dt>Children</dt><dd>${children.length}</dd>
    </dl>
    <ul class="excerpt">${childRows}</ul>
    <div class="actions">
      <button data-action="openEpic" data-value="${esc(epicKey)}">${isTaskFile ? 'Open Task File' : 'Open in Jira'}</button>
      <button class="secondary" data-action="copyId" data-value="${esc(epicKey)}">Copy Key</button>
    </div>
  `;
}

function isOverdue(issue: JiraIssue): boolean {
  if (!issue.due) return false;
  const d = Date.parse(issue.due);
  return !Number.isNaN(d) && d < startOfToday();
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

function daysSinceIso(iso: string): number | null {
  return daysSince(iso);
}

function startOfToday(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function isFail(status: string): boolean {
  const s = (status || '').toLowerCase();
  return s === 'failed' || s === 'error' || s === 'fail';
}

function prioClass(priority: string): string {
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
