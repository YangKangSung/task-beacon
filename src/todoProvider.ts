import * as vscode from 'vscode';
import { fetchTodoFull, readWikiTaskDetail } from './fetchTodo';
import { CronJob, FilterMode, JiraIssue, ShowTodoFull, TodoNode, WikiTask } from './types';
import { configuredWikiRoot, inspectLabel, inspectWikiRoot, isUsableWiki, usingSampleWiki } from './wikiRoot';
import { jiraBaseUrl } from './jiraConfig';
import { filterByCategory } from './owners';

const ROOT_OFFICIAL = 'root-official';
const ROOT_PRIVATE = 'root-private';
const ROOT_AGENT = 'root-agent';

const MS_DAY = 86400000;

export class TodoTreeItem extends vscode.TreeItem {
  constructor(public readonly node: TodoNode, collapsibleState: vscode.TreeItemCollapsibleState) {
    super(
      node.kind === 'epic' ? { label: node.label, highlights: [[0, node.label.length]] } : node.label,
      collapsibleState
    );
    this.description = node.description;
    this.tooltip = node.tooltip ?? node.label;
    this.contextValue =
      node.kind === 'cron' && node.cronJob
        ? cronContextValue(node.cronJob)
        : node.kind;

    if (node.iconId) {
      this.iconPath = node.iconColor
        ? new vscode.ThemeIcon(node.iconId, new vscode.ThemeColor(node.iconColor))
        : new vscode.ThemeIcon(node.iconId);
    }

    if (node.kind === 'error') {
      this.tooltip = `${node.tooltip ?? node.label}\n\nClick to retry.`;
      this.command = {
        command: 'todoView.refresh',
        title: 'Retry',
      };
    } else if (node.kind === 'action' && node.commandId) {
      this.command = {
        command: node.commandId,
        title: node.label,
      };
    }
  }
}

