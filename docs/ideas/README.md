# ideas

Research, proposals, half-formed thoughts — **no commitment**. One file per idea,
`kebab-case.md`.

An idea has exactly two exits: it **graduates** (becomes a `../backlog/` item or
gets pulled into a `../sprints/` plan) or it's **deleted**. It is never a place for
decided work or status.

<!-- index the ideas here, one line each -->

- [Operations plane](operations-plane.md) — broad target for runtime feedback,
  observability, alerting, and response beyond the initial Errors capability.
- [A foreign runtime behind the platform](foreign-runtime.md) — another framework keeps its own data layer; the
  platform reads only its surface and access, and delivers, fronts and authenticates it.
- [Declare the surface, not the behavior](declare-the-surface-not-the-behavior.md) — pre-1.0 revision of the
  entrypoint catalog: public procedures with a workload, files as values in table columns, an independent HTTP shape,
  kicks with a data-layer claim, no generated endpoints, `c.form` and `then` deleted.
