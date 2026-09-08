# Hermes and Agent (optional)

**You do not need Hermes** to use Official and Private wiki tasks.

Hermes is the agent runtime this board is built around. If it is installed and you have cron jobs, **Agent** fills with live jobs. Task Beacon finds Hermes on this machine by itself — you do not paste a cron path.

| Your setup | What Agent shows |
|------------|------------------|
| No Hermes | Wiki tasks tagged `agent-task` / `agent-cron` only (including samples) |
| Hermes installed, no cron yet | Agent can look empty except wiki agent tasks |
| Hermes cron already running | Live jobs, pause / resume / run now on the row |

Wiki tasks still work if Hermes is missing or on another computer.
