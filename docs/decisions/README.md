# decisions (ADR)

One file per significant architectural/product decision: `NNNN-<slug>.md`
(monotonic, never reused). Copy [`_template.md`](_template.md).

**Immutable.** Once a decision is Accepted, don't rewrite it — to change course,
write a _new_ ADR and set the old one's status to `Superseded by NNNN`.

Write one when the choice (a) constrains future work, (b) rejected a real
alternative, or (c) someone will later ask "why did we do it this way?". Otherwise
a commit message suffices.

0001–0008 are the founding set: they record the design conversation that produced
fabrika-platform. Read them in order — 0002 through 0008 all assume the framing in
0001, and several rest on facts collected in
[`../reference/zerops-platform.md`](../reference/zerops-platform.md).

ADR-0011 extends the provider-owned plan and target decisions in ADR-0002 and
ADR-0009 across authoring, persistence, and the control lifecycle. It replaces
their closed driver-registry mechanics with static provider bundles while
retaining their provider-owned plan and collaborator boundaries.

ADR-0013 refines the application runtime boundary from ADR-0012. The package root
is runtime-neutral; Cloudflare and Bun lifecycle APIs use explicit subpath
entrypoints.

ADR-0014 extends the registry placement decision in ADR-0006 through the static
provider boundary from ADR-0011. It makes shared placement, resource ownership,
and its failure boundaries explicit without adding Zerops presets to the neutral
contract.

ADR-0015 moves the SQLite/Postgres portability seam from individual SQL text to
capability repository operations. Shared SQL remains the default; composition
roots may select a backend-specific implementation for a complete operation.

## Log

<!-- newest last; one line each: NNNN — title — status (date) -->

- [0001](0001-merge-propustka-and-vozka.md) — Merge propustka and vozka into fabrika-platform under the `@fabrika/*` scope — accepted (2026-07-28)
- [0002](0002-deploy-driver-owns-the-plan.md) — Multi-cloud through a `DeployDriver`; the deploy plan belongs to the driver — accepted; extended by 0011 (2026-07-28)
- [0003](0003-no-deploy-runner-on-zerops.md) — No deploy runner on Zerops — the platform executes the deploy — accepted (2026-07-28)
- [0004](0004-secrets-live-in-the-platform.md) — The platform holds secret values; fabrika holds only references — accepted (2026-07-28)
- [0005](0005-compile-app-config-to-static-manifest.md) — Compile app config to a static manifest; the control plane never executes app code — accepted (2026-07-28)
- [0006](0006-zerops-project-topology-is-a-registry-field.md) — Zerops project topology is a registry field, defaulting to project-per-environment — accepted (2026-07-28)
- [0007](0007-proxy-based-auth-enforcement.md) — Enforce auth in a proxy instead of an in-process SDK — accepted (2026-07-28)
- [0008](0008-caddy-forward-auth-proxy.md) — Caddy + `forward_auth` on Zerops, a thin Worker on Cloudflare, over one shared TypeScript auth service — accepted (2026-07-28)
- [0009](0009-per-driver-target-and-collaborators.md) — A deploy targets a discriminated platform; collaborators belong to the driver, not to `deploy()` — accepted; extended by 0011 (2026-07-28)
- [0010](0010-gate-evaluation-stays-in-the-auth-service.md) — Gate evaluation stays in the auth service; Caddy routes are a fixed chain (amends 0008) — accepted (2026-07-28)
- [0011](0011-static-provider-bundles.md) — Compose one static provider bundle per installation — accepted (2026-07-29)
- [0012](0012-fabrika-app-runtime.md) — Absorb the Trasa server framework as `@fabrika/app` — accepted (2026-07-29)
- [0013](0013-explicit-runtime-adapter-entrypoints.md) — Expose runtime adapters through explicit package entrypoints — accepted (2026-07-29)
- [0014](0014-provider-owned-deployment-namespaces.md) — Model deployment namespaces as provider-owned placement boundaries — accepted (2026-07-29)
- [0015](0015-repository-operations-are-the-sql-portability-seam.md) — Make repository operations the SQL portability seam — accepted (2026-07-30)
