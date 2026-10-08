# ideas

Research, proposals, half-formed thoughts — **no commitment**. One file per idea,
`kebab-case.md`.

An idea has exactly two exits: it **graduates** (becomes a `../backlog/` item or
gets pulled into a `../sprints/` plan) or it's **deleted**. It is never a place for
decided work or status.

<!-- index the ideas here, one line each -->

- [Operations plane](operations-plane.md) — broad target for runtime feedback,
  observability, alerting, and response beyond the initial Errors capability.
- [Secure-by-default application runtime](secure-by-default-app-runtime.md) — one
  pure-data contract per app, enforced per endpoint by the proxy, with approval of
  every widening.
- [Scoped database access](scoped-database-access.md) — `@fabrika/db` over Kysely:
  per-table access policy, stores reachable only through authorized refs, app-owned
  Postgres migrations.
- [Application file storage](app-file-storage.md) — files that belong to an object and
  inherit its access; private buckets only.
- [Scheduled jobs](app-scheduled-jobs.md) — cron jobs, each with its own narrow
  credential and a platform-generated schedule; enqueued tasks later.
- [Declarative application connectors](declarative-app-connectors.md) — typed, read-only
  exports and imports between applications through the owner's proxy.
