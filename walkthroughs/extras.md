# Optional: Jira, AI, Grafana

Open **Settings** from the sidebar or Command Palette (`Task Beacon: Settings...`). Save when you change something. If a panel does not appear, run **Developer: Reload Window**.

## Jira — only if your company uses Jira

Skip this if you use Linear, GitHub Issues, Notion, or just markdown. Official still shows wiki tasks with `category: official`.

If you do use Jira: Settings → Jira → base URL (no `/browse` at the end) and account. The password is stored in VS Code Secret Storage, not in `settings.json`.

## AI summaries — optional

Summarize and dashboard insights need a provider. Defaults assume **xAI (Grok)** via the same Hermes login as SuperGrok / X Premium+.

| You use | What to do |
|---------|------------|
| SuperGrok / X Premium+ / Hermes xAI | Settings → AI → **Log in with Hermes**, or a terminal: `hermes auth add xai-oauth`. No console API key. |
| Ollama on this machine | Provider: Ollama. Leave the local URL unless you changed it. |
| Other OpenAI-compatible proxy | Provider: LiteLLM / OpenAI / Anthropic and set the base URL. |
| No AI | Ignore this. The tree still works. |

## Grafana / AI Health — only for on-prem model switching

If you watch LiteLLM / vLLM in Grafana: Settings → AI → Grafana URL, then Save. The **AI Health** panel opens next to the bottom dashboard.

Leave the URL empty if you only use xAI or Ollama. That panel stays hidden on purpose. The setting is still there when you need it.
