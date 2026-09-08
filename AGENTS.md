# Task Beacon — how any agent puts work on the board

You are writing into a Task Beacon wiki. The board has three owners: **Official**, **Private**, **Agent**.

Claude Code, Cursor, Codex, Copilot, Gemini, Cline, Windsurf, Aider, Continue, OpenCode, Hermes, and any other agent use the same files. Do not invent a vendor-specific sidecar unless the user asks.

## Write a task

Create `Tasks/<slug>.md` (or `tasks/`) with YAML frontmatter:

```yaml
---
type: Task
title: Short title
status: todo
priority: medium
category: agent-task
---
```

| `category` | Owner |
|------------|--------|
| `official` | Company / team |
| `private` | Human personal |
| `agent-task` | One-off agent work |
| `agent-cron` | Recurring work that should stay on the board |

`status`: `todo` | `in-progress` | `done` | `blocked`

Optional: `epic: Projects/some-epic.md`

Do not invent Jira keys. Do not write secrets, tokens, or API keys.

## Recurring jobs

1. Always add a wiki `agent-cron` task so the row appears even when a scheduler has no local file.
2. Also write `.task-beacon/jobs.json` in the **wiki root** (the folder that contains `Tasks/`, not `Tasks` itself) so Task Beacon can live-list the schedule:

```json
{
  "jobs": [
    {
      "id": "weekly-review",
      "name": "Weekly review",
      "schedule": "0 9 * * 1",
      "state": "active",
      "agent": "claude-code"
    }
  ]
}
```

Optional fields: `prompt`, `command`, `open` (path to the script or workflow to open).

## What Task Beacon reads live

| Source | Path | Pause / run in the sidebar |
|--------|------|----------------------------|
| Wiki | `Tasks/*.md` with `agent-task` / `agent-cron` | Status is edited in the markdown |
| Task Beacon file | `<wiki>/.task-beacon/jobs.json` | No — edit the file |
| Claude Code | `<wiki>/.claude/scheduled_tasks.json` or `~/.claude/scheduled_tasks.json` | No — edit the file |
| Hermes | Hermes `jobs.json` on this machine | Yes |
| GitHub Actions | `<wiki or workspace>/.github/workflows/*.yml` with `on.schedule` | No — open the workflow |
| OpenCode | `~/.config/opencode/scheduler/**/jobs/*.json` | No — edit the file |

Cursor Automations, Codex cloud automations, Copilot scheduled prompts, and Gemini scheduled actions are cloud dashboards. Put those on the board with a wiki `agent-cron` task and/or `.task-beacon/jobs.json`. Do not pretend a local jobs file exists.

Do not scrape OS crontab or Task Scheduler.

## Wiki root

Pick the vault or repo root — the folder that contains `Tasks/`. Do not pick `Tasks/` itself.
