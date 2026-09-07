import * as vscode from 'vscode';
import { fetchModelHealthMap, ModelHealthStatus } from './aiClient';

export type AiProvider = 'xai' | 'litellm' | 'openai' | 'anthropic' | 'ollama';

export interface AiSettings {
  provider: AiProvider;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
}

/** Per-provider defaults, mirrors Roo Code's provider dropdown behavior:
 * picking a provider resets baseUrl to its known endpoint, but leaves
 * apiKey/model alone if the user already customized them. */
export const PROVIDER_PRESETS: Record<AiProvider, { baseUrl: string; label: string }> = {
  xai: { baseUrl: 'https://api.x.ai/v1', label: 'xAI (Grok)' },
  litellm: { baseUrl: 'http://127.0.0.1:4000/v1', label: 'LiteLLM (local proxy)' },
  openai: { baseUrl: 'https://api.openai.com/v1', label: 'OpenAI' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', label: 'Anthropic' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', label: 'Ollama (local)' },
};

/** Static picker entries when the provider has no /model/info probe. */
export const PROVIDER_MODELS: Partial<Record<AiProvider, readonly string[]>> = {
  xai: ['grok-4.6', 'grok-4.5', 'grok-4', 'grok-3-mini'],
};

/**
 * Optional static picker list for the LiteLLM provider. Empty by default —
 * the picker and health view discover models dynamically from the proxy's
 * /model/info endpoint (see discoverModels). Populate this array if your
 * proxy does not expose /model/info and you want a fixed picker list.
 */
export const LITELLM_MODELS: string[] = [];

/** Union of the static list and everything the proxy reports, so users with
 * a live LiteLLM proxy get their real model_list without any config. */
export function discoverModels(
  staticList: readonly string[],
  health: Map<string, ModelHealthStatus> | undefined
): string[] {
  const set = new Set(staticList);
  for (const alias of health?.keys() ?? []) set.add(alias);
  return [...set].sort();
}

function normalizeProvider(raw: string): AiProvider {
  if (raw === 'grok') return 'xai';
  if (raw in PROVIDER_PRESETS) return raw as AiProvider;
  return 'litellm';
}

export function getAiSettings(): AiSettings {
  const cfg = vscode.workspace.getConfiguration('todoView');
  return {
    provider: normalizeProvider(cfg.get<string>('aiProvider', 'litellm')),
    baseUrl: cfg.get<string>('aiBaseUrl', PROVIDER_PRESETS.litellm.baseUrl),
    apiKey: cfg.get<string>('aiApiKey', 'sk-local'),
    defaultModel: cfg.get<string>('aiDefaultModel', ''),
  };
}

async function setAiConfig(key: string, value: string): Promise<void> {
  await vscode.workspace
    .getConfiguration('todoView')
    .update(key, value, vscode.ConfigurationTarget.Global);
}

/** Icon prefix keeps the picker responsive even if the health probe is slow
 * or the proxy is down — health is "best effort" annotation, not a gate. */
function healthIcon(status: ModelHealthStatus | undefined): string {
  if (status === 'healthy') return '$(pass-filled) ';
  if (status === 'unhealthy') return '$(error) ';
  return '';
}

export async function promptSelectAiModel(): Promise<void> {
  const current = getAiSettings();

  let health: Map<string, ModelHealthStatus> | undefined;
  if (current.provider === 'litellm') {
    try {
      health = await fetchModelHealthMap(current);
    } catch {
      // Proxy unreachable or /health not supported — fall back to unannotated list.
    }
  }
  const list =
    current.provider === 'litellm'
      ? discoverModels(LITELLM_MODELS, health)
      : [...(PROVIDER_MODELS[current.provider] ?? [])];

  const items: vscode.QuickPickItem[] = list.map((m) => ({
    label: `${healthIcon(health?.get(m))}${m}`,
    description: health?.get(m) === 'unhealthy' ? 'currently failing health check' : undefined,
    picked: m === current.defaultModel,
  }));
  items.push({ label: '$(edit) Enter custom model id...' });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Select default model (current: ${current.defaultModel})`,
  });
  if (!picked) return;

  let model = picked.label.replace(/^\$\([\w-]+\)\s*/, '');
  if (picked.label.startsWith('$(edit)')) {
    const entered = await vscode.window.showInputBox({
      prompt: 'Model id/alias (must exist on the provider)',
      value: current.defaultModel,
    });
    if (!entered) return;
    model = entered;
  }

  await setAiConfig('aiDefaultModel', model);
  vscode.window.setStatusBarMessage(`Beacon: default model set to "${model}"`, 2500);
}
