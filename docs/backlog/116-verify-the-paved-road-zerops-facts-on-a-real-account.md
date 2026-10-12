---
id: 116
title: Verify the paved-road sprint's Zerops facts on a real account
blocked-by: []
---

# 116 — Verify the paved-road sprint's Zerops facts on a real account

**Summary.** The per-application database roles (WU12) and the malware scan (WU17) rest on Zerops behaviour nobody
has measured, and an application deployed before WU12 cannot migrate without a manual step. One live sitting.
Effort: S–M.

## Problem

`docs/reference/zerops-platform.md` records these as UNVERIFIED:

- **Role creation by the service's own user** (`:1157`). `fabrika db migrate` uses `FABRIKA_APP_DATABASE_URL`, the
  PostgreSQL service's `db` user, as the provisioning credential: it must be a superuser or hold `CREATEROLE`, and
  grant `CREATE` on the database (`packages/platform-node/src/application-postgres-roles.ts:93`). A new login role
  must also authenticate on `portTls` (6432). Both are `not-probed` rows of the platform-facts table
  (`packages/provider-zerops/src/__tests__/platform-facts.ts:1088`). If the first is false, every contract
  application's first deploy fails in `migrate`.
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

- On a light-tier project with a PostgreSQL service: deploy a contract application and record whether
  `fabrika db migrate` creates the role family and the runtime role connects on `portTls`; turn both rows into
  measured rows (or `live: 'build'` probes) and rewrite the UNVERIFIED section with the result.
- Deploy an application with a `scan: true` collection: record the install, `freshclam` from the build and the
  runtime, a clean and an EICAR upload through the scan job, and the container's peak memory; add rows for them and
  adjust `ZEROPS_SCAN_MIN_RAM_GB` to the measurement.
- Decide the pre-WU12 schema: a documented one-time repair (the `ALTER … OWNER TO app_<id>` statements per object,
  run as `db`), or adoption in `provisionPostgresRoles` for a schema `db` owns. Apply it to the live Notes example
  and record it in the reference.
- If `db` cannot create roles, stop and decide before any workaround: the platform does not hand an application a
  superuser (`zerops-platform.md:1171`–`:1172`).

## Touch points

`docs/reference/zerops-platform.md`, `packages/provider-zerops/src/__tests__/platform-facts.ts`,
`packages/provider-zerops/src/execution.ts`, `packages/platform-node/src/application-postgres-roles.ts`.

<!-- Origin: the paved-road sprints, WU12 (paved-road core) and WU17 run logs. The balancer's client address is
     backlog 05's open question. -->
