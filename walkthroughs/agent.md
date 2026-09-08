# Agent work (optional)

**Cron is not Hermes.** Cron means recurring jobs — system crontab, Task Scheduler, GitHub Actions, another agent’s scheduler, or a note you keep in the wiki. Hermes is only the live feed Task Beacon can read *today*.

**Agent** is the owner for that kind of work. You do not need Hermes to use it.

| Your setup | What Agent shows |
|------------|------------------|
| Recurring work in the wiki | Files tagged `agent-cron` (and `agent-task` for one-off agent work) |
| Hermes installed, with jobs | Those wiki rows **plus** live Hermes jobs (pause / resume / run now) |
| crontab / Task Scheduler / another agent | Not read live yet. Keep the job in the wiki as `agent-cron` so it still appears on the board |
| No Agent work | Skip this step. Official and Private are enough |

If you do use Hermes, jobs are detected on this machine — you do not paste a path.
