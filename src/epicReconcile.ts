import * as fs from 'fs';
import * as path from 'path';

/**
 * Keep delegated epics honest about their subtasks.
 *
 * Only epics Task Beacon wrote (`type: Epic` + `delegated:` in frontmatter)
 * are touched. Rule, evaluated on every wiki scan:
 *   all subtasks done            → status: done
 *   none open, at least one blocked → status: blocked
 *   otherwise                    → status: in-progress
 * Writes only when the value changes. Hand-written epics are left alone.
 */

export interface EpicReconcileResult {
  epic: string;
  from: string;
  to: string;
}

const DONE = new Set(['done', 'completed', 'complete']);
const BLOCKED = new Set(['blocked']);
const CANCELLED = new Set(['cancelled', 'canceled']);

export function reconcileDelegatedEpics(root: string): EpicReconcileResult[] {
  const tasksDir = ['Tasks', 'tasks'].map((d) => path.join(root, d)).find(isDir);
  if (!tasksDir) return [];

  // epic rel path → subtask statuses
  const byEpic = new Map<string, string[]>();
  for (const name of fs.readdirSync(tasksDir)) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    const fm = frontmatter(path.join(tasksDir, name));
    if (!fm) continue;
    const epic = (fm.epic || fm.epic_link || '').replace(/\\/g, '/');
    if (!epic.endsWith('.md')) continue;
    const category = fm.category ?? '';
    if (category !== 'agent-task' && category !== 'agent-cron') continue;
    const list = byEpic.get(epic) ?? [];
    list.push((fm.status ?? '').toLowerCase().replace(/_/g, '-'));
    byEpic.set(epic, list);
  }

  const changes: EpicReconcileResult[] = [];
  for (const [epicRel, statuses] of byEpic) {
    const epicAbs = path.join(root, epicRel);
    if (!fs.existsSync(epicAbs)) continue;
    const fm = frontmatter(epicAbs);
    if (!fm || (fm.type ?? '').toLowerCase() !== 'epic' || !fm.delegated) continue;

    const live = statuses.filter((s) => !CANCELLED.has(s));
    const next =
      live.length > 0 && live.every((s) => DONE.has(s))
        ? 'done'
        : live.some((s) => BLOCKED.has(s)) && live.every((s) => DONE.has(s) || BLOCKED.has(s))
        ? 'blocked'
        : 'in-progress';
    const current = (fm.status ?? '').toLowerCase();
    if (current === next) continue;

    const content = fs.readFileSync(epicAbs, 'utf-8');
    const updated = content.replace(/^status:\s*.*$/m, `status: ${next}`);
    if (updated === content) continue;
    fs.writeFileSync(epicAbs, updated, 'utf-8');
    changes.push({ epic: epicRel, from: current, to: next });
  }
  return changes;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function frontmatter(file: string): Record<string, string> | undefined {
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return undefined;
  }
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return undefined;
  const fm: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!m) continue;
    const raw = m[2].trim();
    if (!raw || raw.startsWith('-') || raw.startsWith('[')) continue;
    fm[m[1]] = raw.replace(/^["']|["']$/g, '');
  }
  return fm;
}
