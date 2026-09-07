# Optional next

The tree works with only a wiki folder. Everything else is extra.

- **Hermes cron** — if Hermes is installed, Agent shows live jobs. No extra path needed.
- **xAI** — same login as Hermes (`hermes auth add xai-oauth`). No console API key.
- **Jira** — only if your company uses Jira. Skip it if you use Linear, GitHub Issues, or just the wiki. Official still shows `category: official` tasks.
- **Grafana / AI Health** — set the Grafana URL in Settings → AI to watch on-prem LiteLLM / vLLM models. The AI Health panel then opens next to the dashboard. Leave empty if you do not use that.

Open **Settings** in the Task Beacon sidebar when you want those.
