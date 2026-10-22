---
id: 211
title: Follow-ups of the Zerops presets review
blocked-by: []
---

# 211 — Follow-ups of the Zerops presets review

**Summary.** Minor findings of the review of the `operationsdb` split, the hourly `db` backups, the namespace adoption
refusal and IAM's proxy proof, left out of that change.

## Problem

- **The adoption refusal covers provision and reconcile only.** `republishNamespace`
  (`packages/provider-zerops/src/namespace/provisioning.ts`) and `applyProfile` (`namespace/update.ts`) do not compare
  the target project with `FABRIKA_ZEROPS_PLATFORM_PROJECT_ID`. Only a namespace that adopted the installation's project
  before the refusal existed reaches them, and its next republish rebuilds the platform proxy with its own manifest.
- **The backup live row proves only "read back as sent".** `postgres-backup-period-round-trips`
  (`packages/provider-zerops/src/__tests__/platform-facts.live.test.ts`) passes even if a fresh service reads a degenerate
  retention. It should assert that a fresh service has no `retentionPolicy` of its own and that what was sent equals
  `defaultRetentionPolicy`, and record how hourly backups are tagged.
- **The hourly schedule may shorten the restore history.** If every automatic backup is tagged `daily`, `maxDaily` counts
  hours. Once the live row has measured the tagging and the default retention, decide whether the step raises `maxDaily`
  or uses a coarser period (`docs/reference/zerops-platform.md`).
- **The hourly schedule also reaches `standard`.** `deploy.ts` gates the step on an `operationsdb` service, which
  `standard` always has, so its HA `db` turns hourly on upgrade before the live row has measured tagging, retention and
  whether a `backup-config` write restarts the database.
- **Sending the default retention freezes it.** A service without its own `retentionPolicy` gets a copy of
  `defaultRetentionPolicy` as its own, and a later change of Zerops' default no longer reaches it.
- **A normalised read-back later reads as a chosen schedule.** If Zerops stores `0 * * * *` in another form, the first
  deploy warns `unconfirmed` and every later one logs "a schedule someone chose".
- **The shared-`db` test reads the wrong signal.** It tests that an `operationsdb` service exists, not that Operations'
  `FABRIKA_OPERATIONS_DATABASE_URL` names it.
- **The API still accepts an HA type without a profile.** The CLI pairs `--postgres-type` and `--postgres-profile`;
  the namespace codec does not, so an API caller still gets the ~$72 `oltp-production` default.
- **Console admin actions lose the proxy's request id.** Control forwards `/iam/admin/*` to `iam:3000` without the IAM
  proxy secret, so the audit rows get a generated id. Giving Control the secret widens who holds it.

## Approach / acceptance

- `republishNamespace` and `applyProfile` refuse the installation's project through the same helper as provision.
- The live row asserts the fresh-service retention and prints the backup tags; the step's period and retention are set
  from its result, and the UNVERIFIED notes become facts or stay marked.
- A decision on the admin hop's request id, recorded in ADR-0022.

## Touch points

`packages/provider-zerops/src/namespace/{provisioning,update}.ts`, `packages/provider-zerops/src/installation/deploy.ts`,
`packages/provider-zerops/src/__tests__/platform-facts.live.test.ts`, `packages/control` (admin hop),
`docs/reference/zerops-platform.md`, ADR-0022.
