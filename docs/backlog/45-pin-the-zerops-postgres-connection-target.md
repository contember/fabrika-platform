---
id: 45
title: Pin the Zerops Postgres connection target
blocked-by: []
---

# 45 — Pin the Zerops Postgres connection target

**Summary.** Every Zerops service connects with a bare
`${host_connectionString}`. That value carries no database path and no TLS mode, so
both are decided by driver defaults rather than by us. Today they happen to land on
the right answer.

## Problem

Upstream records, verified live on `postgresql:single@18`, that `connectionString`
is exactly `postgresql://db:<password>@db:5432` — **no trailing `/db`** — and advises
appending `/${host_dbName}` where the driver needs the database in the URL.

Fabrika passes the value straight through:

- `FABRIKA_IAM_DATABASE_URL: ${db_connectionString}`,
  `FABRIKA_CONTROL_DATABASE_URL: ${db_connectionString}`,
  `FABRIKA_OPERATIONS_DATABASE_URL: ${operationsdb_connectionString}`
  ([`../../packages/installation-zerops/zerops/setups.ts`](../../packages/installation-zerops/zerops/setups.ts))
- `NOTES_DATABASE_URL: ${notesdb_connectionString}` (`examples/zerops-app/zerops.yaml`)

and hands it to `new SQL(url)`. With no database in the URL, the libpq/postgres.js
convention is to fall back to the **user name**. Zerops generates both as `db` by
default, so every connection currently reaches the intended database by coincidence
rather than by declaration. Anything that changes either default — a renamed user, a
future version, a database created by hand — silently redirects every connection.

The second half is TLS. Port 5432 is **plaintext only**: upstream states that
requesting TLS there fails the handshake, and that 6432 is the pgBouncer pooler where
TLS is required. We deliberately use 5432 because the migration lock is session-level
and transaction pooling would break it — that reasoning is correct and stays. But
nothing pins `sslmode=disable`, so the connection mode is whatever the Bun client
defaults to, on a port that cannot negotiate.

## Approach / acceptance

- Append the database name explicitly — `${host_connectionString}/${host_dbName}` —
  or construct the URL from the component variables, whichever reads better next to
  the existing commentary.
- Pin the SSL mode for the 5432 path explicitly rather than inheriting a driver
  default.
- Apply the same treatment to the example app and the shared-Postgres variant, since
  those are the copied templates.
- Confirm on a live account what `connectionString`, `user` and `dbName` actually
  hold for a service **not** named `db` — that is the case the current coincidence
  hides — and record it in [`../reference/zerops-platform.md`](../reference/zerops-platform.md).
- Acceptance: no runtime depends on a driver's database-name fallback; a connection
  test proves the process reaches the intended database on a service whose hostname
  is not `db`.

## Touch points

- `packages/installation-zerops/zerops/setups.ts` and the generated root `zerops.yaml`
- `examples/zerops-app/zerops.yaml`, `examples/zerops-app/zerops.shared-postgres.yaml`
- `packages/provider-zerops/src/namespace.ts` (`ZEROPS_SHARED_POSTGRES_CONNECTION_STRING`)
- `packages/platform-node/src/sql-postgres.ts`

<!-- Origin: Zerops skill conformance review, 2026-07-31. -->
