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
upstream documentation. They are corrections and open semantics that item 05's
bring-up will otherwise discover the hard way — 41 blocks its step 3 outright, and 39
decides whether the steady-state re-apply is a reconcile or a redeploy.

## Items

<!-- one line each: NN — short summary (link). Keep it short. -->

- [05](05-bring-up-on-a-real-zerops-account.md) — **Next.** Everything below the account line is built and schema-valid; nothing has run against a real Zerops account.
- [17](17-one-gate-matcher-not-two.md) — The gate matcher is duplicated between the SDK and the proxy — the second implementation ADR-0008 rejected.
- [18](18-shrink-the-app-sdk.md) — Delete in-process enforcement from `@fabrika/auth` now the proxy does it. Keep `redeemKey`.
- [19](19-cancellation-gaps.md) — `reconcileSchema` takes no `AbortSignal`, so the one shared step is the one that cannot be cancelled.
- [21](21-rate-limit-the-iam-mint-surface.md) — Deferred with reasons; the limit belongs at the proxy, which can identify a client.
- [22](22-unix-second-columns-overflow-in-2038.md) — int4 timestamps; `BIGINT` costs every reader a string. Decide before it is urgent.
- [25](25-bootstrap-npm-trusted-publishing.md) — Bootstrap the nineteen package names once through protected CI, then activate tokenless OIDC publishing.
- [26](26-retire-trasa-release-surface.md) — Publish `@fabrika/app`, deprecate `@trasa/core`, and archive the standalone repository.
- [34](34-retire-standalone-poplach.md) — Adopt existing state and retire the standalone Poplach app.
- [36](36-complete-zerops-release-artifact-correlation.md) — Publish Zerops build source maps and link Delivery runs to Operations evidence.
- [37](37-activate-zerops-managed-environment-transactionally.md) — Keep Zerops managed environment activation consistent with the app version that actually ships.
- [38](38-add-dns-safe-operations-egress.md) — Prevent private-address and DNS-rebinding egress through Operations webhooks and active health checks.
- [39](39-settle-zerops-override-semantics.md) — `override: true` is written on every service; upstream says runtime-only, and that it replaces rather than updates.
- [40](40-subdomain-access-is-not-import-settable.md) — `enableSubdomainAccess` does not take effect on a service that has never been deployed.
- [41](41-write-service-variables-without-a-pre-read.md) — The env write reads first, and that read 400s until the first deploy — which is when bring-up writes every secret.
- [42](42-size-the-platform-managed-postgres.md) — Two HA Postgres services declare no `profile`, so both default to the production tier.
- [43](43-gate-zerops-deploys-on-readiness.md) — No `deploy.readinessCheck` anywhere, and no explicit timeouts on any check.
- [44](44-make-proxy-manifest-delivery-quoting-safe.md) — The proxy manifest is spliced into a shell command as JSON; the `${…}` form is ambiguous.
- [45](45-pin-the-zerops-postgres-connection-target.md) — `connectionString` carries no database and no SSL mode; both are driver defaults today.
- [06](06-can-zerops-secrets-be-read-back.md) — Near-settled: upstream says a write-capable token returns secret values. Confirm, then decide the UX.
- [09](09-confirm-multi-domain-per-service.md) — Near-settled: upstream's domain flow takes several domains per service. Confirm and document.
- [10](10-app-scope-secrets-on-zerops.md) — Open: how the `app` secret scope is represented across separate Zerops projects.
- [11](11-oblaka-rewrites-do-migration-history.md) — oblaka rewrites Durable Object migration history when a class is removed.
