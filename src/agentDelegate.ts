import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getAiSettings } from './aiConfig';
import { embedWithAi, summarizeWithAi } from './aiClient';
import { readWikiTaskDetail, taskFilePath } from './fetchTodo';
import { effectiveWikiRoot, pickWikiRoot, usingSampleWiki } from './wikiRoot';

/**
 * Delegate: turn one piece of work into agent-owned wiki files, then hand
 * them to whatever agent runtime the user already has.
 *
 * Task Beacon does not run a scheduler. It writes `Tasks/*.md`
 * (`agent-task` / `agent-cron`), optionally a `.task-beacon/jobs.json` row,
 * and opens a terminal with the configured runner command. Finished tasks
 * in the same wiki are attached as references so similar work follows the
 * same shape.
 */

export type SubtaskKind = 'research' | 'analysis' | 'implement' | 'schedule';

export interface PlannedSubtask {
  kind: SubtaskKind;
  title: string;
  prompt: string;
  schedule?: string;
}

export interface DelegatePlan {
  summary: string;
  subtasks: PlannedSubtask[];
  /** true when the AI produced the split; false when we fell back to one task. */
  planned: boolean;
  note?: string;
}

export interface ReferenceHit {
  file: string;
  title: string;
  score: number;
  excerpt: string;
  /** 'lexical' = word overlap; 'embedding' = re-ranked by cosine similarity. */
  ranker: 'lexical' | 'embedding';
}

export interface DelegateResult {
  epicFile: string;
  taskFiles: string[];
  cronIds: string[];
  refs: ReferenceHit[];
  plan: DelegatePlan;
}

const KINDS: SubtaskKind[] = ['research', 'analysis', 'implement', 'schedule'];
const MAX_REFS = 3;
/** Lexical shortlist handed to the embedding re-ranker. */
const SHORTLIST = 12;
const MAX_SUBTASKS = 6;

// ── Public entry points ────────────────────────────────────────────

/** Command palette: ask for a title and details, then delegate. */
export async function delegateFromInput(): Promise<DelegateResult | undefined> {
  const root = await requireWritableRoot();
  if (!root) return undefined;

  const title = await vscode.window.showInputBox({
    prompt: 'What should the agent take on? One line.',
    placeHolder: 'e.g. Compare three markdown kanban tools and pick one for the wiki',
    ignoreFocusOut: true,
  });
  if (!title?.trim()) return undefined;

  const body = await vscode.window.showInputBox({
    prompt: 'Details, constraints, or what done looks like (optional)',
    placeHolder: 'Leave empty to let the plan fill it in',
    ignoreFocusOut: true,
  });
  if (body === undefined) return undefined;

  return delegateWork(root, title.trim(), body.trim());
}

/** Tree context menu: use an existing wiki task or epic file as the brief. */
export async function delegateFromFile(file: string): Promise<DelegateResult | undefined> {
  const root = await requireWritableRoot();
  if (!root) return undefined;
  const detail = readWikiTaskDetail(file);
  if (!detail) {
    vscode.window.showWarningMessage(`Task file not found: ${file}`);
    return undefined;
  }
  const title = detail.frontmatter.title || path.basename(file, '.md');
  return delegateWork(root, title, detail.body, file);
}

/** Open a terminal with the configured runner for one agent task file. */
export async function runTaskWithAgent(file: string): Promise<void> {
  const root = effectiveWikiRoot();
  const detail = readWikiTaskDetail(file);
  if (!detail) {
    vscode.window.showWarningMessage(`Task file not found: ${file}`);
    return;
  }
  const category = (detail.frontmatter.category ?? '').trim();
  if (category !== 'agent-task' && category !== 'agent-cron') {
    vscode.window.showInformationMessage(
      'Only Agent tasks run unattended. Official and Private rows stay with you.'
    );
    return;
  }
  const runner = runnerTemplate();
  if (!runner) {
    const pick = await vscode.window.showInformationMessage(
      'No agent runner set. Add a command template in Settings (todoView.agentRunner), e.g. hermes chat -q "Read {file} and do it".',
      'Open Settings'
    );
    if (pick) void vscode.commands.executeCommand('workbench.action.openSettings', 'todoView.agentRunner');
    return;
  }
  const abs = taskFilePath(file);
  setFrontmatterStatus(abs, 'in-progress');
  launchRunner(runner, {
    file: abs,
    title: detail.frontmatter.title || path.basename(file, '.md'),
    root,
  });
}

