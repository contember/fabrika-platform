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
that supersedes the four which decided it in stages — then
[ADR-0026](decisions/0026-bind-session-handoffs-to-the-browser.md) for the browser-bound
handoff amendment.

## Folders

- [`reference/`](reference/README.md) — how the system works now.
- [`ideas/`](ideas/README.md) — proposals, no commitment.
- [`decisions/`](decisions/README.md) — ADRs (the _why_), immutable.
- [`backlog/`](backlog/README.md) — decided work, not yet scheduled.
- [`sprints/`](sprints/README.md) — active thematic work-plans.
- [`archive/`](archive/README.md) — shipped sprints + reference-worthy records.

## Active sprints

[`multiple-private-github-source-connections`](sprints/sprint-2026-08-14-multiple-private-github-source-connections.md) —
extend the Zerops source path to one private GitHub App per organization and multiple connections per
installation. [ADR-0032](decisions/0032-support-multiple-private-github-source-connections.md) keeps
the live Zerops v1 credential and generic webhook as a marker-selected compatibility path, gives new
connections keyed v2 credentials and scoped webhooks, and binds every Zerops private app to a
connection-and-installation pair. Cloudflare keeps its static-secret and installation-id webhook
model. Fabrika sets no explicit connection-count limit. Deterministic local compatibility and isolation
gates are complete. The local fixture cannot exercise the GitHub manifest/install browser E2E; that
live flow, the Zerops restart, second-organization private deploy, one legacy-v1 generic delivery and
one keyed-v2 scoped delivery remain open.

[`fabrika-deploys-an-app-on-zerops`](sprints/sprint-2026-08-11-fabrika-deploys-an-app-on-zerops.md) —
**one gate: add a GitHub repository, public or private, to the control plane and get it deployed into
the Zerops account**, signed into by a browser and reporting its own errors. The public source seam,
fast build-failure detection and persisted run logs are implemented checkpoints. A live probe then
proved Zerops' GUI OAuth grant cannot be consumed by the installation's project-scoped token.
[ADR-0029](decisions/0029-an-operator-owned-github-app-delivers-zerops-sources.md) replaces that native
integration plan with an operator-owned GitHub App and a non-public per-installation `source` service.
The service and application upload lifecycle are locally implemented; production is fixed to
`github.com`. Fresh installation leaves source anonymous. Normal App creation, encrypted recovery,
source activation, webhook configuration, legacy adoption and installation verification now run in
the authenticated Control console under
[ADR-0031](decisions/0031-manage-zerops-github-source-from-control.md); ADR-0030 remains the legacy CLI
recovery record. Source fetches an exact commit and uploads the repository archive; Zerops still builds
and deploys it. The complete live browser flow, public/private live deploys and the browser/Operations
last mile remain open.
The example remains a tested workspace fixture and standalone repository whose root holds `zerops.yaml`.
Consumes
[`47`](backlog/47-give-the-zerops-path-a-private-git-source.md),
`backlog/69` (since shipped and deleted) and
[`70`](backlog/70-a-failed-zerops-build-hangs-await-deploy-for-seventy-minutes.md), and answers items 3
and 4 of [`05`](backlog/05-bring-up-on-a-real-zerops-account.md).

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
  session per host, `__Host-` on both cookies. [0026](decisions/0026-bind-session-handoffs-to-the-browser.md)
  binds each callback to the browser that started it, removes the unused JWT-cookie path, and strips
  Fabrika cookies before the application. A session is now refused as soon as its
  authentication method is disabled, and an abuse limit is keyed on a client coordinate
  the caller cannot set — the proxy observes and injects it, IAM enforces, because
  0022 forbids the proxy holding state a decision depends on.
- **Enforcement is one decision, two deployments.** `@fabrika/proxy-core` holds the decision and is
  public; `@fabrika/proxy` is the Caddy artifact that serves it and stays private. That split is what
  lets the published Cloudflare provider reach the enforcement code without publishing a binary, and
  it is what unblocked `release:validate`.
- **Configuration names:** one spelling per setting. `FABRIKA_*` is the only family anything
  reads — [ADR-0024](decisions/0024-retire-the-legacy-environment-name-fallback.md) retired
  0018's `VOZKA_*`/`PROPUSTKA_*` fallback and deleted the shared alias reader with it. Durable
  identifiers that carry those words as VALUES (app ids, worker/database/bucket/queue names,
  migration identities) are untouched and stay that way.
- **Releases are live and tokenless.** All twenty-two `@fabrika` packages are on npm at **`0.0.2`**,
  every one published by `release.yml` through OIDC with a provenance attestation, and every one
  trusting only that workflow ([`25`](backlog/25-bootstrap-npm-trusted-publishing.md)). `0.0.1` was
  the bootstrap: npm demands an interactive one-time password for a first publish, so it went up from
  a laptop and carries no provenance — which is exactly why `0.0.2` exists. **`v0.0.2` is also the
  first tag this repository has ever had**, which is what the sidecar install path was waiting on.
- **Zerops, post-bring-up:** the light tier is **live on a real account** (sprint
  [`zerops-live-bringup`](archive/sprint-2026-08-03-zerops-live-bringup.md)); the
  platform facts it settled are in [`reference/zerops-platform.md`](reference/zerops-platform.md).
  Sprint [`zerops-path-correctness`](archive/sprint-2026-08-05-zerops-path-correctness.md)
  then fixed what the account proved wrong — the env write, four conformance corrections,
  the `.zerops.app` entry point — and signed a browser in through the proxy live. The installation is
  still deployed **by hand**: `platform deploy` and `platform init` are written and unit-tested, but
  neither has run against the account, so the hand sequence remains the only proven one. Next is the
  live acceptance above, including [`47`](backlog/47-give-the-zerops-path-a-private-git-source.md): an
  operator-owned GitHub App and source-upload service now replace the disproved native-integration
  approach in code. The authenticated Control workflow durably recovers the one-time App id and private
  key, activates the source credentials and verifies the App installation
  ([ADR-0031](decisions/0031-manage-zerops-github-source-from-control.md)); the CLI is now a narrow
  repair/adoption path. [ADR-0032](decisions/0032-support-multiple-private-github-source-connections.md)
  implements one private App per organization with keyed credentials and exact-pair source and webhook
  routing, without an explicit connection-count limit. Its deterministic local compatibility and
  isolation gates are complete. The local fixture cannot exercise the GitHub manifest/install browser
  E2E; that flow, the ordered live rollout, restart, second-organization private deploy, one legacy-v1
  generic delivery and one keyed-v2 scoped delivery remain open. The complete browser flow and
  public/private deploys still need live witnesses.
  The production two-project shape and custom domains remain in
  [`05`](backlog/05-bring-up-on-a-real-zerops-account.md).
- **Domain audit delivery is best-effort today.** `IamRpc.audit` intentionally returns before the IAM
  write is durable, which is the existing semantics followed by every Control mutation, including the
  source-connection flow. Repository-wide stable event ids, idempotent IAM acknowledgement and
  transactional producer outboxes are tracked in
  [`71`](backlog/71-deliver-domain-audit-events-durably.md); this is not a private blocker for item 47.
- **The session handoff is the ONLY way a browser gets a session for an app.** IAM
  issues a browser-bound one-time code and the proxy on the app's own host redeems it
  ([ADR-0023](decisions/0023-one-session-per-host.md),
  [ADR-0026](decisions/0026-bind-session-handoffs-to-the-browser.md); how it works is
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
