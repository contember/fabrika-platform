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

- [`sprint-2026-08-14-multiple-private-github-source-connections`](sprint-2026-08-14-multiple-private-github-source-connections.md)
  — extend the live Zerops source path from one installation-wide GitHub App to one private App per
  organization. The additive design keeps the existing Zerops v1 credential and generic webhook route,
  gives every new connection a create-only keyed v2 credential and scoped webhook, and binds app
  registry entries on the Zerops private-source path to connection plus installation. Cloudflare keeps
  its static-secret and installation-id webhook behavior. There is no explicit connection-count limit.
  Deterministic local compatibility and isolation gates are complete. Live setup created and verified
  Apps for two additional organizations, the source restarted with the legacy base credential plus
  three keyed v2 slots, and a keyed-v2 scoped push deployed its bound private application. A private
  deploy from a second organization and a genuine legacy-v1 generic delivery remain open
  ([ADR-0032](../decisions/0032-support-multiple-private-github-source-connections.md)).
