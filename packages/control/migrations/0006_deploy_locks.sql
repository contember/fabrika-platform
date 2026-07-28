-- Deploy locks — the per-(app, env) mutual exclusion that used to be the `DeployLock` Durable Object.
--
-- Two concurrent triggers for one target (a push + the manual button, or two quick pushes) race on
-- oblaka's `cf-state` KV, `wrangler deploy`, and the propustka reconcile, so a deploy of `<app>:<env>`
-- holds a lease for the duration. A DO gave that for free on Cloudflare and nowhere else; one row per
-- lease gives the same three guarantees on SQLite and Postgres alike (src/deploy-locks.ts):
--   * NON-REENTRANT — a live lease is refused even to its own holder, so a redelivered queue message
--     defers instead of double-running;
--   * TTL-BOUNDED   — a consumer that dies mid-deploy never releases, so the lease carries the wall
--     clock at which it stops being honored and the next run takes it over (self-heal);
--   * HOLDER-CHECKED release — only the run named in `holder` can clear the row, so a late release
--     from a superseded run can never free a lease a newer run has since taken.
--
-- The row is the WHOLE lock: acquire is one conditional upsert (`ON CONFLICT … DO UPDATE … WHERE
-- expires_at <= ?`) whose `changes` count is the answer, so there is no read-then-write window for two
-- consumers to slip through. A released lease deletes its row — a MISSING row means free, and a
-- present row with `expires_at` in the past means expired-and-takeable. Rows are transient: nothing
-- reads them for history, and the sole writer is the queue consumer.
--
-- Common-subset SQL only (no AUTOINCREMENT, no `unixepoch()` default): `expires_at` is stamped by the
-- caller in unix MILLISECONDS — the TTL is a `Date.now()`-based deadline, not a creation timestamp, so
-- it does NOT follow the seconds convention the `*_at` columns elsewhere in this schema use. It is
-- spelled BIGINT, not INTEGER, because a millisecond epoch (~1.8e12) overflows Postgres' 32-bit
-- `INTEGER`; SQLite gives INTEGER affinity to both spellings, so the one DDL is correct on either.
CREATE TABLE deploy_locks (
	lock_key   TEXT PRIMARY KEY,  -- the lease target, `<app_id>:<env>`
	holder     TEXT NOT NULL,     -- the run id holding the lease; release is checked against it
	expires_at BIGINT NOT NULL    -- unix MILLISECONDS after which the lease is stale and takeable
);
