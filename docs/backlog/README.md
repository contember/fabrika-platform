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
manifest, proxy, and Zerops control path are built and locally verified. CI and
release restoration remains explicit item 25.

## Items

<!-- one line each: NN — short summary (link). Keep it short. -->

- [05](05-bring-up-on-a-real-zerops-account.md) — **Next.** Everything below the account line is built and schema-valid; nothing has run against a real Zerops account.
- [17](17-one-gate-matcher-not-two.md) — The gate matcher is duplicated between the SDK and the proxy — the second implementation ADR-0008 rejected.
- [18](18-shrink-the-app-sdk.md) — Delete in-process enforcement from `@fabrika/auth` now the proxy does it. Keep `redeemKey`.
- [19](19-cancellation-gaps.md) — `reconcileSchema` takes no `AbortSignal`, so the one shared step is the one that cannot be cancelled.
- [21](21-rate-limit-the-iam-mint-surface.md) — Deferred with reasons; the limit belongs at the proxy, which can identify a client.
- [22](22-unix-second-columns-overflow-in-2038.md) — int4 timestamps; `BIGINT` costs every reader a string. Decide before it is urgent.
- [25](25-migrate-the-ci-workflows.md) — No CI at all. Restore deploy, release (OIDC trusted publishing) and the runner image build.
- [26](26-retire-trasa-release-surface.md) — Publish `@fabrika/app`, deprecate `@trasa/core`, and archive the standalone repository.
- [06](06-can-zerops-secrets-be-read-back.md) — Open: can secret _values_ be read back from the Zerops API?
- [07](07-rename-env-var-prefixes.md) — Sweep `VOZKA_*` → `FABRIKA_*`; decide whether `PROPUSTKA_*` follows.
- [09](09-confirm-multi-domain-per-service.md) — Open: does Zerops allow multiple custom domains on one service?
- [10](10-app-scope-secrets-on-zerops.md) — Open: how the `app` secret scope is represented across separate Zerops projects.
- [11](11-oblaka-rewrites-do-migration-history.md) — oblaka rewrites Durable Object migration history when a class is removed.
