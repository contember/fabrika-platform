# Portability surface

Where fabrika touches Cloudflare, and what each touch point becomes when the
control plane has to run somewhere else. The left column is the current code; the
right column is decided (see the linked ADR / backlog item) but, except where
noted, **not yet built** — the repo is Cloudflare-only today.

## Control plane — port inventory

| Cloudflare primitive        | Portable answer                                                                       | Notes                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1                          | Postgres, behind a `Db` port                                                          | See the dialect assessment below.                                                                                                                     |
| Cloudflare Queues           | A Postgres job table with `SELECT … FOR UPDATE SKIP LOCKED` plus an in-process poller | On a long-running process the queue is unnecessary _in the Workers sense_ — the reason Workers need a queue (no process to poll with) does not apply. |
| `DeployLock` Durable Object | A TTL-bounded conditional `UPDATE` on a DB row                                        | Works identically on SQLite and Postgres, so the DO is deleted on **both** platforms — this is the one port that simplifies Cloudflare too.           |
| R2                          | S3-compatible object storage, behind a `Blob` port                                    | R2 is S3-compatible and Zerops object storage is MinIO, so **one** implementation covers both.                                                        |
| Service bindings            | HTTP                                                                                  |                                                                                                                                                       |
| `ASSETS` binding            | Static file serving                                                                   |                                                                                                                                                       |
| `scheduled` handler         | Platform cron                                                                         |                                                                                                                                                       |
| `waitUntil`                 | A `waitUntil` port                                                                    | Trivial on a long-running process; the seam exists so call sites don't branch.                                                                        |

The ports to extract are `Db`, `Blob`, `Lock`, `Queue`, `Assets`, `Cron`,
`waitUntil` —
[`../backlog/01-phase-1-platform-ports.md`](../backlog/01-phase-1-platform-ports.md).

## Deploy layers — how portable each one actually is

From the per-layer analysis behind
[ADR-0002](../decisions/0002-deploy-driver-owns-the-plan.md):

| Layer            | Portability       | Why                                                                                                                                |
| ---------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Secrets push     | **Portable**      | Same operation everywhere: put a value where the platform will inject it.                                                          |
| Schema reconcile | **Portable**      | Talks to the IAM service, not to the cloud.                                                                                        |
| Provisioning     | **Semi-portable** | The concepts map (a database is a database); the vocabularies do not. Needs a per-provider translation, not a per-provider design. |
| Build            | **Per-provider**  | Cloudflare builds in a fabrika-controlled container; Zerops builds it itself.                                                      |
| Artifact deploy  | **Per-provider**  | `wrangler deploy` vs an `/app-version` API call — and on Zerops build and deploy are one indivisible platform-side step.           |
| Migrations       | **Per-provider**  | A discrete plan step on Cloudflare; `run.initCommands` at container start on Zerops.                                               |

## IAM (`@fabrika/iam`) — port assessment

propustka's Cloudflare coupling is unusually narrow: of roughly **7,900 lines**,
only `env.ts`, `index.ts`, `db.ts` and the test harness are platform-specific.

- **HTTP layer — already portable.** It is written fetch-style
  (`Request → Response`), which both Bun and Node accept natively. No work beyond
  the entrypoint.
- **`db.ts` — the real work.** ~883 lines against the D1 prepared-statement API:
  57 `prepare()`, 55 `bind()`, 15 `run()`, 2 `batch()`.
- **Leading approach:** a thin adapter presenting a D1-shaped interface over
  Postgres. Mechanical `?` → `$n` rewriting; SQL kept to a common subset — both
  dialects support `ON CONFLICT` and `RETURNING`, and timestamps are already
  generated caller-side, so the usual `CURRENT_TIMESTAMP` divergence doesn't arise.
- **The cost is migrations, not queries.** The query surface is mechanical; the
  migration files are where SQLite and Postgres genuinely differ.
- **Alternative — Kysely.** A real option, but it justifies itself mainly if a
  _third_ backend is ever expected. For two, the adapter is less machinery.

Sequencing note that matters:
[`../backlog/02-phase-2-node-bun-and-postgres.md`](../backlog/02-phase-2-node-bun-and-postgres.md)
ports the **test harness first**, before any production code, so dialect bugs
surface against real tests instead of against production traffic.
