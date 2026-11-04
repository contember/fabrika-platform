---
id: 05
title: The Zerops production checks no live run has recorded
blocked-by: []
---

# 05 — The Zerops production checks no live run has recorded

**Summary.** Zerops is brought up and runs production workloads. What no live run in this repository records is the
HA `standard` tier, custom domains, the balancer's client address, one API ordering, and a release and recovery
rehearsal.

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
- **Production workloads run on Zerops** (["Measured in production (2026-10-16)"](../reference/zerops-platform.md#measured-in-production-2026-10-16--an-applications-database-connections)).
- **The two-project `platform` + `apps-prod` shape is gone.** Since `7c9de25d8`, `--tier=standard` installs one
  `SERIOUS` project (HA PostgreSQL for IAM and Control, a second HA PostgreSQL and bucket for Operations, two IAM and
  proxy containers), and Control creates each application namespace's project (the tier table of the operator guide,
  [`guide.md`](../../packages/provider-zerops/src/installation/guide.md)).

The platform facts these runs established are in [`../reference/zerops-platform.md`](../reference/zerops-platform.md);
do not re-derive them.

## What remains

1. **The `standard` tier on a live account.** No recorded run has installed it. Its HA PostgreSQL connection form is
   measured ([platform facts, 2026-08-19](../reference/zerops-platform.md#verified-live-2026-08-19-account-prg1-project-fabrika-notes-prod--postgresql-tls-is-per-service-type)),
   the tier as a whole is not.
2. **Custom domains.** Binding is manual: the import format has no field for it. Bind them to each project's L7
   balancer, proxy service only. A shared IPv4 needs **both** A and AAAA records or routing fails silently. One proxy
   fronts many applications, so confirm that a service takes several custom domains and record it in the platform
   reference. A plain domain validates over HTTP-01, so it must route to the service before its certificate issues; a
   wildcard needs DNS-01 (`CNAME _acme-challenge.<domain>` → `<domain>.zerops.zone`). Sign-in does not depend on it
   ([ADR-0023](../decisions/0023-one-session-per-host.md)).
3. **Does the project L7 balancer forward a client address a downstream may trust, and from what source range?** It
   settles whether the per-client abuse limit can key on the real client on Zerops (WU-C of
   [`auth-track-closeout`](../archive/sprint-2026-08-05-auth-track-closeout.md)). Today it cannot: `trusted_proxies`
   is unset and every client shares the balancer's bucket. A form's `rate.perClient` bucket keys on the same value:
   `clientBucket` (`packages/app/src/implement/form-admission.ts`) reads only the proxy's `X-Fabrika-Client-Ip`, which
   is `{http.vars.client_ip}`, so on Zerops every visitor shares one per-client bucket and the form's `rate.perForm`
   ceiling bounds an intake. One sitting: put a service behind the balancer that echoes `X-Forwarded-For`,
   `X-Real-Ip` and the socket peer; call it from a known public address, then again with
   `X-Forwarded-For: 203.0.113.99` prepended. Three answers: (a) does the balancer append the real address, (b) does
   it drop or keep a caller-supplied prefix, (c) what address does the socket peer show, i.e. what CIDR to hand to
   `--trusted-proxies`. **Only (a) AND (b)-drops together make the range safe to configure.**
4. **`GET /service-stack/{id}/app-version` list order.** The client picks the highest `sequence` rather than trusting
   the order (`packages/provider-zerops/src/api/client.ts`); confirm `sequence` is monotonic.
5. **A release and recovery rehearsal.** No live run records these at a current release: OIDC sign-in on Zerops, a
   keyed webhook, scoped authorization, revocation, and Operations outage isolation. Test acknowledged-write survival on the selected HA PostgreSQL profile, and restore into
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
