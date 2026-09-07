import * as vscode from 'vscode';
import { TodoTreeDataProvider } from './todoProvider';
import { TodoTableViewProvider } from './tableView';
import { TodoSummaryViewProvider } from './summaryView';
import { TodoChartViewProvider } from './chartView';
import { TodoPanelViewProvider } from './panelView';
import { TodoAiHealthViewProvider } from './aiHealthView';
import { CronChartViewProvider } from './cronChartView';
import { TodoSettingsViewProvider } from './settingsView';
import { CronRunsStore } from './cronRunsStore';
import { HistoryStore } from './historyStore';
import { registerCommands } from './commands';
import { registerUpdateCheckCommand, runUpdateCheck } from './updateCheck';
import { setContext } from './extensionContext';
import { FilterMode, ShowTodoFull } from './types';
import { configuredWikiRoot, maybeOfferWikiSetup, refreshSetupContext } from './wikiRoot';

let autoRefreshTimer: NodeJS.Timeout | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

const FILTER_CYCLE: FilterMode[] = ['all', 'official', 'private', 'agent'];

export function activate(context: vscode.ExtensionContext): void {
  setContext(context);
  const provider = new TodoTreeDataProvider();
  const treeView = vscode.window.createTreeView('todoView', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  const summaryProvider = new TodoSummaryViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TodoSummaryViewProvider.viewType, summaryProvider)
  );
  context.subscriptions.push(
    treeView.onDidChangeSelection((e) => summaryProvider.setSelectedNode(e.selection[0]))
  );

  const tableProvider = new TodoTableViewProvider(provider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TodoTableViewProvider.viewType, tableProvider)
  );

  const historyStore = new HistoryStore(context.globalStorageUri.fsPath);
  const chartProvider = new TodoChartViewProvider(historyStore, provider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TodoChartViewProvider.viewType, chartProvider)
  );

  const panelProvider = new TodoPanelViewProvider(historyStore, provider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TodoPanelViewProvider.viewType, panelProvider)
  );

  const aiHealthProvider = new TodoAiHealthViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TodoAiHealthViewProvider.viewType, aiHealthProvider)
  );

  const cronRunsStore = new CronRunsStore();
  const cronChartProvider = new CronChartViewProvider(cronRunsStore, provider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CronChartViewProvider.viewType, cronChartProvider)
  );

  const settingsSidebarProvider = new TodoSettingsViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TodoSettingsViewProvider.viewType, settingsSidebarProvider)
  );

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'todoView.focus';
  statusBarItem.text = '$(sparkle) Beacon: …';
  statusBarItem.tooltip = 'Task Beacon — click to open';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    provider.onLoaded((data) => {
      updateTreeMeta(treeView, provider.getFilter(), data, provider.getSearch());
      updateStatusBar(data);
      if (data) historyStore.appendSnapshot(data);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('todoView.cycleFilter', () => {
      const cur = provider.getFilter();
      const idx = FILTER_CYCLE.indexOf(cur);
      const next = FILTER_CYCLE[(idx + 1) % FILTER_CYCLE.length];
      provider.setFilter(next);
      updateTreeMeta(treeView, next, provider.getData(), provider.getSearch());
      vscode.window.setStatusBarMessage(`Beacon filter: ${next}`, 1500);
    }),
    vscode.commands.registerCommand('todoView.filterAll', () => {
      provider.setFilter('all');
      updateTreeMeta(treeView, 'all', provider.getData(), provider.getSearch());
    }),
    vscode.commands.registerCommand('todoView.filterOfficial', () => {
      provider.setFilter('official');
      updateTreeMeta(treeView, 'official', provider.getData(), provider.getSearch());
    }),
    vscode.commands.registerCommand('todoView.filterPrivate', () => {
      provider.setFilter('private');
      updateTreeMeta(treeView, 'private', provider.getData(), provider.getSearch());
    }),
    vscode.commands.registerCommand('todoView.filterAgent', () => {
      provider.setFilter('agent');
      updateTreeMeta(treeView, 'agent', provider.getData(), provider.getSearch());
    }),
    vscode.commands.registerCommand('todoView.search', async () => {
      const value = await vscode.window.showInputBox({
        prompt: 'Filter tree by text',
        placeHolder: 'Type to filter Jira/LLMWiki/Cron items…',
        value: provider.getSearch(),
      });
      if (value === undefined) return; // Escape — leave search unchanged
      provider.setSearch(value);
      updateTreeMeta(treeView, provider.getFilter(), provider.getData(), value);
    }),
    vscode.commands.registerCommand('todoView.clearSearch', () => {
      provider.setSearch('');
      updateTreeMeta(treeView, provider.getFilter(), provider.getData(), '');
    })
  );

  registerCommands(context, provider);
  registerUpdateCheckCommand(context);
  void runUpdateCheck(context, false);
  void refreshSetupContext().then(() => maybeOfferWikiSetup(context));

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('todoView')) {
        void refreshSetupContext();
        provider.refresh();
        setupAutoRefresh(provider);
      }
    })
  );

  setupAutoRefresh(provider);
  context.subscriptions.push({ dispose: () => clearAutoRefresh() });
}

