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
		await sql.unsafe(`insert into ${schema}.organizations (id, name) values ('o1', 'One'), ('o2', 'Two')`)
		await addWorkspaces(sql, ['w1', 'w2', 'w3', 'w4'])
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

async function addWorkspaces(sql: SQL, ids: readonly string[], organization = 'o1'): Promise<void> {
	for (const id of ids) {
		await sql.unsafe(`insert into ${schema}.workspaces (id, organization_id, name, created_by) values ($1, $2, $1, 'user:alice')`, [id, organization])
	}
}

async function count(table: string): Promise<number> {
	const [row] = await admin((sql) => sql.unsafe(`select count(*)::int as n from ${schema}.${table}`))
	return Number(row?.n)
}

const read = (values: readonly string[] | 'all' = ['w1']) => alice.within('workspace', 'notes.read', values)
const into = (workspace: string, organization = 'o1') => alice.ref('workspace', 'notes.write', workspace, { organization })
const note = <const A extends string>(action: A, id: string, workspace: string, organization = 'o1') =>
	alice.ref('note', action, id, { workspace, organization })
const workspaceAdmin = (workspace: string, organization: string) => alice.ref('workspace', 'workspaces.admin', workspace, { organization })
const intoOrganization = (organization: string) => alice.ref('organization', 'workspaces.create', organization)

async function createNote(workspace: string, title: string, body: string | null = null, organization = 'o1'): Promise<string> {
	const created = await stores.notes.create(into(workspace, organization), { title, body })
	return created.id
}