export class TodoTreeDataProvider implements vscode.TreeDataProvider<TodoNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TodoNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cache: ShowTodoFull | undefined;
  private loadError: string | undefined;
  private loadedEmitter = new vscode.EventEmitter<ShowTodoFull | undefined>();
  readonly onLoaded = this.loadedEmitter.event;
  private filter: FilterMode = 'all';
  private searchQuery = '';

  refresh(): void {
    this.cache = undefined;
    this.loadError = undefined;
    this._onDidChangeTreeData.fire();
  }

  getData(): ShowTodoFull | undefined {
    return this.cache;
  }

  setFilter(mode: FilterMode): void {
    this.filter = mode;
    this._onDidChangeTreeData.fire();
  }

  getFilter(): FilterMode {
    return this.filter;
  }

  setSearch(query: string): void {
    this.searchQuery = query.trim().toLowerCase();
    this._onDidChangeTreeData.fire();
  }

  getSearch(): string {
    return this.searchQuery;
  }

  private matchesSearch(text: string): boolean {
    if (!this.searchQuery) return true;
    return text.toLowerCase().includes(this.searchQuery);
  }

  getTreeItem(node: TodoNode): vscode.TreeItem {
    let collapsible: vscode.TreeItemCollapsibleState;
    if (node.kind === ROOT_OFFICIAL || node.kind === ROOT_PRIVATE || node.kind === ROOT_AGENT) {
      collapsible = vscode.TreeItemCollapsibleState.Expanded;
    } else if (
      (node.kind === 'subhead' || node.kind === 'epic') &&
      node.children &&
      node.children.length > 0
    ) {
      collapsible = vscode.TreeItemCollapsibleState.Collapsed;
    } else {
      collapsible = vscode.TreeItemCollapsibleState.None;
    }
    return new TodoTreeItem(node, collapsible);
  }

  async getChildren(node?: TodoNode): Promise<TodoNode[]> {
    if (!node) {
      return this.getRoots();
    }

    if (!this.cache) {
      return [];
    }

    if ((node.kind === 'subhead' || node.kind === 'epic') && node.children) {
      return node.children;
    }

    switch (node.kind) {
      case ROOT_OFFICIAL:
        return this.officialChildren();
      case ROOT_PRIVATE:
        return this.privateChildren();
      case ROOT_AGENT:
        return this.agentChildren();
      default:
        return [];
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.cache || this.loadError) {
      return;
    }
    try {
      this.cache = await fetchTodoFull();
    } catch (e) {
      this.loadError = (e as Error).message;
    } finally {
      this.loadedEmitter.fire(this.cache);
    }
  }

  private async getRoots(): Promise<TodoNode[]> {
    const root = configuredWikiRoot();
    if (root) {
      const info = inspectWikiRoot(root);
      if (!isUsableWiki(info)) {
        this.loadedEmitter.fire(undefined);
        return wikiSetupRecoveryNodes(info);
      }
    }

    await this.ensureLoaded();

    if (this.loadError) {
      return [
        {
          kind: 'error',
          label: 'Failed to load todo data — click to retry',
          description: this.loadError,
          tooltip: this.loadError,
          iconId: 'error',
          iconColor: 'errorForeground',
        },
      ];
    }

    const data = this.cache!;

    // Category-axis split of wiki tasks. show_todo.py tags each task with
    // category ∈ {official, private, agent-task, agent-cron, unknown}. We fold
    // 'official' wiki tasks under the Jira root and agent-* under Agent.
    // 'private' and 'unknown' land in the Private root.
    const wikiOfficial = data.wiki.ok ? filterByCategory(data.wiki, 'official') : emptyWiki();
    const wikiPrivate = data.wiki.ok ? filterByCategory(data.wiki, 'private', 'unknown', '') : emptyWiki();
    const wikiAgent = data.wiki.ok ? filterByCategory(data.wiki, 'agent-task', 'agent-cron') : emptyWiki();

    const jiraCount = data.jira.ok ? data.jira.total : 0;
    const overdue = data.jira.ok ? countOverdue(data.jira.in_progress.concat(data.jira.to_do)) : 0;
    const officialWikiOpen = wikiOfficial.active.length + wikiOfficial.pending.length;
    const officialTotal = jiraCount + officialWikiOpen;

    const privateActive = wikiPrivate.active.length;
    const privatePending = wikiPrivate.pending.length;
    const privateTotal = privateActive + privatePending;

    const agentTaskTotal = wikiAgent.active.length + wikiAgent.pending.length;
    const cronActive = data.cron.ok ? data.cron.jobs.filter((j) => j.state === 'active').length : 0;
    const cronFail = data.cron.ok ? data.cron.jobs.filter((j) => isFail(j.last_status)).length : 0;
    const cronTotal = data.cron.ok ? data.cron.jobs.length : 0;

    const roots: TodoNode[] = [];

    if (this.filter === 'all' || this.filter === 'official') {
      const parts: string[] = [];
      const jiraConfigured = Boolean(jiraBaseUrl()) || jiraCount > 0 || !data.jira.ok;
      if (jiraConfigured) {
        if (data.jira.ok) parts.push(`Jira ${jiraCount}`);
        else parts.push('Jira · error');
      }
      if (officialWikiOpen > 0) parts.push(`Wiki ${officialWikiOpen}`);
      else if (!jiraConfigured) parts.push('wiki official');
      if (overdue > 0) parts.push(`${overdue} overdue`);
      roots.push({
        kind: ROOT_OFFICIAL,
        label: 'Official',
        description: parts.join('  ·  '),
        tooltip: jiraConfigured
          ? data.jira.ok
            ? `Official work (Jira + wiki category=official)\n${officialTotal} open${overdue ? ` · ${overdue} overdue` : ''}`
            : data.jira.error ?? 'Jira fetch failed'
          : `Official work (wiki category=official — Jira is optional)\n${officialTotal} open${overdue ? ` · ${overdue} overdue` : ''}`,
        iconId: overdue > 0 ? 'flame' : 'briefcase',
        iconColor: overdue > 0 ? 'charts.red' : 'charts.blue',
      });
    }

    if (this.filter === 'all' || this.filter === 'private') {
      roots.push({
        kind: ROOT_PRIVATE,
        label: 'Private',
        description: data.wiki.ok
          ? `LLMWiki · ${privateTotal}${privateActive ? '  ·  ' + privateActive + ' active' : ''}`
          : 'LLMWiki · error',
        tooltip: data.wiki.ok
          ? `Private wiki tasks (category=private/unknown)\n${privateActive} active · ${privatePending} pending`
          : data.wiki.error ?? 'LLMWiki fetch failed',
        iconId: 'home',
        iconColor: 'charts.purple',
      });
    }

    if (this.filter === 'all' || this.filter === 'agent') {
      const parts: string[] = [];
      if (agentTaskTotal > 0) parts.push(`tasks ${agentTaskTotal}`);
      if (cronTotal > 0) parts.push(`cron ${cronActive}/${cronTotal}`);
      if (cronFail > 0) parts.push(`${cronFail} failing`);
      if (parts.length === 0) parts.push('empty');
      roots.push({
        kind: ROOT_AGENT,
        label: 'Agent',
        description: parts.join('  ·  '),
        tooltip: `Agent workload\n${agentTaskTotal} tasks · ${cronTotal} cron jobs${cronFail ? ` · ${cronFail} failing` : ''}`,
        iconId: cronFail > 0 ? 'flame' : 'robot',
        iconColor: cronFail > 0 ? 'charts.red' : 'charts.orange',
      });
    }

    if (usingSampleWiki()) {
      roots.unshift(sampleBannerNode());
    }

    return roots;
  }

  private officialChildren(): TodoNode[] {
    const jira = this.cache!.jira;
    const wiki = this.cache!.wiki;
    const nodes: TodoNode[] = [];

    if (!jira.ok) {
      nodes.push({
        kind: 'error',
        label: 'Jira fetch failed',
        description: jira.error ?? undefined,
        iconId: 'error',
        iconColor: 'errorForeground',
      });
    } else {
      const all = jira.in_progress
        .concat(jira.to_do)
        .filter((i) => this.matchesSearch(`${i.key} ${i.summary}`));
      const overdue = all.filter(isOverdue);

      if (overdue.length > 0) {
        nodes.push({
          kind: 'subhead',
          label: 'Overdue',
          description: `${overdue.length}`,
          iconId: 'flame',
          iconColor: 'charts.red',
          children: groupJiraByEpic(overdue, 'overdue'),
        });
      }

      const inProg = all.filter((i) => !isOverdue(i) && jira.in_progress.includes(i));
      if (inProg.length > 0) {
        nodes.push({
          kind: 'subhead',
          label: 'In Progress',
          description: `${inProg.length}`,
          iconId: 'debug-start',
          iconColor: 'charts.green',
          children: groupJiraByEpic(inProg, 'in-progress'),
        });
      }

      const toDo = all.filter((i) => !isOverdue(i) && jira.to_do.includes(i));
      if (toDo.length > 0) {
        nodes.push({
          kind: 'subhead',
          label: 'To Do',
          description: `${toDo.length}`,
          iconId: 'circle-outline',
          iconColor: 'charts.blue',
          children: groupJiraByEpic(toDo, 'to-do'),
        });
      }
    }

    // Official wiki tasks (category=official) — sibling subhead after Jira.
    if (wiki.ok) {
      const officialWiki = filterByCategory(wiki, 'official');
      const active = officialWiki.active.filter((t) => this.matchesSearch(`${t.title} ${t.note}`));
      const pending = officialWiki.pending.filter((t) => this.matchesSearch(`${t.title} ${t.note}`));

      if (active.length > 0) {
        nodes.push({
          kind: 'subhead',
          label: 'Wiki · Active',
          description: `${active.length}`,
          iconId: 'zap',
          iconColor: 'charts.yellow',
          children: groupWikiByEpic(active, 'active'),
        });
      }

      if (pending.length > 0) {
        nodes.push({
          kind: 'subhead',
          label: 'Wiki · Pending',
          description: `${pending.length}`,
          iconId: 'inbox',
          iconColor: 'charts.purple',
          children: groupWikiByEpic(pending, 'pending'),
        });
      }
    }

    if (nodes.length === 0) {
      nodes.push(inboxZeroNode('no open official work'));
    }

    return nodes;
  }

  private privateChildren(): TodoNode[] {
    const wiki = this.cache!.wiki;
    if (!wiki.ok) {
      return [
        {
          kind: 'error',
          label: 'LLMWiki fetch failed',
          description: wiki.error ?? undefined,
          iconId: 'error',
          iconColor: 'errorForeground',
        },
      ];
    }

    // Category 'private' plus tasks with no category (empty/unknown) — those
    // are personal notes yet to be classified and default to Private.
    const priv = filterByCategory(wiki, 'private', 'unknown', '');
    const active = priv.active.filter((t) => this.matchesSearch(`${t.title} ${t.note}`));
    const pending = priv.pending.filter((t) => this.matchesSearch(`${t.title} ${t.note}`));
    const nodes: TodoNode[] = [];

    if (active.length > 0) {
      nodes.push({
        kind: 'subhead',
        label: 'Active',
        description: `${active.length}`,
        iconId: 'zap',
        iconColor: 'charts.yellow',
        children: groupWikiByEpic(active, 'active'),
      });
    }

    if (pending.length > 0) {
      nodes.push({
        kind: 'subhead',
        label: 'Pending',
        description: `${pending.length}`,
        iconId: 'inbox',
        iconColor: 'charts.purple',
        children: groupWikiByEpic(pending, 'pending'),
      });
    }

    if (nodes.length === 0) {
      nodes.push(inboxZeroNode('no active or pending private tasks'));
    }

    return nodes;
  }

  /** Agent bucket: agent-* wiki tasks + Hermes cron jobs, split into two
   * top-level subheads ('Tasks' and 'Cron') so the two automation streams
   * stay visually distinct while sharing the same category axis. */
  private agentChildren(): TodoNode[] {
    const wiki = this.cache!.wiki;
    const cron = this.cache!.cron;
    const nodes: TodoNode[] = [];

    // --- Tasks subgroup (wiki category = agent-task / agent-cron) ---
    if (!wiki.ok) {
      nodes.push({
        kind: 'error',
        label: 'LLMWiki fetch failed',
        description: wiki.error ?? undefined,
        iconId: 'error',
        iconColor: 'errorForeground',
      });
    } else {
      const agent = filterByCategory(wiki, 'agent-task', 'agent-cron');
      const active = agent.active.filter((t) => this.matchesSearch(`${t.title} ${t.note}`));
      const pending = agent.pending.filter((t) => this.matchesSearch(`${t.title} ${t.note}`));
      const taskChildren: TodoNode[] = [];

      if (active.length > 0) {
        taskChildren.push({
          kind: 'subhead',
          label: 'Active',
          description: `${active.length}`,
          iconId: 'zap',
          iconColor: 'charts.yellow',
          children: groupWikiByEpic(active, 'active'),
        });
      }
      if (pending.length > 0) {
        taskChildren.push({
          kind: 'subhead',
          label: 'Pending',
          description: `${pending.length}`,
          iconId: 'inbox',
          iconColor: 'charts.purple',
          children: groupWikiByEpic(pending, 'pending'),
        });
      }

      nodes.push({
        kind: 'subhead',
        label: 'Tasks',
        description: taskChildren.length > 0 ? `${active.length + pending.length}` : 'empty',
        iconId: 'robot',
        iconColor: 'charts.blue',
        children: taskChildren.length > 0 ? taskChildren : [inboxZeroNode('no agent tasks')],
      });
    }

    // --- Cron subgroup (all Hermes cron jobs) ---
    if (!cron.ok) {
      nodes.push({
        kind: 'error',
        label: 'Cron fetch failed',
        description: cron.error ?? undefined,
        iconId: 'error',
        iconColor: 'errorForeground',
      });
    } else {
      const jobs = cron.jobs.filter((j) => this.matchesSearch(`${j.name} ${j.schedule}`));
      const failing = jobs.filter((j) => isFail(j.last_status));
      const active = jobs.filter((j) => j.state === 'active' && !isFail(j.last_status));
      const idle = jobs.filter((j) => j.state !== 'active' && !isFail(j.last_status));
      const cronChildren: TodoNode[] = [];

      if (failing.length > 0) {
        cronChildren.push({
          kind: 'subhead',
          label: 'Failing',
          description: `${failing.length}`,
          iconId: 'flame',
          iconColor: 'charts.red',
          children: failing.map((job) => cronNode(job, 'failing')),
        });
      }
      if (active.length > 0) {
        cronChildren.push({
          kind: 'subhead',
          label: 'Active',
          description: `${active.length}`,
          iconId: 'watch',
          iconColor: 'charts.orange',
          children: active.map((job) => cronNode(job, 'active')),
        });
      }
      if (idle.length > 0) {
        cronChildren.push({
          kind: 'subhead',
          label: 'Idle',
          description: `${idle.length}`,
          iconId: 'circle-slash',
          iconColor: 'disabledForeground',
          children: idle.map((job) => cronNode(job, 'idle')),
        });
      }

      nodes.push({
        kind: 'subhead',
        label: 'Cron',
        description: cronChildren.length > 0 ? `${jobs.length}` : 'empty',
        iconId: 'clock',
        iconColor: 'charts.orange',
        children:
          cronChildren.length > 0
            ? cronChildren
            : [
                {
                  kind: 'subhead',
                  label: 'No live cron jobs',
                  description: 'wiki agent-cron · .task-beacon/jobs.json · Hermes / Claude / Actions',
                  iconId: 'info',
                  iconColor: 'charts.foreground',
                },
              ],
      });
    }

    return nodes;
  }
}

