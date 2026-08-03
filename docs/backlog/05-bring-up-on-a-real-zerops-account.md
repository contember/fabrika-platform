---
id: 05
title: Finish the Zerops bring-up — production shape and the git-sourced deploy
blocked-by: [./41-write-service-variables-without-a-pre-read.md]
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
   This is also what unblocks **browser SSO**: the session cookie is shared across IAM
   and the console through `SESSION_COOKIE_DOMAIN`, and sibling `*.zerops.app`
   hostnames have no safe common parent (setting one would hand the platform session
   to every other Zerops customer). Machine surfaces are unaffected and are verified.
3. **A git source, and the deploys that need one.** fabrika's GitHub App does not
   reach the Zerops path at all — see
   [`47`](./47-give-the-zerops-path-a-private-git-source.md). Until one exists,
   neither the control-plane `trigger-deploy` step nor the namespace reconcile (which
   builds the proxy from `proxyBuildFromGit`) can run, and therefore neither can the
   Operations DSN that the control→Operations catalog projection mints.
4. **Operations ingest end to end.** Once 3 lands: an ingested exception reaching the
   private operator API, `FABRIKA_OPERATIONS_DSN` and `FABRIKA_RELEASE` arriving in a
   deployed app, and release/source-map correlation
   ([`36`](./36-complete-zerops-release-artifact-correlation.md)).
5. **`putServiceEnv` must stop pre-reading** — [`41`](./41-write-service-variables-without-a-pre-read.md).
   The live bring-up had to work around it with a standalone script; nothing in
   `packages/` writes a service variable successfully today.

## Still-open semantics

- **Is re-applying an unchanged import with `override: true` a no-op, or a redeploy?**
  Not exercised. → [`39`](./39-settle-zerops-override-semantics.md).
- `GET /service-stack/{id}/app-version` list order. The client picks max `sequence`
  rather than trusting order; confirm `sequence` really is monotonic.
- That `${host_connectionString}` reaches the intended database on a service not named
  `db` — [`45`](./45-pin-the-zerops-postgres-connection-target.md). The light run only
  ever used `db`.

## Acceptance

The production two-project topology boots; the proxy is reachable on custom IAM,
control and Operations domains; a human signs in through the browser; and one deploy
of the example app completes **through the control plane** with its logs relayed into
the run record and an ingested exception reaching the private operator API. Then fold
what you learned into [`../reference/zerops-platform.md`](../reference/zerops-platform.md)
and delete this file.
