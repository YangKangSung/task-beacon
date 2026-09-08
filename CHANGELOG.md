# Change Log

## 0.14.18

Say cron is not Hermes-only. Hermes is the one live job feed today; other schedules stay on the board as wiki `agent-cron`.

## 0.14.17

Stop leading with Hermes. The board is a wiki of Official / Private / Agent work. Hermes cron is optional, same as Jira. Other agents keep work in the wiki.

## 0.14.16

Expand the Get Started walkthrough for first-time setup: samples first, then wiki-folder cases (Obsidian vault root vs repo vs empty folder vs this workspace), plus optional Hermes, Jira, AI, and Grafana.

## 0.14.15

The bottom Task Beacon panel, table, chart, and status bar use Official / Private / Agent — same owners as the tree — instead of Jira / Wiki / Cron. Grafana stays usable: the URL field is back in Settings → AI, and saving a URL opens the AI Health panel.

## 0.14.14

Say in the listing and first-run copy that Jira and Grafana are optional. Official work can be wiki-only (Linear, GitHub Issues, or just markdown). Grafana is only for on-prem model switching. The Official tree no longer says “Jira 0” when Jira is unused.

## 0.14.13

Hide the AI Health / Grafana panel unless a Grafana URL is set or the provider is LiteLLM. Most people using xAI or Ollama do not need it.

## 0.14.12

First launch shows bundled sample tasks so the tree is never empty. Existing wiki folders are unchanged. A new folder can get the same samples in one click.

## 0.14.11

First-run setup like GitLens / Python / Kampff: empty-tree welcome, folder picker, walkthrough. New users pick a wiki folder instead of typing a settings path.

## 0.14.10

Read Obsidian vault `Tasks/*.md` when `scripts/show_todo.py` is missing. Hermes cron is loaded from the live jobs.json either way.

## 0.14.9

Default AI provider is xAI, then Ollama in the picker. Other providers stay available.

## 0.14.8

xAI uses Hermes login (`hermes auth add xai-oauth` / SuperGrok or X Premium+), not a console API key. Settings shows login status and does not store the OAuth token.

## 0.14.7

Say Hermes first in the Marketplace listing. Agent work is Hermes tasks + Hermes cron.

## 0.14.6

Put xAI (Grok) first in the provider list. `grok` still maps to `xai`. GitHub Sponsors link on the Marketplace listing.

## 0.14.5

Add Grok (xAI) as an AI provider (`https://api.x.ai/v1`).

## 0.14.4

State the product: Jira-style epics/tasks for company, personal, and agent work (including cron).

## 0.14.3

Rewrite the Marketplace README: short tagline, install path, and settings people can actually use.

## 0.14.2

Rename public task categories `veda-task` / `veda-cron` to `agent-task` / `agent-cron`. Older wiki frontmatter still maps.

## 0.14.1

Initial Visual Studio Marketplace release.

- Sidebar tree for Jira, LLMWiki, and Hermes cron with category filters
- Summary, table, chart, cron-run, and settings webviews
- Bottom-panel dashboard with counters, alarms, and AI insights
- OpenAI-compatible model picker and health map