function sampleBannerNode(): TodoNode {
  return {
    kind: 'action',
    label: 'Showing sample tasks',
    description: 'Choose your wiki folder…',
    tooltip: 'These rows are bundled samples. Your settings stay empty until you pick a folder.',
    iconId: 'lightbulb',
    iconColor: 'charts.yellow',
    commandId: 'todoView.pickWikiRoot',
  };
}

function wikiSetupRecoveryNodes(info: ReturnType<typeof inspectWikiRoot>): TodoNode[] {
  return [
    {
      kind: 'action',
      label: inspectLabel(info),
      description: info.path,
      tooltip: info.path,
      iconId: 'warning',
      iconColor: 'charts.orange',
      commandId: 'todoView.pickWikiRoot',
    },
    {
      kind: 'action',
      label: 'Add sample tasks here',
      iconId: 'new-file',
      commandId: 'todoView.seedSamples',
    },
    {
      kind: 'action',
      label: 'Choose another folder…',
      iconId: 'folder-opened',
      commandId: 'todoView.pickWikiRoot',
    },
    {
      kind: 'action',
      label: 'What is a wiki folder?',
      iconId: 'question',
      commandId: 'todoView.getStarted',
    },
  ];
}

function emptyWiki(): import('./types').WikiChannel {
  return { ok: true, error: null, pending: [], active: [], completed: [], cancelled: [] };
}