function updateTreeMeta(
  treeView: vscode.TreeView<unknown>,
  filter: FilterMode,
  data: ShowTodoFull | undefined,
  search = ''
): void {
  if (!data) {
    treeView.badge = undefined;
    treeView.description = configuredWikiRoot() ? 'load failed' : 'choose wiki folder';
    return;
  }
  const jira = data.jira.ok ? data.jira.total : 0;
  const wiki = data.wiki.ok ? data.wiki.pending.length + data.wiki.active.length : 0;
  const cronActive = data.cron.ok ? data.cron.jobs.filter((j) => j.state === 'active').length : 0;
  const overdue = data.jira.ok ? countOverdue(data.jira) : 0;
  const failing = data.cron.ok ? data.cron.jobs.filter((j) => isFail(j.last_status)).length : 0;
  const total = jira + wiki + cronActive;

  treeView.badge = {
    value: overdue + failing || total,
    tooltip:
      `Jira ${jira} · LLMWiki ${wiki} · Cron active ${cronActive}` +
      (overdue ? ` · ${overdue} overdue` : '') +
      (failing ? ` · ${failing} failing` : ''),
  };

  const filterTag = filter === 'all' ? '' : ` [${filter}]`;
  const searchTag = search ? ` 🔎 "${search}"` : '';
  const alarm =
    overdue > 0 || failing > 0 ? `  ⚠ ${overdue + failing}` : '';
  treeView.description = `${jira} · ${wiki} · ${cronActive}${alarm}${filterTag}${searchTag}`;
}

function updateStatusBar(data: ShowTodoFull | undefined): void {
  if (!statusBarItem) return;
  if (!data) {
    if (!configuredWikiRoot()) {
      statusBarItem.text = '$(sparkle) Beacon: set wiki folder';
      statusBarItem.tooltip = 'Task Beacon — choose a wiki folder to get started.';
      statusBarItem.backgroundColor = undefined;
      return;
    }
    statusBarItem.text = '$(sparkle) Beacon: err';
    statusBarItem.tooltip = 'Task Beacon — load failed. Click to open.';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    return;
  }
  const jira = data.jira.ok ? data.jira.total : 0;
  const wiki = data.wiki.ok ? data.wiki.pending.length + data.wiki.active.length : 0;
  const cronActive = data.cron.ok ? data.cron.jobs.filter((j) => j.state === 'active').length : 0;
  const overdue = data.jira.ok ? countOverdue(data.jira) : 0;
  const failing = data.cron.ok ? data.cron.jobs.filter((j) => isFail(j.last_status)).length : 0;

  // A channel showing 0 could mean "nothing open" or "fetch failed" —
  // callers can't tell those apart from the count alone, so surface it.
  const failedChannels = [
    !data.jira.ok && 'Jira',
    !data.wiki.ok && 'LLMWiki',
    !data.cron.ok && 'Cron',
  ].filter((c): c is string => !!c);

  const alarm = overdue + failing;
  if (failedChannels.length > 0) {
    statusBarItem.text = `$(warning) Beacon: ${jira} · ${wiki} · ${cronActive} · ${failedChannels.length} down`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else if (alarm > 0) {
    statusBarItem.text = `$(flame) Beacon: ${jira} · ${wiki} · ${cronActive} · ⚠${alarm}`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else {
    statusBarItem.text = `$(sparkle) Beacon: ${jira} · ${wiki} · ${cronActive}`;
    statusBarItem.backgroundColor = undefined;
  }
  statusBarItem.tooltip = new vscode.MarkdownString(
    `**Task Beacon**\n\n` +
      `- Jira open: **${jira}**${overdue ? ` (${overdue} overdue)` : ''}${!data.jira.ok ? ` — ⚠ ${data.jira.error ?? 'fetch failed'}` : ''}\n` +
      `- LLMWiki: **${wiki}**${!data.wiki.ok ? ` — ⚠ ${data.wiki.error ?? 'fetch failed'}` : ''}\n` +
      `- Cron active: **${cronActive}**${failing ? ` (${failing} failing)` : ''}${!data.cron.ok ? ` — ⚠ ${data.cron.error ?? 'fetch failed'}` : ''}\n\n` +
      `_Click to open the sidebar_`
  );
}

function countOverdue(jira: ShowTodoFull['jira']): number {
  if (!jira.ok) return 0;
  const today = startOfToday();
  return jira.in_progress.concat(jira.to_do).filter((i) => {
    if (!i.due) return false;
    const d = Date.parse(i.due);
    return !Number.isNaN(d) && d < today;
  }).length;
}

function startOfToday(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function isFail(status: string): boolean {
  const s = (status || '').toLowerCase();
  return s === 'failed' || s === 'error' || s === 'fail';
}

function clearAutoRefresh(): void {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = undefined;
  }
}

function setupAutoRefresh(provider: TodoTreeDataProvider): void {
  clearAutoRefresh();
  const sec = vscode.workspace.getConfiguration('todoView').get<number>('autoRefreshSec', 0);
  if (sec > 0) {
    autoRefreshTimer = setInterval(() => provider.refresh(), sec * 1000);
  }
}

export function deactivate(): void {
  clearAutoRefresh();
}
