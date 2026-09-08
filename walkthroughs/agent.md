# Agent work (optional)

**Agent is not Hermes-only.** It is the owner for agent-owned tasks and recurring jobs. You can fill it with wiki files even if you use another agent, or no agent at all.

| Your setup | What Agent shows |
|------------|------------------|
| Wiki only (Claude, Cursor, Codex, nothing…) | Tasks tagged `agent-task` / `agent-cron` in `Tasks/*.md` |
| Hermes installed, with cron | Those wiki tasks **plus** live Hermes jobs (pause / resume / run now) |
| Hermes not installed | Wiki agent tasks only. Official and Private are unchanged |

Task Beacon does not drive other agents yet. For those, keep the work in the wiki (`category: agent-task` or `agent-cron`) the same way you keep Official and Private tasks.

If you do use Hermes, cron is detected on this machine — you do not paste a path. Skip this whole step if you do not care about Agent yet.
