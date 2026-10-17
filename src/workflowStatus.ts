import { JiraChannel, JiraIssue } from './types';

/** Open-board bucket. Jira workflow names and wiki frontmatter share this. */
export type WorkflowBucket = 'active' | 'pending' | 'completed' | 'cancelled';

/**
 * Case-insensitive workflow key. Spaces, underscores, and hyphens are removed
 * so "In Progress", "in_progress", and "in-progress" are the same status.
 */
export function workflowKey(raw: string | undefined): string {
  return (raw ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

/**
 * Jira epic workflow: To Do, In Progress, Reopened, Resolved, Closed.
 * Wiki aliases (active, doing, wip, done, blocked, cancelled) stay on the same scale.
 * Unrecognized text returns undefined so callers can keep the source array.
 */
export function workflowBucket(raw: string | undefined): WorkflowBucket | undefined {
  const key = workflowKey(raw);
  if (!key) return undefined;
  if (key === 'inprogress' || key === 'active' || key === 'doing' || key === 'wip' || key === 'reopened') {
    return 'active';
  }
  if (key === 'todo' || key === 'pending' || key === 'blocked') return 'pending';
  if (key === 'done' || key === 'completed' || key === 'complete' || key === 'resolved' || key === 'closed') {
    return 'completed';
  }
  if (key === 'cancelled' || key === 'canceled') return 'cancelled';
  return undefined;
}

/** Wiki files with no status, or a status outside the workflow list, stay pending. */
export function wikiStatusBucket(raw: string | undefined): WorkflowBucket {
  return workflowBucket(raw) ?? 'pending';
}

export interface JiraWorkflowSplit {
  active: JiraIssue[];
  todo: JiraIssue[];
  done: JiraIssue[];
}

/**
 * Place each Jira issue by its workflow status, not by the in_progress / to_do
 * array it arrived in. Resolved and Closed leave the open board. A status this
 * list does not know stays in the array show_todo.py already chose.
 */
export function splitJiraByWorkflow(jira: Pick<JiraChannel, 'in_progress' | 'to_do'>): JiraWorkflowSplit {
  const active: JiraIssue[] = [];
  const todo: JiraIssue[] = [];
  const done: JiraIssue[] = [];
  const seen = new Set<string>();

  const take = (issue: JiraIssue, fromActiveArray: boolean) => {
    if (seen.has(issue.key)) return;
    seen.add(issue.key);
    const bucket = workflowBucket(issue.status);
    if (bucket === 'active') active.push(issue);
    else if (bucket === 'pending') todo.push(issue);
    else if (bucket === 'completed' || bucket === 'cancelled') done.push(issue);
    else if (fromActiveArray) active.push(issue);
    else todo.push(issue);
  };

  for (const issue of jira.in_progress) take(issue, true);
  for (const issue of jira.to_do) take(issue, false);
  return { active, todo, done };
}
