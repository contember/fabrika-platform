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

- [`sprint-2026-08-21-bring-up-without-surprises`](sprint-2026-08-21-bring-up-without-surprises.md)
  — make the next from-scratch Zerops bring-up a sequence of commands that say what they need and
  refuse early: one platform-fact table checked against the account and the emulator, a catalog sync
  that logs what it did, `platform upgrade` and `install --create-project`, registration that demands
  the domain its deploy needs, help text that names the right origin, a release smoke that outlives
  npm's lag, and the `source` memory reading the tarball rewrite still owes.
