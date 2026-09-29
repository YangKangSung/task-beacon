import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';

interface Worker {
  request(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  stop(): void;
}

export class LanesViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'todoView.panelLanes';
  private view: vscode.WebviewView | undefined;
  private worker: Worker | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const extensionUri = this.context.extensionUri;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [extensionUri] };
    const nonce = nonceOf();
    webviewView.webview.html = this.html(webviewView.webview, extensionUri, nonce);
    const home = resolveHermesHome();
    const python = findPython(home);
    const reader = startWorker(python, path.join(this.context.extensionPath, 'python'));
    this.worker = reader;
    webviewView.webview.onDidReceiveMessage(async (message: { type?: string; start?: number; end?: number; idle?: number; fresh?: boolean; profile?: string; id?: string }) => {
      try {
        if (message.type === 'board') {
          const response = await reader.request({
            cmd: 'board',
            home,
            start: message.start,
            end: message.end,
            idle: message.idle,
            fresh: !!message.fresh,
          });
          void webviewView.webview.postMessage({ type: 'board', ...response });
        } else if (message.type === 'session') {
          const response = await reader.request({
            cmd: 'session',
            home,
            profile: message.profile,
            id: message.id,
            idle: message.idle,
          });
          if (!response.ok) {
            void webviewView.webview.postMessage({ type: 'error', message: String(response.error || 'session not found') });
          } else {
            void webviewView.webview.postMessage({ type: 'session', session: response.session });
          }
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        void webviewView.webview.postMessage({ type: 'error', message: text });
      }
    });
    webviewView.onDidDispose(() => {
      reader.stop();
      if (this.worker === reader) this.worker = undefined;
      this.view = undefined;
    });
  }

  dispose(): void {
    this.worker?.stop();
  }

  private html(webview: vscode.Webview, extensionUri: vscode.Uri, nonce: string): string {
    const indexPath = path.join(extensionUri.fsPath, 'media', 'lanes', 'index.html');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'lanes', 'app.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'lanes', 'app.js'));
    return fs.readFileSync(indexPath, 'utf8')
      .replace('href="/app.css"', `href="${css}"`)
      .replace('src="/app.js"', `nonce="${nonce}" src="${js}"`)
      .replace(
        '<head>',
        `<head>\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">`,
      );
  }
}

function resolveHermesHome(): string {
  const configured = vscode.workspace.getConfiguration('todoView').get<string>('hermesHome', '').trim();
  if (configured) return configured;
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME;
  const local = process.env.LOCALAPPDATA;
  if (local && fs.existsSync(path.join(local, 'hermes', 'state.db'))) return path.join(local, 'hermes');
  return path.join(os.homedir(), '.hermes');
}

function firstExisting(candidates: string[]): string {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || '';
}

function findPython(home: string): string {
  const venv = firstExisting([
    path.join(home, 'hermes-agent', 'venv', 'Scripts', 'python.exe'),
    path.join(home, 'hermes-agent', 'venv', 'bin', 'python'),
    path.join(home, 'hermes-agent', 'venv', 'bin', 'python3'),
  ]);
  if (venv) return venv;
  const configured = vscode.workspace.getConfiguration('todoView').get<string>('pythonPath', 'python').trim();
  if (configured && (configured === 'python' || configured === 'py' || configured === 'python3' || fs.existsSync(configured))) {
    return configured;
  }
  return process.platform === 'win32' ? 'py' : 'python3';
}

function startWorker(python: string, pythonRoot: string): Worker {
  const args = path.basename(python).toLowerCase() === 'py.exe' || path.basename(python).toLowerCase() === 'py'
    ? ['-3', '-m', 'hermes_lanes.export', 'serve']
    : ['-m', 'hermes_lanes.export', 'serve'];
  const child: ChildProcessWithoutNullStreams = spawn(python, args, {
    cwd: pythonRoot,
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONPATH: pythonRoot,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
    },
  });
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (reason: Error) => void }>();
  let buffer = '';
  let stderr = '';
  let nextId = 1;
  let closed = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
      if (!line) continue;
      let msg: { id?: number };
      try {
        msg = JSON.parse(line) as { id?: number };
      } catch {
        continue;
      }
      if (msg.id == null) continue;
      const waiter = pending.get(msg.id);
      if (!waiter) continue;
      pending.delete(msg.id);
      waiter.resolve(msg as Record<string, unknown>);
    }
  });
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  child.on('exit', () => {
    closed = true;
    for (const waiter of pending.values()) waiter.reject(new Error(stderr.trim() || 'Hermes reader stopped'));
    pending.clear();
  });
  return {
    request(payload) {
      if (closed) return Promise.reject(new Error(stderr.trim() || 'Hermes reader stopped'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ ...payload, id }) + '\n');
      });
    },
    stop() {
      closed = true;
      child.kill();
    },
  };
}

function nonceOf(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