// ── Core flow ─────────────────────────────────────────────────────

export async function delegateWork(
  root: string,
  title: string,
  body: string,
  sourceFile?: string
): Promise<DelegateResult> {
  const refs = await findReferencesRanked(root, `${title}\n${body}`, sourceFile);
  const plan = await planSubtasks(title, body, refs);

  const stamp = new Date().toISOString().slice(0, 10);
  const slug = uniqueSlug(root, slugify(title));
  const tasksDir = ensureTasksDir(root);
  const projectsDir = path.join(root, path.basename(tasksDir) === 'tasks' ? 'projects' : 'Projects');
  fs.mkdirSync(projectsDir, { recursive: true });

  const epicRel = `${path.basename(projectsDir)}/${slug}.md`;
  const taskFiles: string[] = [];
  const cronIds: string[] = [];

  plan.subtasks.forEach((sub, i) => {
    const n = String(i + 1).padStart(2, '0');
    const rel = `${path.basename(tasksDir)}/${slug}-${n}-${sub.kind}.md`;
    const abs = path.join(root, rel);
    const isCron = sub.kind === 'schedule' && Boolean(sub.schedule);
    fs.writeFileSync(abs, renderTaskFile(sub, epicRel, refs, stamp, isCron), 'utf-8');
    taskFiles.push(rel);
    if (isCron) {
      const id = `${slug}-${n}`;
      appendJobsJson(root, {
        id,
        name: sub.title,
        schedule: sub.schedule!,
        agent: runnerName(),
        prompt: `Read ${rel} in the wiki root and do it. Update its status when done.`,
        open: rel,
      });
      cronIds.push(id);
    }
  });

  fs.writeFileSync(
    path.join(root, epicRel),
    renderEpicFile(title, body, plan, taskFiles, refs, stamp, sourceFile),
    'utf-8'
  );

  return { epicFile: epicRel, taskFiles, cronIds, refs, plan };
}

async function planSubtasks(title: string, body: string, refs: ReferenceHit[]): Promise<DelegatePlan> {
  const settings = getAiSettings();
  const refBlock = refs.length
    ? '\n\nFinished reference work (same wiki):\n' +
      refs.map((r) => `- ${r.file} — ${r.title}\n  ${r.excerpt}`).join('\n')
    : '';
  const content = `Title: ${title}\n\nDetails:\n${body || '(none)'}${refBlock}`;

  let raw: string;
  try {
    raw = await summarizeWithAi(settings, 'plan', content);
  } catch (e) {
    return fallbackPlan(title, body, `AI plan failed: ${(e as Error).message}`);
  }
  const parsed = parsePlan(raw);
  if (!parsed) {
    return fallbackPlan(title, body, 'AI reply was not the expected JSON — kept one task instead.');
  }
  return parsed;
}

function fallbackPlan(title: string, body: string, note: string): DelegatePlan {
  return {
    summary: title,
    planned: false,
    note,
    subtasks: [{ kind: guessKind(title, body), title, prompt: body || title }],
  };
}

