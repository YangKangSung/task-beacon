import * as fs from 'fs';
import * as path from 'path';
import { ShowTodoFull } from './types';
import { ownerStats } from './owners';

export interface SnapshotRecord {
  ts: number;
  jira: { total: number; overdue: number; inProgress: number; toDo: number };
  wiki: { pending: number; active: number; completed: number; cancelled: number };
  cron: { active: number; failing: number; total: number; idle: number };
  owners?: {
    official: number;
    private: number;
    agent: number;
    officialOverdue: number;
    agentFailing: number;
  };
}

const MAX_ENTRIES = 5000;
const MIN_INTERVAL_MS = 60 * 60 * 1000;

/** Append-only JSONL snapshot log, one line per meaningfully-changed refresh.
 * show_todo.py only ever returns a live snapshot, so this is the only place
 * the "trend over time" chart's history comes from — it starts empty and
 * builds up from whenever this store first runs, not retroactively. */
export class HistoryStore {
  private readonly filePath: string;

  constructor(storageDir: string) {
    fs.mkdirSync(storageDir, { recursive: true });
    this.filePath = path.join(storageDir, 'history.jsonl');
  }

  appendSnapshot(data: ShowTodoFull): void {
    const record = buildRecord(data);
    const history = this.readHistory();
    const last = history[history.length - 1];
    if (last && !changed(last, record) && record.ts - last.ts < MIN_INTERVAL_MS) {
      return;
    }
    fs.appendFileSync(this.filePath, JSON.stringify(record) + '\n', 'utf-8');
    if (history.length + 1 > MAX_ENTRIES) {
      this.trim([...history, record]);
    }
  }

  readHistory(): SnapshotRecord[] {
    if (!fs.existsSync(this.filePath)) return [];
    const lines = fs.readFileSync(this.filePath, 'utf-8').split(/\r?\n/).filter(Boolean);
    const records: SnapshotRecord[] = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {
        continue;
      }
    }
    return records;
  }

  private trim(history: SnapshotRecord[]): void {
    const trimmed = history.slice(history.length - MAX_ENTRIES);
    fs.writeFileSync(this.filePath, trimmed.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  }
}

function buildRecord(data: ShowTodoFull): SnapshotRecord {
  const overdue = data.jira.ok
    ? data.jira.in_progress.concat(data.jira.to_do).filter((i) => isOverdue(i.due)).length
    : 0;
  const cronFailing = data.cron.ok ? data.cron.jobs.filter((j) => isFail(j.last_status)).length : 0;
  const cronActive = data.cron.ok
    ? data.cron.jobs.filter((j) => j.state === 'active' && !isFail(j.last_status)).length
    : 0;
  const owners = ownerStats(data);
  return {
    ts: Date.now(),
    jira: {
      total: data.jira.ok ? data.jira.total : 0,
      overdue,
      inProgress: data.jira.ok ? data.jira.in_progress.length : 0,
      toDo: data.jira.ok ? data.jira.to_do.length : 0,
    },
    wiki: {
      pending: data.wiki.ok ? data.wiki.pending.length : 0,
      active: data.wiki.ok ? data.wiki.active.length : 0,
      completed: data.wiki.ok ? data.wiki.completed.length : 0,
      cancelled: data.wiki.ok ? data.wiki.cancelled.length : 0,
    },
    cron: {
      active: cronActive,
      failing: cronFailing,
      total: data.cron.ok ? data.cron.jobs.length : 0,
      idle: data.cron.ok
        ? data.cron.jobs.filter((j) => j.state !== 'active' && !isFail(j.last_status)).length
        : 0,
    },
    owners: {
      official: owners.official.open,
      private: owners.private.open,
      agent: owners.agent.open,
      officialOverdue: owners.official.overdue,
      agentFailing: owners.agent.failing,
    },
  };
}

function changed(a: SnapshotRecord, b: SnapshotRecord): boolean {
  return (
    a.jira.total !== b.jira.total ||
    a.jira.overdue !== b.jira.overdue ||
    a.jira.inProgress !== b.jira.inProgress ||
    a.jira.toDo !== b.jira.toDo ||
    a.wiki.pending !== b.wiki.pending ||
    a.wiki.active !== b.wiki.active ||
    a.wiki.completed !== b.wiki.completed ||
    a.wiki.cancelled !== b.wiki.cancelled ||
    a.cron.active !== b.cron.active ||
    a.cron.failing !== b.cron.failing ||
    a.cron.total !== b.cron.total ||
    a.cron.idle !== b.cron.idle ||
    a.owners?.official !== b.owners?.official ||
    a.owners?.private !== b.owners?.private ||
    a.owners?.agent !== b.owners?.agent ||
    a.owners?.officialOverdue !== b.owners?.officialOverdue ||
    a.owners?.agentFailing !== b.owners?.agentFailing
  );
}

function isOverdue(due: string | null): boolean {
  if (!due) return false;
  const d = Date.parse(due);
  return !Number.isNaN(d) && d < startOfToday();
}

function startOfToday(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function isFail(status: string): boolean {
  const s = (status || '').toLowerCase();
  return s === 'failed' || s === 'error' || s === 'fail';
}
