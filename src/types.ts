export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  priority: string;
  labels: string[];
  components: string[];
  updated: string;
  due: string | null;
  epic_key?: string | null;
}

export interface JiraChannel {
  ok: boolean;
  total: number;
  in_progress: JiraIssue[];
  to_do: JiraIssue[];
  error?: string | null;
}

export interface WikiTask {
  title: string;
  file: string;
  note: string;
  epicKey?: string;
  /** 4-category classification from tasks/*.md frontmatter.
   * Added 2026-07-25 to mirror show_todo.py category system.
   * Values: 'official' | 'private' | 'veda-task' | 'veda-cron' | 'unknown' | ''
   */
  category?: string;
}

export interface WikiChannel {
  ok: boolean;
  error?: string | null;
  pending: WikiTask[];
  active: WikiTask[];
  completed: WikiTask[];
  cancelled: WikiTask[];
}

export interface CronJob {
  id: string;
  state: string;
  name: string;
  schedule: string;
  last_status: string;
  last_run: string | null;
  next_run: string | null;
}

export interface CronChannel {
  ok: boolean;
  error?: string | null;
  jobs: CronJob[];
}

export interface ShowTodoFull {
  jira: JiraChannel;
  wiki: WikiChannel;
  cron: CronChannel;
}

export type TodoNodeKind =
  | 'root-official'
  | 'root-private'
  | 'root-agent'
  | 'subhead'
  | 'epic'
  | 'jira'
  | 'task'
  | 'cron'
  | 'error';

export type FilterMode = 'all' | 'official' | 'private' | 'agent';

export interface TodoNode {
  kind: TodoNodeKind;
  label: string;
  description?: string;
  tooltip?: string | import('vscode').MarkdownString;
  iconId?: string;
  iconColor?: string;
  jiraIssue?: JiraIssue;
  jiraGroup?: 'in-progress' | 'to-do' | 'overdue';
  wikiTask?: WikiTask;
  wikiTaskState?: 'pending' | 'active' | 'completed' | 'cancelled';
  cronJob?: CronJob;
  cronGroup?: 'active' | 'idle' | 'failing';
  epicKey?: string;
  children?: TodoNode[];
}

/** Raw shape of ~/.hermes/cron/jobs.json — used only to resolve a job's script path. */
export interface HermesJobsFile {
  jobs: Array<{
    id: string;
    script?: string;
    [key: string]: unknown;
  }>;
}