/** Groups issues into per-epic subgroups within a status subhead. Issues with
 * no epic_key fall into a flat trailing list, not a "No Epic" bucket, since
 * most of a user's own-assigned issues have no Epic Link set at all. */
function groupJiraByEpic(issues: JiraIssue[], group: 'in-progress' | 'to-do' | 'overdue'): TodoNode[] {
  const byEpic = new Map<string, JiraIssue[]>();
  const noEpic: JiraIssue[] = [];
  for (const issue of issues) {
    if (issue.epic_key) {
      const list = byEpic.get(issue.epic_key) ?? [];
      list.push(issue);
      byEpic.set(issue.epic_key, list);
    } else {
      noEpic.push(issue);
    }
  }

  const nodes: TodoNode[] = [];
  for (const [epicKey, epicIssues] of byEpic) {
    nodes.push(epicNode(epicKey, epicIssues.map((issue) => jiraNode(issue, group))));
  }
  nodes.push(...noEpic.map((issue) => jiraNode(issue, group)));
  return nodes;
}

/** Same epic-grouping as groupJiraByEpic() but for LLMWiki tasks, whose
 * epic_link comes from frontmatter (readWikiTaskDetail), not show_todo.py —
 * only ~4 task files set it today, so most tasks fall through to the flat
 * trailing list. */
