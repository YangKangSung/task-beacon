import * as http from 'http';
import * as https from 'https';
import { AiSettings } from './aiConfig';
import { isExplicitAiKey, isHermesXaiTokenExpired, readHermesXaiAccessToken } from './hermesXaiAuth';

export type SummaryKind = 'jira' | 'wiki' | 'cron' | 'insights';

const INSTRUCTIONS: Record<SummaryKind, string> = {
  jira:
    'Summarize this Jira ticket for a busy engineer in 2-4 concise sentences. ' +
    'Focus on the actual work needed and any blockers or open questions. ' +
    'Skip metadata already shown elsewhere (status/priority/dates).',
  wiki:
    'Summarize this task note in 2-4 concise sentences. Focus on what needs to be done and current state.',
  cron:
    "Summarize what this script does in 1-3 concise sentences, in plain language (not a line-by-line walkthrough).",
  insights:
    'You are the tactical AI for Task Beacon — Official (company), Private (personal), and Agent work. ' +
    'Given the following snapshot of open work, produce a terse actionable digest with three sections:\n' +
    '**Top priorities** — 3 bullets, hardest overdue + blockers first, each bullet has ID + one-line why.\n' +
    '**Blockers / risks** — 1-3 bullets, anything failing, stalled >7 days, or missing info.\n' +
    '**Next actions** — 2-4 bullets in imperative form ("Ping X on Y", "Restart cron Z").\n' +
    'No preamble, no filler, no closing summary. Total under 200 words. Markdown bullets only.',
};

/** Real chat-completions call, OpenAI-compatible (works against LiteLLM/
 * Ollama/OpenAI/Grok/Anthropic-via-proxy alike, per getAiSettings()'s baseUrl).
 * Uses http/https directly rather than fetch() — VS Code's extension host
 * Node version varies by release and fetch was experimental pre-v21. */
export async function summarizeWithAi(
  settings: AiSettings,
  kind: SummaryKind,
  content: string
): Promise<string> {
  const prompt = `${INSTRUCTIONS[kind]}\n\n---\n${content}`;
  const body = JSON.stringify({
    model: settings.defaultModel,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    // Reasoning models burn tokens on reasoning_content
    // before emitting `content` — verified 1200 still hits finish_reason
    // "length" with content: null on a ~370-token prompt (1290 completion
    // tokens needed). 4000 covers realistic Jira/task description lengths.
    max_tokens: 4000,
  });

  const url = `${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const raw = await postJson(url, body, bearerFor(settings), settings.provider);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`AI response was not valid JSON: ${raw.slice(0, 200)}`);
  }
  const message = (
    parsed as {
      choices?: { finish_reason?: string; message?: { content?: string; reasoning_content?: string } }[];
    }
  )?.choices?.[0];
  const text = message?.message?.content;
  if (typeof text === 'string' && text.trim()) {
    return text.trim();
  }
  if (message?.finish_reason === 'length') {
    throw new Error(
      'AI reply was cut off before it finished reasoning (finish_reason: length). Try a shorter input or raise max_tokens.'
    );
  }
  throw new Error('AI response had no content');
}

export type ModelHealthStatus = 'healthy' | 'unhealthy';

/** Cross-references LiteLLM's /model/info (alias -> backend model id) with
 * /health (which backend model ids are currently failing) to get a per-alias
 * health status. Both endpoints live at the proxy root, not under /v1. Short
 * 5s timeout since this only feeds a UI hint — if the proxy is slow/down we
 * just skip annotating rather than blocking the model picker. */
export async function fetchModelHealthMap(settings: AiSettings): Promise<Map<string, ModelHealthStatus>> {
  const root = settings.baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  const bearer = bearerFor(settings);
  const [infoRaw, healthRaw] = await Promise.all([
    getJson(`${root}/model/info`, bearer),
    getJson(`${root}/health`, bearer),
  ]);

  const info = JSON.parse(infoRaw) as {
    data?: { model_name?: string; litellm_params?: { model?: string } }[];
  };
  const health = JSON.parse(healthRaw) as { unhealthy_endpoints?: { model?: string }[] };
  const unhealthyBackends = new Set((health.unhealthy_endpoints ?? []).map((e) => e.model));

  const result = new Map<string, ModelHealthStatus>();
  for (const entry of info.data ?? []) {
    const alias = entry.model_name;
    const backend = entry.litellm_params?.model;
    if (!alias || !backend) continue;
    result.set(alias, unhealthyBackends.has(backend) ? 'unhealthy' : 'healthy');
  }
  return result;
}

function bearerFor(settings: AiSettings): string {
  if (settings.provider !== 'xai' || isExplicitAiKey(settings.apiKey)) {
    return settings.apiKey;
  }
  const token = readHermesXaiAccessToken();
  if (!token) {
    throw new Error(
      'xAI uses Hermes login (SuperGrok / X Premium+), not a console API key. Run `hermes auth add xai-oauth` in a terminal, then retry.'
    );
  }
  if (isHermesXaiTokenExpired(token)) {
    throw new Error(
      'Hermes xAI login expired. Run `hermes auth add xai-oauth` again, or open Hermes so it can refresh the token.'
    );
  }
  return token;
}

function getJson(urlStr: string, apiKey: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      reject(new Error(`Invalid AI base URL: ${urlStr}`));
      return;
    }
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;

    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 5000,
      },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`Health check failed (${res.statusCode}): ${data.slice(0, 200)}`));
            return;
          }
          resolve(data);
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Health check timed out')));
    req.end();
  });
}

function postJson(urlStr: string, body: string, apiKey: string, provider?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      reject(new Error(`Invalid AI base URL: ${urlStr}`));
      return;
    }
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;

    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${apiKey}`,
        },
        // Reasoning models can take 60-90s on longer inputs (thinking pass
        // before content) — 30s was cutting those off mid-request.
        timeout: 90000,
      },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 400) {
            if (res.statusCode === 401 && provider === 'xai') {
              reject(
                new Error(
                  'xAI rejected the Hermes login token. Run `hermes auth add xai-oauth` again, or open Hermes so it can refresh.'
                )
              );
              return;
            }
            reject(new Error(`AI request failed (${res.statusCode}): ${data.slice(0, 300)}`));
            return;
          }
          resolve(data);
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('AI request timed out')));
    req.write(body);
    req.end();
  });
}
