# Security Policy

## Supported versions

Only the latest Marketplace release of Task Beacon (`YangKangSung.task-beacon`) gets security fixes. Older versions are unsupported.

Sideloaded VSIX files from [GitHub Releases](https://github.com/YangKangSung/task-beacon/releases) should match that same version.

## What this project stores

Task Beacon is a VS Code extension. It may keep Jira credentials in VS Code Secret Storage, optional API keys in settings, and it may read local scheduler files (Hermes, Claude Code, OpenCode).

Do not put tokens, passwords, or API keys in wiki task files, `.task-beacon/jobs.json`, pull requests, or public issues.

## Reporting a vulnerability

Use **GitHub private vulnerability reporting** on this repository:

https://github.com/YangKangSung/task-beacon/security/advisories/new

Do not open a public issue for an unfixed vulnerability.

Expect an acknowledgement within 7 days. If the report is accepted, a fix ships in the next Marketplace release when possible. If it is declined, we will say why.

## Scope

In scope: the extension source in this repository, the published VSIX, and the GitHub Actions release pipeline.

Out of scope: Jira, Hermes, Grafana, or other tools Task Beacon talks to; a user's wiki content; secrets a user committed in their own vault.