describe.skipIf(!hasPostgres)('the scoped layer on Postgres', () => {
	test('an insert answers its key and version only; it stamps the key, the whole chain, the version and the principal', async () => {
		const acknowledged = await stores.notes.create(into('w1'), { title: 'Hello', body: 'World', word_count: 2, internal: 'x' })
		expect(Object.keys(acknowledged).sort()).toEqual(['id', 'version'])
		expect(acknowledged.version).toBe(1)
		expect(acknowledged.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
		const row = await stores.notes.get(note('notes.read', acknowledged.id, 'w1'))
		expect(row).toMatchObject({
			workspace_id: 'w1',
			organization_id: 'o1',
			title: 'Hello',
			body: 'World',
			word_count: 2,
			created_by: 'user:alice',
			version: 1,
		})
		expect(row.created_at).toBeInstanceOf(Date)
		expect(Object.keys(row)).not.toContain('internal')
	})

	test('a write-only caller learns nothing it could not read: update answers id and version, not the stored body', async () => {
		const id = await createNote('w1', 'private', 'the body a writer never supplied')
		const acknowledged = await stores.notes.update(note('notes.write', id, 'w1'), { title: 'renamed' }, 1)
		expect(acknowledged).toEqual({ id, version: 2 })
		const moved = await stores.notes.move(note('notes.delete', id, 'w1'), into('w2'))
		expect(moved).toEqual({ id, version: 3, chain: { workspace: 'w2', organization: 'o1' } })
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

	test('a Ref whose chain names another workspace or organization reaches nothing: 404 on get, update and remove', async () => {
		const id = await createNote('w1', 'isolated')
		for (const stray of [note('notes.read', id, 'w2'), note('notes.read', id, 'w1', 'o2')]) {
			await expect(stores.notes.get(stray)).rejects.toBeInstanceOf(NotFoundError)
		}
		await expect(stores.notes.update(note('notes.write', id, 'w2'), { title: 'stolen' }, 1)).rejects.toBeInstanceOf(NotFoundError)
		await expect(stores.notes.update(note('notes.write', id, 'w1', 'o2'), { title: 'stolen' }, 1)).rejects.toBeInstanceOf(NotFoundError)
		await expect(stores.notes.remove(note('notes.delete', id, 'w1', 'o2'))).rejects.toBeInstanceOf(NotFoundError)
		expect((await stores.notes.get(note('notes.read', id, 'w1'))).title).toBe('isolated')
	})

	test('after an ancestor moves, a Ref minted before the move reaches nothing, the 409 check included', async () => {
		await admin((sql) => addWorkspaces(sql, ['moving-ws']))
		const id = await createNote('moving-ws', 'in a moving workspace')
		const comment = await stores.comments.add(note('notes.write', id, 'moving-ws'), 'along for the ride')
		const moved = await stores.workspaces.move(workspaceAdmin('moving-ws', 'o1'), intoOrganization('o2'))
		expect(moved.chain).toEqual({ organization: 'o2' })

		const stale = <const A extends string>(action: A) => note(action, id, 'moving-ws', 'o1')
		await expect(stores.notes.get(stale('notes.read'))).rejects.toBeInstanceOf(NotFoundError)
		await expect(stores.notes.update(stale('notes.write'), { title: 'x' }, 1)).rejects.toBeInstanceOf(NotFoundError)
		await expect(stores.notes.update(stale('notes.write'), { title: 'x' }, 99)).rejects.toBeInstanceOf(NotFoundError)
		await expect(stores.notes.remove(stale('notes.delete'))).rejects.toBeInstanceOf(NotFoundError)
		await expect(stores.comments.get(stale('notes.read'), comment.id)).rejects.toBeInstanceOf(NotFoundError)
		await expect(stores.comments.edit(stale('notes.write'), comment.id, 'x')).rejects.toBeInstanceOf(NotFoundError)
		expect(await stores.comments.ofNote(stale('notes.read'))).toEqual([])

		const current = note('notes.read', id, 'moving-ws', 'o2')
		expect((await stores.notes.get(current)).organization_id).toBe('o2')
		expect((await stores.comments.get(current, comment.id)).organization_id).toBe('o2')
		await expect(stores.notes.update(note('notes.write', id, 'moving-ws', 'o2'), { title: 'x' }, 99)).rejects.toBeInstanceOf(ConflictError)
	})

	test('a stale destination Ref inserts nothing and moves nothing', async () => {
		await admin((sql) => addWorkspaces(sql, ['stale-ws', 'source-ws']))
		const staleTarget = into('stale-ws', 'o1')
		const id = await createNote('source-ws', 'stays put')
		const parent = note('notes.write', id, 'source-ws')
		await stores.workspaces.move(workspaceAdmin('stale-ws', 'o1'), intoOrganization('o2'))

		const notesBefore = await count('notes')
		await expect(stores.notes.create(staleTarget, { title: 'lost', body: null })).rejects.toBeInstanceOf(NotFoundError)
		expect(await count('notes')).toBe(notesBefore)

		await expect(stores.notes.move(note('notes.delete', id, 'source-ws'), staleTarget)).rejects.toBeInstanceOf(NotFoundError)
		expect(await stores.notes.get(note('notes.read', id, 'source-ws'))).toMatchObject({ workspace_id: 'source-ws', organization_id: 'o1', version: 1 })

		await stores.workspaces.move(workspaceAdmin('source-ws', 'o1'), intoOrganization('o2'))
		const commentsBefore = await count('note_comments')
		await expect(stores.comments.add(parent, 'lost')).rejects.toBeInstanceOf(NotFoundError)
		expect(await count('note_comments')).toBe(commentsBefore)
	})

	test('a destination that does not exist at all inserts nothing', async () => {
		const before = await count('notes')
		await expect(stores.notes.create(into('no-such-workspace'), { title: 'lost', body: null })).rejects.toBeInstanceOf(NotFoundError)
		expect(await count('notes')).toBe(before)
	})

	test('a read Ref cannot remove, even through a widened handle', async () => {
		const id = await createNote('w1', 'kept')
		const widened: { remove(ref: unknown): Promise<void> } = stores.notes
		await expect(widened.remove(note('notes.read', id, 'w1'))).rejects.toBeInstanceOf(CapabilityError)
		expect((await stores.notes.get(note('notes.read', id, 'w1'))).title).toBe('kept')
	})

	test('optimistic concurrency: the expected version wins, a stale one is 409, a missing object 404', async () => {
		const id = await createNote('w1', 'v1')
		expect(await stores.notes.update(note('notes.write', id, 'w1'), { title: 'v2' }, 1)).toEqual({ id, version: 2 })
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
		expect(moved).toEqual({ id, version: 2, chain: { workspace: 'w2', organization: 'o1' } })
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
		expect(Object.keys(added)).toEqual(['id'])
		expect(await stores.comments.get(note('notes.read', id, 'w1'), added.id)).toMatchObject({
			note_id: id,
			workspace_id: 'w1',
			organization_id: 'o1',
			body: 'hello',
		})
		await expect(stores.comments.get(note('notes.read', id, 'w2'), added.id)).rejects.toBeInstanceOf(NotFoundError)
		const otherNote = await createNote('w1', 'other')
		await expect(stores.comments.edit(note('notes.write', otherNote, 'w1'), added.id, 'hijacked')).rejects.toBeInstanceOf(NotFoundError)
		expect(await stores.comments.edit(note('notes.write', id, 'w1'), added.id, 'edited')).toEqual({ id: added.id })
		expect((await stores.comments.get(note('notes.read', id, 'w1'), added.id)).body).toBe('edited')
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
		await stores.notes.create(into('w3'), { title: 'a', body: null, word_count: 3 })
		await stores.notes.create(into('w3'), { title: 'b', body: null, word_count: 5 })
		expect(await stores.notes.countPerWorkspace(read(['w3']))).toEqual([{ workspace_id: 'w3', count: '2' }])
		const [words] = await stores.notes.words(read(['w3']))
		expect(words).toMatchObject({ count: '2', sum_word_count: '8', min_word_count: 3 })
		expect(words?.max_created_at).toBeInstanceOf(Date)
		expect(await stores.notes.words(read([]))).toEqual([])
	})

	test('contains matches % and _ literally, case-insensitively', async () => {
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

	test('a top-level table inserts the object the Ref names; a contained one lists by its container', async () => {
		expect(await stores.organizations.create(alice.ref('organization', 'organizations.create', 'o9'), 'Nine')).toEqual({ id: 'o9' })
		expect(await stores.organizations.list(alice.within('organization', 'notes.read', ['o9', 'o2']))).toEqual([{ id: 'o2', name: 'Two' }, {
			id: 'o9',
			name: 'Nine',
		}])
		const created = await stores.workspaces.create(alice.ref('organization', 'workspaces.create', 'o9'), 'Nine one')
		expect(await stores.workspaces.list(alice.within('organization', 'notes.read', ['o9']))).toEqual([{ id: created.id, name: 'Nine one' }])
		expect(await stores.workspaces.rename(workspaceAdmin(created.id, 'o9'), 'Renamed')).toEqual({ id: created.id })
		expect((await stores.workspaces.get(alice.ref('workspace', 'notes.read', created.id, { organization: 'o9' }))).name).toBe('Renamed')
	})

	test('the restricted column is written but never read back', async () => {
		const { id } = await stores.notes.create(into('w1'), { title: 'secretive', body: null, internal: 'only for admins' })
		expect(Object.keys(await stores.notes.get(note('notes.read', id, 'w1')))).not.toContain('internal')
		const stored = await admin((sql) => sql.unsafe(`select internal from ${schema}.notes where id = $1`, [id]))
		expect(stored[0]?.internal).toBe('only for admins')
	})
})