function parsePlan(raw: string): DelegatePlan | undefined {
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  const o = obj as { summary?: unknown; subtasks?: unknown };
  if (!Array.isArray(o.subtasks) || o.subtasks.length === 0) return undefined;
  const subtasks: PlannedSubtask[] = [];
  for (const s of o.subtasks.slice(0, MAX_SUBTASKS)) {
    const item = s as Record<string, unknown>;
    const kindRaw = String(item.kind ?? '').toLowerCase();
    const kind = (KINDS.find((k) => kindRaw.startsWith(k)) ?? 'implement') as SubtaskKind;
    const t = String(item.title ?? '').trim();
    const p = String(item.prompt ?? '').trim();
    if (!t) continue;
    const schedule = String(item.schedule ?? '').trim();
    subtasks.push({ kind, title: t, prompt: p || t, schedule: kind === 'schedule' && schedule ? schedule : undefined });
  }
  if (!subtasks.length) return undefined;
  return { summary: String(o.summary ?? subtasks[0].title).trim(), subtasks, planned: true };
}

function guessKind(title: string, body: string): SubtaskKind {
  const s = `${title} ${body}`.toLowerCase();
  if (/(every|daily|weekly|monthly|매일|매주|매월|cron|schedule|정기)/.test(s)) return 'schedule';
  if (/(research|survey|find|investigate|조사|찾아|검색)/.test(s)) return 'research';
  if (/(analy|compare|decide|evaluate|분석|비교|평가)/.test(s)) return 'analysis';
  return 'implement';
}

// ── References: finished work in the same wiki ────────────────────

/** Lexical shortlist, then — if `todoView.aiEmbeddingModel` is set — cosine
 * re-rank over the provider's /embeddings. Any failure keeps the lexical order. */
export async function findReferencesRanked(
  root: string,
  text: string,
  excludeFile?: string
): Promise<ReferenceHit[]> {
  const shortlist = findReferences(root, text, excludeFile, SHORTLIST);
  const model = embeddingModel();
  if (!model || shortlist.length < 2) return shortlist.slice(0, MAX_REFS);
  try {
    const vectors = await embedWithAi(getAiSettings(), model, [
      text.slice(0, 4000),
      ...shortlist.map((r) => `${r.title}\n${r.excerpt}`),
    ]);
    const [q, ...docs] = vectors;
    return shortlist
      .map((r, i) => ({ ...r, score: cosine(q, docs[i]), ranker: 'embedding' as const }))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_REFS);
  } catch {
    return shortlist.slice(0, MAX_REFS);
  }
}

export function embeddingModel(): string {
  return vscode.workspace.getConfiguration('todoView').get<string>('aiEmbeddingModel', '').trim();
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function findReferences(root: string, text: string, excludeFile?: string, limit = MAX_REFS): ReferenceHit[] {
  const dir = existingTasksDir(root);
  if (!dir) return [];
  const query = tokens(text);
  if (!query.size) return [];

  const hits: ReferenceHit[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    const rel = `${path.basename(dir)}/${name}`;
    if (excludeFile && rel === excludeFile.replace(/\\/g, '/')) continue;
    let content: string;
    try {
      content = fs.readFileSync(path.join(dir, name), 'utf-8');
    } catch {
      continue;
    }
    const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!fm) continue;
    const status = (fm[1].match(/^status:\s*(.*)$/m)?.[1] ?? '').trim().toLowerCase();
    if (!['done', 'completed', 'complete'].includes(status)) continue;
    const title = (fm[1].match(/^title:\s*(.*)$/m)?.[1] ?? name).replace(/^["']|["']$/g, '');
    const bodyTokens = tokens(`${title}\n${fm[2]}`);
    if (!bodyTokens.size) continue;
    let overlap = 0;
    for (const t of query) if (bodyTokens.has(t)) overlap++;
    if (overlap === 0) continue;
    const score = overlap / Math.sqrt(query.size * bodyTokens.size);
    hits.push({ file: rel, title, score, excerpt: excerpt(fm[2]), ranker: 'lexical' });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length >= 3 && !STOP.has(w)) out.add(w);
  }
  return out;
}

const STOP = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'task', 'sample', 'status', 'done',
  'todo', 'note', 'file', 'wiki', 'agent', 'when', 'then', 'what', 'will', 'should', 'have', 'has',
]);

