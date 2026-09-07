# Change Log

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
