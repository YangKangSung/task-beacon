import * as vscode from 'vscode';
import * as fs from 'fs';
import { TodoTreeItem, TodoTreeDataProvider } from './todoProvider';
import { resolveCronScriptPath, setCronPaused, taskFilePath, triggerCronRun } from './fetchTodo';
import { promptSelectAiModel } from './aiConfig';
import { jiraBrowseUrl } from './jiraConfig';
import { openSettingsPanel } from './settingsView';
import { TodoNode } from './types';
import { isAiHealthEnabled, openGetStarted, pickWikiRoot, revealAiHealthPanel, seedSamplesIntoConfiguredRoot, useWorkspaceWikiRoot } from './wikiRoot';

function toNode(item: TodoNode | TodoTreeItem | undefined): TodoNode | undefined {
  if (!item) return undefined;
  return item instanceof TodoTreeItem ? item.node : item;
}

const STATUS_CHOICES = ['pending', 'active', 'completed', 'cancelled'] as const;

export function registerCommands(context: vscode.ExtensionContext, provider: TodoTreeDataProvider): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('todoView.refresh', () => provider.refresh()),

    vscode.commands.registerCommand('todoView.openJira', (item?: TodoNode | TodoTreeItem) => {
      const key = toNode(item)?.jiraIssue?.key;
      if (!key) {
        return;
      }
      vscode.env.openExternal(vscode.Uri.parse(jiraBrowseUrl(key)));
    }),

    vscode.commands.registerCommand('todoView.openEpic', async (arg?: string | TodoNode | TodoTreeItem) => {
      const key = typeof arg === 'string' ? arg : toNode(arg)?.epicKey;
      if (!key) {
        return;
      }
      // Wiki epic_link can point at a task file (e.g. task-beacon-vscode-extension.md)
      // instead of a Jira key — open it locally rather than a dead Jira URL.
      if (key.endsWith('.md')) {
        const filePath = taskFilePath(key);
        if (fs.existsSync(filePath)) {
          const doc = await vscode.workspace.openTextDocument(filePath);
          await vscode.window.showTextDocument(doc);
        } else {
          vscode.window.showWarningMessage(`Epic task file not found: ${filePath}`);
        }
        return;
      }
      vscode.env.openExternal(vscode.Uri.parse(jiraBrowseUrl(key)));
    }),

    vscode.commands.registerCommand('todoView.openTaskFile', async (item?: TodoNode | TodoTreeItem) => {
      const file = toNode(item)?.wikiTask?.file;
      if (!file) {
        return;
      }
      const filePath = taskFilePath(file);
      if (!fs.existsSync(filePath)) {
        vscode.window.showWarningMessage(`Task file not found: ${filePath}`);
        return;
      }
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc);
    }),

    vscode.commands.registerCommand('todoView.openCronScript', async (item?: TodoNode | TodoTreeItem) => {
      const job = toNode(item)?.cronJob;
      if (!job) {
        return;
      }
      const scriptPath = resolveCronScriptPath(job.id);
      if (!scriptPath || !fs.existsSync(scriptPath)) {
        vscode.window.showWarningMessage(`No script found for cron job "${job.name}"`);
        return;
      }
      const doc = await vscode.workspace.openTextDocument(scriptPath);
      await vscode.window.showTextDocument(doc);
    }),

    vscode.commands.registerCommand('todoView.copyId', (item?: TodoNode | TodoTreeItem) => {
      const node = toNode(item);
      const value = node?.jiraIssue?.key ?? node?.wikiTask?.file ?? node?.cronJob?.id ?? undefined;
      if (!value) {
        return;
      }
      vscode.env.clipboard.writeText(value);
      vscode.window.showInformationMessage(`Copied: ${value}`);
    }),

    vscode.commands.registerCommand('todoView.changeStatus', async (item?: TodoNode | TodoTreeItem) => {
      const task = toNode(item)?.wikiTask;
      if (!task) {
        return;
      }
      const choice = await vscode.window.showQuickPick(STATUS_CHOICES, {
        placeHolder: `New status for "${task.title}"`,
      });
      if (!choice) {
        return;
      }
      const filePath = taskFilePath(task.file);
      if (!fs.existsSync(filePath)) {
        vscode.window.showWarningMessage(`Task file not found: ${filePath}`);
        return;
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      const updated = content.replace(/^status:\s*.*$/m, `status: ${choice}`);
      if (updated === content) {
        vscode.window.showWarningMessage(`No "status:" field found in frontmatter of ${task.file}`);
        return;
      }
      fs.writeFileSync(filePath, updated, 'utf-8');
      vscode.window.showInformationMessage(
        `Status set to "${choice}" in ${task.file}. tasks/index.md needs manual update.`
      );
      provider.refresh();
    }),

    vscode.commands.registerCommand('todoView.showDetails', (item?: TodoNode | TodoTreeItem) => {
      const node = toNode(item);
      if (!node) return;
      openDetailPanel(context, node);
    }),

    vscode.commands.registerCommand('todoView.openTaskFileByPath', async (file: string) => {
      if (!file) return;
      const filePath = taskFilePath(file);
      if (!fs.existsSync(filePath)) {
        vscode.window.showWarningMessage(`Task file not found: ${filePath}`);
        return;
      }
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc);
    }),

    vscode.commands.registerCommand('todoView.openCronScriptById', async (id: string) => {
      if (!id) return;
      const scriptPath = resolveCronScriptPath(id);
      if (!scriptPath || !fs.existsSync(scriptPath)) {
        vscode.window.showWarningMessage(`No script found for cron job "${id}"`);
        return;
      }
      const doc = await vscode.workspace.openTextDocument(scriptPath);
      await vscode.window.showTextDocument(doc);
    }),

    vscode.commands.registerCommand('todoView.pauseCron', async (item?: TodoNode | TodoTreeItem) => {
      const job = toNode(item)?.cronJob;
      if (!job) return;
      try {
        // hermes CLI cold-starts in ~10-13s — without a progress indicator the
        // click looks like a no-op for that whole window.
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Pausing ${job.name}...` },
          () => setCronPaused(job.id, true)
        );
        vscode.window.showInformationMessage(`Paused: ${job.name}`);
        provider.refresh();
      } catch (e) {
        vscode.window.showErrorMessage((e as Error).message);
      }
    }),

    vscode.commands.registerCommand('todoView.resumeCron', async (item?: TodoNode | TodoTreeItem) => {
      const job = toNode(item)?.cronJob;
      if (!job) return;
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Resuming ${job.name}...` },
          () => setCronPaused(job.id, false)
        );
        vscode.window.showInformationMessage(`Resumed: ${job.name}`);
        provider.refresh();
      } catch (e) {
        vscode.window.showErrorMessage((e as Error).message);
      }
    }),

    vscode.commands.registerCommand('todoView.triggerCronRun', async (item?: TodoNode | TodoTreeItem) => {
      const job = toNode(item)?.cronJob;
      if (!job) return;
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Triggering ${job.name}...` },
          () => triggerCronRun(job.id)
        );
        vscode.window.showInformationMessage(`Triggered: ${job.name}`);
        provider.refresh();
      } catch (e) {
        vscode.window.showErrorMessage((e as Error).message);
      }
    }),

    vscode.commands.registerCommand('todoView.selectAiModel', promptSelectAiModel),
    vscode.commands.registerCommand('todoView.openSettings', openSettingsPanel),
    vscode.commands.registerCommand('todoView.openAiHealth', async () => {
      if (!isAiHealthEnabled()) {
        await openSettingsPanel();
        void vscode.window.showInformationMessage(
          'Set Grafana URL in Settings → AI, then Save. The AI Health panel opens next to the dashboard.'
        );
        return;
      }
      await revealAiHealthPanel();
    }),
    vscode.commands.registerCommand('todoView.loginXai', loginXaiViaHermes),
    vscode.commands.registerCommand('todoView.pickWikiRoot', pickWikiRoot),
    vscode.commands.registerCommand('todoView.useWorkspaceWikiRoot', useWorkspaceWikiRoot),
    vscode.commands.registerCommand('todoView.seedSamples', seedSamplesIntoConfiguredRoot),
    vscode.commands.registerCommand('todoView.getStarted', openGetStarted)
  );
}

function loginXaiViaHermes(): void {
  const term = vscode.window.createTerminal({ name: 'Hermes xAI login' });
  term.show();
  term.sendText('hermes auth add xai-oauth');
  void vscode.window.showInformationMessage(
    'Complete the xAI device login in the terminal (SuperGrok / X Premium+), then click Refresh status in Settings.'
  );
}

function openDetailPanel(context: vscode.ExtensionContext, node: TodoNode): void {
  const title = node.jiraIssue?.key
    ? `Beacon: ${node.jiraIssue.key}`
    : node.wikiTask?.title
    ? `Beacon: ${node.wikiTask.title}`
    : node.cronJob?.name
    ? `Beacon: ${node.cronJob.name}`
    : 'Beacon Detail';

  const panel = vscode.window.createWebviewPanel(
    'taskBeaconDetail',
    title,
    vscode.ViewColumn.Beside,
    { enableScripts: false, retainContextWhenHidden: true }
  );
  panel.webview.html = renderDetailHtml(node);
}

function renderDetailHtml(node: TodoNode): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  let body = '';
  if (node.jiraIssue) {
    const j = node.jiraIssue;
    const url = jiraBrowseUrl(j.key);
    body = `
      <h1><span class="badge jira">JIRA</span> ${esc(j.key)}</h1>
      <p class="summary">${esc(j.summary)}</p>
      <table>
        <tr><th>Status</th><td>${esc(j.status)}</td></tr>
        <tr><th>Priority</th><td>${esc(j.priority)}</td></tr>
        <tr><th>Due</th><td>${esc(j.due || '—')}</td></tr>
        <tr><th>Updated</th><td>${esc(j.updated)}</td></tr>
        <tr><th>Labels</th><td>${j.labels.map((l) => `<code>${esc(l)}</code>`).join(' ') || '—'}</td></tr>
        <tr><th>Components</th><td>${j.components.map((c) => `<code>${esc(c)}</code>`).join(' ') || '—'}</td></tr>
        <tr><th>Link</th><td><a href="${esc(url)}">${esc(url)}</a></td></tr>
      </table>
    `;
  } else if (node.wikiTask) {
    const t = node.wikiTask;
    body = `
      <h1><span class="badge wiki">WIKI</span> ${esc(t.title)}</h1>
      <table>
        <tr><th>State</th><td>${esc(node.wikiTaskState || '—')}</td></tr>
        <tr><th>File</th><td><code>${esc(t.file)}</code></td></tr>
        <tr><th>Note</th><td>${esc(t.note || '—')}</td></tr>
      </table>
    `;
  } else if (node.cronJob) {
    const c = node.cronJob;
    body = `
      <h1><span class="badge cron">CRON</span> ${esc(c.name)}</h1>
      <table>
        <tr><th>ID</th><td><code>${esc(c.id)}</code></td></tr>
        <tr><th>State</th><td>${esc(c.state)}</td></tr>
        <tr><th>Schedule</th><td><code>${esc(c.schedule)}</code></td></tr>
        <tr><th>Last status</th><td>${esc(c.last_status)}</td></tr>
        <tr><th>Last run</th><td>${esc(c.last_run || '—')}</td></tr>
        <tr><th>Next run</th><td>${esc(c.next_run || '—')}</td></tr>
      </table>
    `;
  } else {
    body = `<h1>${esc(node.label)}</h1><p>${esc(node.description || '')}</p>`;
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 1.5em; line-height: 1.5; }
  h1 { font-size: 1.4em; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 0.3em; }
  .summary { font-size: 1.05em; color: var(--vscode-descriptionForeground); }
  table { border-collapse: collapse; width: 100%; margin-top: 1em; }
  th, td { text-align: left; padding: 0.4em 0.8em; border-bottom: 1px solid var(--vscode-widget-border); vertical-align: top; }
  th { color: var(--vscode-descriptionForeground); font-weight: normal; width: 8em; }
  code { background: var(--vscode-textCodeBlock-background); padding: 0.1em 0.4em; border-radius: 3px; font-size: 0.9em; }
  a { color: var(--vscode-textLink-foreground); }
  .badge { display: inline-block; padding: 0.15em 0.6em; margin-right: 0.4em; border-radius: 3px; font-size: 0.75em; font-weight: bold; vertical-align: middle; }
  .badge.jira { background: var(--vscode-charts-blue); color: #fff; }
  .badge.wiki { background: var(--vscode-charts-purple); color: #fff; }
  .badge.cron { background: var(--vscode-charts-orange); color: #fff; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}
