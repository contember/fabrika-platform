// The driver against a REAL Postgres. Two jobs here:
//   1. prove the port's contract holds — `bind()` is non-mutating, `meta.changes` is accurate, and
//      `batch()` is atomic — because the guarded-UPDATE idioms across the codebase are built on those;
//   2. pin the places Postgres genuinely behaves differently from D1, so the divergence is a failing
//      test the day someone changes it rather than a surprise in production.
//
// Skips cleanly (with a reason) when FABRIKA_TEST_POSTGRES_URL is unset — see helpers/postgres.ts.

import type { SqlDatabase } from '@fabrika/platform'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PostgresDatabase } from '../sql-postgres'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

if (!hasPostgres) {
	console.warn(`sql-postgres.test.ts ${skipReason}`)
}

let fixture: PostgresFixture | null = null
let db: SqlDatabase

beforeAll(async () => {
	if (!hasPostgres) {
		return
	}
	fixture = await createPostgres('pgsql')
	db = fixture.db
	await db.prepare(`CREATE TABLE widgets (
		id TEXT PRIMARY KEY,
		label TEXT,
		qty INTEGER NOT NULL,
		big BIGINT,
		flag BOOLEAN,
		created_at INTEGER NOT NULL
	)`).run()
})

afterAll(async () => {
	await fixture?.close()
})

async function reset(): Promise<void> {
	await db.prepare('DELETE FROM widgets').run()
}

describe.skipIf(!hasPostgres)('PostgresDatabase — placeholders end to end', () => {
	test('a statement full of quoting hazards runs and binds correctly', async () => {
		await reset()
		// Every construct the tokeniser has to step over, in one live statement: a literal containing a
		// `?`, a doubled quote, a line comment, a nested block comment and a dollar-quoted string.
		const inserted = await db
			.prepare(`INSERT INTO widgets (id, label, qty, created_at) -- a ? in a comment
				/* outer /* inner ? */ still comment ? */
				VALUES (?, '?' || ? || $tag$ ? $tag$ || 'it''s', ?, ?)
				RETURNING id, label, qty`)
			.bind('w1', 'X', 7, 100)
			.first<{ id: string; label: string; qty: number }>()
		expect(inserted).toEqual({ id: 'w1', label: "?X ? it's", qty: 7 })
	})

	test('a ? inside a literal is stored verbatim', async () => {
		await reset()
		await db.prepare("INSERT INTO widgets (id, label, qty, created_at) VALUES (?, 'a ? b', ?, ?)").bind('w2', 1, 0).run()
		const row = await db.prepare('SELECT label FROM widgets WHERE id = ?').bind('w2').first<{ label: string }>()
		expect(row?.label).toBe('a ? b')
	})

	test('a placeholder in LIMIT and in an IN-subselect both bind', async () => {
		await reset()
		for (const id of ['a', 'b', 'c']) {
			await db.prepare('INSERT INTO widgets (id, qty, created_at) VALUES (?, ?, ?)').bind(id, 1, 0).run()
		}
		const { results } = await db
			.prepare('SELECT id FROM widgets WHERE id IN (SELECT id FROM widgets WHERE id > ?) ORDER BY id LIMIT ?')
			.bind('a', 1)
			.all<{ id: string }>()
		expect(results).toEqual([{ id: 'b' }])
	})

	test('binding the wrong number of values fails loudly, before hitting the server', async () => {
		const statement = db.prepare('SELECT * FROM widgets WHERE id = ? AND qty = ?')
		await expect(statement.bind('a').all()).rejects.toThrow('statement expects 2 bound value(s), got 1')
		await expect(statement.all()).rejects.toThrow('statement expects 2 bound value(s), got 0')
	})
})

