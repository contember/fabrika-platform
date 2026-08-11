# sprints

Active thematic work-plans being executed **now**. One file per sprint:
`sprint-YYYY-MM-DD-<theme>.md` (copy [`_template.md`](_template.md)). Multiple may
be active at once.

A sprint is the unit of work. Running it unattended ("do everything autonomously")
is just a sprint with no human watching — same file, same rules.

Lifecycle (full detail in [`../CLAUDE.md`](../CLAUDE.md)):

1. **Create** — copy the template; re-verify load-bearing facts at HEAD before
   planning on them.
2. **Run** — work the WUs; append discoveries/blockers to `## Run log`; graduate
   entries to a `../decisions/` ADR or a `../backlog/` item.
3. **Close** — stamp the `OUTCOME` header, `git mv` to `../archive/`, delete/rescope
   consumed backlog items, refresh affected `../reference/`, update
   [`../INDEX.md`](../INDEX.md).

## Active

- [`sprint-2026-08-11-fabrika-deploys-an-app-on-zerops`](sprint-2026-08-11-fabrika-deploys-an-app-on-zerops.md)
  — one gate: add a GitHub repository, **public or private**, and get it deployed into the Zerops
  account. Consumes [`47`](../backlog/47-give-the-zerops-path-a-private-git-source.md),
  [`69`](../backlog/69-a-zerops-runs-log-never-reaches-the-run-record.md) and
  [`70`](../backlog/70-a-failed-zerops-build-hangs-await-deploy-for-seventy-minutes.md). The private
  half waits on the operator authorizing GitHub on the Zerops account.
- [`sprint-2026-08-06-zerops-platform-deploy`](sprint-2026-08-06-zerops-platform-deploy.md) —
  an unattended `platform deploy` on Zerops. Consumes backlog
  [`58`](../backlog/58-generate-the-platform-installations-proxy-manifest.md),
  [`59`](../backlog/59-the-live-installation-calls-itself-local.md) and
  [`61`](../backlog/61-make-platform-deploy-an-unattended-command.md); the second install path ADR-0025
  commits to stays filed as
  [`63`](../backlog/63-a-one-click-install-from-the-public-repository.md). Its successor is
  [archived](../archive/sprint-2026-08-07-zerops-from-scratch-install.md).
