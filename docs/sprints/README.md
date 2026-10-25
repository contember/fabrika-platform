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

- [The application Durable Object](sprint-2026-10-24-application-object.md) — the Cloudflare application object sleeps unless it has work, queries stop blocking it, and Control inspects, backs up and side-restores its data. Waits on decision D0 and the proposal's open questions.
- [Provider-neutral core](sprint-2026-10-23-provider-neutral-core.md) — what is the same on every cloud moves out of the provider packages into Control or a neutral library (ADR-0011).
- [Terminals](sprint-2026-10-21-terminals.md) — an enrolled shared computer signs a person in on an application's word, bounded by a ceiling, through the unchanged handoff (ADR-0067).
