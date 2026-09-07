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
import { ownerStats } from './owners';
import { configuredWikiRoot, ensureSampleWiki, maybeOfferWikiSetup, refreshSetupContext, revealAiHealthPanel, usingSampleWiki } from './wikiRoot';

let autoRefreshTimer: NodeJS.Timeout | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

const FILTER_CYCLE: FilterMode[] = ['all', 'official', 'private', 'agent'];

export function activate(context: vscode.ExtensionContext): void {
  setContext(context);
  void refreshSetupContext();
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
  void ensureSampleWiki(context).then(() => {
    void refreshSetupContext();
    provider.refresh();
    return maybeOfferWikiSetup(context);
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('todoView')) {
        void refreshSetupContext();
        provider.refresh();
        setupAutoRefresh(provider);
      }
      if (e.affectsConfiguration('todoView.grafanaUrl') || e.affectsConfiguration('todoView.aiProvider')) {
        void revealAiHealthPanel();
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
    treeView.description = configuredWikiRoot() ? 'load failed' : 'samples';
    return;
  }
  const stats = ownerStats(data);
  const total = stats.official.open + stats.private.open + stats.agent.open;
  const alarmCount = stats.official.overdue + stats.agent.failing;

  treeView.badge = {
    value: alarmCount || total,
    tooltip:
      `Official ${stats.official.open} · Private ${stats.private.open} · Agent ${stats.agent.open}` +
      (stats.official.overdue ? ` · ${stats.official.overdue} overdue` : '') +
      (stats.agent.failing ? ` · ${stats.agent.failing} failing` : ''),
  };

  const filterTag = filter === 'all' ? '' : ` [${filter}]`;
  const searchTag = search ? ` 🔎 "${search}"` : '';
  const alarm = alarmCount > 0 ? `  ⚠ ${alarmCount}` : '';
  const sampleTag = usingSampleWiki() ? 'samples · ' : '';
  treeView.description = `${sampleTag}${stats.official.open} · ${stats.private.open} · ${stats.agent.open}${alarm}${filterTag}${searchTag}`;
}

function updateStatusBar(data: ShowTodoFull | undefined): void {
  if (!statusBarItem) return;
  if (!data) {
    if (!configuredWikiRoot()) {
      statusBarItem.text = '$(sparkle) Beacon: samples';
      statusBarItem.tooltip = 'Task Beacon — showing sample tasks. Choose your wiki folder when ready.';
      statusBarItem.backgroundColor = undefined;
      return;
    }
    statusBarItem.text = '$(sparkle) Beacon: err';
    statusBarItem.tooltip = 'Task Beacon — load failed. Click to open.';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    return;
  }
  const stats = ownerStats(data);
  const failedChannels = [
    (stats.official.jiraUsed && !stats.official.jiraOk) || !stats.official.wikiOk ? 'Official' : '',
    !stats.private.wikiOk ? 'Private' : '',
    !stats.agent.wikiOk || !stats.agent.cronOk ? 'Agent' : '',
  ].filter((c): c is string => Boolean(c));

  const alarm = stats.official.overdue + stats.agent.failing;
  if (usingSampleWiki()) {
    statusBarItem.text = `$(sparkle) Beacon: samples · ${stats.official.open + stats.private.open + stats.agent.open}`;
    statusBarItem.backgroundColor = undefined;
    statusBarItem.tooltip = 'Showing bundled sample tasks. Choose your wiki folder when you want your own work.';
    return;
  }
  if (failedChannels.length > 0) {
    statusBarItem.text = `$(warning) Beacon: ${stats.official.open} · ${stats.private.open} · ${stats.agent.open} · ${failedChannels.length} down`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else if (alarm > 0) {
    statusBarItem.text = `$(flame) Beacon: ${stats.official.open} · ${stats.private.open} · ${stats.agent.open} · ⚠${alarm}`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else {
    statusBarItem.text = `$(sparkle) Beacon: ${stats.official.open} · ${stats.private.open} · ${stats.agent.open}`;
    statusBarItem.backgroundColor = undefined;
  }
  statusBarItem.tooltip = new vscode.MarkdownString(
    `**Task Beacon**\n\n` +
      `- Official: **${stats.official.open}**${stats.official.overdue ? ` (${stats.official.overdue} overdue)` : ''}${stats.official.jiraUsed && !stats.official.jiraOk ? ` — ⚠ Jira ${data.jira.error ?? 'failed'}` : ''}\n` +
      `- Private: **${stats.private.open}**${!stats.private.wikiOk ? ` — ⚠ ${data.wiki.error ?? 'fetch failed'}` : ''}\n` +
      `- Agent: **${stats.agent.open}**${stats.agent.failing ? ` (${stats.agent.failing} failing)` : ''}${!stats.agent.cronOk ? ` — ⚠ cron ${data.cron.error ?? 'failed'}` : ''}\n\n` +
      `_Click to open the sidebar_`
  );
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
