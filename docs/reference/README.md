# reference

How the system works **now** — architecture, conventions, runbooks. Flat files,
`kebab-case.md`.

Rules (see [`../CLAUDE.md`](../CLAUDE.md)): describe the current state only — no
status updates, no TODOs (file those in `../backlog/`), no design rationale (that's
a `../decisions/` ADR). Update reference in the **same change** that alters
behaviour.

<!-- index the reference docs here, one line each -->

- [`overview.md`](overview.md) — what fabrika-platform is, why it exists, the
  three product planes, packages, and primary request flows. **Start here.**
- [`application-runtime.md`](application-runtime.md) — the `@fabrika/app` request
  pipeline, typed RPC, and authorization boundary.
- [`core-application-composition.md`](core-application-composition.md) — how IAM,
  Delivery, and Operations share that runtime, RPC, auth, migrations, and
  compatibility boundaries.
- [`human-authentication.md`](human-authentication.md) — independently configured
  OIDC/password login, enrollment, reset, sessions, and bootstrap behavior.
- [`cross-host-sso.md`](cross-host-sso.md) — the session handoff: how a browser
  authenticated at IAM ends up authenticated at an app, on any host, with no shared
  cookie.
- [`outbound-email.md`](outbound-email.md) — the portable sender contract,
  Resend adapter, configuration, and domain ownership boundary.
- [`operations-errors.md`](operations-errors.md) — current Sentry ingest,
  grouping, issue lifecycle, query, alert production, delivery, and console
  behavior.
- [`zerops-platform.md`](zerops-platform.md) — the Zerops facts the decisions rest
  on, each with a source (and each unverified claim marked as such).
- [`portability-surface.md`](portability-surface.md) — every Cloudflare primitive in
  use and its portable counterpart; how portable each deploy layer is; the IAM
  and Operations port assessment.
- [`provider-bundles.md`](provider-bundles.md) — the static provider contract,
  versioned persistence boundary, composition roots, and unified CLI dispatch.
- [`deployment-namespaces.md`](deployment-namespaces.md) — provider-neutral
  placement lifecycle, assignment and resource claims, Zerops isolation presets,
  and operator interfaces.
- [`local-development.md`](local-development.md) — operate and verify the real
  local Delivery, Access, and Operations data plane behind the narrow Zerops REST
  emulator.
- [`release-process.md`](release-process.md) — required CI gates, the public package contract, trusted tag publication, and the per-account deployment boundary.
