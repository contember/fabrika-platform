# backlog

Decided work items ("issues") not yet scheduled into a sprint. One self-contained
file per item: `NN-<slug>.md` (zero-padded, **folder-local** sequence — don't
renumber, gaps are fine). Copy [`_template.md`](_template.md).

**No `status:` field** — an item is alive because it lives here. It leaves by being
**deleted** on ship (default; git holds the record) or moved to `../archive/` if it
documents something a future reader needs. Dependencies go in frontmatter:
`blocked-by: [./NN-other.md]`.

Add scope sub-folders (`security/`, `perf/`, …) only once the flat list gets
unwieldy; numbers stay folder-local.

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

Items 61–63 come from [ADR-0025](../decisions/0025-the-operator-installs-the-platform-fabrika-deploys-apps.md):
the platform is installed by its operator, so fabrika owes an unattended deploy command
and the two things that call it.

## Items

<!-- one line each: NN — short summary (link). Keep it short. -->

- [05](05-bring-up-on-a-real-zerops-account.md) — The light tier is live on a real account; what remains is the production two-project shape and custom domains.
- [22](22-unix-second-columns-overflow-in-2038.md) — int4 timestamps; `BIGINT` costs every reader a string. Decide before it is urgent.
- [25](25-bootstrap-npm-trusted-publishing.md) — Bootstrap the twenty package names once through protected CI, then activate tokenless OIDC publishing.
- [26](26-retire-trasa-release-surface.md) — Publish `@fabrika/app`, deprecate `@trasa/core`, and archive the standalone repository.
- [34](34-retire-standalone-poplach.md) — Adopt existing state and retire the standalone Poplach app.
- [36](36-complete-zerops-release-artifact-correlation.md) — Publish Zerops build source maps and link Delivery runs to Operations evidence.
- [37](37-activate-zerops-managed-environment-transactionally.md) — Keep Zerops managed environment activation consistent with the app version that actually ships.
- [38](38-add-dns-safe-operations-egress.md) — Prevent private-address and DNS-rebinding egress through Operations webhooks and active health checks.
- [46](46-add-portable-email-alert-delivery.md) — Add email alert delivery without coupling the portable Operations outbox to Cloudflare Email Routing.
- [47](47-give-the-zerops-path-a-private-git-source.md) — An app on Zerops can only build from a public URL; configure the service's own repository integration instead (ADR-0025).
- [54](54-give-operations-its-own-proxy-app-identity.md) — Half shipped; what is left is moving the operator surface onto the Operations host, which is a console architecture change, not a rename.
- [57](57-stop-the-caller-choosing-its-own-audit-correlation-id.md) — IAM takes `X-Request-Id` from the caller, unbounded, into `auth_log`; its Worker is edge-routed so the proxy strip never runs.
- [58](58-generate-the-platform-installations-proxy-manifest.md) — Nothing generates a deployed installation's proxy manifest, so the live one is hand-written and drifted from the gate modules unnoticed.
- [59](59-the-live-installation-calls-itself-local.md) — `control` and `operations` on `fabrika-test` carry `ENVIRONMENT=local`, the value every bypass is gated on.
- [60](60-the-example-app-has-no-light-tier-descriptor.md) — Neither committed `zerops.yaml` names the shared `db` the example actually runs against, so the live app cannot be redeployed from HEAD.
- [61](61-make-platform-deploy-an-unattended-command.md) — `fabrika platform deploy` is the public interface an operator's pipeline calls, and it does not deploy a Zerops installation at all.
- [62](62-generate-the-operators-sidecar-install-repository.md) — Generate the per-account sidecar repository that installs the platform; fabrika ships the generator, never the pipeline.
- [63](63-a-one-click-install-from-the-public-repository.md) — The second install shape: a running platform without creating a repository or a CI system.
- [09](09-confirm-multi-domain-per-service.md) — Near-settled: upstream's domain flow takes several domains per service. Confirm and document.
- [10](10-app-scope-secrets-on-zerops.md) — Open: how the `app` secret scope is represented across separate Zerops projects.
- [11](11-oblaka-rewrites-do-migration-history.md) — oblaka rewrites Durable Object migration history when a class is removed.
