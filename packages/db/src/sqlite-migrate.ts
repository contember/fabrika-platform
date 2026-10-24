// @fabrika/db/sqlite-migrate — applies the framework's and the application's migrations to an application's SQLite
// database when its Durable Object boots (ADR-0065), in a ledger in the same database. The identity and the
// checksum rule are the Postgres runner's (ADR-0017): `(bundle, name)`, and the SHA-256 of an applied file's text.
// Every new object instance runs it, so a bundle whose files match the digest recorded for it is not read further.
// Runs inside a Worker: no Bun import.

/** What the runner needs of the database; a Durable Object's `storage.sql.exec` and `storage.transactionSync` fit it. */
export interface SqliteMigrationTarget {
	/** Runs `query`, which may hold several statements, and answers the rows of the last one. */
	exec(query: string, ...bindings: (string | number | null)[]): { toArray(): Record<string, unknown>[] }
	/** Runs `fn` in one transaction: commits when it returns, rolls back when it throws. */
	transactionSync<T>(fn: () => T): T
}

export interface SqliteMigrationBundle {
	readonly bundle: string
	readonly migrations: readonly { readonly name: string; readonly sql: string }[]
}

export class SqliteMigrationError extends Error {
	override readonly name = 'SqliteMigrationError'
}

const LEDGER = 'fabrika_migrations'
const DIGESTS = 'fabrika_migration_bundles'
const BUNDLE_NAME = /^[a-z][a-z0-9-]*$/
const MIGRATION_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.sql$/

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS ${LEDGER} (
	bundle TEXT NOT NULL,
	name TEXT NOT NULL,
	checksum TEXT NOT NULL,
	applied_at TEXT NOT NULL,
	PRIMARY KEY (bundle, name)
) STRICT`

/** A bundle's digest: the SHA-256 of its ordered file names and checksums, written with the last of its files applied. */
const DIGESTS_DDL = `CREATE TABLE IF NOT EXISTS ${DIGESTS} (
	bundle TEXT PRIMARY KEY,
	digest TEXT NOT NULL
) STRICT`

interface HashedMigration {
	readonly name: string
	readonly sql: string
	readonly checksum: string
}

interface PlannedMigration extends HashedMigration {
	readonly bundle: string
}

interface PlannedBundle {
	readonly bundle: string
	readonly digest: string
	readonly migrations: readonly PlannedMigration[]
}

interface HashedFiles {
	readonly digest: string
	readonly migrations: readonly HashedMigration[]
}

/** The migration arrays are static module values: each is hashed once per isolate. */
const hashedFiles = new WeakMap<SqliteMigrationBundle['migrations'], Promise<HashedFiles>>()

/** The SHA-256 hex of the file's UTF-8 text: the Postgres runner's `migrationChecksum`, so both ledgers agree. */
async function checksumOf(sql: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sql))
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function compareNames(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

/** Refuses a malformed bundle before anything is hashed or run. */
function check(bundles: readonly SqliteMigrationBundle[]): void {
	const bundleNames = new Set<string>()
	for (const bundle of bundles) {
		if (!BUNDLE_NAME.test(bundle.bundle)) throw new SqliteMigrationError(`Invalid SQLite migration bundle name: ${bundle.bundle}`)
		if (bundleNames.has(bundle.bundle)) throw new SqliteMigrationError(`Duplicate SQLite migration bundle ${bundle.bundle}`)
		bundleNames.add(bundle.bundle)
		const names = new Set<string>()
		for (const migration of bundle.migrations) {
			const identity = `${bundle.bundle}/${migration.name}`
			if (!MIGRATION_NAME.test(migration.name)) throw new SqliteMigrationError(`Invalid SQLite migration filename: ${identity}`)
			if (names.has(migration.name)) throw new SqliteMigrationError(`Duplicate SQLite migration ${identity}`)
			if (migration.sql.trim() === '') throw new SqliteMigrationError(`SQLite migration ${identity} is empty`)
			names.add(migration.name)
		}
	}
}

/** A bundle's files in name order with their checksums, and its digest: the SHA-256 of the ordered names and checksums. */
async function hash(files: SqliteMigrationBundle['migrations']): Promise<HashedFiles> {
	const migrations: HashedMigration[] = []
	for (const { name, sql } of [...files].sort((a, b) => compareNames(a.name, b.name))) {
		migrations.push({ name, sql, checksum: await checksumOf(sql) })
	}
	// A filename holds no space or newline, so each line is unambiguous.
	const digest = await checksumOf(migrations.map((migration) => `${migration.name} ${migration.checksum}\n`).join(''))
	return { digest, migrations }
}

/** Each bundle's migrations in name order, the bundles in the order given; refuses a malformed bundle before any SQL runs. */
async function plan(bundles: readonly SqliteMigrationBundle[]): Promise<readonly PlannedBundle[]> {
	check(bundles)
	const planned: PlannedBundle[] = []
	for (const bundle of bundles) {
		let files = hashedFiles.get(bundle.migrations)
		if (files === undefined) {
			files = hash(bundle.migrations)
			hashedFiles.set(bundle.migrations, files)
		}
		const { digest, migrations } = await files
		planned.push({ bundle: bundle.bundle, digest, migrations: migrations.map((migration) => ({ ...migration, bundle: bundle.bundle })) })
	}
	return planned
}

/** The digest recorded for each bundle that has one; empty while the table does not exist, as before its first run. */
function readDigests(target: SqliteMigrationTarget, planned: readonly PlannedBundle[]): Map<string, string> {
	const recorded = new Map<string, string>()
	if (target.exec(`SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?`, DIGESTS).toArray().length === 0) return recorded
	for (const { bundle } of planned) {
		const [row] = target.exec(`SELECT digest FROM ${DIGESTS} WHERE bundle = ?`, bundle).toArray()
		if (row === undefined) continue
		const { digest } = row
		if (typeof digest !== 'string') throw new SqliteMigrationError(`SQLite migration table ${DIGESTS} holds a malformed row`)
		recorded.set(bundle, digest)
	}
	return recorded
}

function recordDigest(target: SqliteMigrationTarget, bundle: PlannedBundle): void {
	target.exec(DIGESTS_DDL)
	target.exec(
		`INSERT INTO ${DIGESTS} (bundle, digest) VALUES (?, ?) ON CONFLICT (bundle) DO UPDATE SET digest = excluded.digest`,
		bundle.bundle,
		bundle.digest,
	)
}

/** Recorded checksums by `bundle/name`; empty while the ledger does not exist, so a fresh database is checked first. */
function readLedger(target: SqliteMigrationTarget): Map<string, string> {
	const present = target.exec(`SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?`, LEDGER).toArray()
	const applied = new Map<string, string>()
	if (present.length === 0) return applied
	for (const row of target.exec(`SELECT bundle, name, checksum FROM ${LEDGER}`).toArray()) {
		const { bundle, name, checksum } = row
		if (typeof bundle !== 'string' || typeof name !== 'string' || typeof checksum !== 'string') {
			throw new SqliteMigrationError(`SQLite migration ledger ${LEDGER} holds a malformed row`)
		}
		applied.set(`${bundle}/${name}`, checksum)
	}
	return applied
}

/**
 * Refuses, before anything is applied: an applied file whose text changed, and a new file that sorts before the last
 * applied one of its bundle, which would run after the files it precedes. A ledger row without a file is the database
 * ahead of the code after a rollback, which is tolerated, as on Postgres.
 */
function verify(planned: readonly PlannedBundle[], applied: ReadonlyMap<string, string>): void {
	for (const { migrations } of planned) {
		let lastApplied: string | undefined
		for (const migration of migrations) {
			const identity = `${migration.bundle}/${migration.name}`
			const recorded = applied.get(identity)
			if (recorded === undefined) continue
			if (recorded !== migration.checksum) {
				throw new SqliteMigrationError(
					`SQLite migration ${identity} changed after it was applied; an applied migration is immutable, so write the change as a new migration`,
				)
			}
			lastApplied = migration.name
		}
		for (const migration of migrations) {
			if (lastApplied === undefined || compareNames(migration.name, lastApplied) >= 0) break
			if (!applied.has(`${migration.bundle}/${migration.name}`)) {
				throw new SqliteMigrationError(
					`SQLite migration ${migration.bundle}/${migration.name} sorts before ${migration.bundle}/${lastApplied}, which is already applied; rename it to sort after it`,
				)
			}
		}
	}
}

/**
 * Applies every migration the ledger does not record, each in its own transaction together with its ledger row, so a
 * failing one leaves nothing of itself and keeps the ones before it. A bundle's digest is recorded in the transaction
 * of its last file, or alone when nothing of it was pending; while every bundle matches its digest, the ledger is not
 * read. Answers the identities it applied.
 */
export async function migrateSqlite(
	target: SqliteMigrationTarget,
	bundles: readonly SqliteMigrationBundle[],
): Promise<{ readonly applied: readonly string[] }> {
	const planned = await plan(bundles)
	const digests = readDigests(target, planned)
	if (planned.every((bundle) => digests.get(bundle.bundle) === bundle.digest)) return { applied: [] }
	const recorded = readLedger(target)
	verify(planned, recorded)
	target.exec(LEDGER_DDL)
	const applied: string[] = []
	for (const bundle of planned) {
		if (digests.get(bundle.bundle) === bundle.digest) continue
		const pending = bundle.migrations.filter((migration) => !recorded.has(`${migration.bundle}/${migration.name}`))
		if (pending.length === 0) target.transactionSync(() => recordDigest(target, bundle))
		for (const [index, migration] of pending.entries()) {
			const identity = `${migration.bundle}/${migration.name}`
			try {
				target.transactionSync(() => {
					target.exec(migration.sql)
					target.exec(
						`INSERT INTO ${LEDGER} (bundle, name, checksum, applied_at) VALUES (?, ?, ?, ?)`,
						migration.bundle,
						migration.name,
						migration.checksum,
						new Date().toISOString(),
					)
					if (index === pending.length - 1) recordDigest(target, bundle)
				})
			} catch (error) {
				throw new SqliteMigrationError(`SQLite migration ${identity} failed`, { cause: error })
			}
			applied.push(identity)
		}
	}
	return { applied }
}