function groupWikiByEpic(tasks: WikiTask[], state: 'active' | 'pending'): TodoNode[] {
  const byEpic = new Map<string, WikiTask[]>();
  const noEpic: WikiTask[] = [];
  for (const t of tasks) {
    const fm = readWikiTaskDetail(t.file)?.frontmatter;
    const epicKey = t.epicKey ?? fm?.epic_link ?? fm?.epic;
    if (epicKey) {
      const list = byEpic.get(epicKey) ?? [];
      list.push(t);
      byEpic.set(epicKey, list);
    } else {
      noEpic.push(t);
    }
  }

  const nodes: TodoNode[] = [];
  for (const [epicKey, epicTasks] of byEpic) {
    nodes.push(epicNode(epicKey, epicTasks.map((t) => taskNode(t, state))));
  }
  nodes.push(...noEpic.map((t) => taskNode(t, state)));
  return nodes;
}

function epicNode(epicKey: string, children: TodoNode[]): TodoNode {
  const openHint = epicKey.endsWith('.md') ? 'Click to open task file' : 'Click to open in Jira';
  return {
    kind: 'epic',
    label: epicKey,
    description: `Epic · ${children.length}`,
    tooltip: `Epic ${epicKey}\n${openHint}`,
    iconId: 'rocket',
    iconColor: 'charts.purple',
    epicKey,
    children,
  };
}

