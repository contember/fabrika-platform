-- Job queue — the table behind `PostgresJobQueue` (src/job-queue-postgres.ts).
--
-- On Workers a queue exists because there is no process to poll with. A long-running process has one,
-- so the whole primitive collapses to a table of due work plus `SELECT … FOR UPDATE SKIP LOCKED`.
--
-- Delivery is VISIBILITY-based, like SQS and Cloudflare Queues: a claim pushes `visible_at` into the
-- future and bumps `attempts`; a completed job deletes its row; a consumer that dies simply lets the
-- timeout lapse and the job becomes claimable again. There is no separate lock column because a lock
-- that outlives its holder is the bug the visibility timeout exists to prevent.
--
-- DIALECT. This DDL is in the SQLite ∩ Postgres common subset — no AUTOINCREMENT, no SERIAL, no
-- `unixepoch()`/`now()` default (ids and timestamps are stamped caller-side, per the repo convention),
-- no partial index. It applies unchanged to both. The Postgres-specific part of this feature is the
-- CLAIM STATEMENT, not the schema: `FOR UPDATE SKIP LOCKED` has no SQLite equivalent, which is fine —
-- SQLite has no concurrent writers to skip.
--
-- TYPE NOTE (this bites on Postgres only). Bun's Postgres client decodes `BIGINT` as a STRING, never a
-- number. The millisecond columns below are therefore BIGINT and are never read back into JS — every
-- comparison against them happens inside SQL. `attempts`/`max_attempts` are INTEGER (int4) precisely
-- so they DO come back as numbers.
CREATE TABLE IF NOT EXISTS jobs (
	id           TEXT PRIMARY KEY,   -- UUIDv7, minted caller-side (time-ordered)
	queue        TEXT NOT NULL,      -- queue name, so several queues share one table
	payload      TEXT NOT NULL,      -- the JSON-serialized message
	visible_at   BIGINT NOT NULL,    -- unix MILLIS: claimable once now >= this (delay + visibility timeout)
	attempts     INTEGER NOT NULL,   -- claims consumed so far
	max_attempts INTEGER NOT NULL,   -- claims allowed before the job is abandoned
	created_at   BIGINT NOT NULL     -- unix MILLIS, enqueued
);

-- The claim's access path: due rows of one queue, oldest first. `id` tie-breaks so the order is total
-- and two consumers scan in the same sequence (which is what makes SKIP LOCKED skip cheaply).
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(queue, visible_at, id);
