// The 0011 / 0005 guards, which are the only thing standing between a fork in email identity and a
// silent merge of two people's grants. CORR-1's decision was FAIL LOUD, so this proves they do.
//
// The SQLite half runs everywhere; the Postgres half needs FABRIKA_TEST_POSTGRES_URL (helpers/postgres.ts).

import { PostgresDatabase } from '@fabrika/platform-node'
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyMigrations, postgresMigrations } from '../node/migrate'
import { hasPostgres, postgresUrl, skipReason } from './helpers/postgres'

const SQLITE_DIR = join(import.meta.dir, '..', '..', 'migrations')
const GUARDED = '0011_one_mailbox_rule.sql'

if (!hasPostgres) {
	console.warn(`migration-guards.test.ts (Postgres half) ${skipReason}`)
}

/** A SQLite database with every migration BEFORE the guarded one applied. */
function beforeGuard(): Database {
	const sqlite = new Database(':memory:')
	sqlite.exec('PRAGMA foreign_keys = ON')
	for (const name of readdirSync(SQLITE_DIR).filter((f) => f.endsWith('.sql') && f < GUARDED).sort()) {
		sqlite.exec(readFileSync(join(SQLITE_DIR, name), 'utf8'))
	}
	return sqlite
}

function seedPrincipal(sqlite: Database, id: string, email: string): void {
	sqlite.run('INSERT INTO principals (id, type, external_id, email, label, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, 'user', id, email, email, 1])
}

/**
 * Apply the guarded migration ONE STATEMENT AT A TIME, which is what `wrangler d1 migrations apply`
 * does and what makes a refusal stop the run. `Database.exec()` cannot stand in here: Bun's version
 * reports a compile error but SWALLOWS a step error and carries on with the rest of the script, so a
 * guard that fires would look like a guard that passed.
 */
function applyGuarded(sqlite: Database): void {
	for (const statement of splitStatements(readFileSync(join(SQLITE_DIR, GUARDED), 'utf8'))) {
		sqlite.query(statement).run()
	}
}

/** Split on `;`, ignoring the ones inside `-- comments`, `'literals'` and a trigger's BEGIN…END body. */
function splitStatements(sql: string): string[] {
	const statements: string[] = []
	let current = ''
	let inString = false
	let inComment = false
	let depth = 0
	for (let i = 0; i < sql.length; i += 1) {
		const char = sql[i] ?? ''
		current += char
		if (inComment) {
			if (char === '\n') inComment = false
			continue
		}
		if (inString) {
			if (char === `'`) inString = false
			continue
		}
		if (char === `'`) {
			inString = true
			continue
		}
		if (char === '-' && sql[i + 1] === '-') {
			inComment = true
			continue
		}
		if (char === ';') {
			if (depth > 0 && /\sEND\s*;$/i.test(current)) depth -= 1
			if (depth === 0) {
				statements.push(current)
				current = ''
			}
			continue
		}
		if (/\sBEGIN\s$/i.test(current)) depth += 1
	}
	return statements.map((s) => s.trim()).filter((s) => s !== '' && !s.split('\n').every((line) => line.trim().startsWith('--')))
}

describe('migrations/0011 — the one mailbox rule refuses to guess (SQLite)', () => {
	test('normalizes legacy spellings and backfills the reservation when the data is clean', () => {
		const sqlite = beforeGuard()
		seedPrincipal(sqlite, 'p-1', 'Bob@Example.com')
		seedPrincipal(sqlite, 'p-2', 'josé@example.com')
		applyGuarded(sqlite)

		expect(sqlite.query<{ email: string; label: string }, [string]>('SELECT email, label FROM principals WHERE id = ?').get('p-1')).toEqual({
			email: 'bob@example.com',
			label: 'Bob@Example.com',
		})
		expect(sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM principal_email_claims').get()).toEqual({ n: 2 })
	})

	test('two principals that become one mailbox stop it, with an actionable message', () => {
		const sqlite = beforeGuard()
		seedPrincipal(sqlite, 'p-1', 'Bob@Example.com')
		seedPrincipal(sqlite, 'p-2', 'bob@example.com')
		expect(() => applyGuarded(sqlite)).toThrow(/share one mailbox/)
		// Nothing was rewritten: an operator resolves it and re-runs from a known state.
		expect(sqlite.query<{ email: string }, [string]>('SELECT email FROM principals WHERE id = ?').get('p-1')).toEqual({ email: 'Bob@Example.com' })
	})

	test('a mailbox no engine can fold identically stops it too', () => {
		const sqlite = beforeGuard()
		seedPrincipal(sqlite, 'p-1', 'JOSÉ@example.com')
		expect(() => applyGuarded(sqlite)).toThrow(/non-ASCII/)
	})
})

describe.skipIf(!hasPostgres)('migrations-postgres/0005 — the same refusals, on Postgres', () => {
	/** A schema with every migration BEFORE the guarded one applied, plus the seeded rows. */
	async function beforeGuardPostgres(seed: readonly (readonly [string, string])[]) {
		const url = postgresUrl ?? ''
		const schema = `guard_${Math.random().toString(36).slice(2, 10)}`
		const admin = PostgresDatabase.connect(url)
		await admin.prepare(`CREATE SCHEMA ${schema}`).run()
		await admin.close()
		const db = PostgresDatabase.connect(url, { connection: { search_path: schema }, max: 1 })
		const all = postgresMigrations()
		await applyMigrations(db, all.filter((m) => m.name < '0005_one_mailbox_rule.sql'))
		for (const [id, email] of seed) {
			await db.prepare('INSERT INTO principals (id, type, external_id, email, label, created_at) VALUES (?, ?, ?, ?, ?, ?)')
				.bind(id, 'user', id, email, email, 1)
				.run()
		}
		const close = async (): Promise<void> => {
			await db.close()
			const cleanup = PostgresDatabase.connect(url)
			await cleanup.prepare(`DROP SCHEMA ${schema} CASCADE`).run()
			await cleanup.close()
		}
		return { db, close }
	}

	test('normalizes legacy spellings and backfills the reservation when the data is clean', async () => {
		const { db, close } = await beforeGuardPostgres([['p-1', 'Bob@Example.com'], ['p-2', 'josé@example.com']])
		try {
			await applyMigrations(db)
			expect(await db.prepare('SELECT email, label FROM principals WHERE id = ?').bind('p-1').first<{ email: string; label: string }>())
				.toEqual({ email: 'bob@example.com', label: 'Bob@Example.com' })
			expect((await db.prepare('SELECT COUNT(*)::int AS n FROM principal_email_claims').first<{ n: number }>())?.n).toBe(2)
		} finally {
			await close()
		}
	})

	test('a collision stops it and NAMES the principals — Postgres can, so it does', async () => {
		const { db, close } = await beforeGuardPostgres([['p-1', 'Bob@Example.com'], ['p-2', 'bob@example.com']])
		try {
			await expect(applyMigrations(db)).rejects.toThrow(/share one mailbox once case is normalized: bob@example\.com -> p-1/)
			expect((await db.prepare('SELECT email FROM principals WHERE id = ?').bind('p-1').first<{ email: string }>())?.email).toBe('Bob@Example.com')
		} finally {
			await close()
		}
	})

	test('a mailbox no engine can fold identically stops it too', async () => {
		const { db, close } = await beforeGuardPostgres([['p-1', 'JOSÉ@example.com']])
		try {
			await expect(applyMigrations(db)).rejects.toThrow(/non-ASCII/)
		} finally {
			await close()
		}
	})
})
