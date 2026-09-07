import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export type CronRunStatus = 'ok' | 'failed' | 'silent' | 'running' | 'unknown';

export interface CronRun {
  jobId: string;
  startTs: number;
  /** end timestamp — for historical runs, inferred from next run's start; for
   * the tail run, from file mtime if not currently running; undefined if running. */
  endTs?: number;
  durationSec?: number;
  status: CronRunStatus;
  fileName: string;
  sizeBytes: number;
  /** Last markdown heading or trailing non-empty bullet — a lightweight "stage"
   * hint scanned only for the tail run to avoid rescanning long histories. */
  stage?: string;
}

export interface JobRuns {
  jobId: string;
  runs: CronRun[];
  /** Live status of the last run — set from jobs.json when available. */
  live: {
    state: string;
    lastStatus: string;
    lastRun: string | null;
    nextRun: string | null;
  } | null;
}

interface DirCacheEntry {
  mtimeMs: number;
  runs: CronRun[];
}

const FILE_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.md$/;
const RUNNING_WINDOW_MS = 60_000;
const MAX_RUNS_PER_JOB = 200;

/** Live Hermes profile cron dir — active runtime state, not a mirror. Reading
 * the live profile directly (instead of a backup mirror) fixes stale-view bugs.
 * Profile name is configurable via todoView.hermesProfile (default: "default").
 * Resolved lazily so config changes apply without an extension reload. */
function hermesCronDir(): string {
  const profile = vscode.workspace
    .getConfiguration('todoView')
    .get<string>('hermesProfile', 'default');
  return path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'profiles', profile, 'cron');
}

/** Discovers per-job cron run history from `<hermesCronDir>/output/<jobId>/*.md`.
 * Caches per-dir listings keyed by directory mtime so an unchanged dir skips readdir.
 * Only the newest file's content is scanned (for stage/status refinement) — older files
 * are trusted as ok unless they carry a Status: line, so scanning stays O(new runs). */
export class CronRunsStore {
  private dirCache = new Map<string, DirCacheEntry>();
  private jobsFileCache: { mtimeMs: number; parsed: HermesJobsSnapshot } | undefined;

  listJobs(): JobRuns[] {
    const outputRoot = path.join(hermesCronDir(), "output");
    if (!fs.existsSync(outputRoot)) return [];
    const jobs = this.readJobsFile();
    const jobDirs = safeReadDir(outputRoot).filter((e) => e.isDirectory());
    const results: JobRuns[] = [];
    for (const entry of jobDirs) {
      const jobId = entry.name;
      const jobDir = path.join(outputRoot, jobId);
      const runs = this.readJobDir(jobId, jobDir);
      const live = jobs?.byId.get(jobId) ?? null;
      if (runs.length > 0 && live && runs.length > 0) {
        applyLiveStatus(runs[runs.length - 1], live);
      }
      results.push({ jobId, runs, live });
    }
    return results;
  }

  private readJobDir(jobId: string, jobDir: string): CronRun[] {
    let dirStat: fs.Stats;
    try {
      dirStat = fs.statSync(jobDir);
    } catch {
      return [];
    }
    const cached = this.dirCache.get(jobDir);
    if (cached && cached.mtimeMs === dirStat.mtimeMs) return cached.runs;

    const files = safeReadDir(jobDir)
      .filter((e) => e.isFile() && FILE_RE.test(e.name))
      .map((e) => e.name)
      .sort();

    const trimmed = files.slice(-MAX_RUNS_PER_JOB);
    const runs: CronRun[] = [];
    for (let i = 0; i < trimmed.length; i++) {
      const name = trimmed[i];
      const startTs = parseFileTs(name);
      if (startTs === undefined) continue;
      const filePath = path.join(jobDir, name);
      let sizeBytes = 0;
      let mtimeMs = 0;
      try {
        const st = fs.statSync(filePath);
        sizeBytes = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        continue;
      }
      const isTail = i === trimmed.length - 1;
      const { status, stage } = classifyRun(filePath, sizeBytes, isTail);
      const nextStartTs =
        i + 1 < trimmed.length ? parseFileTs(trimmed[i + 1]) : undefined;

      let endTs: number | undefined;
      let durationSec: number | undefined;
      if (nextStartTs !== undefined) {
        endTs = mtimeMs > startTs ? Math.min(mtimeMs, nextStartTs) : nextStartTs;
        durationSec = Math.max(1, Math.round((endTs - startTs) / 1000));
      } else if (mtimeMs > startTs) {
        endTs = mtimeMs;
        durationSec = Math.max(1, Math.round((endTs - startTs) / 1000));
      }

      runs.push({
        jobId,
        startTs,
        endTs,
        durationSec,
        status,
        fileName: name,
        sizeBytes,
        stage: isTail ? stage : undefined,
      });
    }

    this.dirCache.set(jobDir, { mtimeMs: dirStat.mtimeMs, runs });
    return runs;
  }

