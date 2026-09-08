# Point it at your tasks

Task Beacon reads **one folder**. Pick the folder that *contains* your tasks — not a single `.md` file, and not the `Tasks` folder itself.

## Which folder? Pick the case that matches you

**A. Just trying it**  
Do nothing. Samples stay until you choose a folder.

**B. Obsidian vault**  
Pick the **vault root** (the folder that has `Tasks/` inside it). Each task file is `Tasks/*.md` with `type: Task` in the frontmatter. Example:

```yaml
---
type: Task
title: File the quarterly report
status: todo
category: official
---
```

`category` is `official`, `private`, `agent-task`, or `agent-cron`.

**C. Older LLMWiki / show_todo repo**  
Pick the **repo root** that contains `scripts/show_todo.py`. Python is only needed for that script (and for Jira through that script).

**D. Empty folder, or a new vault**  
Choose the folder, then click **Add sample tasks** when asked. You get the same Official / Private / Agent examples inside *your* folder.

**E. This workspace is already the wiki**  
Use **Use this workspace**. If the window has several folders, pick which one is the wiki.

**F. You already set this**  
Skip this step. Your folder is unchanged.

## Common misses

| If you… | What happens |
|---------|----------------|
| Pick `Tasks/` instead of the vault root | Beacon cannot see `Tasks/*.md` |
| Type a path into `settings.json` | Works, but the folder picker is safer |
| Have no `Tasks/` and no `show_todo.py` | You will be offered sample tasks or an empty folder |
