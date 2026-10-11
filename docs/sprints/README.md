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

- [MCP application authoring](sprint-2026-10-07-mcp-authoring.md) — employees author apps from Claude/ChatGPT through MCP in Control: Git workspaces, stage deploys, pull requests; Zerops first. Decisions in ADR-0049.
- [The paved-road application framework](sprint-2026-10-11-paved-road-framework.md) — a declarative shell with colocated handlers, a mini-ORM scoped by the endpoint's capability, raw SQL as a legitimate tool, and deviations from the road shown in the approval.
