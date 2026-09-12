# Task Beacon — how any agent puts work on the board

Claude Code, Cursor, Codex, Copilot, Gemini, Cline, Windsurf, OpenCode, Hermes, and any other agent use the same files.

## Tasks

Create `Tasks/<slug>.md`:

```yaml
---
type: Task
title: Short title
status: todo
priority: medium
category: agent-task
---
```

Categories: `official` | `private` | `agent-task` | `agent-cron`

## Recurring jobs

1. Add a wiki task with `category: agent-cron`.
2. Also write `.task-beacon/jobs.json` in this wiki root:

```json
{
  "jobs": [
    {
      "id": "weekly-review",
      "name": "Weekly review",
      "schedule": "0 9 * * 1",
      "state": "active",
      "agent": "your-agent-name"
    }
  ]
}
```

Task Beacon also live-reads Hermes, Claude Code `scheduled_tasks.json`, GitHub Actions `on.schedule`, and OpenCode scheduler files when they exist on disk. Cursor / Codex / Copilot cloud schedules are not local files — use the wiki or `.task-beacon/jobs.json`.

## Delegated tasks

Files written by Task Beacon's **Delegate to Agent** carry `kind:`, `epic:`, `refs:` (finished tasks to read first) and a `## Result` section. Do the Goal, write under Result, set `status: done` or `status: blocked`. Never touch `official` / `private` files unless told.

Do not write secrets.
