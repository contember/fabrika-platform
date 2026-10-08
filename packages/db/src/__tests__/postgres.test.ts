// The data layer against a REAL Postgres, through kysely-postgres-js over Bun.SQL. Skips cleanly (with a reason)
// when FABRIKA_TEST_POSTGRES_URL is unset:
//
//   docker run --rm -d -p 55433:5432 -e POSTGRES_PASSWORD=postgres postgres:17
//   FABRIKA_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres bun test packages/db
//
// The file gets its own schema, which the layer reaches through the connection's search_path. The URL is a
// credential: it is never logged.

import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from '../database'
import { CapabilityError, ConflictError, NotFoundError } from '../errors'
import { TestAuthority } from './fixtures/authority'
import { migration } from './fixtures/schema'
import { defineStores } from './fixtures/stores'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR]
const hasPostgres = url !== undefined && url !== ''

if (!hasPostgres) {
	console.warn(`postgres.test.ts skipped: set ${URL_VAR} to run the Postgres-backed tests`)
}

const schema = `db_${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
const alice = new TestAuthority('user:alice')
let database: Database
let stores: ReturnType<typeof defineStores>

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

beforeAll(async () => {
	if (!hasPostgres) {
		return
	}
	await admin(async (sql) => {
		await sql.unsafe(`create schema ${schema}`)
		await sql.unsafe(`set search_path to ${schema}; ${migration}`)
		await sql.unsafe(`insert into ${schema}.workspaces (id, name, created_by) values ('w1', 'One', 'user:alice'), ('w2', 'Two', 'user:alice')`)
	})
	database = Database.postgres({ url: url ?? '', schema, max: 2 })
	stores = defineStores({ database, capabilities: alice })
})

afterAll(async () => {
	if (!hasPostgres) {
		return
	}
	await database.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

const read = (values: readonly string[] | 'all' = ['w1']) => alice.within('workspace', 'notes.read', values)
const into = (workspace: string) => alice.ref('workspace', 'notes.write', workspace)
const note = <const A extends string>(action: A, id: string, workspace: string) => alice.ref('note', action, id, { workspace })

async function createNote(workspace: string, title: string, body: string | null = null): Promise<string> {
	const created = await stores.notes.create(into(workspace), { title, body })
	return created.id
}

describe.skipIf(!hasPostgres)('the scoped layer on Postgres', () => {
	test('an insert stamps the key, the container, the version and the principal, and returns no restricted column', async () => {
		const row = await stores.notes.create(into('w1'), { title: 'Hello', body: 'World', word_count: 2 })
		expect(row).toMatchObject({ workspace_id: 'w1', title: 'Hello', body: 'World', word_count: 2, created_by: 'user:alice', version: 1 })
		expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
		expect(row.created_at).toBeInstanceOf(Date)
		expect(Object.keys(row)).not.toContain('internal')
	})

	test('a list sees only the scope values of its Within', async () => {
		const inOne = await createNote('w1', 'list one')
		const inTwo = await createNote('w2', 'list two')
		const one = (await stores.notes.list(read(['w1']), { limit: 1000, offset: 0 })).map((row) => row.id)
		const two = (await stores.notes.list(read(['w2']), { limit: 1000, offset: 0 })).map((row) => row.id)
		const all = (await stores.notes.list(read('all'), { limit: 1000, offset: 0 })).map((row) => row.id)
		expect(one).toContain(inOne)
		expect(one).not.toContain(inTwo)
		expect(two).toContain(inTwo)
		expect(two).not.toContain(inOne)
		expect(all).toEqual(expect.arrayContaining([inOne, inTwo]))
		expect(await stores.notes.list(read([]), { limit: 10, offset: 0 })).toEqual([])
	})

	test('a Ref whose chain names another workspace reaches nothing: 404 on get, update and remove', async () => {
		const id = await createNote('w1', 'isolated')
		await expect(stores.notes.get(note('notes.read', id, 'w2'))).rejects.toBeInstanceOf(NotFoundError)
		await expect(stores.notes.update(note('notes.write', id, 'w2'), { title: 'stolen' }, 1)).rejects.toBeInstanceOf(NotFoundError)
		await expect(stores.notes.remove(note('notes.delete', id, 'w2'))).rejects.toBeInstanceOf(NotFoundError)
		expect((await stores.notes.get(note('notes.read', id, 'w1'))).title).toBe('isolated')
	})

	test('a read Ref cannot remove, even through a widened handle', async () => {
		const id = await createNote('w1', 'kept')
		const widened: { remove(ref: unknown): Promise<void> } = stores.notes
		await expect(widened.remove(note('notes.read', id, 'w1'))).rejects.toBeInstanceOf(CapabilityError)
		expect((await stores.notes.get(note('notes.read', id, 'w1'))).title).toBe('kept')
	})

	test('optimistic concurrency: the expected version wins, a stale one is 409, a missing object 404', async () => {
		const id = await createNote('w1', 'v1')
		const updated = await stores.notes.update(note('notes.write', id, 'w1'), { title: 'v2' }, 1)
		expect(updated).toMatchObject({ title: 'v2', version: 2 })
		await expect(stores.notes.update(note('notes.write', id, 'w1'), { title: 'v3' }, 1)).rejects.toBeInstanceOf(ConflictError)
		await expect(stores.notes.update(note('notes.write', Bun.randomUUIDv7(), 'w1'), { title: 'x' }, 1)).rejects.toBeInstanceOf(NotFoundError)
		expect((await stores.notes.get(note('notes.read', id, 'w1'))).title).toBe('v2')
	})

	test('remove deletes once; the second remove is 404', async () => {
		const id = await createNote('w1', 'gone')
		await stores.notes.remove(note('notes.delete', id, 'w1'))
		await expect(stores.notes.remove(note('notes.delete', id, 'w1'))).rejects.toBeInstanceOf(NotFoundError)
	})

	test('move takes the comments along through ON UPDATE CASCADE; the old chain reaches nothing', async () => {
		const id = await createNote('w1', 'moving')
		await stores.comments.add(note('notes.write', id, 'w1'), 'first')
		const moved = await stores.notes.move(note('notes.delete', id, 'w1'), into('w2'))
		expect(moved).toMatchObject({ workspace_id: 'w2', version: 2 })
		await expect(stores.notes.get(note('notes.read', id, 'w1'))).rejects.toBeInstanceOf(NotFoundError)
		expect(await stores.comments.ofNote(note('notes.read', id, 'w1'))).toEqual([])
		const comments = await stores.comments.ofNote(note('notes.read', id, 'w2'))
		expect(comments.map((comment) => comment.body)).toEqual(['first'])
		const inWorkspace = await stores.comments.inWorkspaces(read(['w2']))
		expect(inWorkspace.find((comment) => comment.note_id === id)?.workspace_id).toBe('w2')
	})

	test('child rows: add, get, edit and remove through the parent Ref only', async () => {
		const id = await createNote('w1', 'with comments')
		const added = await stores.comments.add(note('notes.write', id, 'w1'), 'hello')
		expect(added).toMatchObject({ note_id: id, workspace_id: 'w1', body: 'hello' })
		expect((await stores.comments.get(note('notes.read', id, 'w1'), added.id)).body).toBe('hello')
		await expect(stores.comments.get(note('notes.read', id, 'w2'), added.id)).rejects.toBeInstanceOf(NotFoundError)
		const otherNote = await createNote('w1', 'other')
		await expect(stores.comments.edit(note('notes.write', otherNote, 'w1'), added.id, 'hijacked')).rejects.toBeInstanceOf(NotFoundError)
		expect((await stores.comments.edit(note('notes.write', id, 'w1'), added.id, 'edited')).body).toBe('edited')
		await stores.comments.remove(note('notes.write', id, 'w1'), added.id)
		await expect(stores.comments.remove(note('notes.write', id, 'w1'), added.id)).rejects.toBeInstanceOf(NotFoundError)
	})

	test('a join returns the child columns prefixed, ON the composite key', async () => {
		const id = await createNote('w1', 'joined')
		await stores.comments.add(note('notes.write', id, 'w1'), 'a')
		await stores.comments.add(note('notes.write', id, 'w1'), 'b')
		const rows = await stores.notes.withComments(read(['w1']), [id])
		expect(rows.map((row) => [row.title, row['note_comments.body']]).sort()).toEqual([['joined', 'a'], ['joined', 'b']])
		expect(await stores.notes.withComments(read(['w2']), [id])).toEqual([])
	})

	test('aggregates: count is a string, an integer sum a string, min and max keep the column type', async () => {
		await admin((sql) => sql.unsafe(`insert into ${schema}.workspaces (id, name, created_by) values ('w3', 'Three', 'user:alice')`))
		await stores.notes.create(into('w3'), { title: 'a', body: null, word_count: 3 })
		await stores.notes.create(into('w3'), { title: 'b', body: null, word_count: 5 })
		expect(await stores.notes.countPerWorkspace(read(['w3']))).toEqual([{ workspace_id: 'w3', count: '2' }])
		const [words] = await stores.notes.words(read(['w3']))
		expect(words).toMatchObject({ count: '2', sum_word_count: '8', min_word_count: 3 })
		expect(words?.max_created_at).toBeInstanceOf(Date)
		expect(await stores.notes.words(read([]))).toEqual([])
	})

	test('contains matches % and _ literally, case-insensitively', async () => {
		await admin((sql) => sql.unsafe(`insert into ${schema}.workspaces (id, name, created_by) values ('w4', 'Four', 'user:alice')`))
		await createNote('w4', '50% OFF')
		await createNote('w4', '500 off')
		await createNote('w4', 'a_b')
		await createNote('w4', 'axb')
		expect((await stores.notes.titled(read(['w4']), '50% off')).map((row) => row.title)).toEqual(['50% OFF'])
		expect((await stores.notes.titled(read(['w4']), 'a_b')).map((row) => row.title)).toEqual(['a_b'])
		const searched = await stores.notes.search(read(['w4']), 'OFF')
		expect(searched.map((row) => row.title).sort()).toEqual(['50% OFF', '500 off'])
	})

	test('a long Within is expanded into parameters, never bound as an array', async () => {
		const values = [...Array.from({ length: 300 }, (_, index) => `missing-${index}`), 'w1']
		const rows = await stores.notes.list(read(values), { limit: 1, offset: 0 })
		expect(rows.length).toBe(1)
	})

	test('a top-level table: insert the object the Ref names, list by its key, update without a version', async () => {
		const created = await stores.workspaces.create(alice.ref('workspace', 'workspaces.create', 'w9'), 'Nine')
		expect(created).toEqual({ id: 'w9', name: 'Nine', created_by: 'user:alice' })
		expect(await stores.workspaces.list(read(['w9', 'w2']))).toEqual([{ id: 'w9', name: 'Nine' }, { id: 'w2', name: 'Two' }])
		expect((await stores.workspaces.rename(alice.ref('workspace', 'workspaces.admin', 'w9'), 'Renamed')).name).toBe('Renamed')
	})

	test('the restricted column is written but never read back', async () => {
		const row = await stores.notes.create(into('w1'), { title: 'secretive', body: null, internal: 'only for admins' })
		expect(Object.keys(row)).not.toContain('internal')
		const stored = await admin((sql) => sql.unsafe(`select internal from ${schema}.notes where id = $1`, [row.id]))
		expect(stored[0]?.internal).toBe('only for admins')
	})
})
