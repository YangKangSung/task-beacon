import { ShowTodoFull, WikiChannel, WikiTask, normalizeCategory } from './types';
import { jiraBaseUrl } from './jiraConfig';

export type Owner = 'official' | 'private' | 'agent';

export function filterByCategory(wiki: WikiChannel, ...allowed: string[]): WikiChannel {
  const wants = new Set(allowed);
  const keep = (t: WikiTask) => wants.has(normalizeCategory(t.category));
  return {
    ok: wiki.ok,
    error: wiki.error ?? null,
    pending: wiki.pending.filter(keep),
    active: wiki.active.filter(keep),
    completed: wiki.completed.filter(keep),
    cancelled: wiki.cancelled.filter(keep),
  };
}

export function wikiForOwner(wiki: WikiChannel, owner: Owner): WikiChannel {
  if (owner === 'official') return filterByCategory(wiki, 'official');
  if (owner === 'private') return filterByCategory(wiki, 'private', 'unknown', '');
  return filterByCategory(wiki, 'agent-task', 'agent-cron');
}

export function ownerOfWikiTask(t: WikiTask): Owner {
  const c = normalizeCategory(t.category);
  if (c === 'official') return 'official';
  if (c === 'agent-task' || c === 'agent-cron') return 'agent';
  return 'private';
}

export interface OwnerStats {
  official: {
    open: number;
    jira: number;
    wiki: number;
    overdue: number;
    jiraOk: boolean;
    wikiOk: boolean;
    jiraUsed: boolean;
  };
  private: { open: number; active: number; pending: number; wikiOk: boolean };
  agent: {
    open: number;
    tasks: number;
    cronActive: number;
    cronTotal: number;
    failing: number;
    wikiOk: boolean;
    cronOk: boolean;
  };
}

function isOverdue(due: string | null | undefined): boolean {
  if (!due) return false;
  const d = Date.parse(due);
  if (Number.isNaN(d)) return false;
  const now = new Date();
  return d < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function isFail(status: string): boolean {
  const s = (status || '').toLowerCase();
  return s === 'failed' || s === 'error' || s === 'fail';
}

export function ownerStats(data: ShowTodoFull): OwnerStats {
  const wikiOfficial = data.wiki.ok ? wikiForOwner(data.wiki, 'official') : emptyWiki(data.wiki.error);
  const wikiPrivate = data.wiki.ok ? wikiForOwner(data.wiki, 'private') : emptyWiki(data.wiki.error);
  const wikiAgent = data.wiki.ok ? wikiForOwner(data.wiki, 'agent') : emptyWiki(data.wiki.error);

  const jiraCount = data.jira.ok ? data.jira.total : 0;
  const overdue = data.jira.ok
    ? data.jira.in_progress.concat(data.jira.to_do).filter((i) => isOverdue(i.due)).length
    : 0;
  const officialWiki = wikiOfficial.active.length + wikiOfficial.pending.length;
  const jiraUsed = Boolean(jiraBaseUrl()) || jiraCount > 0 || !data.jira.ok;

  const privateActive = wikiPrivate.active.length;
  const privatePending = wikiPrivate.pending.length;

  const agentTasks = wikiAgent.active.length + wikiAgent.pending.length;
  const cronActive = data.cron.ok ? data.cron.jobs.filter((j) => j.state === 'active').length : 0;
  const cronFail = data.cron.ok ? data.cron.jobs.filter((j) => isFail(j.last_status)).length : 0;
  const cronTotal = data.cron.ok ? data.cron.jobs.length : 0;

  return {
    official: {
      open: jiraCount + officialWiki,
      jira: jiraCount,
      wiki: officialWiki,
      overdue,
      jiraOk: data.jira.ok,
      wikiOk: data.wiki.ok,
      jiraUsed,
    },
    private: {
      open: privateActive + privatePending,
      active: privateActive,
      pending: privatePending,
      wikiOk: data.wiki.ok,
    },
    agent: {
      open: agentTasks + cronActive,
      tasks: agentTasks,
      cronActive,
      cronTotal,
      failing: cronFail,
      wikiOk: data.wiki.ok,
      cronOk: data.cron.ok,
    },
  };
}

function emptyWiki(error?: string | null): WikiChannel {
  return { ok: false, error: error ?? null, pending: [], active: [], completed: [], cancelled: [] };
}