function taskNode(t: WikiTask, state: 'active' | 'pending'): TodoNode {
  const fm = readWikiTaskDetail(t.file)?.frontmatter;
  const epicKey = t.epicKey ?? fm?.epic_link ?? fm?.epic;
  // Prepend category badge to label so the 4-category classification is visible
  // in the tree view at a glance. Mirrors show_todo.py display format.
  const catBadge = t.category ? `[${t.category}] ` : '';
  return {
    kind: 'task',
    label: catBadge + t.title,
    description: t.note,
    tooltip: buildTaskTooltip(t, state, epicKey),
    iconId: state === 'active' ? 'flame' : 'circle-outline',
    iconColor: state === 'active' ? 'charts.yellow' : 'charts.purple',
    wikiTask: t,
    wikiTaskState: state,
  };
}

function jiraNode(issue: JiraIssue, group: 'in-progress' | 'to-do' | 'overdue'): TodoNode {
  const overdue = group === 'overdue';
  const priorityColor = prioColor(issue.priority);
  const dueLabel = issue.due
    ? overdue
      ? `${daysUntil(issue.due)}d overdue`
      : `due ${issue.due}`
    : '';
  const age = daysSince(issue.updated);
  const descParts = [issue.summary, prioSymbol(issue.priority)];
  if (dueLabel) descParts.push(dueLabel);
  if (age !== null && age >= 7) descParts.push(`idle ${age}d`);

  let iconId: string;
  let iconColor: string;
  if (overdue) {
    iconId = 'flame';
    iconColor = 'charts.red';
  } else if (group === 'in-progress') {
    iconId = 'record';
    iconColor = 'charts.green';
  } else {
    iconId = 'circle-outline';
    iconColor = priorityColor ?? 'charts.blue';
  }

  return {
    kind: 'jira',
    label: issue.key,
    description: descParts.join('   ·   '),
    tooltip: buildJiraTooltip(issue, overdue),
    iconId,
    iconColor,
    jiraIssue: issue,
    jiraGroup: group,
  };
}

