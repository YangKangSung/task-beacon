import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';

const TOKEN_SECRET_KEY = 'taskBeacon.ghToken';
const LAST_CHECK_KEY = 'taskBeacon.lastUpdateCheckMs';
const LAST_NOTIFIED_KEY = 'taskBeacon.lastNotifiedVersion';
const TOKEN_PROMPT_SHOWN_KEY = 'taskBeacon.tokenPromptShown';

interface RepoRef {
  apiBase: string; // e.g. https://api.github.com or https://ghe.example.com/api/v3
  owner: string;
  repo: string;
}

/** Parses package.json's repository.url into a GHES API base + owner/repo,
 * so this keeps working if the repo is ever renamed/forked without a code change. */
function parseRepoUrl(url: string): RepoRef | undefined {
  const m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  if (!m) return undefined;
  const [, host, owner, repo] = m;
  // github.com's REST API lives on a separate host; GHES uses /api/v3
  const apiBase = host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
  return { apiBase, owner, repo };
}

function getJson(urlStr: string, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      reject(new Error(`Invalid update-check URL: ${urlStr}`));
      return;
    }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'task-beacon-update-check',
        },
        timeout: 8000,
      },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`update check failed (${res.statusCode})`));
            return;
          }
          resolve(data);
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('update check timed out')));
    req.end();
  });
}

/** Compares "vX.Y.Z"/"X.Y.Z" tags numerically, ignoring any pre-release suffix. */
function isNewer(remote: string, local: string): boolean {
  const parse = (v: string) =>
    v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const [rMaj, rMin, rPatch] = parse(remote);
  const [lMaj, lMin, lPatch] = parse(local);
  if (rMaj !== lMaj) return rMaj > lMaj;
  if (rMin !== lMin) return rMin > lMin;
  return rPatch > lPatch;
}

async function fetchLatestTag(ref: RepoRef, token: string): Promise<string | undefined> {
  const raw = await getJson(`${ref.apiBase}/repos/${ref.owner}/${ref.repo}/tags`, token);
  const tags = JSON.parse(raw) as { name: string }[];
  if (!Array.isArray(tags) || tags.length === 0) return undefined;
  // Tags aren't guaranteed chronological order from the API — pick the numerically highest.
  return tags.map((t) => t.name).sort((a, b) => (isNewer(a, b) ? 1 : -1)).pop();
}

async function promptForToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  const token = await vscode.window.showInputBox({
    prompt: 'GHES personal access token (repo:read scope) for update checks — stored encrypted, never logged',
    password: true,
    ignoreFocusOut: true,
  });
  if (!token) return undefined;
  await context.secrets.store(TOKEN_SECRET_KEY, token);
  return token;
}

export function registerUpdateCheckCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('todoView.setUpdateCheckToken', () => promptForToken(context)),
    vscode.commands.registerCommand('todoView.checkForUpdates', () => runUpdateCheck(context, true))
  );
}

/**
 * Fire-and-forget background check, throttled to once per
 * `todoView.updateCheckIntervalHours` (default 24h). Never throws — a failed
 * check (no token, proxy down, host unreachable) degrades to silent no-op so
 * it can't break activation or spam the user on a flaky network.
 */
export async function runUpdateCheck(context: vscode.ExtensionContext, manual: boolean): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('todoView');
  if (!manual && !cfg.get<boolean>('updateCheckEnabled', true)) return;

  const now = Date.now();
  if (!manual) {
    const last = context.globalState.get<number>(LAST_CHECK_KEY, 0);
    const intervalMs = cfg.get<number>('updateCheckIntervalHours', 24) * 3600_000;
    if (now - last < intervalMs) return;
  }

  const repoUrl = (context.extension.packageJSON.repository?.url as string | undefined) ?? '';
  const ref = parseRepoUrl(repoUrl);
  if (!ref) return;

  let token = await context.secrets.get(TOKEN_SECRET_KEY);
  if (!token) {
    if (manual) {
      token = await promptForToken(context);
      if (!token) return;
    } else {
      const alreadyShown = context.globalState.get<boolean>(TOKEN_PROMPT_SHOWN_KEY, false);
      if (alreadyShown) return;
      await context.globalState.update(TOKEN_PROMPT_SHOWN_KEY, true);
      const pick = await vscode.window.showInformationMessage(
        'Task Beacon can check GitHub for newer releases. Set a token to enable this?',
        'Set Token',
        'Not now'
      );
      if (pick !== 'Set Token') return;
      token = await promptForToken(context);
      if (!token) return;
    }
  }

  await context.globalState.update(LAST_CHECK_KEY, now);

  let latest: string | undefined;
  try {
    latest = await fetchLatestTag(ref, token);
  } catch {
    return; // network/proxy/auth failure — silent, retried next interval
  }
  if (!latest) return;

  const currentVersion = context.extension.packageJSON.version as string;
  if (!isNewer(latest, currentVersion)) {
    if (manual) vscode.window.setStatusBarMessage('Beacon: up to date', 2500);
    return;
  }

  const lastNotified = context.globalState.get<string>(LAST_NOTIFIED_KEY);
  if (!manual && lastNotified === latest) return; // already nagged for this version once

  await context.globalState.update(LAST_NOTIFIED_KEY, latest);
  const pick = await vscode.window.showInformationMessage(
    `Task Beacon ${latest} is available (installed: ${currentVersion}).`,
    'View Release',
    'Later'
  );
  if (pick === 'View Release') {
    vscode.env.openExternal(
      vscode.Uri.parse(`https://${new URL(ref.apiBase).host}/${ref.owner}/${ref.repo}/releases/tag/${latest}`)
    );
  }
}
