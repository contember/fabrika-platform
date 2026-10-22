---
id: 212
title: The console shows no database backups
blocked-by: []
---

# 212 — The console shows no database backups

**Summary.** Fabrika relies on the provider's own backups and shows none of them. An operator learns whether `db`,
`operationsdb` or a namespace's database was backed up, and how far back its restore points reach, only in the Zerops
GUI.

## Problem

- Zerops backs every PostgreSQL service up on its own schedule (daily by default; `db` hourly since `platform deploy`
  sets it, `docs/reference/zerops-platform.md`). Restore is manual: download in the GUI, then `pg_restore` per schema.
- Nothing in Fabrika reads the backups. `platform deploy` logs the schedule it set, not whether a backup ran.
- Failures are silent: a backup that would exceed the project's backup storage is not stored, and the retention may
  keep only about two days of hourly dumps (backlog [211](211-zerops-preset-review-follow-ups.md)).
- Object storage (Operations' bucket, applications' buckets) is not covered by Zerops backups at all.

## Approach / acceptance

- A provider-owned read, through `@fabrika/provider-contract`, of each managed database's backups: schedule, retention,
  the newest backup's time and size, the count and the oldest restore point. Zerops answers it from
  `GET /service-stack/{id}/backup` (`getBackupConfig` reads the same response without its `files`).
- Control serves it for the installation's databases and each namespace's shared database; the console shows it and
  marks a database whose newest backup is older than its schedule allows.
- The view names what is not backed up (object storage) instead of omitting it.
- Optional: an Operations alert when a database misses its schedule.

## Touch points

`packages/provider-zerops/src/api/{client,types,readers}.ts`, `packages/provider-contract`, `packages/control`,
`packages/dashboard`, `docs/reference/zerops-platform.md`.
