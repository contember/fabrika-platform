---
id: 116
title: Verify the paved-road sprint's Zerops facts on a real account
blocked-by: []
---

# 116 — Verify the paved-road sprint's Zerops facts on a real account

**Summary.** The per-application database roles (WU12) on an HA service and part of the malware scan (WU17) rest on
Zerops behaviour nobody has measured. One live sitting. Effort: S–M.

## Problem

`docs/reference/zerops-platform.md` records these as not measured:

- **A new role on the direct port of `postgresql:ha@18`**. `FABRIKA_APP_DATABASE_URL` is the service's superuser on
  the direct port with `sslmode=disable` (measured on `postgresql:single@18`, 2026-10-15). Whether a role fabrika
  creates logs in on that port of an `ha` service is the `not-probed` row `unverified-postgres-ha-new-role-on-direct-port`.
  If it does not, a contract application on an `ha` service fails its first `migrate`.
- **ClamAV in the runtime container**
  ([section](../reference/zerops-platform.md#partly-verified-clamav-in-a-scanning-applications-runtime-container)). A production installation shows that `clamav` installs in
  `run.prepareCommands` and that the runtime's `freshclam` reaches its mirror. Not measured: `freshclam` from the build
  (`packages/provider-zerops/src/execution.ts`), a scan job's run, and the peak memory behind
  `ZEROPS_SCAN_MIN_RAM_GB = 2` (same file; measured locally only, `clamav/clamav:1.4`: 11 s and 0.99 GB resident for 21
  small files). The facts table has no row for any of them.

## Approach / acceptance

- On a project with a `postgresql:ha@18` service: deploy a contract application and record whether its migration
  and runtime roles connect on the direct port; turn the row into a measured row (or a `live: 'build'` probe) and
  rewrite the UNVERIFIED section with the result.
- Deploy an application with a `scan: true` collection: record `freshclam` from the build, a clean and an EICAR
  upload through the scan job, and the container's peak memory; add rows for them and adjust
  `ZEROPS_SCAN_MIN_RAM_GB` to the measurement.

## Touch points

`docs/reference/zerops-platform.md`, `packages/provider-zerops/src/__tests__/platform-facts.ts`,
`packages/provider-zerops/src/execution.ts`.

<!-- Origin: the paved-road sprints, WU12 (paved-road core) and WU17 run logs. The balancer's client address is
     backlog 05's open question. -->
