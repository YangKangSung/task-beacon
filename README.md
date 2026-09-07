<p align="center">
  <img src="resources/icon.png" width="128" height="128" alt="Task Beacon">
</p>

<h1 align="center">Task Beacon</h1>

<p align="center">
  <strong>Hermes-first task board in VS Code.</strong><br>
  Jira’s epic / task model for company, personal, and Hermes agent work — including cron.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=YangKangSung.task-beacon"><img src="https://img.shields.io/visual-studio-marketplace/v/YangKangSung.task-beacon?label=Marketplace&logo=visual-studio-code&logoColor=white" alt="Marketplace version"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=YangKangSung.task-beacon"><img src="https://img.shields.io/visual-studio-marketplace/d/YangKangSung.task-beacon?label=Installs" alt="Installs"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=YangKangSung.task-beacon"><img src="https://img.shields.io/visual-studio-marketplace/r/YangKangSung.task-beacon?label=Rating" alt="Rating"></a>
  <a href="https://github.com/sponsors/YangKangSung"><img src="https://img.shields.io/badge/Sponsor-YangKangSung-ea4aaa?logo=githubsponsors" alt="Sponsor"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

[Hermes](https://github.com/NousResearch/hermes-agent) is the agent runtime this board is built around. Task Beacon does not replace Hermes. It is the epic / task view for work Hermes already owns — plus company Jira and personal wiki tasks in the same tree.

The idea is simple: **Jira already got epics and tasks right.** Use that shape for three owners, with Hermes first.

| Owner | What you manage |
|-------|-----------------|
| **Company** (Official) | Team epics and tasks — Jira plus wiki tasks tagged `official` |
| **Personal** (Private) | Your own epics and tasks in the wiki |
| **Agent** (Hermes) | Hermes agent tasks **and** Hermes cron — same epic/task tree |

Epics group work. Tasks are the items. Hermes cron is the recurring agent work. The tree, table, and dashboard are that management surface — filter by owner, open the epic or the task, see what is overdue or failing.

Inspired by GitLens and Todo Tree, but the unit here is *owned work*, not comments in source.

---

## Getting started

1. Install **Task Beacon** from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=YangKangSung.task-beacon), or search the name in Extensions (`Ctrl+Shift+X`).
2. Click the beacon icon in the Activity Bar (or open the **Task Beacon** panel).
3. Run **Task Beacon: Settings...** from the Command Palette.
4. Set **LLMWiki repo root** to a folder that contains `scripts/show_todo.py` and `tasks/`.
5. If Hermes is installed locally, set **Hermes profile** (default `default`) so cron jobs show under Agent.

Wiki tasks work without Hermes. Hermes cron is the reason Agent exists.

```text
Command Palette → Task Beacon: Settings...
```

---

## What you see

The tree is the same epic → task outline Jira uses, split by owner. Cycle owners with the filter (All → Official → Private → Agent).

| Owner | Epics & tasks from | Cron |
|-------|--------------------|------|
| **Official** | Jira + wiki `official` | — |
| **Private** | Wiki `private` | — |
| **Agent** | Wiki `agent-task` / `agent-cron` | Live Hermes cron (`profiles/<name>/cron/`) |

Wiki tasks can set `epic:` / `epic_link:` in frontmatter so they nest under an epic, just like Jira issues with an Epic Link. Items with no epic stay flat.

Click a row to open the Jira issue, the markdown task, or the cron script.

Next to the tree:

- **Summary** — details for the selected item, optional AI summary
- **Table** — sortable grid of the same items
- **Chart** — counts over time (local snapshot history)
- **Cron Runs** — recent job output
- **Settings** — the same setup UI as the command

A bottom **Task Beacon** panel adds counters, alarms, and optional AI insights.

---

## Wiki categories

Each `tasks/*.md` file can set `category:` in frontmatter. The extension only displays it.

| Category | Meaning |
|----------|---------|
| `official` | Team / company work |
| `private` | Personal |
| `agent-task` | Agent-owned tasks |
| `agent-cron` | Recurring automation |

Older `veda-task` / `veda-cron` values still load; they show as `agent-task` / `agent-cron`.

---

## Requirements

| Need | Why |
|------|-----|
| VS Code 1.80+ | Extension host |
| [Hermes](https://github.com/NousResearch/hermes-agent) | Agent runtime. Cron is read from the live profile |
| Python 3 | Runs `show_todo.py` for Jira + wiki |
| A wiki folder | Must include `scripts/show_todo.py` |

Optional:

- **Jira** — set base URL and account via **Settings...** (password goes to Secret Storage)
- **AI** — xAI (Grok) first, then LiteLLM, OpenAI, Anthropic, or Ollama. xAI uses the same Hermes login as SuperGrok / X Premium+ (`hermes auth add xai-oauth`), not a console API key.

Empty settings stay empty on purpose. No machine paths ship in the install.

---

## Settings

Open **Task Beacon: Settings...**, or edit these keys:

| Setting | Default | Purpose |
|---------|---------|---------|
| `todoView.llmWikiRoot` | *(empty)* | Wiki root with `scripts/show_todo.py` |
| `todoView.pythonPath` | `python` | Python used to run that script |
| `todoView.jiraBaseUrl` | *(empty)* | Jira site, no `/browse` |
| `todoView.hermesProfile` | `default` | Hermes profile for cron |
| `todoView.autoRefreshSec` | `0` | Auto-refresh; `0` is off |
| `todoView.aiProvider` | `litellm` | `xai` / `litellm` / `openai` / `anthropic` / `ollama` |
| `todoView.aiBaseUrl` | `http://127.0.0.1:4000/v1` | OpenAI-compatible API |
| `todoView.aiApiKey` | `sk-local` | Optional. xAI uses Hermes login; local proxies use a proxy key |
| `todoView.aiDefaultModel` | *(empty)* | Default model id |
| `todoView.grafanaUrl` | *(empty)* | Optional Grafana URL for model stats; leave empty to hide |

---

## Useful commands

| Command | Does |
|---------|------|
| **Task Beacon: Settings...** | First-run setup |
| **Task Beacon: Refresh** | Reload Jira / wiki / cron |
| **Task Beacon: Cycle Filter** | All → Official → Private → Agent |
| **Task Beacon: Search / Filter Tree...** | Filter the tree |
| **Task Beacon: Select AI Model...** | Pick a model when AI is configured |
| **Task Beacon: Log in to xAI via Hermes** | Device login (`hermes auth add xai-oauth`) |

---

## How data is loaded

The extension does not reimplement Jira or wiki parsing. It runs:

```text
<llmWikiRoot>/scripts/show_todo.py --json full
```

Cron state is read from the live Hermes profile (`profiles/<name>/cron/`), not a copy.

Charts use an append-only log under the extension’s global storage (`history.jsonl`). Delete that file to reset the chart.

---

## Develop

```bash
npm install
npm run build
```

Press **F5** for an Extension Development Host, or:

```bash
npm run package
code --install-extension task-beacon-*.vsix --force
```

If the repo is damaged, paste [AI-RECOVERY.md](AI-RECOVERY.md) into a coding agent.

---

## Sponsor

If Task Beacon is useful: [github.com/sponsors/YangKangSung](https://github.com/sponsors/YangKangSung).

## License

[MIT](LICENSE)
