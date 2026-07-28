// `DeployLocks` as ONE row per lease — the Durable Object's three guarantees expressed as properties
// of a STATEMENT rather than of Cloudflare's single-threaded object, so the same code serves SQLite,
// D1 and Postgres.
//
// It lives in `@fabrika/platform` (with the ports, not with either runtime) because it depends on
// NOTHING but the `SqlDatabase` port: no `cloudflare:workers`, no `bun:*`, no `node:*`, no I/O
// primitive of its own. That makes it runtime-neutral by construction, which is why the control-plane
// Worker and a long-running Bun process can share ONE copy instead of keeping two that drift.
//
// The contract (verbatim from the port):
//   * NON-REENTRANT — a live lease is refused even to its own holder, so a redelivered message defers
//     instead of double-running.
//   * TTL-BOUNDED — a consumer that dies mid-deploy never releases; the stored deadline is what lets
//     the next run take over instead of the target being wedged forever.
//   * HOLDER-CHECKED release — a late release from a superseded run cannot free a newer run's lease.
//
// `acquire` is ONE conditional upsert and NEVER a read-then-write. Two consumers racing for a free
// target cannot both observe "free": one inserts, the other conflicts onto the live row and its
// DO UPDATE is skipped by the `expires_at <= ?` guard. `meta.changes` is the whole answer — 1 means
// the lease is ours, 0 means someone else holds it. Splitting this into a SELECT and an UPDATE
// reintroduces exactly the race the DO existed to prevent.
//
// GENERIC ON PURPOSE: the table name is a parameter so a control plane that already owns a
// `deploy_locks` table and a second service that wants its own lease table share one implementation.
// The DDL is per-dialect and therefore NOT here — see `@fabrika/control`'s migrations (SQLite/D1) and
// `@fabrika/platform-node`'s `migrations/0002_deploy_locks.sql` (Postgres).

import type { DeployLocks } from './ports'
import type { SqlDatabase } from './sql'

export interface SqlDeployLocksOptions {
	/** Table holding the leases. Must already exist; the DDL is the owning service's migration. */
	table?: string
	/** Injectable clock so lease expiry is testable without sleeping. */
	now?: () => number
}

/** The default lease table, matching the `deploy_locks` table both current consumers migrate. */
const DEFAULT_TABLE = 'deploy_locks'
/** A table name is interpolated into SQL, so it is restricted to a bare unqualified identifier. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

export class SqlDeployLocks implements DeployLocks {
	private readonly acquireSql: string
	private readonly releaseSql: string
	private readonly now: () => number

	constructor(private readonly db: SqlDatabase, options: SqlDeployLocksOptions = {}) {
		const table = options.table ?? DEFAULT_TABLE
		if (!IDENTIFIER.test(table)) {
			throw new Error(`invalid lock table name: ${table}`)
		}
		this.now = options.now ?? Date.now
		this.acquireSql = `INSERT INTO ${table} (lock_key, holder, expires_at) VALUES (?, ?, ?)
			ON CONFLICT (lock_key) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
			WHERE ${table}.expires_at <= ?`
		this.releaseSql = `DELETE FROM ${table} WHERE lock_key = ? AND holder = ?`
	}

	async acquire(key: string, holder: string, ttlMs: number): Promise<boolean> {
		const now = this.now()
		const result = await this.db.prepare(this.acquireSql).bind(key, holder, now + ttlMs, now).run()
		return (result.meta.changes ?? 0) > 0
	}

	async release(key: string, holder: string): Promise<void> {
		// Deleting the row is what "free" means. The holder predicate makes this a no-op for a run whose
		// lease already expired and was taken over — it cannot delete the newer holder's row.
		await this.db.prepare(this.releaseSql).bind(key, holder).run()
	}
}
