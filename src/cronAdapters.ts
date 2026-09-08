import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CronChannel, CronJob, HermesJobsFile } from './types';
import { effectiveWikiRoot } from './wikiRoot';

const MAX_JOBS = 200;
const MAX_NAME = 96;

export function loadCronChannel(wikiRoot?: string): CronChannel {
  const jobs: CronJob[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  const add = (job: CronJob): void => {
    if (jobs.length >= MAX_JOBS) return;
    const key = `${job.source}\0${job.openPath ?? ''}\0${job.nativeId ?? job.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    jobs.push(job);
  };

  const run = (label: string, loader: () => CronJob[]): void => {
    try {
      loader().forEach(add);
    } catch (e) {
      errors.push(`${label}: ${(e as Error).message}`);
    }
  };

  const roots = scanRoots(wikiRoot);
  run('Hermes', loadHermesJobs);
  run('Task Beacon', () => loadTaskBeaconJobs(roots));
  run('Claude Code', () => loadClaudeJobs(roots));
  run('GitHub Actions', () => loadGithubActionJobs(roots));
  run('OpenCode', loadOpenCodeJobs);

  return {
    ok: true,
    error: jobs.length === 0 && errors.length > 0 ? errors.join('; ') : null,
    jobs,
  };
}

export function findCronJob(jobId: string, wikiRoot?: string): CronJob | undefined {
  return loadCronChannel(wikiRoot).jobs.find((job) => job.id === jobId);
}

export function isHermesJob(job: CronJob): boolean {
  return job.source === 'hermes';
}

export function hermesNativeId(jobId: string): string {
  return jobId.startsWith('hermes:') ? jobId.slice('hermes:'.length) : jobId;
}

export function resolveCronScriptPath(jobId: string): string | undefined {
  const job = findCronJob(jobId);
  if (job?.openPath && fs.existsSync(job.openPath)) {
    return job.openPath;
  }
  return resolveHermesScriptPath(job?.nativeId ?? hermesNativeId(jobId));
}

export function hermesCronJobsPath(): string | undefined {
  const profile = vscode.workspace.getConfiguration('todoView').get<string>('hermesProfile', 'default');
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = [
    path.join(localAppData, 'hermes', 'profiles', profile, 'cron', 'jobs.json'),
    path.join(localAppData, 'hermes', 'cron', 'jobs.json'),
    path.join(os.homedir(), '.hermes', 'profiles', profile, 'cron', 'jobs.json'),
    path.join(os.homedir(), '.hermes', 'cron', 'jobs.json'),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

function scanRoots(wikiRoot?: string): string[] {
  const roots = new Set<string>();
  const wiki = (wikiRoot || effectiveWikiRoot() || '').trim();
  if (wiki && fs.existsSync(wiki)) {
    roots.add(path.normalize(wiki));
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    roots.add(path.normalize(folder.uri.fsPath));
  }
  return [...roots];
}

function loadHermesJobs(): CronJob[] {
  const jobsPath = hermesCronJobsPath();
  if (!jobsPath) return [];
  const parsed = JSON.parse(fs.readFileSync(jobsPath, 'utf-8')) as {
    jobs?: Array<{
      id?: string;
      name?: string;
      state?: string;
      enabled?: boolean;
      paused_at?: string | null;
      schedule_display?: string;
      schedule?: { display?: string } | string;
      last_status?: string;
      last_run_at?: string | null;
      next_run_at?: string | null;
      script?: string;
      prompt?: string;
    }>;
  };
  return (parsed.jobs ?? [])
    .filter((j) => j.id && j.name)
    .map((j) => {
      const paused = Boolean(j.paused_at) || j.state === 'paused' || j.enabled === false;
      const schedule =
        j.schedule_display ||
        (typeof j.schedule === 'string' ? j.schedule : j.schedule?.display) ||
        '';
      const scriptAbs = resolveMaybeRelative(jobsPath, j.script);
      return cronJob({
        source: 'hermes',
        sourceLabel: 'Hermes',
        nativeId: j.id as string,
        name: j.name as string,
        schedule,
        state: paused ? 'paused' : 'active',
        last_status: j.last_status || '',
        last_run: j.last_run_at ?? null,
        next_run: j.next_run_at ?? null,
        openPath: scriptAbs && fs.existsSync(scriptAbs) ? scriptAbs : jobsPath,
        preview: clipText(j.prompt),
      });
    });
}

function loadTaskBeaconJobs(roots: string[]): CronJob[] {
  const jobs: CronJob[] = [];
  for (const root of roots) {
    const file = path.join(root, '.task-beacon', 'jobs.json');
    if (!fs.existsSync(file)) continue;
    const parsed = readJson(file);
    for (const raw of asJobList(parsed)) {
      const id = str(raw.id);
      const name = str(raw.name) || id;
      if (!id || !name) continue;
      const schedule = str(raw.schedule) || str(raw.cron);
      const open = resolveMaybeRelative(file, str(raw.open) || str(raw.script));
      jobs.push(
        cronJob({
          source: 'task-beacon',
          sourceLabel: str(raw.agent) ? `Task Beacon · ${str(raw.agent)}` : 'Task Beacon',
          nativeId: id,
          name,
          schedule,
          state: pausedState(raw),
          last_status: str(raw.last_status),
          last_run: str(raw.last_run) || null,
          next_run: str(raw.next_run) || null,
          openPath: open && fs.existsSync(open) ? open : file,
          preview: clipText(str(raw.prompt) || str(raw.command)),
        })
      );
    }
  }
  return jobs;
}

function loadClaudeJobs(roots: string[]): CronJob[] {
  const files = [
    ...roots.map((root) => path.join(root, '.claude', 'scheduled_tasks.json')),
    path.join(os.homedir(), '.claude', 'scheduled_tasks.json'),
  ];
  const jobs: CronJob[] = [];
  for (const file of uniqueExisting(files)) {
    const parsed = readJson(file);
    const list = Array.isArray(parsed)
      ? parsed
      : asJobList(parsed, 'tasks');
    for (const raw of list) {
      const id = str(raw.id);
      const prompt = str(raw.prompt);
      const schedule = str(raw.cron) || str(raw.schedule);
      if (!id && !prompt) continue;
      const nativeId = id || slug(prompt || schedule);
      jobs.push(
        cronJob({
          source: 'claude',
          sourceLabel: 'Claude Code',
          nativeId,
          name: clipName(prompt || nativeId),
          schedule,
          state: pausedState(raw),
          last_status: str(raw.last_status),
          last_run: epochOrIso(raw.lastFiredAt) || str(raw.last_run) || null,
          next_run: str(raw.next_run) || null,
          openPath: file,
          preview: clipText(prompt),
        })
      );
    }
  }
  return jobs;
}

function loadGithubActionJobs(roots: string[]): CronJob[] {
  const jobs: CronJob[] = [];
  for (const root of roots) {
    const dir = path.join(root, '.github', 'workflows');
    if (!fs.existsSync(dir)) continue;
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/\.ya?ml$/i.test(name)) continue;
      const file = path.join(dir, name);
      let content = '';
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }
      if (!/\bschedule\s*:/.test(content)) continue;
      const crons = extractYamlCrons(content);
      const workflowName = extractYamlName(content) || name.replace(/\.ya?ml$/i, '');
      crons.forEach((schedule, index) => {
        jobs.push(
          cronJob({
            source: 'github-actions',
            sourceLabel: 'GitHub Actions',
            nativeId: `${name}:${index}`,
            name: crons.length > 1 ? `${workflowName} (${index + 1})` : workflowName,
            schedule,
            state: 'active',
            last_status: '',
            last_run: null,
            next_run: null,
            openPath: file,
          })
        );
      });
    }
  }
  return jobs;
}

function loadOpenCodeJobs(): CronJob[] {
  const roots = [
    path.join(os.homedir(), '.config', 'opencode', 'scheduler'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'opencode', 'scheduler'),
  ];
  const jobs: CronJob[] = [];
  for (const root of roots) {
    for (const file of listFiles(root, 4, '.json')) {
      let parsed: unknown;
      try {
        parsed = readJson(file);
      } catch {
        continue;
      }
      const list = Array.isArray(parsed) ? parsed : asJobList(parsed);
      const rows = list.length > 0 ? list : isRecord(parsed) && (parsed.id || parsed.name || parsed.schedule || parsed.cron) ? [parsed] : [];
      for (const raw of rows) {
        const id = str(raw.id) || path.basename(file, '.json');
        const name = str(raw.name) || str(raw.title) || id;
        const schedule = str(raw.schedule) || str(raw.cron);
        const underJobs = /[/\\]jobs[/\\]/.test(file) || path.basename(path.dirname(file)) === 'jobs';
        if (!name || (!schedule && !underJobs)) continue;
        jobs.push(
          cronJob({
            source: 'opencode',
            sourceLabel: 'OpenCode',
            nativeId: id,
            name,
            schedule,
            state: pausedState(raw),
            last_status: str(raw.last_status),
            last_run: str(raw.last_run) || null,
            next_run: str(raw.next_run) || null,
            openPath: file,
            preview: clipText(str(raw.prompt) || str(raw.command)),
          })
        );
      }
    }
  }
  return jobs;
}

function cronJob(partial: {
  source: string;
  sourceLabel: string;
  nativeId: string;
  name: string;
  schedule: string;
  state: string;
  last_status: string;
  last_run: string | null;
  next_run: string | null;
  openPath?: string;
  preview?: string;
}): CronJob {
  return {
    id: `${partial.source}:${partial.nativeId}`,
    nativeId: partial.nativeId,
    state: partial.state,
    name: partial.name,
    schedule: partial.schedule,
    last_status: partial.last_status,
    last_run: partial.last_run,
    next_run: partial.next_run,
    source: partial.source,
    sourceLabel: partial.sourceLabel,
    openPath: partial.openPath,
    preview: partial.preview,
  };
}

function resolveHermesScriptPath(nativeId: string): string | undefined {
  const jobsPath = hermesCronJobsPath();
  if (!jobsPath) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(jobsPath, 'utf-8')) as HermesJobsFile;
    const job = parsed.jobs.find((j) => j.id === nativeId);
    return resolveMaybeRelative(jobsPath, job?.script);
  } catch {
    return undefined;
  }
}

function resolveMaybeRelative(fromFile: string, value?: string): string | undefined {
  if (!value) return undefined;
  if (path.isAbsolute(value)) return value;
  return path.join(path.dirname(fromFile), value);
}

function asJobList(parsed: unknown, key = 'jobs'): Record<string, unknown>[] {
  if (Array.isArray(parsed)) {
    return parsed.filter(isRecord);
  }
  if (isRecord(parsed) && Array.isArray(parsed[key])) {
    return (parsed[key] as unknown[]).filter(isRecord);
  }
  return [];
}

function pausedState(raw: Record<string, unknown>): string {
  if (raw.paused === true || raw.enabled === false || raw.state === 'paused') return 'paused';
  return 'active';
}

function extractYamlCrons(content: string): string[] {
  const crons: string[] = [];
  const re = /\bcron:\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content))) {
    crons.push(match[1]);
  }
  return [...new Set(crons)];
}

function extractYamlName(content: string): string | undefined {
  const match = content.match(/^\s*name:\s*['"]?(.+?)['"]?\s*$/m);
  return match?.[1]?.trim();
}

function listFiles(dir: string, depth: number, ext: string): string[] {
  if (depth < 0 || !fs.existsSync(dir)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, depth - 1, ext));
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

function uniqueExisting(files: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const file of files) {
    const normalized = path.normalize(file);
    if (seen.has(normalized) || !fs.existsSync(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clipName(value: string): string {
  const first = value.split(/\r?\n/)[0]?.trim() || value;
  return first.length > MAX_NAME ? `${first.slice(0, MAX_NAME - 1)}…` : first;
}

function clipText(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 2000 ? `${trimmed.slice(0, 1999)}…` : trimmed;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'job';
}

function epochOrIso(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
