// The SQLite migration runner over bun:sqlite, behind an adapter shaped like a Durable Object's storage. What it
// cannot see: the object's own `sql.exec` with multi-statement text and its `transactionSync` (checked on Lopata).

import { Database } from 'bun:sqlite'
import { describe, expect, spyOn, test } from 'bun:test'
import { SQLITE_FRAMEWORK_MIGRATIONS } from '../migrations-sqlite'
import { migrateSqlite, type SqliteMigrationBundle, SqliteMigrationError, type SqliteMigrationTarget } from '../sqlite-migrate'

/** `prepare` compiles only the first statement, so text without bindings or rows runs through `run`, as `sql.exec` would. */
function target(db: Database): SqliteMigrationTarget {
	return {
		exec(query, ...bindings) {
			const statement = db.prepare<Record<string, unknown>, (string | number | null)[]>(query)
			try {
				if (bindings.length > 0 || statement.columnNames.length > 0) {
					const rows = statement.all(...bindings)
					return { toArray: () => rows }
				}
			} finally {
				statement.finalize()
			}
			db.run(query)
			return { toArray: () => [] }
		},
		transactionSync: (fn) => db.transaction(fn)(),
	}
}

function open(): Database {
	const db = new Database(':memory:')
	db.run('PRAGMA foreign_keys = ON')
	return db
}

const NOTES = '20260101000000_notes.sql'
const TAGS = '20260102000000_tags.sql'

const app = (migrations: SqliteMigrationBundle['migrations']): SqliteMigrationBundle => ({ bundle: 'app', migrations })
const framework: SqliteMigrationBundle = { bundle: 'fabrika', migrations: SQLITE_FRAMEWORK_MIGRATIONS }
const notes = { name: NOTES, sql: 'CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL);\nCREATE INDEX notes_title ON notes (title);' }
const tags = { name: TAGS, sql: 'CREATE TABLE tags (id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes (id));' }

function tables(db: Database): string[] {
	return db.query<{ name: string }, []>(`SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name`).all().map((row) => row.name)
}

function ledger(db: Database): { bundle: string; name: string; checksum: string; applied_at: string }[] {
	return db
		.query<{ bundle: string; name: string; checksum: string; applied_at: string }, []>(
			'SELECT bundle, name, checksum, applied_at FROM fabrika_migrations ORDER BY bundle, name',
		)
		.all()
}

function digests(db: Database): Map<string, string> {
	const rows = db.query<{ bundle: string; digest: string }, []>('SELECT bundle, digest FROM fabrika_migration_bundles ORDER BY bundle').all()
	return new Map(rows.map((row) => [row.bundle, row.digest]))
}

/** The statements and transactions a run issues, and the SHA-256 digests it computes, while `run` is pending. */
async function observe(db: Database, run: (observed: SqliteMigrationTarget) => Promise<unknown>) {
	const inner = target(db)
	const queries: string[] = []
	let transactions = 0
	const hashes = spyOn(crypto.subtle, 'digest')
	try {
		await run({
			exec(query, ...bindings) {
				queries.push(query)
				return inner.exec(query, ...bindings)
			},
			transactionSync(fn) {
				transactions++
				return inner.transactionSync(fn)
			},
		})
		return { queries, transactions, hashes: hashes.mock.calls.length }
	} finally {
		hashes.mockRestore()
	}
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise
	} catch (error) {
		return error
	}
	throw new Error('expected a rejection')
}

