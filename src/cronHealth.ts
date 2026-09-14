import { CronJob } from './types';

/**
 * Cron health — "is the thing that should be ticking actually ticking?"
 *
 * Every scheduler dies the same way from the outside: a job's due time passes
 * and nothing records a run. That is the only signal we can read for every
 * source from files alone, so that is what "ok" means here: the job's last
 * due time has been honoured. We never claim to have seen the controller
 * process itself. Cloud-ticked sources (GitHub Actions) are reported as
 * "cloud", not "ok".
 */

export type HealthState = 'ok' | 'overdue' | 'unknown' | 'cloud' | 'paused';

export interface CronHealth {
  state: HealthState;
  /** One sentence a human can check against the job file. */
  reason: string;
  /** ISO time of the fire we judged against, when known. */
  dueAt?: string;
  /** How late the missed fire is, when overdue. */
  lateMs?: number;
}

export interface HealthSummary {
  /** broken = at least one overdue; ok = at least one ok and none overdue; unknown = nothing assessable. */
  state: 'ok' | 'broken' | 'unknown';
  ok: number;
  overdue: number;
  unknown: number;
  cloud: number;
  paused: number;
  /** Most-late overdue job, for the headline. */
  worst?: CronJob;
}

/** Hermes ticks every 60s and long runs update next_run only on completion;
 * ten minutes keeps a slow job from flashing "broken". */
export const GRACE_MS = 10 * 60_000;

const CLOUD_SOURCES = new Set(['github-actions']);

export function annotateHealth(jobs: CronJob[], now: Date = new Date()): void {
  for (const job of jobs) job.health = assessJobHealth(job, now);
}

export function assessJobHealth(job: CronJob, now: Date = new Date()): CronHealth {
  if (job.state === 'paused') return { state: 'paused', reason: 'Paused — not expected to fire.' };
  if (CLOUD_SOURCES.has(job.source ?? '')) {
    return { state: 'cloud', reason: `${job.sourceLabel ?? 'Cloud'} ticks this job; not checked locally.` };
  }

  const lastRun = parseIso(job.last_run);
  const nextRun = parseIso(job.next_run);

  let due: Date | undefined = nextRun;
  let basis = 'next_run';
  if (!due) {
    if (!lastRun) {
      return {
        state: 'unknown',
        reason: 'No next_run and no last_run recorded — cannot tell whether it fires.',
      };
    }
    due = nextAfter(job.schedule, lastRun);
    basis = 'schedule after last_run';
    if (!due) {
      return {
        state: 'unknown',
        reason: `Schedule "${job.schedule || '—'}" is not a cron expression or interval I can compute.`,
      };
    }
  }

  // Fired since the due time → the scheduler is alive even if next_run is stale.
  if (lastRun && lastRun.getTime() >= due.getTime()) {
    return { state: 'ok', reason: `Ran ${fmt(lastRun)}, after the ${fmt(due)} fire.`, dueAt: due.toISOString() };
  }

  const late = now.getTime() - due.getTime();
  if (late <= GRACE_MS) {
    return {
      state: 'ok',
      reason: late > 0 ? `Due ${fmt(due)}, within the ${GRACE_MS / 60000}-minute grace.` : `Next fire ${fmt(due)} (${basis}).`,
      dueAt: due.toISOString(),
    };
  }
  return {
    state: 'overdue',
    reason: `Was due ${fmt(due)} (${basis}); no run recorded since${lastRun ? ` — last run ${fmt(lastRun)}` : ''}. The scheduler that owns it may be down.`,
    dueAt: due.toISOString(),
    lateMs: late,
  };
}

export function summarizeHealth(jobs: CronJob[]): HealthSummary {
  const s: HealthSummary = { state: 'unknown', ok: 0, overdue: 0, unknown: 0, cloud: 0, paused: 0 };
  for (const job of jobs) {
    const h = job.health;
    if (!h) continue;
    s[h.state]++;
    if (h.state === 'overdue' && (!s.worst || (h.lateMs ?? 0) > (s.worst.health?.lateMs ?? 0))) s.worst = job;
  }
  s.state = s.overdue > 0 ? 'broken' : s.ok > 0 ? 'ok' : 'unknown';
  return s;
}

/** One summary per source id, in first-seen order. */
export function healthBySource(jobs: CronJob[]): Array<{ source: string; label: string; summary: HealthSummary }> {
  const groups = new Map<string, CronJob[]>();
  for (const job of jobs) {
    const key = job.source ?? 'unknown';
    const list = groups.get(key) ?? [];
    list.push(job);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([source, list]) => ({
    source,
    label: baseLabel(list[0].sourceLabel) || source,
    summary: summarizeHealth(list),
  }));
}

