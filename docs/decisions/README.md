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

[ADR-0026](0026-bind-session-handoffs-to-the-browser.md) closes the remaining browser boundary: a
state-specific host-only verifier cookie and S256 challenge bind each callback to the browser that
started it. It also retires the unused browser JWT-cookie path, strips Fabrika cookies before the
application, and disables Cloudflare invocation logs that could capture a callback code. It amends
0022 and 0023.

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
identities from the naming sweep. **Superseded by
[ADR-0024](0024-retire-the-legacy-environment-name-fallback.md)** — its naming
rules and its durable-identifier exclusion both survive there; only the
compatibility window is gone.

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

ADR-0024 retires ADR-0018's legacy fallback: canonical `FABRIKA_*` names only, and the shared
canonical-or-legacy reader in `@fabrika/platform` is deleted rather than left callerless. Read it
together with 0018 — 0018 still holds the naming rules and the durable-identifier exclusion, and
0024 states why the transitional half was safe to remove and that a configuration name now has
exactly one spelling.

ADR-0026 binds an app session handoff to its initiating browser with a private verifier, removes the
unused browser JWT-cookie tier, and makes the proxy-to-app credential boundary explicit. Read it
together with 0022 and 0023.

ADR-0029 amends ADR-0003 and ADR-0025 after a live account disproved the assumed Zerops OAuth
delegation. Zerops integration tokens cannot configure a service from a user's GitHub grant, so an
operator-owned GitHub App and an internal per-installation `source` service fetch an exact commit and
upload its archive. Zerops still executes every application build and deploy; Fabrika still never
deploys its own installation. The service is now implemented for public anonymous and App-authenticated
private repositories. Production is fixed to `github.com`; it has no GitHub Enterprise configuration
surface.

ADR-0030 amends only ADR-0029's init durability detail. When Zerops supplies `onCreated`, the shared
manifest helper does not report success until Zerops durably persists GitHub's one-time App
credentials. Zerops init keeps that recovery in a bounded owner-only XDG file outside the worktree,
uses create-only remote writes and exact rereads, and deletes recovery after the live App and webhook
configuration are verified.

ADR-0031 supersedes ADR-0030 only for normal Zerops GitHub setup. Fresh installation remains
anonymous, and an authenticated control-plane action creates and verifies the organization-owned App
without a PAT. Control owns a dynamic encrypted webhook secret; source receives one atomic canonical
App-id/private-key bundle and activates it through a digest-bound private RPC. The CLI is a repair path
over the same remote state. ADR-0030 still records the shared loopback helper's durability contract.

## Log

<!-- newest last; one line each: NNNN — title — status (date) -->

- [0001](0001-merge-propustka-and-vozka.md) — Merge propustka and vozka into fabrika-platform under the `@fabrika/*` scope — accepted (2026-07-28)
- [0002](0002-deploy-driver-owns-the-plan.md) — Multi-cloud through a `DeployDriver`; the deploy plan belongs to the driver — accepted; extended by 0011 (2026-07-28)
- [0003](0003-no-deploy-runner-on-zerops.md) — No deploy runner on Zerops — the platform executes the deploy — accepted; filesystem-helper boundary amended by 0029 (2026-07-28)
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
- [0018](0018-canonical-fabrika-environment-names.md) — Use plane-qualified fabrika environment names with legacy fallback — superseded by 0024 (2026-07-31)
- [0019](0019-portable-outbound-email.md) — Keep outbound email behind one portable service contract — accepted (2026-08-04)
- [0020](0020-compose-human-authentication-methods.md) — Compose OIDC and password as independent human authentication methods — accepted (2026-08-04)
- [0021](0021-exchange-token-session-handoff.md) — Hand a session to an app through a one-time code, not a shared cookie — superseded by 0022 (2026-08-04)
- [0022](0022-the-proxy-is-the-only-enforcement-point.md) — The proxy is the only enforcement point (supersedes 0007, 0008, 0010, 0021) — accepted (2026-08-05)
- [0023](0023-one-session-per-host.md) — One session per host — retire the shared session cookie (amends 0022) — accepted (2026-08-05)
- [0024](0024-retire-the-legacy-environment-name-fallback.md) — Retire the legacy environment-name fallback; canonical names only (supersedes 0018) — accepted (2026-08-05)
- [0025](0025-the-operator-installs-the-platform-fabrika-deploys-apps.md) — The operator installs the platform; fabrika deploys only apps — accepted; private-source mechanism amended by 0029 (2026-08-06)
- [0026](0026-bind-session-handoffs-to-the-browser.md) — Bind session handoffs to the browser that started them (amends 0022 and 0023) — accepted (2026-08-06)
- [0027](0027-platform-deploy-is-as-wide-as-the-provider-needs.md) — `platform deploy` is as wide as its provider needs, not uniformly wide — accepted (2026-08-06)
- [0028](0028-zerops-apps-own-their-repository-root.md) — Zerops apps own their repository root — accepted (2026-08-11)
- [0029](0029-an-operator-owned-github-app-delivers-zerops-sources.md) — An operator-owned GitHub App delivers Zerops application sources — accepted (2026-08-11)
- [0030](0030-persist-github-app-creation-before-success.md) — Persist GitHub App creation before success — accepted; amends 0029's init durability detail (2026-08-12)
- [0031](0031-manage-zerops-github-source-from-control.md) — Manage the Zerops GitHub source connection from control — accepted; supersedes 0030 for normal Zerops setup (2026-08-13)
