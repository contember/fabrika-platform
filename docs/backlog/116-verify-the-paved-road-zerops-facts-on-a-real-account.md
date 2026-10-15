---
id: 116
title: Verify the paved-road sprint's Zerops facts on a real account
blocked-by: []
---

# 116 — Verify the paved-road sprint's Zerops facts on a real account

**Summary.** The per-application database roles (WU12) on an HA service and the malware scan (WU17) rest on Zerops
behaviour nobody has measured, and an application deployed before WU12 cannot migrate without a manual step. One
live sitting. Effort: S–M.

## Problem

`docs/reference/zerops-platform.md` records these as UNVERIFIED:

- **A new role on the direct port of `postgresql:ha@18`**. `FABRIKA_APP_DATABASE_URL` is the service's superuser on
  the direct port with `sslmode=disable` (measured on `postgresql:single@18`, 2026-10-15). Whether a role fabrika
  creates logs in on that port of an `ha` service is the `not-probed` row `unverified-postgres-ha-new-role-on-direct-port`.
  If it does not, a contract application on an `ha` service fails its first `migrate`.
- **ClamAV in the runtime container** (`:1143`). Measured locally only (`clamav/clamav:1.4`: 11 s and 0.99 GB
  resident for 21 small files). Not measured: that Alpine's `clamav` installs in `run.prepareCommands`, that
  `freshclam` reaches its mirror from the build and the runtime (`packages/provider-zerops/src/execution.ts:48`,
  `:314`), and the peak memory behind `ZEROPS_SCAN_MIN_RAM_GB = 2` (`execution.ts:44`). The facts table has no row
  for any of them.

One consequence is certain from the code: an application whose schema `app_<id>` was created before WU12 is owned by
`db`, and `provisionPostgresRoles` refuses it ("predates the application's database roles and is not adopted",
`application-postgres-roles.ts:119`). The Notes example deployed on a live installation before WU12 needs the
schema and every object in it given to `app_<id>`, by hand, before its next deploy migrates. No runbook says how.

## Approach / acceptance

- On a project with a `postgresql:ha@18` service: deploy a contract application and record whether its migration
  and runtime roles connect on the direct port; turn the row into a measured row (or a `live: 'build'` probe) and
  rewrite the UNVERIFIED section with the result.
- Deploy an application with a `scan: true` collection: record the install, `freshclam` from the build and the
  runtime, a clean and an EICAR upload through the scan job, and the container's peak memory; add rows for them and
  adjust `ZEROPS_SCAN_MIN_RAM_GB` to the measurement.
- Decide the pre-WU12 schema: a documented one-time repair (the `ALTER … OWNER TO app_<id>` statements per object,
  run as the service's superuser), or adoption in `provisionPostgresRoles` for a schema `db` owns. Apply it to the
  live Notes example and record it in the reference.

## Touch points

`docs/reference/zerops-platform.md`, `packages/provider-zerops/src/__tests__/platform-facts.ts`,
`packages/provider-zerops/src/execution.ts`, `packages/platform-node/src/application-postgres-roles.ts`.

<!-- Origin: the paved-road sprints, WU12 (paved-road core) and WU17 run logs. The balancer's client address is
     backlog 05's open question. -->