/** "Task Beacon · hermes" → "Task Beacon". */
function baseLabel(label?: string): string {
  return (label ?? '').split('·')[0].trim();
}

export function healthGlyph(state: HealthSummary['state'] | HealthState): string {
  switch (state) {
    case 'ok':
      return '♥';
    case 'broken':
    case 'overdue':
      return '💔';
    case 'cloud':
      return '☁';
    case 'paused':
      return '⏸';
    default:
      return '♡';
  }
}

export function formatLate(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// ── Schedules ─────────────────────────────────────────────────────

/** Next fire strictly after `after`, for a 5-field cron or a simple interval. */
export function nextAfter(schedule: string, after: Date): Date | undefined {
  const s = (schedule || '').trim();
  if (!s) return undefined;
  const cron = parseCron(s);
  if (cron) return nextCronAfter(cron, after);
  const interval = parseIntervalMs(s);
  if (interval) return new Date(after.getTime() + interval);
  return undefined;
}

export interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function parseCron(expr: string): CronSpec | undefined {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const minute = parseField(parts[0], 0, 59);
  const hour = parseField(parts[1], 0, 23);
  const dom = parseField(parts[2], 1, 31);
  const month = parseField(parts[3], 1, 12, MONTHS, 1);
  const dow = parseField(parts[4], 0, 7, DAYS, 0);
  if (!minute || !hour || !dom || !month || !dow) return undefined;
  if (dow.has(7)) {
    dow.delete(7);
    dow.add(0);
  }
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domAny: parts[2] === '*',
    dowAny: parts[4] === '*',
  };
}

function parseField(field: string, min: number, max: number, names?: string[], nameBase = 0): Set<number> | undefined {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const m = part.match(/^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/i);
    if (!m) return undefined;
    const step = m[2] ? Number(m[2]) : 1;
    if (!step || step < 1) return undefined;
    let lo: number;
    let hi: number;
    if (m[1] === '*') {
      lo = min;
      hi = max;
    } else {
      const [a, b] = m[1].split('-');
      const av = value(a, names, nameBase);
      const bv = b === undefined ? (m[2] ? max : av) : value(b, names, nameBase);
      if (av === undefined || bv === undefined) return undefined;
      lo = av;
      hi = bv;
    }
    if (lo < min || hi > max || lo > hi) return undefined;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size ? out : undefined;
}

function value(token: string, names: string[] | undefined, nameBase: number): number | undefined {
  if (/^\d+$/.test(token)) return Number(token);
  if (!names) return undefined;
  const idx = names.indexOf(token.slice(0, 3).toLowerCase());
  return idx < 0 ? undefined : idx + nameBase;
}

/** Vixie semantics: when both day fields are restricted, either may match. Local time. */
export function nextCronAfter(spec: CronSpec, after: Date): Date | undefined {
  const t = new Date(after.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const dayOk = (d: Date): boolean => {
    const domOk = spec.dom.has(d.getDate());
    const dowOk = spec.dow.has(d.getDay());
    if (spec.domAny && spec.dowAny) return true;
    if (spec.domAny) return dowOk;
    if (spec.dowAny) return domOk;
    return domOk || dowOk;
  };
  for (let i = 0; i < 100_000; i++) {
    if (!spec.month.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayOk(t)) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!spec.hour.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!spec.minute.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1, 0, 0);
      continue;
    }
    return t;
  }
  return undefined;
}

/** "every 2h", "30m", "every 15 minutes", "hourly", "daily", "weekly". */
export function parseIntervalMs(text: string): number | undefined {
  const s = text.trim().toLowerCase();
  if (s === 'hourly' || s === 'every hour') return 3_600_000;
  if (s === 'daily' || s === 'every day') return 86_400_000;
  if (s === 'weekly' || s === 'every week') return 7 * 86_400_000;
  const m = s.match(/^(?:every\s+)?(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!n) return undefined;
  const u = m[2][0];
  const unit = u === 's' ? 1000 : u === 'm' ? 60_000 : u === 'h' ? 3_600_000 : u === 'd' ? 86_400_000 : 7 * 86_400_000;
  return n * unit;
}

// ── Helpers ───────────────────────────────────────────────────────

function parseIso(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms);
}

function fmt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
