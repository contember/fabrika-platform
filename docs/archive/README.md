# archive

Shipped sprints (each carrying its `OUTCOME` header — that's the record) and the
rare backlog/spec item with standalone reference value. Items arrive here by
`git mv`; they are **not** edited afterward.

**Default is delete, not archive.** The archive is not a graveyard for everything
that ships — only what genuinely helps a future reader. The git log holds the rest.

<!-- optional: group by date or theme as it grows; one line per entry -->

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
