import * as http from 'http';
import * as https from 'https';

export interface ModelStats {
  model: string;
  running: number;
  queue: number;
  kvCachePct: number;
  requests1h: number;
  promptTokensPerSec: number;
  genTokensPerSec: number;
  queueLatencyP99: number;
  prefillP99: number;
  decodeP99: number;
}

const QUERIES: { key: keyof Omit<ModelStats, 'model'>; expr: string }[] = [
  { key: 'running', expr: 'vllm:num_requests_running' },
  { key: 'queue', expr: 'vllm:num_requests_waiting' },
  { key: 'kvCachePct', expr: 'vllm:kv_cache_usage_perc * 100' },
  { key: 'requests1h', expr: 'sum by (model_name) (increase(vllm:request_success_total[1h]))' },
  { key: 'promptTokensPerSec', expr: 'sum by (model_name) (rate(vllm:prompt_tokens_total[5m]))' },
  { key: 'genTokensPerSec', expr: 'sum by (model_name) (rate(vllm:generation_tokens_total[5m]))' },
  {
    key: 'queueLatencyP99',
    expr: 'histogram_quantile(0.99, sum by (le, model_name) (rate(vllm:request_queue_time_seconds_bucket[5m])))',
  },
  {
    key: 'prefillP99',
    expr: 'histogram_quantile(0.99, sum by (le, model_name) (rate(vllm:request_prefill_time_seconds_bucket[5m])))',
  },
  {
    key: 'decodeP99',
    expr: 'histogram_quantile(0.99, sum by (le, model_name) (rate(vllm:request_decode_time_seconds_bucket[5m])))',
  },
];

/** Grafana's image-renderer plugin isn't installed on this server (not
 * user-administered, so not fixable there), and the configured panel ids
 * turned out to be non-renderable "row" section headers anyway. Instead of
 * server-side PNG rendering, query the underlying Prometheus datasource
 * directly through Grafana's anonymous datasource-proxy endpoint and render
 * stat cards client-side — mirrors the dashboard's per-model stat panels. */
export async function fetchVllmModelStats(grafanaUrl: string): Promise<ModelStats[]> {
  const base = grafanaUrl.replace(/\/d\/.*$/, '');
  const datasourceUid = await findPrometheusDatasourceUid(base);
  const results = await Promise.all(
    QUERIES.map(async ({ key, expr }) => {
      const path = `/api/datasources/proxy/uid/${datasourceUid}/api/v1/query?query=${encodeURIComponent(expr)}`;
      const raw = await getJson(`${base}${path}`);
      const parsed = JSON.parse(raw) as {
        data?: { result?: { metric?: { model_name?: string }; value?: [number, string] }[] };
      };
      const byModel = new Map<string, number>();
      for (const r of parsed.data?.result ?? []) {
        const model = r.metric?.model_name;
        const value = r.value?.[1];
        if (model && value !== undefined) byModel.set(model, Number(value));
      }
      return { key, byModel };
    })
  );

  const models = new Set<string>();
  for (const { byModel } of results) {
    for (const m of byModel.keys()) models.add(m);
  }

  return [...models].sort().map((model) => {
    const stats: Partial<ModelStats> = { model };
    for (const { key, byModel } of results) {
      stats[key] = byModel.get(model) ?? 0;
    }
    return stats as ModelStats;
  });
}

async function findPrometheusDatasourceUid(base: string): Promise<string> {
  const raw = await getJson(`${base}/api/datasources`);
  const datasources = JSON.parse(raw) as { uid?: string; type?: string }[];
  const prom = datasources.find((d) => d.type === 'prometheus');
  if (!prom?.uid) throw new Error('No Prometheus datasource found on Grafana server');
  return prom.uid;
}

function getJson(urlStr: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      reject(new Error(`Invalid Grafana URL: ${urlStr}`));
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
        timeout: 5000,
      },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`Grafana query failed (${res.statusCode}): ${data.slice(0, 200)}`));
            return;
          }
          resolve(data);
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Grafana query timed out')));
    req.end();
  });
}
