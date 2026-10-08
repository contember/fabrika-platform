# ideas

Research, proposals, half-formed thoughts — **no commitment**. One file per idea,
`kebab-case.md`.

An idea has exactly two exits: it **graduates** (becomes a `../backlog/` item or
gets pulled into a `../sprints/` plan) or it's **deleted**. It is never a place for
decided work or status.

<!-- index the ideas here, one line each -->

- [Operations plane](operations-plane.md) — broad target for runtime feedback,
  observability, alerting, and response beyond the initial Errors capability.
- [Secure-by-default application runtime](secure-by-default-app-runtime.md) — mandatory
  caller and permission on every endpoint, an access manifest, and approval of widening.
- [Scoped database access](scoped-database-access.md) — `@fabrika/db` over Kysely:
  per-table access policy, scoped handles, and app-owned Postgres migrations.
- [Declarative application connectors](declarative-app-connectors.md) — typed data
  exchange between applications, on behalf of the user, through the owner's proxy.