  private readJobsFile(): HermesJobsSnapshot | undefined {
    const jobsPath = path.join(hermesCronDir(), "jobs.json");
    let stat: fs.Stats;
    try {
      stat = fs.statSync(jobsPath);
    } catch {
      return undefined;
    }
    if (this.jobsFileCache && this.jobsFileCache.mtimeMs === stat.mtimeMs) {
      return this.jobsFileCache.parsed;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(jobsPath, 'utf-8')) as {
        jobs?: Array<{
          id: string;
          name?: string;
          state?: string;
          last_status?: string;
          last_run_at?: string | null;
          next_run_at?: string | null;
        }>;
      };
      const byId = new Map<string, JobsFileEntry>();
      const nameById = new Map<string, string>();
      for (const j of raw.jobs ?? []) {
        byId.set(j.id, {
          state: j.state ?? '',
          lastStatus: j.last_status ?? '',
          lastRun: j.last_run_at ?? null,
          nextRun: j.next_run_at ?? null,
        });
        if (j.name) nameById.set(j.id, j.name);
      }
      const parsed: HermesJobsSnapshot = { byId, nameById };
      this.jobsFileCache = { mtimeMs: stat.mtimeMs, parsed };
      return parsed;
    } catch {
      return undefined;
    }
  }

  jobName(jobId: string): string | undefined {
    return this.readJobsFile()?.nameById.get(jobId);
  }
}

interface JobsFileEntry {
  state: string;
  lastStatus: string;
  lastRun: string | null;
  nextRun: string | null;
}

interface HermesJobsSnapshot {
  byId: Map<string, JobsFileEntry>;
  nameById: Map<string, string>;
}

function safeReadDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function parseFileTs(name: string): number | undefined {
  const m = FILE_RE.exec(name);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  const t = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s)
  ).getTime();
  return Number.isNaN(t) ? undefined : t;
}

/** Scans the run's .md file just enough to tell ok/failed/silent apart.
 * Only reads the head (~2KB) — cron outputs put `**Status:**` on line ~6
 * when non-ok, so we never load the full body. Tail run also scans the
 * tail for a "stage" hint. */
function classifyRun(
  filePath: string,
  sizeBytes: number,
  scanStage: boolean
): { status: CronRunStatus; stage?: string } {
  let head = '';
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(Math.min(sizeBytes, 2048));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    head = buf.toString('utf-8');
  } catch {
    return { status: 'unknown' };
  }

  const statusMatch = /\*\*Status:\*\*\s*(.+)/i.exec(head);
  let status: CronRunStatus = 'ok';
  if (statusMatch) {
    const s = statusMatch[1].toLowerCase();
    if (s.includes('fail') || s.includes('error')) status = 'failed';
    else if (s.includes('silent')) status = 'silent';
  }

  if (!scanStage) return { status };

  let stage: string | undefined;
  try {
    const readBytes = Math.min(sizeBytes, 4096);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(readBytes);
    const offset = Math.max(0, sizeBytes - readBytes);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    stage = extractStage(buf.toString('utf-8'));
  } catch {
    // stage optional
  }
  return { status, stage };
}

function extractStage(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const heading = /^#{1,6}\s+(.+)/.exec(line);
    if (heading) return heading[1].slice(0, 80);
    const bullet = /^[-*]\s+(.+)/.exec(line);
    if (bullet) return bullet[1].slice(0, 80);
  }
  return lines[lines.length - 1]?.slice(0, 80);
}

function applyLiveStatus(tail: CronRun, live: JobsFileEntry): void {
  const s = live.lastStatus.toLowerCase();
  if (s === 'running' || live.state === 'running') {
    tail.status = 'running';
    tail.endTs = undefined;
    tail.durationSec = undefined;
    return;
  }
  if (s === 'failed' || s === 'error' || s === 'fail') {
    tail.status = 'failed';
    return;
  }
  if (tail.status === 'ok' && (s === 'ok' || s === 'success')) {
    return;
  }
  // In-progress heuristic: tail file mtime within the last minute + job scheduled.
  if (tail.endTs && Date.now() - tail.endTs < RUNNING_WINDOW_MS && live.state === 'active') {
    tail.status = 'running';
    tail.endTs = undefined;
    tail.durationSec = undefined;
  }
}

