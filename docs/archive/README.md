# archive

Shipped sprints (each carrying its `OUTCOME` header — that's the record) and the
rare backlog/spec item with standalone reference value. Items arrive here by
`git mv`; they are **not** edited afterward.

**Default is delete, not archive.** The archive is not a graveyard for everything
that ships — only what genuinely helps a future reader. The git log holds the rest.

<!-- optional: group by date or theme as it grows; one line per entry -->

- [Auth boundary cleanup (2026-07-31)](sprint-2026-07-31-auth-boundary-cleanup.md)
  — centralizes gate contracts and makes schema reconciliation cancellable; SDK removal remains blocked by the missing Cloudflare proxy path.
- [Operations functional parity (2026-07-31)](sprint-2026-07-31-operations-functional-parity.md)
  — wires error and spike alert producers, restores complete issue read models
  and console workflows, and exposes redacted delivery evidence.
- [Automated release readiness (2026-07-31)](sprint-2026-07-31-automated-release-readiness.md)
  — adds honest backend CI, verified co-versioned package artifacts, trusted-release automation, and account-local runner rollouts; hosted CI and live npm activation remain backlog 25.
- [Operations adoption proof (2026-07-31)](sprint-2026-07-31-operations-adoption-proof.md)
  — proves managed `@sentry/browser` ingest and ten unified-console workflows
  against the real local composition, including scoped access and bounded
  Operations failure.
- [Operations plane foundation (2026-07-30)](sprint-2026-07-30-operations-plane.md)
  — absorbed Poplach as portable Errors and connected it to Delivery, Access,
  health, and the unified console, with restart-safe release projection and an
  end-to-end local recovery witness.
- [Repository capabilities (2026-07-30)](sprint-2026-07-30-repository-capabilities.md)
  — made complete repository operations the SQLite/Postgres portability seam for
  IAM and control.
- [Unified Fabrika console (2026-07-30)](sprint-2026-07-30-unified-console.md)
  — composed Delivery and Access into one professional control-plane console
  while preserving IAM as an independent authority.
- [Local Zerops stack (2026-07-30)](sprint-2026-07-30-local-zerops-stack.md)
  — composed the real local runtime behind a narrow Zerops API emulator and
  proved deploy recovery, IAM, persistence, proxies, and network isolation.
- [Zerops deployment namespaces (2026-07-29)](sprint-2026-07-29-zerops-deployment-namespaces.md)
  — added provider-owned placement boundaries with shared and exclusive Zerops
  projects, proxy ownership, and optional shared PostgreSQL.
- [Fabrika application runtime (2026-07-29)](sprint-2026-07-29-fabrika-app-runtime.md)
  — absorbed Trasa as `@fabrika/app` with explicit Cloudflare and Bun runtime
  entrypoints.
- [Static provider bundles (2026-07-29)](sprint-2026-07-29-static-provider-bundles.md)
  — extracted Cloudflare and Zerops behind open contracts and static composition
  roots.
- [Post-merge readiness (2026-07-29)](sprint-2026-07-29-post-merge-readiness.md)
  — unified the merged deployment surfaces and updated the toolchain.
- [Zerops control path (2026-07-29)](sprint-2026-07-29-zerops-control-path.md)
  — shipped static manifests, in-process Zerops deploys, proxy delivery,
  service-level secret writes, and restart reconciliation.
- [Proxy gate-config delivery](08-distribute-gate-config-to-proxy.md) — the
  shipped redeploy decision retained as context for ADR-0007, ADR-0008, and
  ADR-0010.
- [Canonical Fabrika environment names](07-rename-env-var-prefixes.md) — the
  shipped ADR-0018 compatibility sweep retained as the inventory of renamed
  configuration boundaries and exclusions.