function cronContextValue(job: CronJob): string {
  const src = job.source === 'hermes' ? 'hermes' : 'other';
  return job.state === 'paused' ? `cron-${src}-paused` : `cron-${src}-active`;
}

function cronNode(job: CronJob, group: 'active' | 'idle' | 'failing'): TodoNode {
  const status = job.last_status || 'never';
  const desc = [job.sourceLabel, job.schedule, statusSymbol(status)].filter(Boolean);
  if (job.last_run) {
    const age = daysSinceIso(job.last_run);
    if (age !== null) desc.push(`${age}d ago`);
  }

  let iconId: string;
  let iconColor: string;
  if (group === 'failing') {
    iconId = 'flame';
    iconColor = 'charts.red';
  } else if (group === 'idle') {
    iconId = 'circle-slash';
    iconColor = 'disabledForeground';
  } else {
    iconId = statusIcon(status);
    iconColor = statusColor(status);
  }

  return {
    kind: 'cron',
    label: job.name,
    description: desc.join('   ·   '),
    tooltip: buildCronTooltip(job),
    iconId,
    iconColor,
    cronJob: job,
    cronGroup: group,
  };
}

function inboxZeroNode(sub: string): TodoNode {
  return {
    kind: 'subhead',
    label: 'Inbox zero',
    description: sub,
    iconId: 'sparkle',
    iconColor: 'charts.green',
  };
}

function countOverdue(issues: JiraIssue[]): number {
  return issues.filter(isOverdue).length;
}

function isOverdue(issue: JiraIssue): boolean {
  if (!issue.due) return false;
  const due = Date.parse(issue.due);
  if (Number.isNaN(due)) return false;
  return due < startOfToday();
}

function daysUntil(due: string): number {
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

function prioSymbol(priority: string): string {
  const p = priority.toLowerCase();
  if (p.includes('highest') || p.includes('critical') || p.includes('block')) return '↑↑';
  if (p.includes('high')) return '↑';
  if (p.includes('medium')) return '=';
  if (p.includes('low')) return '↓';
  return priority || '·';
}

function prioColor(priority: string): string | undefined {
  const p = priority.toLowerCase();
  if (p.includes('highest') || p.includes('critical') || p.includes('block')) return 'charts.red';
  if (p.includes('high')) return 'charts.orange';
  if (p.includes('medium')) return 'charts.yellow';
  if (p.includes('low')) return 'disabledForeground';
  return undefined;
}

function statusSymbol(status: string): string {
  const s = (status || '').toLowerCase();
  if (s === 'success' || s === 'ok') return 'ok';
  if (s === 'failed' || s === 'error' || s === 'fail') return 'fail';
  if (s === 'running') return 'run';
  if (!s || s === 'n/a' || s === 'never') return 'idle';
  return status;
}

function statusIcon(status: string): string {
  const s = (status || '').toLowerCase();
  if (s === 'success' || s === 'ok') return 'pass';
  if (s === 'failed' || s === 'error' || s === 'fail') return 'error';
  if (s === 'running') return 'sync~spin';
  return 'clock';
}

function statusColor(status: string): string {
  const s = (status || '').toLowerCase();
  if (s === 'success' || s === 'ok') return 'charts.green';
  if (s === 'failed' || s === 'error' || s === 'fail') return 'charts.red';
  if (s === 'running') return 'charts.blue';
  return 'charts.orange';
}

function buildJiraTooltip(issue: JiraIssue, overdue: boolean): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.supportThemeIcons = true;
  md.isTrusted = false;
  md.appendMarkdown(`**${issue.key}** — ${escapeMd(issue.summary)}\n\n`);
  if (overdue && issue.due) {
    md.appendMarkdown(`> $(flame) **${daysUntil(issue.due)}d overdue** (due \`${issue.due}\`)\n\n`);
  }
  md.appendMarkdown(`- Status: \`${issue.status}\`\n`);
  md.appendMarkdown(`- Priority: \`${issue.priority}\`\n`);
  if (issue.epic_key) md.appendMarkdown(`- Epic: **$(rocket) ${escapeMd(issue.epic_key)}**\n`);
  if (issue.due && !overdue) md.appendMarkdown(`- Due: \`${issue.due}\`\n`);
  if (issue.labels.length) md.appendMarkdown(`- Labels: ${issue.labels.map((l) => '`' + l + '`').join(' ')}\n`);
  if (issue.components.length) md.appendMarkdown(`- Components: ${issue.components.map((c) => '`' + c + '`').join(' ')}\n`);
  md.appendMarkdown(`- Updated: ${issue.updated}\n`);
  return md;
}

