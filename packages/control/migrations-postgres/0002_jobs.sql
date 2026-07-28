-- The deploy QUEUE, as a table — POSTGRES ONLY, with no counterpart in `../migrations/`.
--
-- On Cloudflare the queue is a platform primitive: a `Queue` binding produces and the runtime delivers
-- to the Worker's `queue()` handler, so there is no schema. Off Cloudflare there is a process to poll
-- with, and the whole primitive collapses to a table of due work plus
-- `SELECT … FOR UPDATE SKIP LOCKED`. That is why this file exists on one side only.
--
-- OWNERSHIP. The statements over this table live in `@fabrika/platform-node`'s `PostgresJobQueue`, and
-- the reference DDL is that package's `migrations/0001_jobs.sql`. It is restated here rather than
-- imported because DDL is per-SERVICE — a service applies the schema its own runner owns, and
-- `PostgresJobQueue` is parameterised by table name precisely so two services can each have their own.
-- Keep the two in step: column names and TYPES are the contract, and
-- `src/__tests__/postgres-schema.test.ts` pins the types that decide the row shape.
--
-- Delivery is VISIBILITY-based, like SQS and Cloudflare Queues: a claim pushes `visible_at` into the
-- future and bumps `attempts`; a completed job deletes its row; a consumer that dies simply lets the
-- timeout lapse and the job becomes claimable again. There is no lock column because a lock that
-- outlives its holder is the bug the visibility timeout exists to prevent.
--
-- TYPES. `visible_at` and `created_at` are unix MILLISECONDS and therefore BIGINT — int4 cannot hold a
-- millisecond epoch. Neither is ever read into JS (Bun would decode a BIGINT as a string); both are
-- only ever compared inside SQL. `attempts`/`max_attempts` are INTEGER precisely so they DO come back
-- as numbers — `ClaimedRow` types them `number`.
CREATE TABLE IF NOT EXISTS jobs (
	id           TEXT PRIMARY KEY,   -- UUIDv7, minted caller-side (time-ordered)
	queue        TEXT NOT NULL,      -- queue name, so several queues share one table
	payload      TEXT NOT NULL,      -- the JSON-serialized message (a DeployJobMessage)
	visible_at   BIGINT NOT NULL,    -- unix MILLIS: claimable once now >= this (delay + visibility timeout)
	attempts     INTEGER NOT NULL,   -- claims consumed so far
	max_attempts INTEGER NOT NULL,   -- claims allowed before the job is abandoned
	created_at   BIGINT NOT NULL     -- unix MILLIS, enqueued
);

-- The claim's access path: due rows of one queue, oldest first. `id` tie-breaks so the order is total
-- and two consumers scan in the same sequence (which is what makes SKIP LOCKED skip cheaply).
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(queue, visible_at, id);
