import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { ShowTodoFull, HermesJobsFile, WikiChannel, WikiTask, CronChannel, normalizeCategory } from './types';
import { jiraAuthEnv, jiraBaseUrl } from './jiraConfig';

function config() {
  const cfg = vscode.workspace.getConfiguration('todoView');
  return {
    llmWikiRoot: cfg.get<string>('llmWikiRoot', ''),
    pythonPath: cfg.get<string>('pythonPath', 'python'),
    hermesProfile: cfg.get<string>('hermesProfile', 'default'),
  };
}

// show_todo.py bounds its own network calls (Jira timeout=30s, cron
// subprocess timeout=15s, run mostly sequentially) — 45s covers that
// worst case plus slack, so a hung proxy/subprocess can't block the UI forever.
const FETCH_TODO_TIMEOUT_MS = 45000;

/** Only set SHOW_TODO_JIRA_URL/AUTH when the user has actually run the Jira
 * setup wizard — an unconfigured install spawns show_todo.py with no
 * override so it keeps using its own DEFAULT_CONFIG,
 * exactly matching pre-multi-user behavior. */
async function jiraEnvOverrides(): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  const base = jiraBaseUrl();
  if (base) env.SHOW_TODO_JIRA_URL = base;
  const auth = await jiraAuthEnv();
  if (auth) env.SHOW_TODO_JIRA_AUTH = auth;
  return env;
}

/** Shells out to show_todo.py --json full. TODO_BYPASS_LOCK=1 avoids the
 * script's same-turn re-injection lock, which is meant for the chat skill,
 * not for a UI that legitimately refreshes on demand. */