function excerpt(body: string): string {
  const flat = body
    .replace(/^#.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > 240 ? `${flat.slice(0, 237)}…` : flat;
}

// ── File rendering ────────────────────────────────────────────────

function renderTaskFile(
  sub: PlannedSubtask,
  epicRel: string,
  refs: ReferenceHit[],
  stamp: string,
  isCron: boolean
): string {
  const refsLine = refs.length ? `refs: ${refs.map((r) => r.file).join(', ')}\n` : '';
  const scheduleLine = isCron ? `schedule: "${sub.schedule}"\n` : '';
  const refsSection = refs.length
    ? `\n## References (finished work in this wiki)\n\n${refs
        .map((r) => `- [[${r.file}]] — ${r.title}\n  > ${r.excerpt}`)
        .join('\n')}\n`
    : '';
  return (
    `---\n` +
    `type: Task\n` +
    `title: "${escapeYaml(sub.title)}"\n` +
    `status: todo\n` +
    `priority: medium\n` +
    `category: ${isCron ? 'agent-cron' : 'agent-task'}\n` +
    `kind: ${sub.kind}\n` +
    `epic: ${epicRel}\n` +
    scheduleLine +
    refsLine +
    `delegated: ${stamp}\n` +
    `---\n\n` +
    `# ${sub.title}\n\n` +
    `Kind: **${sub.kind}**${isCron ? ` · schedule \`${sub.schedule}\`` : ''}\n\n` +
    `## Goal\n\n${sub.prompt}\n\n` +
    `## Working rules\n\n` +
    `- Read \`AGENTS.md\` in the wiki root first.\n` +
    `- Work alone. Do not ask the human mid-task; write questions under **Result** instead.\n` +
    `- Put findings, decisions, or a change summary under **Result**.\n` +
    `- When finished set \`status: done\`. If stuck set \`status: blocked\` and say why.\n` +
    refsSection +
    `\n## Result\n\n_(empty)_\n`
  );
}

function renderEpicFile(
  title: string,
  body: string,
  plan: DelegatePlan,
  taskFiles: string[],
  refs: ReferenceHit[],
  stamp: string,
  sourceFile?: string
): string {
  const list = taskFiles.map((f, i) => `${i + 1}. [[${f}]] — ${plan.subtasks[i].kind}: ${plan.subtasks[i].title}`).join('\n');
  const ranker = refs[0]?.ranker === 'embedding' ? 'embedding re-rank' : 'word overlap';
  const refsSection = refs.length
    ? `\n## References\n\nFinished tasks in this wiki, matched by ${ranker}.\n\n${refs
        .map((r) => `- [[${r.file}]] — ${r.title}`)
        .join('\n')}\n`
    : '';
  const source = sourceFile ? `\nSource brief: [[${sourceFile}]]\n` : '';
  const note = plan.note ? `\n> ${plan.note}\n` : '';
  return (
    `---\n` +
    `type: Epic\n` +
    `title: "${escapeYaml(title)}"\n` +
    `status: in-progress\n` +
    `priority: medium\n` +
    `category: agent-task\n` +
    `delegated: ${stamp}\n` +
    `---\n\n` +
    `# Epic: ${title}\n\n` +
    `${plan.summary}\n${source}${note}\n` +
    (body ? `## Brief\n\n${body}\n\n` : '') +
    `## Subtasks\n\n${list}\n` +
    refsSection
  );
}

// ── jobs.json ─────────────────────────────────────────────────────

interface JobRow {
  id: string;
  name: string;
  schedule: string;
  agent: string;
  prompt: string;
  open: string;
}

