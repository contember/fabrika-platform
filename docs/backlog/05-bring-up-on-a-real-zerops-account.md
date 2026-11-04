---
id: 05
title: The Zerops production checks no live run has recorded
blocked-by: []
---

# 05 — The Zerops production checks no live run has recorded

**Summary.** Zerops is brought up and runs production workloads on the `light` tier. What no live run records is the
HA `standard` tier, a second custom domain on one proxy and custom domains on the platform hosts, the client address
on a dedicated IPv4, and a release and recovery rehearsal.

## Done

- **Bring-up on a real account.** IAM, Operations, Control and the proxy built, booted and served on the `light` tier,
  behind the proxy enforcement boundary of ADR-0022
  ([sprint](../archive/sprint-2026-08-03-zerops-live-bringup.md)). Human authentication and cross-host browser SSO
  between two `.zerops.app` hostnames ran live on 2026-08-04.
- **An installation deploys itself from its operator's CI.** After `fabrika platform install`, a fresh installation
  was deployed and rolled forward from its sidecar pipeline
  ([sprint](../archive/sprint-2026-08-07-zerops-from-scratch-install.md)); that sprint was password only, by decision.
- **Applications deploy.** Public and private application source, browser handoff, run-log relay and
  release-correlated Operations ingest
  ([sprint](../archive/sprint-2026-08-11-fabrika-deploys-an-app-on-zerops.md)); an application namespace in its own
  project reaching IAM across projects (`fabrika-notes-prod`,
  [platform facts](../reference/zerops-platform.md#verified-live-2026-08-18-account-prg1-projects-fabrika-install-test--fabrika-notes-prod--provisioning-an-app-namespace)).
- **Production workloads run on the `light` tier.** A production installation (its platform project and its
  application namespace, both on a `LIGHT` core with single-node PostgreSQL) is rolled forward from its sidecar
  pipeline, and an application domain is bound to its namespace proxy
  ([platform facts](../reference/zerops-platform.md#public-access),
  ["Measured in production (2026-10-16)"](../reference/zerops-platform.md#measured-in-production-2026-10-16--an-applications-database-connections)).
- **The balancer's client address and the app-version order are measured passively** on that installation and recorded in the
  [platform facts](../reference/zerops-platform.md#public-access): the shared IPv4 forwards no IPv4 client's address,
  and `sequence` was monotonic with gaps.
- **The two-project `platform` + `apps-prod` shape is gone.** Since `7c9de25d8`, `--tier=standard` installs one
  `SERIOUS` project (HA PostgreSQL for IAM and Control, a second HA PostgreSQL and bucket for Operations, two IAM and
  proxy containers), and Control creates each application namespace's project (the tier table of the operator guide,
  [`guide.md`](../../packages/provider-zerops/src/installation/guide.md)).

The platform facts these runs established are in [`../reference/zerops-platform.md`](../reference/zerops-platform.md);
do not re-derive them.

## What remains

1. **The `standard` tier on a live account.** No installation runs it; production runs on `light`. Its HA PostgreSQL connection form is
   measured ([platform facts, 2026-08-19](../reference/zerops-platform.md#verified-live-2026-08-19-account-prg1-project-fabrika-notes-prod--postgresql-tls-is-per-service-type)),
   the tier as a whole is not.
2. **The rest of custom domains.** One application domain on a namespace proxy works in production: `A` to the
   shared IPv4 and `AAAA` to the project's IPv6, certificate over HTTP-01
   ([platform facts](../reference/zerops-platform.md#public-access)). Binding stays manual: the import format has no
   field for it. Left: a second custom domain on one fabrika proxy (one proxy fronts many applications; Zerops holds
   two on a non-fabrika service), custom domains for the platform hosts (IAM, Control, Operations), and a wildcard,
   which needs DNS-01 (`CNAME _acme-challenge.<domain>` → `<domain>.zerops.zone`). Sign-in does not depend on any of
   it ([ADR-0023](../decisions/0023-one-session-per-host.md)).
3. **A client address on a dedicated IPv4.** Measured passively on a production installation
   ([platform facts](../reference/zerops-platform.md#public-access)): behind the shared IPv4 the balancer appends one
   gateway address for every IPv4 client and keeps a caller-supplied `X-Forwarded-For` prefix, so no `trusted_proxies`
   range is safe and every IPv4 visitor shares one per-client bucket (the abuse limit of WU-C of
   [`auth-track-closeout`](../archive/sprint-2026-08-05-auth-track-closeout.md), and a form's `rate.perClient`, which
   `clientBucket` in `packages/app/src/implement/form-admission.ts` keys on `X-Fabrika-Client-Ip`, i.e.
   `{http.vars.client_ip}`; a form's `rate.perForm` ceiling bounds the submissions). Left: whether a project with a
   dedicated IPv4 gets the client's address appended, and whether it drops a caller-supplied prefix. **Only both
   together make a range safe to configure.**
4. **A release and recovery rehearsal.** None has run. No live run records these at a current release: OIDC sign-in
   on Zerops, a keyed webhook, scoped authorization, revocation, and Operations outage isolation. A production
   installation signs in with passwords only and runs single-node PostgreSQL with daily automatic dumps (no
   object-storage backup), so its traffic exercises neither OIDC nor a failover, and no restore is recorded. Test acknowledged-write survival on the selected HA PostgreSQL profile, and restore into
   an isolated project from a complete recovery set (IAM/Control/Operations SQL with migration ledgers and queues,
   object payloads, and the matching vault, signing and configuration secrets). Restored work must not duplicate
   occurrences or dispatch stale notifications. Recovery targets agreed with the owner: survive a single
   database-node failure without losing acknowledged writes; after project loss, restore within four hours from a
   verified backup no older than 24 hours. The per-release install acceptance is
   [185](185-no-release-is-accepted-on-a-live-zerops-account.md).

## Acceptance

Each point above is either measured on a live account and recorded in
[`../reference/zerops-platform.md`](../reference/zerops-platform.md) (or the operator guide), or dropped by the owner
as not needed. Then delete this file.
