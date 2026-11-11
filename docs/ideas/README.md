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
- [One authorization model](authorization-model.md) — concepts and twelve guarantees the platform and any runtime
  behind it share: serializable grants, declarative rules, and code that narrows freely but widens only when declared.
- [The ACL coverage roadmap](acl-coverage-roadmap.md) — frozen steps that would extend ADR-0073's relation grants and
  conditions towards about 95 % of a production rule corpus; a step is built when an application needs it.
- [A compact installation](compact-installation.md) — applications beside the platform on one HA database; reviewed,
  gated by two live-account facts, and only worth it if platform data must also be HA.
- [An AWS provider](aws-provider.md): ECS on Fargate, RDS with point-in-time recovery, S3 and CodeBuild behind the
  existing contract. What it takes, what it costs to run against Zerops, and why to build it with the first installation that needs it.
- [A dev environment for MCP authoring](mcp-dev-containers.md) — a `dev` environment that takes each workspace
  commit in about two seconds through an in-container launcher that pulls from Control; measured on Zerops.
