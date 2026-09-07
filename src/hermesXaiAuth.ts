import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Hermes xAI OAuth login status for Settings UI. Never includes tokens. */
export type HermesXaiLoginState = 'ok' | 'expired' | 'missing';

export interface HermesXaiLoginStatus {
  state: HermesXaiLoginState;
  /** Local datetime for display only. */
  expiresAt?: string;
}

const PLACEHOLDER_KEYS = new Set(['', 'sk-local']);

export function isExplicitAiKey(key: string | undefined): boolean {
  return !PLACEHOLDER_KEYS.has((key ?? '').trim());
}

/** Read Hermes `auth.json` for an xai-oauth access token. Never log the value. */
export function readHermesXaiAccessToken(): string | undefined {
  for (const file of hermesAuthFiles()) {
    const token = tokenFromAuthFile(file);
    if (token) return token;
  }
  return undefined;
}

export function isHermesXaiTokenExpired(token: string, skewSeconds = 60): boolean {
  const exp = jwtExpUnix(token);
  if (exp === undefined) return false;
  return exp <= Date.now() / 1000 + skewSeconds;
}

export function probeHermesXaiLogin(): HermesXaiLoginStatus {
  const token = readHermesXaiAccessToken();
  if (!token) return { state: 'missing' };
  const exp = jwtExpUnix(token);
  if (exp !== undefined && exp <= Date.now() / 1000 + 60) {
    return { state: 'expired', expiresAt: formatLocal(exp) };
  }
  return {
    state: 'ok',
    expiresAt: exp !== undefined ? formatLocal(exp) : undefined,
  };
}

function hermesAuthFiles(): string[] {
  const homes: string[] = [];
  const envHome = process.env.HERMES_HOME?.trim();
  if (envHome) homes.push(envHome);
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (localAppData) homes.push(path.join(localAppData, 'hermes'));
  homes.push(path.join(os.homedir(), '.hermes'));
  homes.push(path.join(os.homedir(), 'AppData', 'Local', 'hermes'));

  const seen = new Set<string>();
  const files: string[] = [];
  for (const home of homes) {
    const resolved = path.resolve(home);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    files.push(path.join(resolved, 'auth.json'));
  }
  return files;
}

function tokenFromAuthFile(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  let store: unknown;
  try {
    store = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!store || typeof store !== 'object') return undefined;
  const root = store as Record<string, unknown>;

  const fromProviders = tokenFromProviderState(root.providers);
  if (fromProviders) return fromProviders;

  return tokenFromCredentialPool(root.credential_pool);
}

function tokenFromProviderState(providers: unknown): string | undefined {
  if (!providers || typeof providers !== 'object') return undefined;
  const xai = (providers as Record<string, unknown>)['xai-oauth'];
  if (!xai || typeof xai !== 'object') return undefined;
  const tokens = (xai as Record<string, unknown>).tokens;
  if (!tokens || typeof tokens !== 'object') return undefined;
  return nonEmptyString((tokens as Record<string, unknown>).access_token);
}

function tokenFromCredentialPool(pool: unknown): string | undefined {
  if (!pool || typeof pool !== 'object') return undefined;
  const entries = (pool as Record<string, unknown>)['xai-oauth'];
  if (!Array.isArray(entries)) return undefined;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const token = nonEmptyString((entry as Record<string, unknown>).access_token);
    if (token) return token;
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function jwtExpUnix(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length < 2) return undefined;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(json) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

function formatLocal(expUnix: number): string {
  return new Date(expUnix * 1000).toLocaleString();
}
