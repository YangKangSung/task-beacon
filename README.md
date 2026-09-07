# Task Beacon — AI Todo Agent

VS Code extension unifying **Jira** (Official), **LLMWiki tasks** (Private), and **Hermes Cron** (Automated) into a single sidebar beacon.

Inspired by GitLens and todo-tree, extended with an AI-powered dashboard for tactical decision support.

## Features

- **Sidebar tree** — collapsible subheads for Jira / LLMWiki / Cron with cycle-filter
- **4-category classification** (2026-07-25) — every LLMWiki task is tagged with one of `official` / `private` / `veda-task` / `veda-cron` (or `unknown`); visible as a `[category]` prefix on the task label and as a themed icon (💼/🏠/🤖/🕒) in the hover tooltip
- **Summary sub-panel** — details view for selected item + AI summary
- **Table view** — sortable, filterable webview grid
- **Chart view** — trend lines from local snapshot history (JSONL, append-only)
- **Panel dashboard** — full-width bottom panel with counters, top items, alarms, trend charts, and AI insights
- **AI insights** — OpenAI-compatible endpoint (LiteLLM / OpenAI / Anthropic / Ollama), model picker with health map

### 4-category classification

Each LLMWiki task file (`tasks/*.md`) carries a `category:` frontmatter field, populated by `show_todo.py` from the file's frontmatter (with inline `**[Category]**` marker fallback). The 4-category system was established 2026-07-25 to separate master's personal tasks from Veda-managed automation work:

| Category | Icon | Source | Meaning |
|----------|------|--------|---------|
| `official` | 💼 `$(briefcase)` | Jira team work | Company/team tasks |
| `private` | 🏠 `$(home)` | master personal portfolio | Personal projects |
| `veda-task` | 🤖 `$(robot)` | Veda self-registered | Agent-managed tasks |
| `veda-cron` | 🕒 `$(clock)` | cron/watchdog patterns | Automated routines |

Classification rules live in `show_todo.py` (`_read_task_category`); this extension just consumes the result. To re-classify a task, edit the file's `category:` frontmatter and refresh the sidebar.

## Data source

Shells out to `<llmWikiRoot>/scripts/show_todo.py --json full`. No logic duplicated — Jira auth/proxy, LLMWiki parsing, and cron introspection all live in `show_todo.py`. Cron run history is read directly from the live Hermes profile at `<hermes home>/profiles/<profile>/cron/`, not a mirror.

## Recovery

If this repository is damaged or the build breaks, paste the prompt block in
[AI-RECOVERY.md](AI-RECOVERY.md) into any AI coding agent to fully restore it.

## Build

```bash
npm install
npm run build
npx vsce package
code --install-extension task-beacon-*.vsix --force
```

Then in VS Code: `Developer: Reload Window`.

## Settings

| Key | Default | Description |
|-----|---------|-------------|
| `todoView.hermesProfile` | `default` | Hermes profile whose cron state is displayed |
| `todoView.llmWikiRoot` | *(empty — set to your wiki root)* | Path to LLMWiki repo (contains `scripts/show_todo.py` and `tasks/<slug>.md`) |
| `todoView.pythonPath` | `python` | Python executable used to invoke `show_todo.py` |
| `todoView.autoRefreshSec` | `0` | Auto-refresh interval in seconds (0 = disabled) |
| `todoView.aiProvider` | `litellm` | AI provider (`litellm` / `openai` / `anthropic` / `ollama`) |
| `todoView.aiBaseUrl` | `http://127.0.0.1:4000/v1` | OpenAI-compatible base URL |
| `todoView.aiApiKey` | `sk-local` | API key (use local proxy key, not a real provider secret) |
| `todoView.aiDefaultModel` | *(empty)* | Default model alias |
| `todoView.grafanaUrl` | *(empty)* | Base dashboard URL. `/d/<uid>/<slug>` is rewritten to `/render/d-solo/<uid>/<slug>?panelId=N`. Empty hides the section. Internal-network only. |
| `todoView.grafanaPanelIds` | `[]` | Panel IDs (numbers) to embed as server-rendered PNGs |

### Grafana embed

Requires the [Grafana image renderer plugin](https://grafana.com/grafana/plugins/grafana-image-renderer/) installed on the server (bundled by default in recent Grafana releases). Uses `/render/d-solo/...` PNG output instead of `<iframe>` so it sidesteps CSP `frame-src`, `X-Frame-Options`, and iframe auth-cookie issues.

To find panel IDs: open the dashboard in Grafana, click the panel title → **Share** → **Direct link rendered image**. The `panelId=N` value in that URL goes into `todoView.grafanaPanelIds`.

Example:

```jsonc
{
  "todoView.grafanaUrl": "https://grafana.example.com/d/abc123/overview",
  "todoView.grafanaPanelIds": [2, 4, 7]
}
```

## History store

`context.globalStorageUri/history.jsonl` — append-only snapshot log (max 5000 entries, min 1h between changed snapshots). Deleting the file resets the chart.

## License

MIT — see [LICENSE](LICENSE).
