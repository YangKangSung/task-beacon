import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export type WikiKind = 'vault' | 'script' | 'both';

export interface WikiInspect {
  path: string;
  exists: boolean;
  kind?: WikiKind;
  taskFiles?: number;
}

export function configuredWikiRoot(): string {
  return vscode.workspace.getConfiguration('todoView').get<string>('llmWikiRoot', '').trim();
}

export async function setWikiRoot(absPath: string): Promise<void> {
  await vscode.workspace.getConfiguration('todoView').update(
    'llmWikiRoot',
    absPath,
    vscode.ConfigurationTarget.Global
  );
  await refreshSetupContext();
}

export function inspectWikiRoot(root: string): WikiInspect {
  if (!root) return { path: root, exists: false };
  try {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      return { path: root, exists: false };
    }
  } catch {
    return { path: root, exists: false };
  }

  const hasScript = fs.existsSync(path.join(root, 'scripts', 'show_todo.py'));
  const tasksDir = [path.join(root, 'Tasks'), path.join(root, 'tasks')].find(
    (d) => {
      try {
        return fs.existsSync(d) && fs.statSync(d).isDirectory();
      } catch {
        return false;
      }
    }
  );
  let taskFiles = 0;
  if (tasksDir) {
    try {
      taskFiles = fs
        .readdirSync(tasksDir)
        .filter((n) => n.toLowerCase().endsWith('.md') && n.toLowerCase() !== 'index.md').length;
    } catch {
      taskFiles = 0;
    }
  }
  const isVault = Boolean(tasksDir && taskFiles > 0);
  if (hasScript && isVault) return { path: root, exists: true, kind: 'both', taskFiles };
  if (hasScript) return { path: root, exists: true, kind: 'script', taskFiles };
  if (isVault) return { path: root, exists: true, kind: 'vault', taskFiles };
  return { path: root, exists: true, taskFiles };
}

export function isUsableWiki(info: WikiInspect): boolean {
  return Boolean(info.exists && info.kind);
}

export function inspectLabel(info: WikiInspect): string {
  if (!info.path) return 'Not set — choose a folder to see tasks.';
  if (!info.exists) return 'Folder not found.';
  if (info.kind === 'vault' || info.kind === 'both') {
    return `Looks good — ${info.taskFiles ?? 0} task file${info.taskFiles === 1 ? '' : 's'}.`;
  }
  if (info.kind === 'script') return 'Looks good — scripts/show_todo.py found.';
  return 'This folder has no Tasks/*.md and no scripts/show_todo.py.';
}

export function discoverWikiCandidates(): { path: string; label: string; info: WikiInspect }[] {
  const seen = new Set<string>();
  const out: { path: string; label: string; info: WikiInspect }[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const folderPath = folder.uri.fsPath;
    const key = path.resolve(folderPath).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const info = inspectWikiRoot(folderPath);
    if (isUsableWiki(info)) {
      out.push({ path: folderPath, label: folder.name, info });
    }
  }
  return out;
}

export async function pickWikiRoot(): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Use as wiki folder',
    title: 'Task Beacon: choose the folder that holds your tasks',
  });
  const folder = picked?.[0]?.fsPath;
  if (!folder) return undefined;

  const info = inspectWikiRoot(folder);
  if (!isUsableWiki(info)) {
    const choice = await vscode.window.showWarningMessage(
      `"${path.basename(folder)}" has no Tasks/*.md and no scripts/show_todo.py. Use it anyway?`,
      { modal: true },
      'Use anyway',
      'Choose another…'
    );
    if (choice === 'Choose another…') return pickWikiRoot();
    if (choice !== 'Use anyway') return undefined;
  }

  await setWikiRoot(folder);
  vscode.window.setStatusBarMessage(`Beacon: wiki folder set to ${folder}`, 4000);
  return folder;
}

export async function useWorkspaceWikiRoot(): Promise<void> {
  const candidates = discoverWikiCandidates();
  if (candidates.length === 1) {
    await setWikiRoot(candidates[0].path);
    vscode.window.setStatusBarMessage(`Beacon: using ${candidates[0].label}`, 4000);
    return;
  }
  if (candidates.length > 1) {
    const picked = await vscode.window.showQuickPick(
      candidates.map((c) => ({
        label: c.label,
        description: inspectLabel(c.info),
        detail: c.path,
        path: c.path,
      })),
      { placeHolder: 'Which workspace folder is the wiki?' }
    );
    if (picked) await setWikiRoot(picked.path);
    return;
  }

  const folders = vscode.workspace.workspaceFolders;
  if (folders?.length === 1) {
    const choice = await vscode.window.showWarningMessage(
      `"${folders[0].name}" does not look like a wiki (need Tasks/*.md or scripts/show_todo.py).`,
      'Choose folder…',
      'Use anyway'
    );
    if (choice === 'Use anyway') await setWikiRoot(folders[0].uri.fsPath);
    else if (choice === 'Choose folder…') await pickWikiRoot();
    return;
  }

  await pickWikiRoot();
}

export async function refreshSetupContext(): Promise<void> {
  await vscode.commands.executeCommand('setContext', 'taskBeacon.needsWikiRoot', !configuredWikiRoot());
}

export async function openGetStarted(): Promise<void> {
  await vscode.commands.executeCommand(
    'workbench.action.openWalkthrough',
    'YangKangSung.task-beacon#taskBeacon.getStarted',
    false
  );
}

export async function maybeOfferWikiSetup(context: vscode.ExtensionContext): Promise<void> {
  if (configuredWikiRoot()) return;
  if (context.globalState.get('taskBeacon.setupOffered')) return;
  await context.globalState.update('taskBeacon.setupOffered', true);

  const candidates = discoverWikiCandidates();
  if (candidates.length === 1) {
    const choice = await vscode.window.showInformationMessage(
      `Task Beacon found a wiki in "${candidates[0].label}". Use it to fill the sidebar?`,
      'Use this folder',
      'Choose another…',
      'Later'
    );
    if (choice === 'Use this folder') await setWikiRoot(candidates[0].path);
    else if (choice === 'Choose another…') await pickWikiRoot();
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    'Task Beacon needs a wiki folder to show work — an Obsidian vault with Tasks/*.md, or a repo with scripts/show_todo.py.',
    'Choose folder…',
    'Learn more',
    'Later'
  );
  if (choice === 'Choose folder…') await pickWikiRoot();
  else if (choice === 'Learn more') await openGetStarted();
}
