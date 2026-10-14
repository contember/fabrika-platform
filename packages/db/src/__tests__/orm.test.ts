// The mini-ORM on a REAL Postgres: the handles `ctx.db` holds, each running in one invocation's transaction. Skips
// cleanly (with a reason) when FABRIKA_TEST_POSTGRES_URL is unset:
//
//   docker run --rm -d -p 55433:5432 -e POSTGRES_PASSWORD=postgres postgres:17
//   FABRIKA_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres bun test packages/db/src/__tests__/orm.test.ts
//
// The handles are untyped here (the framework builds them); `orm-types.ts` types them for a handler.

import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { Database, type InvocationTransaction, runFixedStatement } from '../database'
import { CapabilityError, ConflictError, DatabaseError, NotFoundError, QueryRefusedError } from '../errors'
import { bindScopedDatabase, type DataAccess, dataAccessOf, type DataSite } from '../framework'
import type { DataKind, UnscopedMode } from '../orm-types'
import { scoped } from '../store'
import { TestAuthority } from './fixtures/authority'
import { migration } from './fixtures/schema'
import { tables } from './fixtures/tables'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR]
const hasPostgres = url !== undefined && url !== ''

if (!hasPostgres) {
	console.warn(`orm.test.ts skipped: set ${URL_VAR} to run the Postgres-backed tests`)
}

