<p align="center">
  <img src="resources/icon.png" width="128" height="128" alt="Task Beacon">
</p>

<h1 align="center">Task Beacon</h1>

<p align="center">
  <strong>Official, Private, and Agent tasks in one VS Code sidebar.</strong><br>
  Jira’s epic / task model. A wiki folder is enough. Jira, Hermes, and Grafana are optional.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=YangKangSung.task-beacon"><img src="https://img.shields.io/visual-studio-marketplace/v/YangKangSung.task-beacon?label=Marketplace&logo=visual-studio-code&logoColor=white" alt="Marketplace version"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=YangKangSung.task-beacon"><img src="https://img.shields.io/visual-studio-marketplace/d/YangKangSung.task-beacon?label=Installs" alt="Installs"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=YangKangSung.task-beacon"><img src="https://img.shields.io/visual-studio-marketplace/r/YangKangSung.task-beacon?label=Rating" alt="Rating"></a>
  <a href="https://github.com/sponsors/YangKangSung"><img src="https://img.shields.io/badge/Sponsor-YangKangSung-ea4aaa?logo=githubsponsors" alt="Sponsor"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

The idea is simple: **Jira already got epics and tasks right.** Use that shape for three owners. The source of truth is a wiki folder. You do not need Jira, and you do not need [Hermes](https://github.com/NousResearch/hermes-agent).

| Owner | What you manage |
|-------|-----------------|
| **Company** (Official) | Team epics and tasks — wiki `official`, plus Jira *if* you use Jira |
| **Personal** (Private) | Your own epics and tasks in the wiki |
| **Agent** | Agent-owned wiki tasks. Live cron only if Hermes is installed |

Epics group work. Tasks are the items. The tree, table, and dashboard are that management surface — filter by owner, open the epic or the task, see what is overdue or failing.

Other agents (Cursor, Claude Code, Codex, …) are not wired as a live runtime. Put that work in the wiki with `category: agent-task` or `agent-cron`, same as Official and Private.

Inspired by GitLens and Todo Tree, but the unit here is *owned work*, not comments in source.

---

## Getting started

1. Install **Task Beacon** from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=YangKangSung.task-beacon), or search the name in Extensions (`Ctrl+Shift+X`).
2. A **Get Started** walkthrough opens after install (Command Palette → **Task Beacon: Get Started**). Follow the steps — samples first, then your folder.
3. Click the beacon icon in the Activity Bar. The tree already has sample Official / Private / Agent tasks.
4. When you want your own work, pick the **vault or repo root** (the folder that contains `Tasks/`, not `Tasks` itself). Jira, Hermes, AI, and Grafana stay optional.

Wiki tasks work with no agent runtime. Hermes is optional — it adds live cron under Agent if you already use it.

```text
Command Palette → Task Beacon: Settings...
```

---

## What you see

The tree is the same epic → task outline Jira uses, split by owner. Cycle owners with the filter (All → Official → Private → Agent).

| Owner | Epics & tasks from | Cron |
|-------|--------------------|------|
| **Official** | Wiki `official` (+ Jira only if configured) | — |
| **Private** | Wiki `private` | — |
| **Agent** | Wiki `agent-task` / `agent-cron` | Hermes cron, if Hermes is installed |

Wiki tasks can set `epic:` / `epic_link:` in frontmatter so they nest under an epic, just like Jira issues with an Epic Link. Items with no epic stay flat.

Click a row to open the ticket, the markdown task, or the cron script.

Next to the tree:

- **Summary** — details for the selected item, optional AI summary
- **Table** — sortable grid of the same items
- **Chart** — counts over time (local snapshot history)
- **Cron Runs** — recent job output
- **Settings** — the same setup UI as the command

A bottom **Task Beacon** panel (same strip as Terminal) shows Official / Private / Agent counters, a matching priority feed, and optional AI insights.

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
| [Hermes](https://github.com/NousResearch/hermes-agent) | *Optional.* Live Agent cron if you already run Hermes |
| Python 3 | Only if you use `scripts/show_todo.py` for Jira |
| A wiki folder | Obsidian vault with `Tasks/*.md`, or a repo with `scripts/show_todo.py` |

Optional — skip anything you do not use:

- **Jira** — only if your company uses Jira. Official still works from wiki tasks tagged `official` (Linear, GitHub Issues, Notion, etc. stay in the wiki).
- **AI** — xAI (Grok) first, then Ollama, then LiteLLM, OpenAI, or Anthropic. xAI uses the same Hermes login as SuperGrok / X Premium+ (`hermes auth add xai-oauth`), not a console API key.
- **Grafana / AI Health** — set `todoView.grafanaUrl` (Settings → AI) to show the bottom AI Health panel with LiteLLM / vLLM stats. Empty keeps the panel hidden. Command: **Task Beacon: Open AI Health (Grafana)…**

Empty settings stay empty on purpose. No machine paths ship in the install.

---

## Settings

Open **Task Beacon: Settings...**, or edit these keys:

| Setting | Default | Purpose |
|---------|---------|---------|
| `todoView.llmWikiRoot` | *(empty)* | Vault with `Tasks/*.md`, or a repo with `show_todo.py` |
| `todoView.pythonPath` | `python` | Python used to run that script |
| `todoView.jiraBaseUrl` | *(empty)* | Optional Jira site. Empty = Official is wiki-only |
| `todoView.hermesProfile` | `default` | Hermes profile for cron |
| `todoView.autoRefreshSec` | `0` | Auto-refresh; `0` is off |
| `todoView.aiProvider` | `xai` | `xai` / `ollama` / `litellm` / `openai` / `anthropic` |
| `todoView.aiBaseUrl` | `https://api.x.ai/v1` | OpenAI-compatible API |
| `todoView.aiApiKey` | `sk-local` | Optional. xAI uses Hermes login; local proxies use a proxy key |
| `todoView.aiDefaultModel` | *(empty)* | Default model id |
| `todoView.grafanaUrl` | *(empty)* | Grafana URL. Set it to show the AI Health panel |

---

## Useful commands

| Command | Does |
|---------|------|
| **Task Beacon: Get Started** | Walkthrough for first-time users |
| **Task Beacon: Choose Wiki Folder...** | Folder picker (do not type a path) |
| **Task Beacon: Settings...** | Jira, AI, and optional paths |
| **Task Beacon: Refresh** | Reload Jira / wiki / cron |
| **Task Beacon: Cycle Filter** | All → Official → Private → Agent |
| **Task Beacon: Search / Filter Tree...** | Filter the tree |
| **Task Beacon: Select AI Model...** | Pick a model when AI is configured |
| **Task Beacon: Log in to xAI via Hermes** | Device login (`hermes auth add xai-oauth`) |

---

## How data is loaded

Wiki tasks come from `Tasks/*.md` (or `tasks/*.md`) in the wiki root. If `scripts/show_todo.py` is present, that script still supplies Jira + wiki JSON.

Cron state is read from the live Hermes `jobs.json` (profile or `%LOCALAPPDATA%\hermes\cron\`).

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
