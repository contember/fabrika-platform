# fabrika-platform docs — index

The map of everything under `docs/`. Read [`CLAUDE.md`](CLAUDE.md) for the rules.
When sources disagree, precedence is: invariants/hard-rules → active sprint →
decisions → reference → archive.

**New here?** Start with [`reference/overview.md`](reference/overview.md) — what
fabrika-platform is and how the pieces fit — then skim
[`decisions/README.md`](decisions/README.md) for the _why_. For the current error
ingest, grouping, triage, and alert workflows, read
[`reference/operations-errors.md`](reference/operations-errors.md). For how
authentication and authorization work, read
[ADR-0022](decisions/0022-the-proxy-is-the-only-enforcement-point.md) — one document
that supersedes the four which decided it in stages.

## Folders

- [`reference/`](reference/README.md) — how the system works now.
- [`ideas/`](ideas/README.md) — proposals, no commitment.
- [`decisions/`](decisions/README.md) — ADRs (the _why_), immutable.
- [`backlog/`](backlog/README.md) — decided work, not yet scheduled.
- [`sprints/`](sprints/README.md) — active thematic work-plans.
- [`archive/`](archive/README.md) — shipped sprints + reference-worthy records.

## Active sprints

- [`zerops-path-correctness`](sprints/sprint-2026-08-05-zerops-path-correctness.md) — the live
  installation has drifted from HEAD (the control plane is gated `/*` public there), one mechanism
  is broken on every call (41), and four conformance corrections are unexercised.

Two auth sprints shipped on 2026-08-05 —
[hardening](archive/sprint-2026-08-04-auth-hardening.md), then
[track closeout](archive/sprint-2026-08-05-auth-track-closeout.md). The Access-plane
backlog is empty; what is left of item 54 is a console architecture decision, not auth work.

## What's hot

<!-- hand-maintained, keep short: the few things actually in motion + what's next.
     If everything is "hot", nothing is. -->

- **Auth:** there is now one enforcement point and one enforcement ADR —
  [0022](decisions/0022-the-proxy-is-the-only-enforcement-point.md), superseding
  0007/0008/0010/0021. The SDK's duplicate in-process gate path is deleted, and the
  one question 0022 left open is answered by
  [0023](decisions/0023-one-session-per-host.md): one session-delivery mechanism, one
  session per host, `__Host-` on both cookies. A session is now refused as soon as its
  authentication method is disabled, and an abuse limit is keyed on a client coordinate
  the caller cannot set — the proxy observes and injects it, IAM enforces, because
  0022 forbids the proxy holding state a decision depends on.
- **Release is blocked:** `release:validate` has been red since `18d9575` — a published
  package depends on a private one ([56](backlog/56-unbreak-the-release-dependency-gate.md)).
  Decide what `@fabrika/proxy` is before anything ships.
- **Configuration names:** one spelling per setting. `FABRIKA_*` is the only family anything
  reads — [ADR-0024](decisions/0024-retire-the-legacy-environment-name-fallback.md) retired
  0018's `VOZKA_*`/`PROPUSTKA_*` fallback and deleted the shared alias reader with it. Durable
  identifiers that carry those words as VALUES (app ids, worker/database/bucket/queue names,
  migration identities) are untouched and stay that way.
- **Release activation:** run hosted CI, bootstrap the twenty npm packages, and prove the tokenless release path in
  [`backlog/25-bootstrap-npm-trusted-publishing.md`](backlog/25-bootstrap-npm-trusted-publishing.md).
- **Zerops, post-bring-up:** the light tier is **live on a real account** (sprint
  [`zerops-live-bringup`](archive/sprint-2026-08-03-zerops-live-bringup.md)); the
  platform facts it settled are in [`reference/zerops-platform.md`](reference/zerops-platform.md).
  Next: [`41`](backlog/41-write-service-variables-without-a-pre-read.md) — the env write
  reads first and that read never succeeds, so nothing in `packages/` can write a
  service variable — then [`47`](backlog/47-give-the-zerops-path-a-private-git-source.md),
  which blocks every control-plane-triggered deploy. The production two-project shape and
  custom domains remain in [`05`](backlog/05-bring-up-on-a-real-zerops-account.md);
  [`39`](backlog/39-settle-zerops-override-semantics.md) is still unexercised.
- **The session handoff is the ONLY way a browser gets a session for an app.** IAM
  issues a one-time code and the proxy on the app's own host redeems it
  ([ADR-0023](decisions/0023-one-session-per-host.md); how it works is
  [`reference/cross-host-sso.md`](reference/cross-host-sso.md)). The shared parent-domain
  cookie is gone, both session cookies carry the `__Host-` prefix, and the control plane
  projects an app's return origins into IAM on every deploy.
- **Operations follow-up:** complete
  [Zerops release artifact correlation](backlog/36-complete-zerops-release-artifact-correlation.md),
  settle [managed-environment activation](backlog/37-activate-zerops-managed-environment-transactionally.md),
  add [DNS-safe Operations egress](backlog/38-add-dns-safe-operations-egress.md),
  and add [email as an Operations notification target](backlog/46-add-portable-email-alert-delivery.md).
  The [broad target](ideas/operations-plane.md) and credentialed
  [Poplach cutover](backlog/34-retire-standalone-poplach.md) remain separate.
