# archive

Shipped sprints (each carrying its `OUTCOME` header — that's the record) and the
rare backlog/spec item with standalone reference value. Items arrive here by
`git mv`; they are **not** edited afterward.

**Default is delete, not archive.** The archive is not a graveyard for everything
that ships — only what genuinely helps a future reader. The git log holds the rest.

<!-- optional: group by date or theme as it grows; one line per entry -->

- [A Zerops installation from an empty project (2026-08-07)](sprint-2026-08-07-zerops-from-scratch-install.md)
  — the operator creates an empty project and `fabrika` does the rest: install, sidecar repository, CI
  deploy, first administrator. Proven end to end on a fresh account; five defects, all in shipped code
  that had never been executed.
- [Exchange-token SSO (2026-08-04)](sprint-2026-08-04-exchange-token-sso.md) — a
  one-time code replaces the shared session cookie, so a browser authenticated at IAM
  reaches an app on any domain; proven live across two `.zerops.app` hostnames.
- [Password authentication and portable email (2026-08-04)](sprint-2026-08-04-password-auth-and-email.md)
  — adds reusable outbound email and independently configurable OIDC/password authentication with enrollment and reset.
- [Zerops live bring-up (2026-08-03)](sprint-2026-08-03-zerops-live-bringup.md) — the light tier on a real account; six defects only an account could surface
- [Cloudflare proxy enforcement (2026-08-01)](sprint-2026-08-01-cloudflare-proxy-enforcement.md)
  — puts Cloudflare applications behind the shared TypeScript proxy authorizer and deploys the nested Worker graph.
- [Auth boundary cleanup (2026-07-31)](sprint-2026-07-31-auth-boundary-cleanup.md)
  — centralizes gate contracts and makes schema reconciliation cancellable; SDK removal remains backlog 18.
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
- [Auth hardening (2026-08-04)](sprint-2026-08-04-auth-hardening.md) — made
  the proxy the only enforcement point, deleted the SDK's duplicate path and
  the dev-persona bypass, gave every host its own session, and consolidated
  four enforcement ADRs into ADR-0022.
- [Auth track closeout (2026-08-05)](sprint-2026-08-05-auth-track-closeout.md) —
  emptied the Access-plane backlog: a session is refused once its method is
  disabled, Operations' public host declares only the routes it serves, an abuse
  limit is keyed on a coordinate the caller cannot set, the drifted Operations
  browser scenarios are re-authored, and ADR-0018's legacy environment-name
  fallback is retired. Records why item 54's other half is a console architecture
  change rather than a rename.
- [Zerops path correctness (2026-08-05)](sprint-2026-08-05-zerops-path-correctness.md)
  — settled six conformance items against the real account rather than the docs,
  unbroke the service-variable write, made the `.zerops.app` entry point real or
  loud, and brought the live installation to HEAD — which is where a browser found
  two sign-in defects no test could reach. Its fifth unit was overtaken by ADR-0025.
- [Proxy gate-config delivery](08-distribute-gate-config-to-proxy.md) — the
  shipped redeploy decision retained as context for ADR-0007, ADR-0008, and
  ADR-0010.
- [Canonical Fabrika environment names](07-rename-env-var-prefixes.md) — the
  shipped ADR-0018 compatibility sweep retained as the inventory of renamed
  configuration boundaries and exclusions.