export async function fetchTodoFull(): Promise<ShowTodoFull> {
  const { llmWikiRoot, pythonPath } = config();
  if (!llmWikiRoot) {
    return Promise.reject(
      new Error(
        "Task Beacon: 'todoView.llmWikiRoot' is not set. Point it at a vault with Tasks/*.md, or a repo with scripts/show_todo.py (run 'Task Beacon: Settings...')."
      )
    );
  }
  const scriptPath = path.join(llmWikiRoot, 'scripts', 'show_todo.py');
  if (!fs.existsSync(scriptPath)) {
    return fetchFromVault(llmWikiRoot);
  }
  const jiraEnv = await jiraEnvOverrides();

  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, [scriptPath, '--json', 'full'], {
      cwd: llmWikiRoot,
      env: { ...process.env, TODO_BYPASS_LOCK: '1', ...jiraEnv },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      reject(new Error(`show_todo.py timed out after ${FETCH_TODO_TIMEOUT_MS / 1000}s (network or subprocess hang)`));
    }, FETCH_TODO_TIMEOUT_MS);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    child.on('error', (err) => {
      clearTimeout(timer);
      if (timedOut) return;
      reject(new Error(`Failed to spawn "${pythonPath}": ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`show_todo.py exited ${code}: ${stderr.trim() || '(no stderr)'}`));
        return;
      }
      try {
        resolve(normalizeFetchedTodo(JSON.parse(stdout) as ShowTodoFull));
      } catch (e) {
        reject(new Error(`Failed to parse show_todo.py output: ${(e as Error).message}\n${stdout.slice(0, 500)}`));
      }
    });
  });
}

function mapWikiTasks(wiki: WikiChannel): WikiChannel {
  const map = (t: WikiTask): WikiTask => ({ ...t, category: normalizeCategory(t.category) || t.category });
  return {
    ...wiki,
    pending: wiki.pending.map(map),
    active: wiki.active.map(map),
    completed: wiki.completed.map(map),
    cancelled: wiki.cancelled.map(map),
  };
}

function normalizeFetchedTodo(data: ShowTodoFull): ShowTodoFull {
  return data.wiki ? { ...data, wiki: mapWikiTasks(data.wiki) } : data;
}

function fetchFromVault(root: string): ShowTodoFull {
  return {
    jira: { ok: true, total: 0, in_progress: [], to_do: [], error: null },
    wiki: mapWikiTasks(scanVaultTasks(root)),
    cron: loadHermesCron(),
  };
}

function scanVaultTasks(root: string): WikiChannel {
  const dir = vaultTasksDir(root);
  if (!dir) {
    return {
      ok: false,
      error: `No Tasks/ or tasks/ folder under ${root}, and scripts/show_todo.py is missing.`,
      pending: [],
      active: [],
      completed: [],
      cancelled: [],
    };
  }

  const pending: WikiTask[] = [];
  const active: WikiTask[] = [];
  const completed: WikiTask[] = [];
  const cancelled: WikiTask[] = [];
  const folderName = path.basename(dir);

  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return {
      ok: false,
      error: `Cannot read ${dir}: ${(e as Error).message}`,
      pending: [],
      active: [],
      completed: [],
      cancelled: [],
    };
  }

  for (const name of names) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    if (name.toLowerCase() === 'index.md') continue;
    const rel = `${folderName}/${name}`;
    const parsed = parseVaultTaskFile(path.join(dir, name), rel);
    if (!parsed) continue;
    const bucket = parsed.bucket;
    if (bucket === 'active') active.push(parsed.task);
    else if (bucket === 'completed') completed.push(parsed.task);
    else if (bucket === 'cancelled') cancelled.push(parsed.task);
    else pending.push(parsed.task);
  }

  return { ok: true, error: null, pending, active, completed, cancelled };
}

function vaultTasksDir(root: string): string | undefined {
  const capital = path.join(root, 'Tasks');
  if (fs.existsSync(capital) && fs.statSync(capital).isDirectory()) return capital;
  const lower = path.join(root, 'tasks');
  if (fs.existsSync(lower) && fs.statSync(lower).isDirectory()) return lower;
  return undefined;
}

function parseVaultTaskFile(
  absPath: string,
  rel: string
): { task: WikiTask; bucket: 'pending' | 'active' | 'completed' | 'cancelled' } | undefined {
  let content: string;
  try {
    content = fs.readFileSync(absPath, 'utf-8');
  } catch {
    return undefined;
  }
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return undefined;
  const fm: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!m) continue;
    const raw = m[2].trim();
    if (!raw || raw.startsWith('-') || raw.startsWith('[')) continue;
    fm[m[1]] = raw.replace(/^["']|["']$/g, '');
  }
  if ((fm.type ?? '').toLowerCase() !== 'task') return undefined;

  const title = fm.title || path.basename(rel, '.md');
  const note = [fm.priority, fm.due].filter(Boolean).join(' · ');
  const task: WikiTask = {
    title,
    file: rel,
    note,
    epicKey: fm.epic_link || fm.epic || undefined,
    category: normalizeCategory(fm.category) || fm.category || '',
  };
  return { task, bucket: wikiStatusBucket(fm.status) };
}

function wikiStatusBucket(raw: string | undefined): 'pending' | 'active' | 'completed' | 'cancelled' {
  const status = (raw ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (['in-progress', 'active', 'doing', 'wip'].includes(status)) return 'active';
  if (['done', 'completed', 'complete'].includes(status)) return 'completed';
  if (['cancelled', 'canceled'].includes(status)) return 'cancelled';
  return 'pending';
}

function hermesCronJobsPath(): string | undefined {
  const profile = config().hermesProfile;
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = [
    path.join(localAppData, 'hermes', 'profiles', profile, 'cron', 'jobs.json'),
    path.join(localAppData, 'hermes', 'cron', 'jobs.json'),
    path.join(os.homedir(), '.hermes', 'profiles', profile, 'cron', 'jobs.json'),
    path.join(os.homedir(), '.hermes', 'cron', 'jobs.json'),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

function loadHermesCron(): CronChannel {
  const jobsPath = hermesCronJobsPath();
  if (!jobsPath) {
    return { ok: true, error: null, jobs: [] };
  }
  try {
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
      }>;
    };
    const jobs = (parsed.jobs ?? [])
      .filter((j) => j.id && j.name)
      .map((j) => {
        const paused = Boolean(j.paused_at) || j.state === 'paused' || j.enabled === false;
        const schedule =
          j.schedule_display ||
          (typeof j.schedule === 'string' ? j.schedule : j.schedule?.display) ||
          '';
        return {
          id: j.id as string,
          name: j.name as string,
          state: paused ? 'paused' : 'active',
          schedule,
          last_status: j.last_status || '',
          last_run: j.last_run_at ?? null,
          next_run: j.next_run_at ?? null,
        };
      });
    return { ok: true, error: null, jobs };
  } catch (e) {
    return { ok: false, error: (e as Error).message, jobs: [] };
  }
}

/** show_todo.py's cron channel doesn't carry the job's `script` field
 * (it only surfaces id/state/name/schedule/last_status/next_run). The
 * script path only exists in the raw hermes jobs.json, so resolve it
 * there when the user wants to jump to a cron job's source file. */
export function resolveCronScriptPath(jobId: string): string | undefined {
  const jobsPath = hermesCronJobsPath();
  if (!jobsPath) {
    return undefined;
  }
  try {
    const parsed: HermesJobsFile = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));
    const job = parsed.jobs.find((j) => j.id === jobId);
    const script = job?.script;
    if (!script) return undefined;
    if (path.isAbsolute(script)) return script;
    return path.join(path.dirname(jobsPath), script);
  } catch {
    return undefined;
  }
}

// hermes CLI cold-starts its Python venv on every invocation (~9-13s
// measured) before it even reaches the cron subcommand — 30s covers that
// plus slack so a genuinely hung process still gets killed instead of
// leaving the progress notification spinning forever.
const CRON_TOGGLE_TIMEOUT_MS = 30000;

/** Shells out to `hermes cron pause/resume <id>` — mirrors the job.script
 * resolution above by reading hermes state directly rather than duplicating
 * its scheduler logic in TypeScript. */
export function setCronPaused(jobId: string, paused: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('hermes', ['cron', paused ? 'pause' : 'resume', jobId], {
      windowsHide: true,
    });
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      reject(new Error(`hermes cron ${paused ? 'pause' : 'resume'} ${jobId} timed out after ${CRON_TOGGLE_TIMEOUT_MS / 1000}s`));
    }, CRON_TOGGLE_TIMEOUT_MS);

    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      if (timedOut) return;
      reject(new Error(`Failed to spawn "hermes": ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code !== 0) {
        reject(new Error(`hermes cron ${paused ? 'pause' : 'resume'} ${jobId} exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolve();
    });
  });
}

/** Shells out to `hermes cron run <id>` — forces the job onto the next
 * scheduler tick instead of waiting for its cron schedule. Same cold-start
 * cost/timeout as pause/resume, so it reuses CRON_TOGGLE_TIMEOUT_MS. Used
 * both for "replay a failed run" and ad-hoc manual triggers. */
export function triggerCronRun(jobId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('hermes', ['cron', 'run', jobId], {
      windowsHide: true,
    });
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      reject(new Error(`hermes cron run ${jobId} timed out after ${CRON_TOGGLE_TIMEOUT_MS / 1000}s`));
    }, CRON_TOGGLE_TIMEOUT_MS);

    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      if (timedOut) return;
      reject(new Error(`Failed to spawn "hermes": ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code !== 0) {
        reject(new Error(`hermes cron run ${jobId} exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolve();
    });
  });
}

export function llmWikiRoot(): string {
  return config().llmWikiRoot;
}

export function taskFilePath(file: string): string {
  const root = config().llmWikiRoot;
  const normalized = file.replace(/\\/g, '/');
  if (/^(tasks|Tasks)\//.test(normalized)) {
    return path.join(root, file);
  }
  const capital = path.join(root, 'Tasks', file);
  if (fs.existsSync(capital)) return capital;
  return path.join(root, 'tasks', file);
}

export interface WikiTaskDetail {
  frontmatter: Record<string, string>;
  tags: string[];
  body: string;
}

/** Reads the task .md file directly (frontmatter + body) for a richer
 * summary than the one-line `note` parsed out of tasks/index.md by
 * show_todo.py. Extension-side only — show_todo.py stays untouched. */
export function readWikiTaskDetail(file: string): WikiTaskDetail | undefined {
  const filePath = taskFilePath(file);
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) {
      return { frontmatter: {}, tags: [], body: content.trim() };
    }
    const [, fm, body] = match;
    const frontmatter: Record<string, string> = {};
    const tags: string[] = [];
    for (const line of fm.split(/\r?\n/)) {
      const m = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (!m) continue;
      const [, key, rawVal] = m;
      if (key === 'tags') {
        const arr = rawVal.match(/\[(.*)\]/);
        if (arr) {
          tags.push(
            ...arr[1]
              .split(',')
              .map((s) => s.trim().replace(/^["']|["']$/g, ''))
              .filter(Boolean)
          );
        }
      } else if (rawVal.trim() && !rawVal.trim().startsWith('-')) {
        frontmatter[key] = rawVal.trim();
      }
    }
    return { frontmatter, tags, body: body.trim() };
  } catch {
    return undefined;
  }
}

/** Extracts a cron job's script leading comment block (or first lines as
 * fallback) so the Summary view can show what the script actually does,
 * not just its schedule/status. */
export function readCronScriptPreview(jobId: string): string | undefined {
  const scriptPath = resolveCronScriptPath(jobId);
  if (!scriptPath || !fs.existsSync(scriptPath)) {
    return undefined;
  }
  try {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    return extractLeadingComment(content) ?? content.split(/\r?\n/).slice(0, 8).join('\n').trim();
  } catch {
    return undefined;
  }
}

const JIRA_DETAIL_MARKER = '─ 설명 ─';

/** Shells out to show_todo.py detail <KEY> for the full Jira description/
 * comments/links. The `detail` subcommand has no --json branch, so this
 * parses the human-readable output: everything before the marker duplicates
 * fields already shown by renderJira(), so only the tail is kept — mirrors
 * how readWikiTaskDetail() enriches Wiki tasks, but via a live shell-out
 * instead of a file read since Jira data isn't local.
 *
 * Rejects on spawn error/timeout so callers can distinguish "fetch failed"
 * from "fetched fine, ticket just has no description" (both used to
 * resolve to undefined, hiding real failures from the user). */
export async function fetchJiraDetail(key: string): Promise<string | undefined> {
  const { llmWikiRoot, pythonPath } = config();
  if (!llmWikiRoot) {
    return Promise.reject(new Error("Task Beacon: 'todoView.llmWikiRoot' is not set. Point it at a repo containing scripts/show_todo.py (run 'Task Beacon: Settings...' to configure)."));
  }
  const scriptPath = path.join(llmWikiRoot, 'scripts', 'show_todo.py');
  const jiraEnv = await jiraEnvOverrides();

  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, [scriptPath, 'detail', key], {
      cwd: llmWikiRoot,
      env: { ...process.env, TODO_BYPASS_LOCK: '1', ...jiraEnv },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      reject(new Error(`show_todo.py detail ${key} timed out after ${FETCH_TODO_TIMEOUT_MS / 1000}s`));
    }, FETCH_TODO_TIMEOUT_MS);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      if (timedOut) return;
      reject(new Error(`Failed to spawn "${pythonPath}": ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`show_todo.py detail ${key} exited ${code}: ${stderr.trim() || '(no stderr)'}`));
        return;
      }
      const marker = stdout.indexOf(JIRA_DETAIL_MARKER);
      const text = marker === -1 ? stdout : stdout.slice(marker + JIRA_DETAIL_MARKER.length);
      resolve(text.trim() || undefined);
    });
  });
}

function extractLeadingComment(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  const commentLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (commentLines.length) break;
      continue;
    }
    if (trimmed.startsWith('#!')) continue;
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
      commentLines.push(trimmed.replace(/^#+\s*|^\/\/\s*/, ''));
    } else {
      break;
    }
  }
  return commentLines.length ? commentLines.join('\n') : undefined;
}
