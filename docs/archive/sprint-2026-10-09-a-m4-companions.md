> **OUTCOME — shipped 2026-10-09.** What an application needs beside its endpoints and tables: file collections with
> two-phase uploads, the owner's chain on every operation and the file treatment on every answer (A14); `c.cron` jobs
> under a fenced lease with database-clock deadlines and fixed failure codes (A15); read-only connectors with
> `ctx.connect` bound to the request and answers validated against a frozen vendored snapshot (A16); one agent skill
> source for the builder, the MCP server (`get_app_rules`) and the template's `AGENTS.md` (A17a); both examples on the
> contract and the local stack's Notes deployed as a contract application (A17b); and an opice scenario in which an
> agent adds an endpoint and a table and the approval shows only what it adds (A17c). F1 (Zerops storage references)
> and F2 (one `Date` binding) landed here; F3 and F4 moved to B-M3. Commit map: see the table below. Every work unit
> had an independent review and one or two fix rounds. Verification: full `bun run test` with Postgres, S3 and Caddy at
> the A17c merge (6311 pass, 38 skip — live Zerops only, 0 fail); `bun run local:reset && bun run local:smoke` passed
> (run `01a12125`) and the scenario passed on a freshly reset browser stack. Deferred: successful job runs in Operations
> (backlog 96); presigned downloads; per-edge quotas.

# Sprint — A-M4: companions (2026-10-09)

**Goal.** Files, cron, read-only connectors, the skill and the template: A14–A17 of the
[implementation plan](../ideas/app-framework-implementation-plan.md).

**Theme.** What an application needs beside its endpoints and tables. Run by the
[orchestration](../ideas/app-framework-orchestration.md).

## Refs re-verified at HEAD (2026-10-09)

Each work unit re-verifies the plan's facts it depends on before coding.

## Work units

| WU   | State                 | Commits / note        |
| ---- | --------------------- | --------------------- |
| A14  | landed                | `98fc2218`…`3c1e16b4` |
| A15  | landed                | `32918fd1`…`3e327a63` |
| A16  | landed                | `60ef8fbd`…`ffa5445e` |
| A17a | landed                | `ede3df0b`…`843b9e5d` |
| A17b | landed                | `2b4587dc`…`de45be72` |
| A17c | landed                | `e44df02e`…`44195ad4` |
| F1   | landed                | `e0dad6a2`            |
| F2   | landed                | `496aeb79`            |
| F3   | moved to B-M3, landed | see B-M3              |
| F4   | moved to B-M3 (B9b)   | see B-M3              |

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
- 2026-10-09: A16 landed after one fix round: `ctx.connect` is bound to the live request; the description requires
  the export's own action; answers are bounded, unredirected, JSON-only and validated against a frozen snapshot;
  diagnostics never carry response text.
- 2026-10-09: A17a landed: one skill source (`packages/app/skill/SKILL.md`) for the builder, the MCP server
  (`get_app_rules`, instructions under 2 KB) and the template's `AGENTS.md`.
- 2026-10-09: F1 landed: `FABRIKA_APP_STORAGE_*` are run-section references to the app's one object-storage service.
- 2026-10-09: A17b landed after one fix round: the pinned fixture is the complete example and passes the production
  build checks; the smoke checks the proxy secret, bucket provenance and storage references; file-collection endpoints
  get generated cross-scope cases.
- 2026-10-09: A17c landed: the `notes-agent-change` seed parks an agent commit; the scenario approves it in the console.
  It also fixed the browser seed's Operations calls after B10f moved admission to the proxy.
