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

- [`sprint-2026-08-21-cheap-rebuild-from-scratch`](sprint-2026-08-21-cheap-rebuild-from-scratch.md)
  — empty the Zerops account, remove the legacy v1 source path its deletion makes unreachable, fix the
  five defects that make a from-scratch bring-up expensive (stdin intent, the first administrator,
  asynchronous namespace provisioning, actionable namespace failures, removal of a failed namespace),
  and stand one installation back up on the cheap defaults landed in `3ecf86d`. The rebuild is the
  single live acceptance for all of it.
