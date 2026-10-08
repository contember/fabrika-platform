# ideas

Research, proposals, half-formed thoughts — **no commitment**. One file per idea,
`kebab-case.md`.

An idea has exactly two exits: it **graduates** (becomes a `../backlog/` item or
gets pulled into a `../sprints/` plan) or it's **deleted**. It is never a place for
decided work or status.

<!-- index the ideas here, one line each -->

- [Operations plane](operations-plane.md) — broad target for runtime feedback,
  observability, alerting, and response beyond the initial Errors capability.
- [Opinionated application framework](opinionated-app-framework.md) — one literal
  contract per app; typed handlers that receive authorized objects; runs on today's
  platform.
- [Platform enforcement](platform-enforcement.md) — the proxy, IAM, Control and the
  providers make the contract binding; widenings on production wait for a human.
- [Scoped database access](scoped-database-access.md) — `@fabrika/db` over Kysely:
  per-table access policy, stores reachable only through authorized refs, app-owned
  Postgres migrations.
- [Application file storage](app-file-storage.md) — files that belong to an object and
  inherit its access; private buckets only.
- [Scheduled jobs](app-scheduled-jobs.md) — cron jobs with declared actions, leases
  and reporting; enqueued tasks later.
- [Declarative application connectors](declarative-app-connectors.md) — typed, read-only
  exports and imports between applications through the owner's proxy.
- [Implementation plan](app-framework-implementation-plan.md) — decisions, part 0
  fixes, part A (framework) and part B (enforcement), milestones.
- [Orchestration](app-framework-orchestration.md) — lanes by package ownership, the loop for
  one work unit, gates and human checkpoints for executing the implementation plan.
