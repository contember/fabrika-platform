// An application table read with `'any'`, on SQLite: every `app` capability but a public procedure's reads it, whatever
// its action, unconditioned and without a column of another read action; a public procedure and a scoped site are
// refused; a `when` narrows only the writes of its action; `ctx.sql.scope` follows the same rule.

import { beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { CapabilityError, QueryRefusedError } from '../errors'
import { bindScopedDatabase, type DataAccess, dataAccessOf, type DataHandles, type DataSite } from '../framework'
import type { DataKind, PublicApplicationTables, ScopedApplicationTables } from '../orm-types'
import { defineTables } from '../policy'
import { openSqlite } from '../sqlite'
import { bunSqliteStorage } from '../sqlite-bun'
import { scoped } from '../store'
import type { ApplicationTables, DbIndex, Tables, Unavailable } from '../tables'
import type { TypedColumnList } from '../vocabulary-tables'
import { TestAuthority } from './fixtures/authority'

const vocabulary = {
	app: 'board',
	dimensions: { workspace: {} },
	actions: {
		'notices.edit': 'Edit the open notices',
		'notices.audit': 'Read the internal notes',
		'reports.run': 'Run the reports',
		'intake.submit': 'Submit a notice anonymously',
		'notes.read': 'Read notes',
	},
	roles: {},
} as const

interface DB {
	notices: { id: string; body: string; status: string; internal: string }
}

const columns: TypedColumnList<DB> = {
	notices: { columns: ['id', 'body', 'status', 'internal'], foreignKeys: [], notNull: ['id', 'body', 'status', 'internal'] },
}

const tables = defineTables(vocabulary, columns)({
	notices: {
		scope: { app: 'notices of the whole board' },
		actions: { read: 'any', insert: ['notices.edit', 'intake.submit'], update: 'notices.edit' },
		insert: ['body', 'status', 'internal'],
		update: ['body'],
		columns: { internal: { read: 'notices.audit' } },
		when: { 'notices.edit': { status: { eq: 'open' } } },
	},
})

type Policies = typeof tables extends Tables<DB, infer P> ? P : never
type Index = DbIndex<DB, Policies>
type Expect<T extends true> = T
type Listed<A extends string> = ApplicationTables<Index, A, 'query'>['notices']['list'] extends
	(...args: never[]) => Promise<{ readonly items: readonly (infer R)[] }> ? R : never

/** What each site's types make of the table: read by any `app` action, refused to a public procedure and a scoped site. */
export type ReadAnyTypes = [
	Expect<'body' extends keyof Listed<'reports.run'> ? true : false>,
	Expect<'internal' extends keyof Listed<'reports.run'> ? false : true>,
	Expect<'internal' extends keyof Listed<'notices.audit'> ? true : false>,
	Expect<
		PublicApplicationTables<Index, 'intake.submit', 'query'>['notices']['get'] extends
			Unavailable<"a public procedure does not read notices: it is read with 'any', which an app endpoint, a job and a webhook hold"> ? true
			: false
	>,
	Expect<
		ScopedApplicationTables<Index, 'notes.read'>['notices'] extends
			Unavailable<"a scoped endpoint does not read notices: it is read with 'any', which an app endpoint, a job and a webhook hold"> ? true
			: false
	>,
]

const alice = new TestAuthority('user:alice')
let data: DataAccess

beforeEach(async () => {
	const storage = bunSqliteStorage()
	storage.sql.exec('create table notices (id text not null primary key, body text not null, status text not null, internal text not null)')
	storage.sql.exec("insert into notices (id, body, status, internal) values ('n1', 'open one', 'open', 'x'), ('n2', 'closed one', 'closed', 'y')")
	const layer = scoped(tables)
	bindScopedDatabase(layer, { database: openSqlite(storage), capabilities: alice })
	data = dataAccessOf(layer)
})

async function invoke<T>(kind: DataKind, work: (handles: DataHandles) => Promise<T>, publicSite = false): Promise<T> {
	const transaction = data.invocation(kind === 'query')
	const site: DataSite = {
		kind,
		unscoped: {},
		principal: 'user:alice',
		...(publicSite ? { public: true } : {}),
		check() {
			if (transaction.ended) {
				throw new QueryRefusedError('ended', 'this invocation has ended')
			}
		},
		session: () => transaction.session(),
	}
	try {
		const result = await work(data.handles(site))
		await transaction.commit()
		return result
	} catch (error) {
		await transaction.rollback()
		throw error
	}
}

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

function idsOf(page: unknown): string[] {
	const items: unknown = typeof page === 'object' && page !== null ? Reflect.get(page, 'items') : undefined
	return Array.isArray(items) ? items.map((item: unknown) => String(Reflect.get(Object(item), 'id'))).sort() : []
}

describe("an application table read with 'any'", () => {
	test('an app capability of an action the table does not name lists, counts and gets every row, without a column of another read action', async () => {
		await invoke('query', async (db) => {
			const reports = db.app(alice.app('reports.run'))
			expect(idsOf(await call(reports, 'notices.list'))).toEqual(['n1', 'n2'])
			expect(await call(reports, 'notices.count')).toBe(2)
			expect(await call(reports, 'notices.get', 'n2')).toEqual({ id: 'n2', body: 'closed one', status: 'closed' })
			expect(await call(db.app(alice.app('notices.audit')), 'notices.get', 'n1')).toMatchObject({ internal: 'x' })
		})
	})

	test('a when of an action narrows only its writes: its holder reads every row and updates only the open ones', async () => {
		await invoke('mutation', async (db) => {
			const editor = db.app(alice.app('notices.edit'))
			expect(idsOf(await call(editor, 'notices.list'))).toEqual(['n1', 'n2'])
			expect(await call(editor, 'notices.get', 'n2')).toMatchObject({ status: 'closed' })
			await call(editor, 'notices.update', 'n1', { body: 'edited' })
			await expect(call(editor, 'notices.update', 'n2', { body: 'edited' })).rejects.toThrow('notices not found')
		})
	})

	test('writes keep their actions: an action the table does not name inserts and updates nothing', async () => {
		await invoke('mutation', async (db) => {
			const reports = db.app(alice.app('reports.run'))
			await expect(call(reports, 'notices.insert', { body: 'b', status: 'open', internal: '' })).rejects.toBeInstanceOf(CapabilityError)
			await expect(call(reports, 'notices.update', 'n1', { body: 'b' })).rejects.toBeInstanceOf(CapabilityError)
		})
	})

	test('a public procedure inserts under its action and reads nothing', async () => {
		await invoke(
			'mutation',
			async (db) => {
				const intake = db.app(alice.publicApp('intake.submit'))
				await call(intake, 'notices.insert', { body: 'anonymous', status: 'open', internal: '' })
				for (const read of ['list', 'count']) {
					await expect(call(intake, `notices.${read}`)).rejects.toThrow(
						"a public procedure does not read notices: it is read with 'any', which an app endpoint, a job and a webhook hold",
					)
				}
				await expect(call(intake, 'notices.get', 'n1')).rejects.toBeInstanceOf(CapabilityError)
			},
			true,
		)
	})

	test('a scoped site reads nothing of it, through a Ref or a Within', async () => {
		await invoke('query', async (db) => {
			for (const capability of [alice.within('workspace', 'notes.read', ['w1']), alice.ref('workspace', 'notes.read', 'w1')]) {
				await expect(call(db.app(capability), 'notices.list')).rejects.toThrow(
					"a scoped site does not read notices: it is read with 'any', which an app endpoint, a job and a webhook hold",
				)
				await expect(call(db.app(capability), 'notices.get', 'n1')).rejects.toBeInstanceOf(CapabilityError)
			}
		})
	})

	test('ctx.sql.scope reads every row with an app capability, and refuses a public procedure and a scoped site', async () => {
		const transaction = data.invocation(true)
		const sql = data.sql({ mode: 'read', check() {}, session: () => transaction.session(), fail: () => transaction.fail() })
		const Id = z.object({ id: z.string() })
		const rows = await sql(Id)`select id from notices where ${sql.scope(alice.app('reports.run'), 'notices')} order by id`
		expect(rows).toEqual([{ id: 'n1' }, { id: 'n2' }])
		expect(() => sql.scope(alice.publicApp('intake.submit'), 'notices')).toThrow(CapabilityError)
		expect(() => sql.scope(alice.within('workspace', 'notes.read', ['w1']), 'notices')).toThrow(CapabilityError)
		await transaction.rollback()
	})
})