describe.skipIf(!hasPostgres)('PostgresDatabase — bind() is non-mutating (D1 semantics)', () => {
	test('binding a base statement twice yields two independent statements', async () => {
		await reset()
		const insert = db.prepare('INSERT INTO widgets (id, qty, created_at) VALUES (?, ?, ?)')
		await insert.bind('one', 1, 0).run()
		await insert.bind('two', 2, 0).run()
		const { results } = await db.prepare('SELECT id, qty FROM widgets ORDER BY id').all<{ id: string; qty: number }>()
		expect(results).toEqual([{ id: 'one', qty: 1 }, { id: 'two', qty: 2 }])
	})

	test('bind() returns a NEW statement and leaves the receiver unbound', async () => {
		const base = db.prepare('SELECT id FROM widgets WHERE id = ?')
		const bound = base.bind('one')
		expect(bound).not.toBe(base)
		// The receiver still has zero values, so using it must fail rather than reuse the other's binding.
		await expect(base.all()).rejects.toThrow('got 0')
		await expect(bound.all()).resolves.toBeDefined()
	})

	test('re-binding a bound statement replaces the values rather than appending', async () => {
		await reset()
		await db.prepare('INSERT INTO widgets (id, qty, created_at) VALUES (?, ?, ?)').bind('one', 1, 0).run()
		const statement = db.prepare('SELECT id FROM widgets WHERE id = ?').bind('nope')
		expect(await statement.bind('one').first()).not.toBeNull()
	})
})

describe.skipIf(!hasPostgres)('PostgresDatabase — meta.changes', () => {
	beforeAll(async () => {
		if (!hasPostgres) {
			return
		}
		await reset()
		await db.prepare('INSERT INTO widgets (id, qty, created_at) VALUES (?, ?, ?)').bind('m1', 1, 0).run()
	})

	test('an INSERT reports 1', async () => {
		const result = await db.prepare('INSERT INTO widgets (id, qty, created_at) VALUES (?, ?, ?)').bind('m2', 1, 0).run()
		expect(result.meta.changes).toBe(1)
	})

	test('a guarded UPDATE that matches reports 1 and one that does not reports 0', async () => {
		const hit = await db.prepare('UPDATE widgets SET qty = ? WHERE id = ? AND qty = ?').bind(9, 'm1', 1).run()
		expect(hit.meta.changes).toBe(1)
		const miss = await db.prepare('UPDATE widgets SET qty = ? WHERE id = ? AND qty = ?').bind(9, 'm1', 1).run()
		expect(miss.meta.changes).toBe(0)
	})

	test('a multi-row UPDATE reports every row it touched', async () => {
		const result = await db.prepare('UPDATE widgets SET qty = qty + ?').bind(1).run()
		expect(result.meta.changes).toBe(2)
	})

	test('… RETURNING still reports the affected-row count', async () => {
		const result = await db.prepare('UPDATE widgets SET qty = ? WHERE id = ? RETURNING id').bind(3, 'm1').run()
		expect(result.meta.changes).toBe(1)
	})

	test('a DELETE that matches nothing reports 0', async () => {
		const result = await db.prepare('DELETE FROM widgets WHERE id = ?').bind('absent').run()
		expect(result.meta.changes).toBe(0)
	})

	test('an ON CONFLICT DO NOTHING that conflicts reports 0', async () => {
		const result = await db
			.prepare('INSERT INTO widgets (id, qty, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING')
			.bind('m1', 1, 0)
			.run()
		expect(result.meta.changes).toBe(0)
	})

	test('run() on a SELECT reports 0, not the row count (D1 parity)', async () => {
		// Bun reports the returned-row count as `count` for a SELECT; D1 reports `changes: 0`. If this
		// leaked through, `changes === 0` would stop meaning "the guard did not match".
		const result = await db.prepare('SELECT * FROM widgets').run()
		expect(result.meta.changes).toBe(0)
	})
})

describe.skipIf(!hasPostgres)('PostgresDatabase — reads', () => {
	beforeAll(async () => {
		if (!hasPostgres) {
			return
		}
		await reset()
		await db.prepare('INSERT INTO widgets (id, label, qty, flag, created_at) VALUES (?, ?, ?, ?, ?)').bind('r1', null, 4, true, 100).run()
	})

	test('first() returns null when nothing matched', async () => {
		expect(await db.prepare('SELECT * FROM widgets WHERE id = ?').bind('absent').first()).toBeNull()
	})

	test('all() wraps rows in { results }, empty included', async () => {
		expect(await db.prepare('SELECT * FROM widgets WHERE id = ?').bind('absent').all()).toEqual({ results: [] })
	})

	test('a NULL column comes back as null, not undefined', async () => {
		const row = await db.prepare('SELECT label FROM widgets WHERE id = ?').bind('r1').first<{ label: string | null }>()
		expect(row).toEqual({ label: null })
	})

	test('undefined binds as NULL (D1 would throw) — matching both bun:sqlite harnesses', async () => {
		await db.prepare('INSERT INTO widgets (id, label, qty, created_at) VALUES (?, ?, ?, ?)').bind('r2', undefined, 1, 0).run()
		const row = await db.prepare('SELECT label FROM widgets WHERE id = ?').bind('r2').first<{ label: string | null }>()
		expect(row?.label).toBeNull()
	})

	test('a non-scalar bind value is rejected at bind time', () => {
		expect(() => db.prepare('SELECT ?').bind({ nope: true })).toThrow('unsupported bind value of type object')
	})
})

