---
id: 05
title: Finish the Zerops bring-up — the production two-project shape
blocked-by: []
---

# 05 — Finish the Zerops bring-up

**"None of it has ever touched a real account" is no longer true.** Sprint
[`zerops-live-bringup`](../archive/sprint-2026-08-03-zerops-live-bringup.md) brought
the platform up on `prg1` in project `fabrika-test` on 2026-08-03: IAM, Operations,
control and the proxy all build, boot and serve; the proxy enforcement boundary
behaves exactly as ADR-0007 and ADR-0010 describe; and an example app runs behind it
with its gates enforced. Six defects that only a live account could surface were found
and five fixed.

What that run did **not** cover is below. The platform facts it established are in
[`../reference/zerops-platform.md`](../reference/zerops-platform.md); do not re-derive
them.

## What remains

1. **The production shape.** The live run used the single-project `light` tier. The
   committed `platform` + `apps-prod` topology — two projects, HA Postgres, separate
   Operations data services, `corePackage: SERIOUS` — has still never been applied.
   With it comes the cross-project hop ADR-0006 accepts: an apps-project proxy
   reaching IAM over its public origin.
2. **Custom domains.** Bind them to each project's L7 balancer, proxy service only;
   the import format has no field for it, so it is manual by construction. A shared
   IPv4 needs **both** A and AAAA records or routing fails silently — see
   [`09`](./09-confirm-multi-domain-per-service.md).
   Browser SSO no longer waits on this. It used to: the session cookie was shared
   across hosts through a parent-domain `Domain` attribute, and `*.zerops.app` is on
   the Public Suffix List, so a browser refuses a cookie scoped to `prg1.zerops.app`
   outright. [ADR-0021](../decisions/0021-exchange-token-session-handoff.md) replaced
   that with a one-time code redeemed by the proxy, verified live across two
   `.zerops.app` hostnames on 2026-08-04, and
   [ADR-0023](../decisions/0023-one-session-per-host.md) has since deleted the shared
   cookie outright. Custom domains are now about operating a real installation, not
   about making sign-in work.
3. **A source a private app can build from.**
   [ADR-0029](../decisions/0029-an-operator-owned-github-app-delivers-zerops-sources.md) settled
   the mechanism after a live probe disproved ADR-0025's native-integration assumption: an
   operator-owned GitHub App authorizes a per-installation `source` service, which uploads an exact
   repository snapshot for Zerops to build, see [`47`](./47-give-the-zerops-path-a-private-git-source.md).
   Until that lands the control-plane deploy cannot build a private repository, and neither can the
   Operations DSN that the control→Operations catalog projection mints.
   (The namespace proxy is no longer part of this: ADR-0025 builds it from a pinned tag
   of the public repository, needing no credential.)
4. **Operations ingest end to end.** Once 3 lands: an ingested exception reaching the
   private operator API, `FABRIKA_OPERATIONS_DSN` and `FABRIKA_RELEASE` arriving in a
   deployed app, and release/source-map correlation
   ([`36`](./36-complete-zerops-release-artifact-correlation.md)).
5. **The installation deploys itself from a pipeline, not a laptop.** The command
   exists and a DIFFERENT, fresh installation has been deployed and rolled forward
   entirely from an operator's CI
   ([archive](../archive/sprint-2026-08-07-zerops-from-scratch-install.md)).
   `fabrika-test` itself has not — it is still on the hand-chosen `zops push` order of
   2026-08-05 → [`59`](./59-the-live-installation-calls-itself-local.md).
6. **Human authentication is done on this tier.** Password enrollment, sign-in,
   throttling, admin disable and the audit trail were exercised live on 2026-08-04,
   and so was cross-host browser SSO between two `.zerops.app` hostnames
   ([ADR-0021](../decisions/0021-exchange-token-session-handoff.md)). Nothing
   authentication-shaped is left for this list.

## Still-open semantics

- **Does the project L7 balancer forward a client address a downstream may trust, and
  from what source range?** Settles whether the per-client abuse limit can key on the
  real client on Zerops (WU-C of
  [`auth-track-closeout`](../archive/sprint-2026-08-05-auth-track-closeout.md));
  today it cannot, so `trusted_proxies` is unset and every client shares the
  balancer's bucket. One sitting: put a service behind the balancer that echoes
  `X-Forwarded-For`, `X-Real-Ip` and the socket peer; call it from a known public
  address, then again with `X-Forwarded-For: 203.0.113.99` prepended. Three answers
  are needed — (a) does the balancer append the real address, (b) does it drop or
  keep a caller-supplied prefix, (c) what address does the socket peer show, i.e.
  what CIDR to hand to `--trusted-proxies`. **Only (a) AND (b)-drops together make the
  range safe to configure**; (a) alone with a preserved prefix means a caller can
  still choose its own bucket, which is the case the limit must not be built on.
- `GET /service-stack/{id}/app-version` list order. The client picks max `sequence`
  rather than trusting order; confirm `sequence` really is monotonic.

## Acceptance

The production two-project topology boots; the proxy is reachable on custom IAM,
control and Operations domains; a human signs in through the browser; and one deploy
of the example app completes **through the control plane** with its logs relayed into
the run record and an ingested exception reaching the private operator API. Then fold
what you learned into [`../reference/zerops-platform.md`](../reference/zerops-platform.md)
and delete this file.
