# backlog

Decided work items ("issues") not yet scheduled into a sprint. One self-contained
file per item: `NN-<slug>.md` (zero-padded, **folder-local** sequence — don't
renumber, gaps are fine). Copy [`_template.md`](_template.md).

**No `status:` field** — an item is alive because it lives here. It leaves by being
**deleted** on ship (default; git holds the record) or moved to `../archive/` if it
documents something a future reader needs. Dependencies go in frontmatter:
`blocked-by: [./NN-other.md]`.

Add scope sub-folders (`security/`, `perf/`, …) only once the flat list gets
unwieldy; numbers stay folder-local. A number a deleted item used is retired with
it — the next item takes the next free number, so a link in an archived sprint
never resolves to a different item than the one it meant.

## The phase ladder

Items 01–05 formed the portability ladder. Phases 0–4 are complete. Phase 5 is
the live-account bring-up in item 05.

Phase 0 merged and renamed the repositories. The portable runtime, static
manifest, proxy, and Zerops control path are built and locally verified. Repository CI and release automation are built; activating npm trusted publishing remains external item 25.

Items 39–45 came out of a conformance review of the Zerops implementation against
upstream documentation. All six were settled against the real account by sprint
[`zerops-path-correctness`](../archive/sprint-2026-08-05-zerops-path-correctness.md)
and deleted; what they established is in
[`reference/zerops-platform.md`](../reference/zerops-platform.md).

Items 61–63 came from [ADR-0025](../decisions/0025-the-operator-installs-the-platform-fabrika-deploys-apps.md):
the platform is installed by its operator, so fabrika owed an unattended deploy command and the two
things that call it. The command and the sidecar shipped and were proven live
([archive](../archive/sprint-2026-08-06-zerops-platform-deploy.md),
[archive](../archive/sprint-2026-08-07-zerops-from-scratch-install.md)); only
[63](63-a-one-click-install-from-the-public-repository.md), the install shape that needs no repository
at all, is still open. Items 64–65 are what building them uncovered — an escape hatch nobody closes,
and a pin that pins half of what it claims.

## Items

<!-- one line each: NN — short summary (link). Keep it short. -->

- [05](05-bring-up-on-a-real-zerops-account.md) — The light tier is live on a real account; what remains is the production two-project shape and custom domains.
- [22](22-unix-second-columns-overflow-in-2038.md) — int4 timestamps; `BIGINT` costs every reader a string. Decide before it is urgent.
- [25](25-bootstrap-npm-trusted-publishing.md) — Done but for one step: 22 packages ship at 0.0.2 through OIDC with provenance; token publishing is still permitted and should be restricted.
- [26](26-retire-trasa-release-surface.md) — Publish `@fabrika/app`, deprecate `@trasa/core`, and archive the standalone repository.
- [34](34-retire-standalone-poplach.md) — Adopt existing state and retire the standalone Poplach app.
- [36](36-complete-zerops-release-artifact-correlation.md) — Publish Zerops build source maps and link Delivery runs to Operations evidence.
- [37](37-activate-zerops-managed-environment-transactionally.md) — Keep Zerops managed environment activation consistent with the app version that actually ships.
- [38](38-add-dns-safe-operations-egress.md) — Prevent private-address and DNS-rebinding egress through Operations webhooks and active health checks.
- [46](46-add-portable-email-alert-delivery.md) — Add email alert delivery without coupling the portable Operations outbox to Cloudflare Email Routing.
- [54](54-give-operations-its-own-proxy-app-identity.md) — Half shipped; what is left is moving the operator surface onto the Operations host, which is a console architecture change, not a rename.
- [57](57-stop-the-caller-choosing-its-own-audit-correlation-id.md) — IAM takes `X-Request-Id` from the caller, unbounded, into `auth_log`; its Worker is edge-routed so the proxy strip never runs.
- [63](63-a-one-click-install-from-the-public-repository.md) — The second install shape: a running platform without creating a repository or a CI system.
- [64](64-close-the-bootstrap-admission-hatch-automatically.md) — A Cloudflare installation comes up admitting on a standing admin list, and closing it is an instruction printed to a human.
- [65](65-pin-a-zerops-build-to-a-revision.md) — A Zerops build source names a repository, not a revision, so `fabrika.ref` pins the pipeline but not the code Zerops builds.
- [71](71-deliver-domain-audit-events-durably.md) — Add stable event ids, idempotent IAM acknowledgement and transactional producer outboxes for every domain mutation.
- [75](75-a-running-installation-keeps-a-token-that-cannot-create-projects.md) — No `fabrika` command can re-mint a pre-ADR-0034 integration token with `canCreateProjects`; the diagnosis half shipped.
- [78](78-register-a-zerops-app-from-local-config-in-one-command.md) — Compose the existing local manifest build and Control registration into one command without executing application code in Control.
- [79](79-a-namespace-target-cannot-be-changed-after-creation.md) — A namespace's provider target is written once; no API takes a new one, and a hand-edited one is refused against the live service.
- [80](80-harmonize-the-admin-rpc-principal-inputs.md) — Two admin-RPC procedures name the same principal by two different keys, so the obvious call is refused.
- [81](81-exercise-a-private-keyed-deploy-in-the-local-stack.md) — The local stack cannot exercise a keyed private deploy or a bound-app webhook: `source` mints installation tokens against real GitHub.
- [82](82-a-duplicate-cross-app-grant-answers-500.md) — IAM answers 500, not 409, when the same cross-app grant is created twice.
- [83](83-a-proxy-target-registers-without-the-domain-its-deploy-needs.md) — A proxy-target manifest registers without a `domain`; the first deploy fails instead, and nothing names the hosts a `zerops-subdomain` namespace can serve.
- [84](84-the-first-deploy-after-registration-can-miss-its-operations-ingest.md) — The first deploys of a newly registered app carried no Operations-managed values although Operations listed the source; a later catalog change fixed it and the cause is not established.
- [09](09-confirm-multi-domain-per-service.md) — Near-settled: upstream's domain flow takes several domains per service. Confirm and document.
- [10](10-app-scope-secrets-on-zerops.md) — Open: how the `app` secret scope is represented across separate Zerops projects.
- [11](11-oblaka-rewrites-do-migration-history.md) — oblaka rewrites Durable Object migration history when a class is removed.
