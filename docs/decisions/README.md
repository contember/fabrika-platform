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

**Authentication and authorization: read [ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md)
and nothing else first.** It states the settled model end to end and supersedes the four ADRs that
decided the same question in stages — 0007 (enforcement moves out of the in-process SDK), 0008
(Caddy + `forward_auth`, not a Go plugin), 0010 (gates never become Caddy routes; it amends 0008
after implementation disproved its central assumption), and 0021 (a one-time code replaces the
shared session cookie). Those four are kept and are still where the _why_ lives — 0010 in
particular holds the three Caddy semantics mismatches verified against a running binary. None of
them should be read as a description of current behaviour.

[ADR-0023](0023-one-session-per-host.md) then answers the single question 0022 deliberately left
open: the shared parent-domain session cookie is retired, so the one-time code is the only way a
session reaches an application and both session cookies carry the `__Host-` prefix. It amends 0022
rather than superseding it — every rule in 0022 still holds.

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

ADR-0016 adds Operations as a third product plane while keeping its telemetry
data path and persistence outside control. The accepted first slice absorbs
Poplach as Errors; broader observability remains an idea.

ADR-0017 makes Postgres migration ownership explicit at the service and bundle
levels. It preserves legacy installations without moving IAM or Control data
into new schemas, and lets Operations compose the generic Postgres job-queue
migration before its own schema.

ADR-0018 defines plane-qualified canonical environment names and a
canonical-first compatibility window for the `VOZKA_*` and `PROPUSTKA_*`
families. It explicitly excludes deployed resource names and migration
identities from the naming sweep.

ADR-0019 puts provider-neutral outbound email behind `@fabrika/email` rather than a runtime-specific binding or the no-I/O platform package. Domains retain templates, action state, outboxes, and retry scheduling.

ADR-0020 composes OIDC and password as independent capabilities, keeps email delivery orthogonal, and replaces OIDC-derived principal/session lifecycle state with auth-neutral state.

ADR-0021 replaces the shared session cookie with a one-time code the proxy redeems, so an app can
live on any domain — including a `.zerops.app` subdomain, which is a public suffix and can carry no
shared cookie at all. Superseded by ADR-0022, which carries its invariants forward.

ADR-0022 consolidates 0007, 0008, 0010, and 0021 into one statement of how authentication and
authorization work: the proxy is the only enforcement point and app services are not publicly
routed, Caddy owns HTTP correctness and gets no vote on authorization, gates are evaluated once in
TypeScript, a session reaches an app as a one-time code, and an app only ever verifies an injected
token. It records two things none of the four did — that the least-privilege split around handoff
redemption is a real key boundary on Zerops but only a typing convention on Cloudflare, and that
the shared cookie's survival alongside the handoff is an open question with a real cost.

## Log

<!-- newest last; one line each: NNNN — title — status (date) -->

- [0001](0001-merge-propustka-and-vozka.md) — Merge propustka and vozka into fabrika-platform under the `@fabrika/*` scope — accepted (2026-07-28)
- [0002](0002-deploy-driver-owns-the-plan.md) — Multi-cloud through a `DeployDriver`; the deploy plan belongs to the driver — accepted; extended by 0011 (2026-07-28)
- [0003](0003-no-deploy-runner-on-zerops.md) — No deploy runner on Zerops — the platform executes the deploy — accepted (2026-07-28)
- [0004](0004-secrets-live-in-the-platform.md) — The platform holds secret values; fabrika holds only references — accepted (2026-07-28)
- [0005](0005-compile-app-config-to-static-manifest.md) — Compile app config to a static manifest; the control plane never executes app code — accepted (2026-07-28)
- [0006](0006-zerops-project-topology-is-a-registry-field.md) — Zerops project topology is a registry field, defaulting to project-per-environment — accepted (2026-07-28)
- [0007](0007-proxy-based-auth-enforcement.md) — Enforce auth in a proxy instead of an in-process SDK — superseded by 0022 (2026-07-28)
- [0008](0008-caddy-forward-auth-proxy.md) — Caddy + `forward_auth` on Zerops, a thin Worker on Cloudflare, over one shared TypeScript auth service — superseded by 0022 (2026-07-28)
- [0009](0009-per-driver-target-and-collaborators.md) — A deploy targets a discriminated platform; collaborators belong to the driver, not to `deploy()` — accepted; extended by 0011 (2026-07-28)
- [0010](0010-gate-evaluation-stays-in-the-auth-service.md) — Gate evaluation stays in the auth service; Caddy routes are a fixed chain (amends 0008) — superseded by 0022 (2026-07-28)
- [0011](0011-static-provider-bundles.md) — Compose one static provider bundle per installation — accepted (2026-07-29)
- [0012](0012-fabrika-app-runtime.md) — Absorb the Trasa server framework as `@fabrika/app` — accepted (2026-07-29)
- [0013](0013-explicit-runtime-adapter-entrypoints.md) — Expose runtime adapters through explicit package entrypoints — accepted (2026-07-29)
- [0014](0014-provider-owned-deployment-namespaces.md) — Model deployment namespaces as provider-owned placement boundaries — accepted (2026-07-29)
- [0015](0015-repository-operations-are-the-sql-portability-seam.md) — Make repository operations the SQL portability seam — accepted (2026-07-30)
- [0016](0016-independent-operations-plane.md) — Add an independent Operations plane — accepted (2026-07-30)
- [0017](0017-service-owned-postgres-migrations.md) — Make Postgres migrations service-owned and bundle-qualified — accepted (2026-07-30)
- [0018](0018-canonical-fabrika-environment-names.md) — Use plane-qualified fabrika environment names with legacy fallback — accepted (2026-07-31)
- [0019](0019-portable-outbound-email.md) — Keep outbound email behind one portable service contract — accepted (2026-08-04)
- [0020](0020-compose-human-authentication-methods.md) — Compose OIDC and password as independent human authentication methods — accepted (2026-08-04)
- [0021](0021-exchange-token-session-handoff.md) — Hand a session to an app through a one-time code, not a shared cookie — superseded by 0022 (2026-08-04)
- [0022](0022-the-proxy-is-the-only-enforcement-point.md) — The proxy is the only enforcement point (supersedes 0007, 0008, 0010, 0021) — accepted (2026-08-05)