describe.skipIf(!hasPostgres)('PostgresDatabase — divergences that would silently change behaviour', () => {
	test('INTEGER comes back as a number but BIGINT comes back as a STRING', async () => {
		await reset()
		await db.prepare('INSERT INTO widgets (id, qty, big, created_at) VALUES (?, ?, ?, ?)').bind('t1', 5, 5, 0).run()
		const row = await db.prepare('SELECT qty, big FROM widgets WHERE id = ?').bind('t1').first<{ qty: unknown; big: unknown }>()
		expect(typeof row?.qty).toBe('number')
		// Bun decodes by COLUMN TYPE, not by value: even a BIGINT holding 5 is a string. D1/SQLite would
		// hand back a number, so any row shape typed `number` must be INTEGER in the Postgres migration.
		expect(typeof row?.big).toBe('string')
	})

	test('comparing a TEXT column to a numeric bind throws instead of matching nothing', async () => {
		// SQLite compares across types happily (and returns no rows); Postgres refuses. This turns a
		// latent bind-type bug into a loud error, which is the better failure — but it IS a behaviour change.
		await expect(db.prepare('SELECT * FROM widgets WHERE id = ?').bind(5).all()).rejects.toThrow(/operator does not exist/)
	})

	test('SQLite-only functions do not exist here', async () => {
		await expect(db.prepare('SELECT unixepoch()').all()).rejects.toThrow(/unixepoch/)
	})
})

describe.skipIf(!hasPostgres)('PostgresDatabase — batch()', () => {
	test('runs statements in order and returns one result each', async () => {
		await reset()
		const results = await db.batch<{ id: string }>([
			db.prepare('INSERT INTO widgets (id, qty, created_at) VALUES (?, ?, ?) RETURNING id').bind('b1', 1, 0),
			db.prepare('INSERT INTO widgets (id, qty, created_at) VALUES (?, ?, ?) RETURNING id').bind('b2', 2, 0),
			db.prepare('SELECT id FROM widgets ORDER BY id'),
		])
		expect(results).toHaveLength(3)
		expect(results[0]?.results).toEqual([{ id: 'b1' }])
		expect(results[2]?.results).toEqual([{ id: 'b1' }, { id: 'b2' }])
	})

	test('is ATOMIC — a failure rolls back the statements before it', async () => {
		await reset()
		await db.prepare('INSERT INTO widgets (id, qty, created_at) VALUES (?, ?, ?)').bind('keep', 1, 0).run()
		await expect(db.batch([
			db.prepare('INSERT INTO widgets (id, qty, created_at) VALUES (?, ?, ?)').bind('rolled-back', 1, 0),
			// Duplicate primary key: the second statement fails, so the first must not survive.
			db.prepare('INSERT INTO widgets (id, qty, created_at) VALUES (?, ?, ?)').bind('keep', 1, 0),
		])).rejects.toThrow()
		const { results } = await db.prepare('SELECT id FROM widgets ORDER BY id').all<{ id: string }>()
		expect(results).toEqual([{ id: 'keep' }])
	})

	test('rejects a statement that did not come from this database', async () => {
		const foreign = { bind: () => foreign, first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 0 } }) }
		await expect(db.batch([foreign])).rejects.toThrow('batch() accepts only statements created by this database')
	})

	test('an empty batch is a no-op', async () => {
		expect(await db.batch([])).toEqual([])
	})
})

describe.skipIf(!hasPostgres)('PostgresDatabase.connect', () => {
	test('does not put the connection URL into an error message', async () => {
		// A bad URL must not have its credentials echoed back through a thrown error.
		const bad = PostgresDatabase.connect('postgres://someuser:sup3rsecret@127.0.0.1:1/nope', { connectionTimeout: 1 })
		try {
			await bad.prepare('SELECT 1').all()
			expect.unreachable('expected the connection to fail')
		} catch (error) {
			expect(error instanceof Error ? error.message : String(error)).not.toContain('sup3rsecret')
		} finally {
			await bad.close({ timeout: 0 })
		}
	})
})