function appendJobsJson(root: string, row: JobRow): void {
  const dir = path.join(root, '.task-beacon');
  const file = path.join(dir, 'jobs.json');
  fs.mkdirSync(dir, { recursive: true });
  let doc: { jobs: Record<string, unknown>[] } = { jobs: [] };
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { jobs?: unknown };
      if (Array.isArray(parsed.jobs)) doc = { jobs: parsed.jobs as Record<string, unknown>[] };
    } catch {
      // Unreadable file: keep existing bytes untouched and write a sibling instead.
      fs.writeFileSync(path.join(dir, 'jobs.invalid.bak'), fs.readFileSync(file));
    }
  }
  doc.jobs = doc.jobs.filter((j) => j.id !== row.id);
  doc.jobs.push({ ...row, state: 'active' });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf-8');
}

// ── Runner ────────────────────────────────────────────────────────

export function runnerTemplate(): string {
  return vscode.workspace.getConfiguration('todoView').get<string>('agentRunner', '').trim();
}

function runnerName(): string {
  const t = runnerTemplate();
  if (!t) return 'any';
  return t.split(/\s+/)[0].replace(/^"|"$/g, '') || 'any';
}

function launchRunner(template: string, vars: { file: string; title: string; root: string }): void {
  const cmd = template
    .replace(/\{file\}/g, vars.file)
    .replace(/\{title\}/g, vars.title.replace(/"/g, "'"))
    .replace(/\{root\}/g, vars.root);
  const term = vscode.window.createTerminal({ name: `Beacon · ${vars.title.slice(0, 32)}`, cwd: vars.root });
  term.show();
  term.sendText(cmd);
}

/** Run every one-off subtask from a delegate result in its own terminal. */
export function runAllWithAgent(root: string, result: DelegateResult): number {
  const runner = runnerTemplate();
  if (!runner) return 0;
  let n = 0;
  result.taskFiles.forEach((rel, i) => {
    if (result.plan.subtasks[i].kind === 'schedule') return;
    const abs = path.join(root, rel);
    setFrontmatterStatus(abs, 'in-progress');
    launchRunner(runner, { file: abs, title: result.plan.subtasks[i].title, root });
    n++;
  });
  return n;
}

// ── Helpers ───────────────────────────────────────────────────────

async function requireWritableRoot(): Promise<string | undefined> {
  if (usingSampleWiki() || !effectiveWikiRoot()) {
    const pick = await vscode.window.showInformationMessage(
      'Delegating writes real task files. Choose your wiki folder first (the built-in samples are read-only).',
      'Choose folder…'
    );
    if (pick) await pickWikiRoot();
    return undefined;
  }
  return effectiveWikiRoot();
}

function existingTasksDir(root: string): string | undefined {
  for (const name of ['Tasks', 'tasks']) {
    const p = path.join(root, name);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
  }
  return undefined;
}

function ensureTasksDir(root: string): string {
  const existing = existingTasksDir(root);
  if (existing) return existing;
  const p = path.join(root, 'Tasks');
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function slugify(s: string): string {
  const base = s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return base || 'delegated';
}

function uniqueSlug(root: string, slug: string): string {
  const dir = existingTasksDir(root);
  if (!dir) return slug;
  const taken = (s: string) => fs.readdirSync(dir).some((n) => n.startsWith(`${s}-01-`));
  if (!taken(slug)) return slug;
  for (let i = 2; i < 100; i++) {
    if (!taken(`${slug}-${i}`)) return `${slug}-${i}`;
  }
  return `${slug}-${Date.now()}`;
}

function setFrontmatterStatus(absPath: string, status: string): void {
  if (!fs.existsSync(absPath)) return;
  const content = fs.readFileSync(absPath, 'utf-8');
  const updated = content.replace(/^status:\s*.*$/m, `status: ${status}`);
  if (updated !== content) fs.writeFileSync(absPath, updated, 'utf-8');
}

/** The wiki parser strips one pair of quotes and does not unescape — keep titles free of double quotes. */
function escapeYaml(s: string): string {
  return s.replace(/"/g, "'").replace(/\r?\n/g, ' ');
}
