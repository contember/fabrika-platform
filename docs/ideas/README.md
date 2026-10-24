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
- [A compact installation](compact-installation.md) — applications beside the platform on one HA database; reviewed,
  gated by two live-account facts, and only worth it if platform data must also be HA.
- [The application Durable Object](application-object-runtime-and-operations.md) — runtime gaps, cost rules, an alarm
  scheduler, read-only invocations, an ops channel, backups with an importer, and side restore on Cloudflare.
