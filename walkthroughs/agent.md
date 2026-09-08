# Agent work (optional)

**Any agent can use this board.** Claude Code, Cursor, Codex, Copilot, Gemini, Cline, Windsurf, OpenCode, Hermes — they all write the same wiki files.

**Agent** is the owner. You do not need Hermes.

| How the work is stored | What Agent shows |
|------------------------|------------------|
| Wiki `agent-task` / `agent-cron` | Those rows. This is the universal contract |
| `.task-beacon/jobs.json` in the wiki root | Live schedule list (any agent can write this file) |
| Hermes installed | Live Hermes jobs — pause / resume / run now |
| Claude Code `scheduled_tasks.json` | Live list if that file exists (project or `~/.claude`) |
| GitHub Actions `on.schedule` | Workflow cron lines from `.github/workflows` |
| OpenCode scheduler jobs on disk | Live list if those JSON files exist |
| Cursor / Codex / Copilot cloud automations | Not local files. Keep a wiki `agent-cron` row and/or `.task-beacon/jobs.json` |

Copy `AGENTS.md` from this walkthrough’s samples (or the Task Beacon repo) into your wiki root so the next agent knows the contract.

If you have no Agent work, skip this step. Official and Private are enough.
