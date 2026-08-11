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
- [47](47-give-the-zerops-path-a-private-git-source.md) — Deliver public and private GitHub sources through an operator-owned GitHub App and a per-installation Zerops source service (ADR-0029).
- [54](54-give-operations-its-own-proxy-app-identity.md) — Half shipped; what is left is moving the operator surface onto the Operations host, which is a console architecture change, not a rename.
- [57](57-stop-the-caller-choosing-its-own-audit-correlation-id.md) — IAM takes `X-Request-Id` from the caller, unbounded, into `auth_log`; its Worker is edge-routed so the proxy strip never runs.
- [59](59-the-live-installation-calls-itself-local.md) — `fabrika-test` has never been deployed by the command that fixes it; `control` and `operations` still carry `ENVIRONMENT=local`.
- [60](60-the-example-app-has-no-light-tier-descriptor.md) — Neither committed `zerops.yaml` names the shared `db` the example actually runs against, so the live app cannot be redeployed from HEAD.
- [63](63-a-one-click-install-from-the-public-repository.md) — The second install shape: a running platform without creating a repository or a CI system.
- [64](64-close-the-bootstrap-admission-hatch-automatically.md) — A Cloudflare installation comes up admitting on a standing admin list, and closing it is an instruction printed to a human.
- [65](65-pin-a-zerops-build-to-a-revision.md) — A Zerops build source names a repository, not a revision, so `fabrika.ref` pins the pipeline but not the code Zerops builds.
- [67](67-command-for-the-first-administrator.md) — A fresh installation comes up with nobody able to sign in, and the four RPC calls that fix that live in a throwaway script.
- [68](68-platform-commands-mishandle-a-closed-stdin.md) — `platform install` runs unattended when it should refuse, and `platform init` cannot be run unattended at all.
- [69](69-a-zerops-runs-log-never-reaches-the-run-record.md) — The Zerops build log is relayed and then dropped into stdout, so every Zerops run's log endpoint is empty.
- [70](70-a-failed-zerops-build-hangs-await-deploy-for-seventy-minutes.md) — A build that fails before it creates a container leaves its app version at `WAITING_TO_BUILD`, which `await-deploy` waits out.
- [09](09-confirm-multi-domain-per-service.md) — Near-settled: upstream's domain flow takes several domains per service. Confirm and document.
- [10](10-app-scope-secrets-on-zerops.md) — Open: how the `app` secret scope is represented across separate Zerops projects.
- [11](11-oblaka-rewrites-do-migration-history.md) — oblaka rewrites Durable Object migration history when a class is removed.
