# Sprint — A-M4: companions (2026-10-09)

**Goal.** Files, cron, read-only connectors, the skill and the template: A14–A17 of the
[implementation plan](../ideas/app-framework-implementation-plan.md).

**Theme.** What an application needs beside its endpoints and tables. Run by the
[orchestration](../ideas/app-framework-orchestration.md).

## Refs re-verified at HEAD (2026-10-09)

Each work unit re-verifies the plan's facts it depends on before coding.

## Work units

| WU  | State                  | Commits / note                                                 |
| --- | ---------------------- | -------------------------------------------------------------- |
| A14 | landed                 | `98fc2218`…`3c1e16b4`                                          |
| A15 | in review fixes        |                                                                |
| A16 | in review              |                                                                |
| A17 | queued (after A14–A16) |                                                                |
| F1  | queued                 | provider-zerops writes `FABRIKA_APP_STORAGE_*`                 |
| F2  | queued                 | `@fabrika/db` binds a `Date` as ISO text in one place          |
| F3  | queued                 | Zerops IAM membership transport for applications               |
| F4  | queued                 | provider-cloudflare generates the consumer's connector binding |

## Out of scope (explicit)

Presigned downloads; per-binding jobs; per-edge quotas; successful job runs in Operations (ingest is error-only).

## Decisions

- H8 (integrator): a Cloudflare consumer reaches the owner's proxy Worker through a service binding; a Zerops consumer
  reaches the owner's public proxy with `Authorization: Bearer <edge key>` (unverified on a real account until the
  live row runs); no per-edge quotas in v1.
- A14: uploads are two-phase (`pending` row first, object key from its id, `live` under the owner's chain lock);
  `Range` requests get the whole file.
- A15: job reports to Operations carry DSN-level trust until B9 gives the job a workload credential.
- F3: a narrow IAM app surface (`members.*`, `invitations.*`, `links.*` for the caller's own `<app>@<env>`) with a
  per-environment key from Control; provider-zerops writes `FABRIKA_IAM_RPC_URL` and the key.

## Sequencing

A14 ∥ A15 ∥ A16 → A17; F1–F4 after their parents land.

## Run log

- 2026-10-09: A14 landed after one fix round: every file operation carries the capability's whole chain; download
  error answers keep the file treatment; the pending row is the cleanup intent the sweep retries.
- 2026-10-09: A15 landed after one fix round: lease times use the database clock; a write re-checks the attempt's
  deadline before `COMMIT` and in-flight statements are cancelled; failures are fixed codes; the serving process
  reports overdue jobs once per period. Successful runs → backlog 96.
- 2026-10-09: F2 landed: `@fabrika/db` binds a `Date` as ISO 8601 UTC text in its compiler; an invalid Date is refused.
