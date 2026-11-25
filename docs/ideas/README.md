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
- [A compact installation](compact-installation.md) — applications beside the platform on one HA database; reviewed,
  gated by two live-account facts, and only worth it if platform data must also be HA.
- [Fabrika on the big three clouds](cloud-providers.md): AWS, Azure and Google Cloud side by side, the twelve
  provider-neutral prerequisites all three need first, and one Kubernetes provider as the alternative.
- [An AWS provider](aws-provider.md): ECS on Fargate, RDS with point-in-time recovery, S3 and CodeBuild behind the
  existing contract; the checklist, what it costs to run against Zerops, and why to build it with the first installation that needs it.
- [An Azure provider](azure-provider.md): Container Apps with an environment per namespace, Flexible Server, ACR Tasks,
  and a native Blob Storage adapter because Blob Storage speaks no S3.
- [A Google Cloud provider](gcp-provider.md): GKE Autopilot rather than Cloud Run, Cloud SQL, Cloud Build and Cloud
  Storage; a Kubernetes provider other clouds could reuse.
- [A dev environment for MCP authoring](mcp-dev-containers.md) — a `dev` environment that takes each workspace
  commit in about two seconds through an in-container launcher that pulls from Control; measured on Zerops.
- [Start memory and init connections without the isolation tests](start-memory-without-isolation-tests.md) — the
  container init on 0.9.0-dev.22 peaks at ~38 MiB and 1 connection (was ~180–200 MiB and 4); measured locally, not yet
  on Zerops; the 0.5 GB floor and the 5-connection budget are unchanged.
- [Approvals an agent asks for](agent-requested-approvals.md) — one approval gate with a mode per environment and change
  category (off, plan, person, refuse): one-off requests a person approves from one link, and plans approved with the
  pull request and matched at deploy; decided defaults, the settings for the alternatives and a ten-PR plan.