describe('migrateSqlite', () => {
	test('applies the framework bundle, then the application bundle in name order, each with its ledger row', async () => {
		const db = open()
		const result = await migrateSqlite(target(db), [framework, app([tags, notes])])
		expect(result.applied).toEqual([...SQLITE_FRAMEWORK_MIGRATIONS.map((migration) => `fabrika/${migration.name}`), `app/${NOTES}`, `app/${TAGS}`])
		expect(tables(db)).toContain('notes')
		expect(tables(db)).toContain('tags')
		expect(tables(db)).toContain('fabrika_job_leases')
		expect(db.query(`SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'notes_title'`).all()).toHaveLength(1)
		const rows = ledger(db)
		expect(rows.map((row) => `${row.bundle}/${row.name}`).sort()).toEqual([...result.applied].sort())
		const notesRow = rows.find((row) => row.name === NOTES)
		expect(notesRow?.checksum).toBe(new Bun.CryptoHasher('sha256').update(notes.sql).digest('hex'))
		expect(notesRow?.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
		expect(db.query(`SELECT strict FROM pragma_table_list WHERE name = 'fabrika_migrations'`).get()).toEqual({ strict: 1 })
	})

	test('a second run applies nothing, and a new migration after the last applied one is applied alone', async () => {
		const db = open()
		await migrateSqlite(target(db), [framework, app([notes])])
		expect((await migrateSqlite(target(db), [framework, app([notes])])).applied).toEqual([])
		expect((await migrateSqlite(target(db), [framework, app([notes, tags])])).applied).toEqual([`app/${TAGS}`])
	})

	test('refuses an applied migration whose text changed, before applying anything', async () => {
		const db = open()
		await migrateSqlite(target(db), [app([notes])])
		const error = await rejection(migrateSqlite(target(db), [app([{ ...notes, sql: `${notes.sql}\n-- edited` }, tags])]))
		expect(error).toBeInstanceOf(SqliteMigrationError)
		expect(String(error)).toContain(`app/${NOTES} changed after it was applied`)
		expect(tables(db)).not.toContain('tags')
	})

	test('tolerates a ledger row whose migration the bundle no longer has: a rollback left the database ahead', async () => {
		const db = open()
		await migrateSqlite(target(db), [app([notes, tags])])
		expect((await migrateSqlite(target(db), [app([notes])])).applied).toEqual([])
		expect(tables(db)).toContain('tags')
	})

	test('refuses a new migration that sorts before the last applied one of its bundle', async () => {
		const db = open()
		const standaloneTags = { name: TAGS, sql: 'CREATE TABLE tags (id TEXT PRIMARY KEY);' }
		await migrateSqlite(target(db), [app([standaloneTags])])
		const error = await rejection(migrateSqlite(target(db), [app([notes, standaloneTags])]))
		expect(error).toBeInstanceOf(SqliteMigrationError)
		expect(String(error)).toContain(`app/${NOTES} sorts before app/${TAGS}`)
		expect(tables(db)).not.toContain('notes')
	})

	test('a failing migration rolls back itself and its ledger row and keeps the ones before it', async () => {
		const db = open()
		const broken = {
			name: '20260103000000_broken.sql',
			sql: "CREATE TABLE broken (id TEXT PRIMARY KEY);\nINSERT INTO tags (id, note_id) VALUES ('t', 'no-such-note');",
		}
		const error = await rejection(migrateSqlite(target(db), [framework, app([notes, tags, broken])]))
		expect(error).toBeInstanceOf(SqliteMigrationError)
		expect(String(error)).toContain(`app/${broken.name} failed`)
		expect(error instanceof Error ? String(error.cause) : '').toContain('FOREIGN KEY constraint failed')
		expect(tables(db)).not.toContain('broken')
		expect(tables(db)).toContain('tags')
		expect(ledger(db).map((row) => row.name)).not.toContain(broken.name)
		expect(ledger(db).map((row) => row.name)).toContain(TAGS)
		const fixed = { ...broken, sql: 'CREATE TABLE broken (id TEXT PRIMARY KEY);' }
		expect((await migrateSqlite(target(db), [framework, app([notes, tags, fixed])])).applied).toEqual([`app/${broken.name}`])
	})

	test('refuses a malformed bundle before running any SQL', async () => {
		const db = open()
		for (
			const bundles of [
				[app([notes, notes])],
				[app([{ name: 'notes.txt', sql: 'SELECT 1' }])],
				[app([{ name: NOTES, sql: '  ' }])],
				[app([notes]), app([tags])],
				[{ bundle: 'App', migrations: [notes] }],
			]
		) {
			expect(await rejection(migrateSqlite(target(db), bundles))).toBeInstanceOf(SqliteMigrationError)
		}
		expect(tables(db)).toEqual([])
	})

	describe('bundle digests', () => {
		test('a second run over unchanged bundles reads one digest row per bundle, hashes nothing and applies nothing', async () => {
			const db = open()
			const bundles = [framework, app([notes, tags])]
			await migrateSqlite(target(db), bundles)
			expect([...digests(db).keys()]).toEqual(['app', 'fabrika'])
			const second = await observe(db, (observed) => migrateSqlite(observed, bundles))
			expect(second.hashes).toBe(0)
			expect(second.transactions).toBe(0)
			expect(second.queries.filter((query) => query.includes('fabrika_migration_bundles WHERE bundle = ?'))).toHaveLength(bundles.length)
			expect(second.queries.filter((query) => query.includes('fabrika_migrations'))).toEqual([])
			expect(second.queries).toHaveLength(bundles.length + 1)
		})

		test('an edited applied file is still refused when its bundle has a recorded digest', async () => {
			const db = open()
			await migrateSqlite(target(db), [app([notes])])
			const before = digests(db)
			const error = await rejection(migrateSqlite(target(db), [app([{ ...notes, sql: `${notes.sql}\n-- edited` }])]))
			expect(error).toBeInstanceOf(SqliteMigrationError)
			expect(String(error)).toContain(`app/${NOTES} changed after it was applied`)
			expect(digests(db)).toEqual(before)
		})

		test('an appended file is applied and moves the digest; a failing one leaves the digest where it was', async () => {
			const db = open()
			await migrateSqlite(target(db), [framework, app([notes])])
			const first = digests(db)
			expect(first.get('app')).toEqual(expect.any(String))
			const broken = { name: TAGS, sql: "INSERT INTO notes (id) VALUES ('missing title');" }
			expect(await rejection(migrateSqlite(target(db), [framework, app([notes, broken])]))).toBeInstanceOf(SqliteMigrationError)
			expect(digests(db)).toEqual(first)
			const appended = [framework, app([notes, tags])]
			expect((await migrateSqlite(target(db), appended)).applied).toEqual([`app/${TAGS}`])
			const second = digests(db)
			expect(second.get('app')).not.toBe(first.get('app'))
			expect(second.get('fabrika')).toBe(first.get('fabrika'))
			const third = await observe(db, (observed) => migrateSqlite(observed, appended))
			expect(third.transactions).toBe(0)
			expect(third.queries).toHaveLength(appended.length + 1)
		})

		test('a database migrated before the digests existed converges: a full check, then the digests are recorded', async () => {
			const db = open()
			const bundles = [framework, app([notes, tags])]
			await migrateSqlite(target(db), bundles)
			const recorded = digests(db)
			db.run('DROP TABLE fabrika_migration_bundles')
			expect((await migrateSqlite(target(db), bundles)).applied).toEqual([])
			expect(digests(db)).toEqual(recorded)
			expect(db.query(`SELECT strict FROM pragma_table_list WHERE name = 'fabrika_migration_bundles'`).get()).toEqual({ strict: 1 })
			const next = await observe(db, (observed) => migrateSqlite(observed, bundles))
			expect(next.transactions).toBe(0)
			expect(next.queries).toHaveLength(bundles.length + 1)
		})

		test('a file appended to an array already hashed is applied', async () => {
			const db = open()
			const files = [notes]
			await migrateSqlite(target(db), [app(files)])
			files.push(tags)
			expect((await migrateSqlite(target(db), [app(files)])).applied).toEqual([`app/${TAGS}`])
			expect(tables(db)).toContain('tags')
		})

		test('an applied file replaced in an array already hashed is refused', async () => {
			const db = open()
			const files = [notes]
			await migrateSqlite(target(db), [app(files)])
			files[0] = { ...notes, sql: `${notes.sql}\n-- edited` }
			const error = await rejection(migrateSqlite(target(db), [app(files)]))
			expect(error).toBeInstanceOf(SqliteMigrationError)
			expect(String(error)).toContain(`app/${NOTES} changed after it was applied`)
		})

		test('an applied file whose text is edited in place in an array already hashed is refused', async () => {
			const db = open()
			const file = { name: NOTES, sql: notes.sql }
			const files = [file]
			await migrateSqlite(target(db), [app(files)])
			file.sql = `${notes.sql}\n-- edited`
			const error = await rejection(migrateSqlite(target(db), [app(files)]))
			expect(error).toBeInstanceOf(SqliteMigrationError)
			expect(String(error)).toContain(`app/${NOTES} changed after it was applied`)
		})
	})
})
