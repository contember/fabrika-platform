-- Deploy locks — the table behind `SqlDeployLocks` (src/deploy-locks-sql.ts).
--
-- One row per lease. The row IS the lock: acquire is a single conditional upsert whose `changes` count
-- is the answer, so there is no read-then-write window for two consumers to slip through. A MISSING
-- row means free; a present row whose `expires_at` is in the past means expired-and-takeable; a
-- release deletes the row, but only when the caller is still the named holder.
--
-- `SqlDeployLocks` is parameterised by table name, so a service that wants a second, independent lease
-- namespace applies this DDL under a different name rather than getting a second implementation.
--
-- DIALECT. Common subset — no defaults, no generated columns, no partial index; applies unchanged to
-- SQLite and Postgres.
--
-- TYPE NOTE (this bites on Postgres only). `expires_at` is a `Date.now()`-based DEADLINE in unix
-- MILLISECONDS, not a creation timestamp, so it does NOT follow the unix-seconds convention the `*_at`
-- columns elsewhere in this codebase use. It must be BIGINT: Postgres `INTEGER` is int4, which tops
-- out at 2147483647 and cannot hold a millisecond epoch at all (SQLite's INTEGER is 64-bit, so the
-- same DDL survives there and the overflow only appears after the port). Nothing reads the column into
-- JS — Bun would decode a BIGINT as a string — every comparison stays inside SQL.
CREATE TABLE IF NOT EXISTS deploy_locks (
	lock_key   TEXT PRIMARY KEY,  -- the lease target, e.g. `<app_id>:<env>`
	holder     TEXT NOT NULL,     -- the run id holding the lease; release is checked against it
	expires_at BIGINT NOT NULL    -- unix MILLIS after which the lease is stale and takeable
);