const schema = `orm_${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
const alice = new TestAuthority('user:alice')
let database: Database
let data: DataAccess

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
		await sql.unsafe(
			`insert into ${schema}.workspaces (id, organization_id, name, created_by) values ('w1', 'o1', 'W1', 'u'), ('w2', 'o1', 'W2', 'u'), ('w3', 'o2', 'W3', 'u')`,
		)
		await sql.unsafe(`insert into ${schema}.countries (code, name) values ('CZ', 'Czechia'), ('DE', 'Germany'), ('AT', 'Austria')`)
		await sql.unsafe(`alter table ${schema}.notes add constraint notes_body_allowed check (body is distinct from 'forbidden')`)
		await sql.unsafe(`alter table ${schema}.organizations add constraint organizations_name_once unique (name) deferrable initially deferred`)
	})
	database = Database.postgres({ url: url ?? '', schema, max: 4 })
	const layer = scoped(tables)
	bindScopedDatabase(layer, { database, capabilities: alice })
	data = dataAccessOf(layer)
})

afterAll(async () => {
	if (!hasPostgres) {
		return
	}
	await database.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

/** One invocation and the site its handles are made for, as the framework builds them for a handler. */
function invocation(kind: DataKind, unscoped: Readonly<Record<string, UnscopedMode>> = {}) {
	const transaction: InvocationTransaction = data.invocation(kind === 'query')
	const site: DataSite = {
		kind,
		unscoped,
		principal: 'user:alice',
		check() {
			if (transaction.ended) {
				throw new QueryRefusedError('ended', 'this invocation has ended')
			}
		},
		session: () => transaction.session(),
	}
	return { transaction, handles: data.handles(site) }
}

/** Calls `path` (`deals.list`, `get`) on an untyped handle, as a handler whose types were defeated would. */
async function call(handle: unknown, path: string, ...args: unknown[]): Promise<unknown> {
	const parts = path.split('.')
	const name = parts.pop() ?? ''
	const target = parts.reduce<unknown>((node, part) => (typeof node === 'object' && node !== null ? Reflect.get(node, part) : undefined), handle)
	const method: unknown = typeof target === 'object' && target !== null ? Reflect.get(target, name) : undefined
	if (typeof method !== 'function') {
		throw new TypeError(`${path} is not a method of the handle`)
	}
	return Reflect.apply(method, target, args)
}

const note = <const A extends string>(action: A, id: string, workspace = 'w1', organization = 'o1') =>
	alice.ref('note', action, id, { workspace, organization })
const inWorkspace = <const A extends string>(action: A, workspace = 'w1', organization = 'o1') =>
	alice.ref('workspace', action, workspace, { organization })

async function seedNote(title: string, workspace = 'w1', organization = 'o1', createdAt = new Date().toISOString()): Promise<string> {
	const id = Bun.randomUUIDv7()
	await admin((sql) =>
		sql.unsafe(
			`insert into ${schema}.notes (id, workspace_id, organization_id, title, body, internal, created_by, version, created_at) values ($1, $2, $3, $4, 'body', 'internal', 'u', 1, $5)`,
			[id, workspace, organization, title, createdAt],
		)
	)
	return id
}

/** `work` within `ms`, or the test fails: a leaked connection makes the next invocation wait for ever. */
function inTime<T>(ms: number, work: Promise<T>): Promise<T> {
	return Promise.race([
		work,
		Bun.sleep(ms).then((): never => {
			throw new Error(`still waiting after ${ms} ms`)
		}),
	])
}

async function row(table: string, id: string): Promise<Record<string, unknown> | undefined> {
	const [found] = await admin((sql) => sql.unsafe(`select * from ${schema}.${table} where id = $1`, [id]))
	return found
}

function keysOf(value: unknown): string[] {
	return typeof value === 'object' && value !== null ? Object.keys(value).sort() : []
}

function itemsOf(page: unknown): Record<string, unknown>[] {
	const items: unknown = typeof page === 'object' && page !== null ? Reflect.get(page, 'items') : undefined
	return Array.isArray(items) ? items : []
}

function nextOf(page: unknown): unknown {
	return typeof page === 'object' && page !== null ? Reflect.get(page, 'next') : undefined
}

describe.skipIf(!hasPostgres)('the mini-ORM on Postgres', () => {
	test('a write Ref reads its own row; every column of another read action is hidden', async () => {
		const id = await seedNote('own')
		const { transaction, handles } = invocation('mutation')
		const asWriter = await call(handles.target(note('notes.write', id), 'on'), 'get')
		const asDeleter = await call(handles.target(note('notes.delete', id), 'on'), 'get')
		const asReader = await call(handles.target(note('notes.read', id), 'on'), 'get')
		await transaction.commit()
		// `title` declares notes.read and `internal` notes.delete: each is read only by a capability of exactly that action.
		expect(keysOf(asWriter)).toEqual(['body', 'created_at', 'created_by', 'id', 'organization_id', 'version', 'word_count', 'workspace_id'])
		expect(keysOf(asDeleter)).toContain('internal')
		expect(keysOf(asDeleter)).not.toContain('title')
		expect(keysOf(asReader)).toContain('title')
		expect(keysOf(asReader)).not.toContain('internal')
	})

	test('a Ref whose action the table does not name reads nothing of it', async () => {
		const id = await seedNote('unnamed')
		const { transaction, handles } = invocation('query')
		await expect(call(handles.target(note('secrets.admin', id), 'on'), 'get')).rejects.toThrow("notes does not name the action 'secrets.admin'")
		await transaction.rollback()
	})

	test('two concurrent precondition writes: getForUpdate makes the second wait and see the first, which wins', async () => {
		const id = await seedNote('lead')
		const order: string[] = []
		const reopen = async (name: string, wait: Promise<void>) => {
			const { transaction, handles } = invocation('mutation')
			const target = handles.target(note('notes.write', id), 'on')
			try {
				await wait
				const current = await call(target, 'getForUpdate')
				order.push(`${name} locked`)
				const version = typeof current === 'object' && current !== null ? Reflect.get(current, 'version') : undefined
				if (version !== 1) {
					throw new ConflictError('the note changed since the caller read it')
				}
				await Bun.sleep(100)
				const saved = await call(target, 'update', { body: `reopened by ${name}` }, { expectVersion: 1 })
				order.push(`${name} commits`)
				await transaction.commit()
				return saved
			} catch (error) {
				await transaction.rollback()
				throw error
			}
		}
		const first = reopen('first', Promise.resolve())
		const second = reopen('second', Bun.sleep(30))
		const [won, lost] = await Promise.allSettled([first, second])
		expect(won).toEqual({ status: 'fulfilled', value: { id, version: 2 } })
		expect(lost.status).toBe('rejected')
		expect(order).toEqual(['first locked', 'first commits', 'second locked'])
		expect((await row('notes', id))?.['body']).toBe('reopened by first')
	})

	test('expectVersion: an update or a remove of a changed row is 409, of a missing one 404', async () => {
		const id = await seedNote('versioned')
		const { transaction, handles } = invocation('mutation')
		const target = handles.target(note('notes.write', id), 'on')
		await expect(call(target, 'update', { body: 'x' }, { expectVersion: 7 })).rejects.toBeInstanceOf(ConflictError)
		await transaction.rollback()
		const removal = invocation('mutation')
		const removable = removal.handles.target(note('notes.delete', id), 'on')
		await expect(call(removable, 'remove')).rejects.toThrow('take { expectVersion: number }')
		await removal.transaction.rollback()
		const conflict = invocation('mutation')
		await expect(call(conflict.handles.target(note('notes.delete', id), 'on'), 'remove', { expectVersion: 3 })).rejects.toBeInstanceOf(
			ConflictError,
		)
		await conflict.transaction.rollback()
		const gone = invocation('mutation')
		await expect(call(gone.handles.target(note('notes.delete', Bun.randomUUIDv7()), 'on'), 'remove', { expectVersion: 1 })).rejects
			.toBeInstanceOf(NotFoundError)
		await call(gone.handles.target(note('notes.delete', id), 'on'), 'remove', { expectVersion: 1 })
		await gone.transaction.commit()
		expect(await row('notes', id)).toBeUndefined()
	})

	test('every statement of an invocation is one transaction: a rollback keeps nothing, a commit keeps all', async () => {
		const id = await seedNote('atomic')
		const failed = invocation('mutation')
		const comments = failed.handles.target(note('notes.write', id), 'on')
		const comment = await call(comments, 'note_comments.insert', { body: 'kept only on commit' })
		await call(comments, 'update', { body: 'changed' }, { expectVersion: 1 })
		await failed.transaction.rollback()
		const commentId = typeof comment === 'object' && comment !== null ? String(Reflect.get(comment, 'id')) : ''
		expect(await row('note_comments', commentId)).toBeUndefined()
		expect((await row('notes', id))?.['version']).toBe(1)

		const kept = invocation('mutation')
		const target = kept.handles.target(note('notes.write', id), 'on')
		await call(target, 'note_comments.insert', { body: 'kept' })
		await call(target, 'update', { body: 'changed' }, { expectVersion: 1 })
		await kept.transaction.commit()
		expect((await row('notes', id))?.['version']).toBe(2)
	})

	test('a statement the database refused fails the commit, and nothing of the invocation is kept', async () => {
		const id = await seedNote('kept apart')
		const { transaction, handles } = invocation('mutation', { note_comments: 'write' })
		const target = handles.target(note('notes.write', id), 'on')
		const kept = await call(target, 'note_comments.insert', { body: 'before the failure' })
		// A refusal of the layer sends nothing, so the transaction stays usable.
		const stale = handles.target(alice.ref('workspace', 'notes.write', 'w1', { organization: 'o2' }), 'in')
		await expect(call(stale, 'notes.insert', { title: 'stale chain' })).rejects.toBeInstanceOf(NotFoundError)
		// A foreign key the database refuses aborts it: Postgres would answer the COMMIT with a ROLLBACK.
		const orphan = { body: 'no such note', note_id: 'missing', workspace_id: 'w1', organization_id: 'o1' }
		await expect(call(handles.unscoped, 'note_comments.insert', orphan)).rejects.toThrow()
		await expect(transaction.commit()).rejects.toThrow('a statement of this invocation failed')
		const commentId = typeof kept === 'object' && kept !== null ? String(Reflect.get(kept, 'id')) : ''
		expect(await row('note_comments', commentId)).toBeUndefined()
	})

	test('the transaction sets its idle timeout, and a query runs READ ONLY', async () => {
		const query = invocation('query')
		const [setting] = await runFixedStatement(await query.transaction.session(), 'show idle_in_transaction_session_timeout', [])
		expect(setting).toEqual({ idle_in_transaction_session_timeout: '30s' })
		const [mode] = await runFixedStatement(await query.transaction.session(), 'show transaction_read_only', [])
		expect(mode).toEqual({ transaction_read_only: 'on' })
		await query.transaction.commit()
	})

	test('a query cannot write, not even through unscoped, and locks nothing', async () => {
		const id = await seedNote('read only')
		const { transaction, handles } = invocation('query', { notes: 'write' })
		const target = handles.target(note('notes.write', id), 'on')
		await expect(call(target, 'update', { body: 'x' }, { expectVersion: 1 })).rejects.toThrow('update writes, so it runs only in a mutation')
		await expect(call(target, 'getForUpdate')).rejects.toThrow('getForUpdate locks the row, so it runs only in a mutation')
		await expect(call(target, 'note_comments.insert', { body: 'x' })).rejects.toThrow('insert writes, so it runs only in a mutation')
		await expect(call(handles.unscoped, 'notes.update', id, { body: 'x' }, { expectVersion: 1 })).rejects.toThrow('update writes')
		await transaction.commit()

		// A mutation's handles in a read-only transaction (an export's request) are refused by the session as well.
		const readOnly = data.invocation(true)
		const site: DataSite = { kind: 'mutation', unscoped: {}, principal: 'u', check() {}, session: () => readOnly.session() }
		await expect(call(data.handles(site).target(note('notes.write', id), 'on'), 'update', { body: 'x' }, { expectVersion: 1 })).rejects.toThrow(
			'this request is read-only',
		)
		await readOnly.rollback()
		expect((await row('notes', id))?.['body']).toBe('body')
	})

	test('a job reads outside its transaction and writes only inside it', async () => {
		const id = await seedNote('job')
		const outside: DataSite = { kind: 'job', unscoped: {}, principal: 'job:sweep', check() {}, session: async () => data.direct() }
		const target = data.handles(outside).target(note('notes.write', id), 'on')
		expect(keysOf(await call(target, 'get'))).toContain('body')
		await expect(call(target, 'update', { body: 'x' }, { expectVersion: 1 })).rejects.toThrow('a job writes inside ctx.transaction')
		await data.transaction(async (session) => {
			const inside: DataSite = { kind: 'mutation', unscoped: {}, principal: 'job:sweep', check() {}, session: async () => session }
			await call(data.handles(inside).target(note('notes.write', id), 'on'), 'update', { body: 'swept' }, { expectVersion: 1 })
		})
		expect((await row('notes', id))?.['body']).toBe('swept')
	})

	test('a captured handle refuses once its invocation ended, before it reads its arguments', async () => {
		const id = await seedNote('captured')
		const { transaction, handles } = invocation('mutation', { notes: 'read' })
		const target = handles.target(note('notes.write', id), 'on')
		await transaction.commit()
		await expect(call(target, 'get')).rejects.toThrow('this invocation has ended')
		await expect(call(handles.reference, 'countries.list')).rejects.toThrow('this invocation has ended')
		await expect(call(handles.unscoped, 'notes.list')).rejects.toThrow('this invocation has ended')
		expect(() => handles.target(note('notes.write', id), 'on')).toThrow('this invocation has ended')
		await expect(transaction.session()).rejects.toThrow('this invocation has ended')
	})

	test('a list pages by keyset in the order asked, and never orders or filters by a hidden column', async () => {
		await admin((sql) => sql.unsafe(`insert into ${schema}.workspaces (id, organization_id, name, created_by) values ('wp', 'o1', 'WP', 'u')`))
		const titles = ['b', 'a', 'c', 'a', 'b']
		for (const title of titles) {
			await seedNote(title, 'wp')
		}
		const { transaction, handles } = invocation('query')
		const within = handles.within(alice.within('workspace', 'notes.read', ['wp']))
		const seen: string[] = []
		let after: unknown
		do {
			const page = await call(within, 'notes.list', { orderBy: [['title', 'desc']], limit: 2, ...(after === undefined ? {} : { after }) })
			seen.push(...itemsOf(page).map((item) => String(item['title'])))
			after = nextOf(page) ?? undefined
		} while (after !== undefined)
		expect(seen).toEqual(['c', 'b', 'b', 'a', 'a'])
		expect(await call(within, 'notes.count', { where: [['title', '=', 'a']] })).toBe(2)
		expect(await call(within, 'notes.aggregate', { groupBy: ['title'], count: true })).toHaveLength(3)
		await expect(call(within, 'notes.list', { orderBy: [['internal', 'asc']] })).rejects.toThrow('internal is not a column of notes')
		await expect(call(within, 'notes.list', { where: [['internal', '=', 'x']] })).rejects.toThrow('internal is not a column of notes')
		await expect(call(within, 'notes.list', { after: 'not a cursor' })).rejects.toThrow('after takes the next cursor')
		await expect(call(within, 'notes.list', { offset: 2 })).rejects.toThrow('offset is not an option of list')
		await expect(call(within, 'notes.list', { limit: 501 })).rejects.toThrow('limit must be an integer from 1 to 500')
		expect(keysOf(within)).toEqual(['note_comments', 'note_flags', 'notes'])
		await transaction.commit()
	})

	test('a Within reads its own values only, and a list needs the table read action', async () => {
		const mine = await seedNote('mine', 'w1')
		const theirs = await seedNote('theirs', 'w2')
		const { transaction, handles } = invocation('query')
		const page = await call(handles.within(alice.within('workspace', 'notes.read', ['w1'])), 'notes.list', { limit: 500 })
		const ids = itemsOf(page).map((item) => item['id'])
		expect(ids).toContain(mine)
		expect(ids).not.toContain(theirs)
		expect(await call(handles.within(alice.within('workspace', 'notes.read', [])), 'notes.list')).toEqual({ items: [], next: null })
		await expect(call(handles.within(alice.within('workspace', 'notes.write', ['w1'])), 'notes.list')).rejects.toBeInstanceOf(CapabilityError)
		await transaction.commit()
	})

	test('in: the container lists and inserts the tables it contains, stamping the chain from its Ref', async () => {
		const { transaction, handles } = invocation('mutation')
		const workspace = handles.target(inWorkspace('notes.write'), 'in')
		const saved = await call(workspace, 'notes.insert', { title: 'from in', body: null })
		const id = typeof saved === 'object' && saved !== null ? String(Reflect.get(saved, 'id')) : ''
		await expect(call(workspace, 'update', { name: 'x' })).rejects.toThrow('update acts on one object: declare access with on')
		await expect(call(workspace, 'getForUpdate')).rejects.toThrow('getForUpdate locks one object: declare access with on')
		await transaction.commit()
		expect(await row('notes', id)).toMatchObject({ workspace_id: 'w1', organization_id: 'o1', created_by: 'user:alice', version: 1 })

		const reading = invocation('query')
		const listed = await call(reading.handles.target(inWorkspace('notes.read'), 'in'), 'notes.list', { limit: 500 })
		expect(itemsOf(listed).map((item) => item['id'])).toContain(id)
		await reading.transaction.commit()
	})

	test('a top-level scope inserts its own row under in, keyed by the scope value', async () => {
		const { transaction, handles } = invocation('mutation')
		const created = handles.target(alice.ref('organization', 'organizations.create', 'o-new'), 'in')
		expect(await call(created, 'organizations.insert', { name: 'New' })).toEqual({ id: 'o-new' })
		await transaction.commit()
		expect(await row('organizations', 'o-new')).toEqual({ id: 'o-new', name: 'New' })
	})

	test('child rows under the target: list and get by the action the child names', async () => {
		const id = await seedNote('with comments')
		const { transaction, handles } = invocation('mutation')
		const target = handles.target(note('notes.write', id), 'on')
		const comment = await call(target, 'note_comments.insert', { body: 'first' })
		const commentId = typeof comment === 'object' && comment !== null ? String(Reflect.get(comment, 'id')) : ''
		expect(await call(target, 'note_comments.get', commentId)).toMatchObject({ body: 'first', note_id: id })
		expect(itemsOf(await call(target, 'note_comments.list'))).toHaveLength(1)
		await call(target, 'note_comments.update', commentId, { body: 'edited' })
		await transaction.commit()
		expect((await row('note_comments', commentId))?.['body']).toBe('edited')
	})

	test('reference tables: every site reads them through their read action, and none writes them', async () => {
		const { transaction, handles } = invocation('mutation')
		const page = await call(handles.reference, 'countries.list', { orderBy: [['name', 'asc']] })
		expect(itemsOf(page).map((item) => item['code'])).toEqual(['AT', 'CZ', 'DE'])
		expect(await call(handles.reference, 'countries.count')).toBe(3)
		expect(keysOf(handles.reference)).toEqual(['countries'])
		await transaction.commit()
	})

	test('an application table read from a scoped site: every row by its read action, read-only, refused for another action', async () => {
		const id = `setting-${Bun.randomUUIDv7()}`
		await admin((sql) => sql.unsafe(`insert into ${schema}.settings (id, value) values ($1, 'on')`, [id]))
		const { transaction, handles } = invocation('mutation')
		const within = handles.app(alice.within('workspace', 'settings.read', ['w1']))
		expect(keysOf(within)).toEqual(['settings'])
		expect(itemsOf(await call(within, 'settings.list', { limit: 500 })).map((item) => item['id'])).toContain(id)
		expect(await call(within, 'settings.get', id)).toEqual({ id, value: 'on' })
		expect(await call(within, 'settings.count', { where: [['id', '=', id]] })).toBe(1)
		expect(await call(within, 'settings.aggregate', { groupBy: ['id'], count: true })).toContainEqual({ id, count: '1' })
		const onNote = handles.app(note('settings.read', await seedNote('reads settings')))
		expect(await call(onNote, 'settings.get', id)).toEqual({ id, value: 'on' })
		for (const method of ['insert', 'update', 'remove', 'getForUpdate']) {
			expect(Reflect.get(Reflect.get(onNote, 'settings'), method)).toBeUndefined()
		}
		const other = handles.app(note('notes.read', await seedNote('reads no settings')))
		await expect(call(other, 'settings.list')).rejects.toThrow(
			'a scoped site reads settings with its read action settings.read only; the capability holds notes.read',
		)
		await expect(call(other, 'settings.get', id)).rejects.toBeInstanceOf(CapabilityError)
		await expect(call(handles.app(alice.within('workspace', 'settings.edit', ['w1'])), 'settings.count')).rejects.toBeInstanceOf(CapabilityError)
		await transaction.commit()
	})

	test('an app capability reads every row of a dimension table with an action of its appRead, and only counts with one of its appCount', async () => {
		const elsewhere = await seedNote('exported from another organization', 'w3', 'o2')
		const { transaction, handles } = invocation('mutation')
		const exporting = handles.app(alice.app('notes.export'))
		expect(itemsOf(await call(exporting, 'notes.list', { limit: 500 })).map((item) => item['id'])).toContain(elsewhere)
		expect(await call(exporting, 'notes.count', { where: [['id', '=', elsewhere]] })).toBe(1)
		const counting = handles.app(alice.app('notes.count'))
		expect(await call(counting, 'notes.count', { where: [['id', '=', elsewhere]] })).toBe(1)
		expect(await call(counting, 'notes.aggregate', { groupBy: ['workspace_id'], count: true })).toContainEqual({ workspace_id: 'w3', count: '1' })
		await expect(call(counting, 'notes.list')).rejects.toThrow(
			'an app capability of notes.count only counts notes (its appCount): it reads no row, so list and a scope fragment need its read action notes.read or one of its appRead (notes.export)',
		)
		expect(Reflect.get(Reflect.get(counting, 'notes'), 'get')).toBeUndefined()
		const other = handles.app(alice.app('notes.write'))
		await expect(call(other, 'notes.count')).rejects.toThrow(
			'an app capability of notes.write does not reach notes: ctx.db.app lists it for its read action notes.read or one of its appRead (notes.export) only',
		)
		await expect(call(handles.app(alice.app('notes.export')), 'note_comments.list')).rejects.toBeInstanceOf(CapabilityError)
		await transaction.commit()
	})

	test('unscoped: only the declared tables, scope predicate true, the mode enforced, containment named on insert', async () => {
		const elsewhere = await seedNote('in another organization', 'w3', 'o2')
		const { transaction, handles } = invocation('mutation', { notes: 'read', note_comments: 'write' })
		expect(keysOf(handles.unscoped)).toEqual(['note_comments', 'notes'])
		expect(await call(handles.unscoped, 'notes.get', elsewhere)).toMatchObject({ title: 'in another organization', organization_id: 'o2' })
		expect(keysOf(await call(handles.unscoped, 'notes.get', elsewhere))).not.toContain('internal')
		await expect(call(handles.unscoped, 'notes.insert', { title: 'x' })).rejects.toThrow(
			"notes is declared unscoped: 'read', so insert needs unscoped: { notes: 'write' }",
		)
		await expect(call(handles.unscoped, 'note_comments.insert', { body: 'x', note_id: elsewhere })).rejects.toThrow(
			'an unscoped insert into note_comments names its containment',
		)
		const saved = await call(handles.unscoped, 'note_comments.insert', {
			body: 'across scopes',
			note_id: elsewhere,
			workspace_id: 'w3',
			organization_id: 'o2',
		})
		await transaction.commit()
		const commentId = typeof saved === 'object' && saved !== null ? String(Reflect.get(saved, 'id')) : ''
		expect(await row('note_comments', commentId)).toMatchObject({ note_id: elsewhere, organization_id: 'o2' })
		expect(invocation('query').handles.unscoped).toBeUndefined()
		expect(() => invocation('mutation', { fabrika_job_leases: 'read' })).toThrow('is a framework table')
		expect(() => invocation('mutation', { deals: 'read' })).toThrow('not a table of src/db/tables.ts')
	})

	test('a statement the database refuses throws only its SQLSTATE: no driver detail, no row, no hidden column', async () => {
		const id = await seedNote('constrained')
		await admin((sql) => sql.unsafe(`update ${schema}.notes set internal = 'hidden-secret-value' where id = $1`, [id]))
		const { transaction, handles } = invocation('mutation')
		const refused = await call(handles.target(note('notes.write', id), 'on'), 'update', { body: 'forbidden' }, { expectVersion: 1 }).then(
			() => undefined,
			(error: unknown) => error,
		)
		await transaction.rollback()
		expect(refused).toBeInstanceOf(DatabaseError)
		expect(refused instanceof DatabaseError ? refused.sqlState : null).toBe('23514')
		const exposed = JSON.stringify(refused, Object.getOwnPropertyNames(refused))
		expect(exposed).not.toContain('hidden-secret-value')
		expect(exposed).not.toContain('forbidden')
		for (const field of ['cause', 'detail', 'hint', 'where', 'table', 'constraint']) {
			expect(Object.getOwnPropertyNames(refused)).not.toContain(field)
		}
	})

	test('a failed COMMIT still releases the connection: the next invocation on a one-connection pool runs', async () => {
		const single = Database.postgres({ url: url ?? '', schema, max: 1 })
		const layer = scoped(tables)
		bindScopedDatabase(layer, { database: single, capabilities: alice })
		const one = dataAccessOf(layer)
		const site = (transaction: InvocationTransaction): DataSite => ({
			kind: 'mutation',
			unscoped: {},
			principal: 'user:alice',
			check() {},
			session: () => transaction.session(),
		})
		try {
			// The deferred unique key is checked at COMMIT, which the database refuses.
			const twins = one.invocation(false)
			for (const value of ['twin-a', 'twin-b']) {
				await call(one.handles(site(twins)).target(alice.ref('organization', 'organizations.create', value), 'in'), 'organizations.insert', {
					name: 'Twin',
				})
			}
			const failed = await twins.commit().then(() => undefined, (error: unknown) => error)
			expect(failed).toBeInstanceOf(DatabaseError)
			expect(JSON.stringify(failed, Object.getOwnPropertyNames(failed))).not.toContain('Twin')
			await twins.rollback()
			expect(twins.released).toBe(true)
			const next = one.invocation(true)
			expect(await inTime(3000, call(one.handles(site(next)).reference, 'countries.count'))).toBe(3)
			await next.commit()
		} finally {
			await single.close()
		}
		const twins: unknown[] = await admin((sql) => sql.unsafe(`select id from ${schema}.organizations where name = 'Twin'`))
		expect(twins).toEqual([])
	})

	test('a connection the database ends inside the transaction fails the COMMIT and still goes back to the pool', async () => {
		const child = Bun.spawn(['bun', join(import.meta.dir, 'fixtures', 'connection-loss.ts')], { stdout: 'pipe', stderr: 'ignore' })
		const lines = (await new Response(child.stdout).text()).trim().split('\n')
		expect(await child.exited).toBe(0)
		expect(lines).toEqual(['commit: DatabaseError', 'released: true', 'next: [{"one":1}]'])
	})

	test('a write Ref pages its subtree by its key, and a write answers only the key and the version', async () => {
		await admin((sql) => sql.unsafe(`insert into ${schema}.workspaces (id, organization_id, name, created_by) values ('ww', 'o1', 'WW', 'u')`))
		const ids = [await seedNote('w-one', 'ww'), await seedNote('w-two', 'ww'), await seedNote('w-three', 'ww')]
		const { transaction, handles } = invocation('mutation')
		const workspace = handles.target(inWorkspace('notes.write', 'ww'), 'in')
		const seen: unknown[] = []
		let after: unknown
		do {
			const page = await call(workspace, 'notes.list', { limit: 1, ...(after === undefined ? {} : { after }) })
			for (const item of itemsOf(page)) {
				expect(Object.keys(item)).not.toContain('title')
				seen.push(item['id'])
			}
			after = nextOf(page) ?? undefined
		} while (after !== undefined)
		expect(seen).toEqual([...ids].sort())
		const saved = await call(handles.target(note('notes.write', ids[0] ?? '', 'ww'), 'on'), 'update', { body: 'x' }, { expectVersion: 1 })
		expect(keysOf(saved)).toEqual(['id', 'version'])
		await transaction.commit()
	})

	test('a timestamp cursor keeps its microseconds: rows within one millisecond page once each', async () => {
		await admin((sql) => sql.unsafe(`insert into ${schema}.workspaces (id, organization_id, name, created_by) values ('wt', 'o1', 'WT', 'u')`))
		const first = await seedNote('first', 'wt', 'o1', '2026-10-11 10:00:00.123456+00')
		const second = await seedNote('second', 'wt', 'o1', '2026-10-11 10:00:00.123789+00')
		const { transaction, handles } = invocation('query')
		const within = handles.within(alice.within('workspace', 'notes.read', ['wt']))
		const seen: unknown[] = []
		let after: unknown
		for (let page = 0; page < 4; page++) {
			const listed = await call(within, 'notes.list', { orderBy: [['created_at', 'asc']], limit: 1, ...(after === undefined ? {} : { after }) })
			seen.push(...itemsOf(listed).map((item) => item['id']))
			after = nextOf(listed) ?? undefined
			if (after === undefined) {
				break
			}
		}
		await transaction.commit()
		expect(seen).toEqual([first, second])
	})
})