function buildCronTooltip(job: CronJob): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.supportThemeIcons = true;
  md.appendMarkdown(`**${escapeMd(job.name)}**\n\n`);
  const failing = isFail(job.last_status);
  if (failing) {
    md.appendMarkdown(`> $(flame) **Failing** — last run status \`${job.last_status}\`\n\n`);
  }
  md.appendMarkdown(`- ID: \`${job.id}\`\n`);
  if (job.sourceLabel) md.appendMarkdown(`- Source: \`${job.sourceLabel}\`\n`);
  md.appendMarkdown(`- State: \`${job.state}\`\n`);
  md.appendMarkdown(`- Schedule: \`${job.schedule}\`\n`);
  md.appendMarkdown(`- Last run: ${job.last_run ?? '_n/a_'} (\`${job.last_status}\`)\n`);
  md.appendMarkdown(`- Next run: ${job.next_run ?? '_n/a_'}\n`);
  return md;
}

function buildTaskTooltip(
  t: { title: string; file: string; note: string; category?: string },
  state: 'active' | 'pending',
  epicKey?: string
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.supportThemeIcons = true;
  const icon = state === 'active' ? '$(flame)' : '$(inbox)';
  md.appendMarkdown(`${icon} **${escapeMd(t.title)}**\n\n`);
  md.appendMarkdown(`- File: \`${t.file}\`\n`);
  md.appendMarkdown(`- State: \`${state}\`\n`);
  // Category badge with color/icon mapping (added 2026-07-25)
  if (t.category) {
    const catIcon = categoryIcon(t.category);
    md.appendMarkdown(`- Category: ${catIcon} **${escapeMd(t.category)}**\n`);
  }
  if (epicKey) md.appendMarkdown(`- Epic: **$(rocket) ${escapeMd(epicKey)}**\n`);
  if (t.note) md.appendMarkdown(`\n${escapeMd(t.note)}\n`);
  return md;
}

/** Maps category value → VS Code theme icon for visual distinction.
 * Added 2026-07-25 to extend the 4-category system into the tooltip UI.
 */
function categoryIcon(category: string): string {
  switch (category) {
    case 'official': return '$(briefcase)';
    case 'private': return '$(home)';
    case 'agent-task':
    case 'veda-task': return '$(robot)';
    case 'agent-cron':
    case 'veda-cron': return '$(clock)';
    case 'unknown': return '$(question)';
    default: return '$(tag)';
  }
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\[\]])/g, '\\$1');
}
