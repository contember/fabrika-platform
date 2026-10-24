// A read-only invocation on SQLite holds no storage transaction across an await: each statement runs in a
// `transactionSync` of its own, which rolls back a statement that wrote. Over the bun:sqlite stand-in; workerd is not here.

import { beforeEach, describe, expect, test } from 'bun:test'
import { FromNode, SelectionNode, type SelectQueryNode, TableNode } from 'kysely'
import { type Database, InvocationTransaction, runFixedStatement, type Session } from '../database'
import { DatabaseError, QueryRefusedError } from '../errors'
import type { GuardContext } from '../guard'
import { acknowledgement, column, equals, insertNode, scopedWhere } from '../nodes'
import { openSqlite, type SqliteStorage } from '../sqlite'
import { type BunSqliteStorage, bunSqliteStorage } from '../sqlite-bun'

const SCHEMA = `
create table orgs (id text primary key) strict;
create table items (id text primary key, org text not null references orgs (id), title text not null) strict;
insert into orgs (id) values ('o1');
`

let storage: BunSqliteStorage
let database: Database
let transactions: number
let syncTransactions: number

/** The storage, counting the transactions the engine opens. */
function counting(inner: BunSqliteStorage): SqliteStorage {
	return {
		sql: inner.sql,
		transaction: (closure) => {
			transactions += 1
			return inner.transaction(closure)
		},
		transactionSync: (closure) => {
			syncTransactions += 1
			return inner.transactionSync(closure)
		},
	}
}

beforeEach(() => {
	storage = bunSqliteStorage()
	storage.sql.exec(SCHEMA)
	transactions = 0
	syncTransactions = 0
	database = openSqlite(counting(storage))
})

const scope = equals('items', 'org', 'o1')
const selectContext: GuardContext = { root: 'SelectQueryNode', table: 'items', joins: {}, scope }
const insertContext: GuardContext = { root: 'InsertQueryNode', table: 'items', joins: {}, scope: undefined }
const selectAll: SelectQueryNode = Object.freeze({
	kind: 'SelectQueryNode',
	from: FromNode.create([TableNode.create('items')]),
	selections: [SelectionNode.create(column('items', 'id'))],
	where: scopedWhere(undefined, scope),
})

async function readIds(session: Session): Promise<string[]> {
	const rows = await session.run<Readonly<Record<string, unknown>>>(selectAll, selectContext)
	return rows.map(({ id }) => String(id)).sort()
}

function storedIds(): string[] {
	return storage.sql.exec('select id from items order by id').toArray().map(({ id }) => String(id))
}

const insertItem = (into: Session, id: string): Promise<readonly unknown[]> =>
	runFixedStatement(into, "insert into items (id, org, title) values (?1, 'o1', ?1)", [id])

/** A write invocation from start to commit, as another request runs it. */
async function writeInvocation(id: string): Promise<void> {
	const invocation = new InvocationTransaction(database, false)
	await invocation.enclose(async () => {
		await insertItem(await invocation.session(), id)
		await invocation.commit()
	})
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('a read-only invocation on SQLite is not enclosed', () => {
	test('two reads across an await see a write another invocation committed between them', async () => {
		const invocation = new InvocationTransaction(database, true)
		const between = Promise.withResolvers<void>()
		const written = Promise.withResolvers<void>()
		const reading = invocation.enclose(async () => {
			const before = await readIds(await invocation.session())
			between.resolve()
			// An enclosed read would hold the write back until the read's work returned.
			await Promise.race([written.promise, tick(50)])
			const after = await readIds(await invocation.session())
			await invocation.commit()
			return { before, after }
		})
		// The write starts outside the read's async context, as another request's event does.
		await between.promise
		const write = writeInvocation('a').then(() => written.resolve())
		expect(await reading).toEqual({ before: [], after: ['a'] })
		await write
		expect(storedIds()).toEqual(['a'])
	})

	test('it opens no storage transaction: each statement runs in a transactionSync of its own', async () => {
		const invocation = new InvocationTransaction(database, true)
		await invocation.enclose(async () => {
			await readIds(await invocation.session())
			await tick(5)
			await readIds(await invocation.session())
			await invocation.commit()
		})
		expect(transactions).toBe(0)
		expect(syncTransactions).toBe(2)
		expect(invocation.ended).toBe(true)
		expect(invocation.released).toBe(true)
	})

	test('a write the data layer builds in a read-only session is refused, and nothing is written', async () => {
		const invocation = new InvocationTransaction(database, true)
		await invocation.enclose(async () => {
			const insert = insertNode('items', new Map(Object.entries({ id: 'a', org: 'o1', title: 'a' })), acknowledgement('items', 'id', undefined))
			await expect((await invocation.session()).run(insert, insertContext)).rejects.toMatchObject({ reason: 'read_only' })
			await invocation.rollback()
		})
		expect(storedIds()).toEqual([])
	})

	test('a raw write past the node guard is rolled back by its own statement transaction, and fails the invocation', async () => {
		const invocation = new InvocationTransaction(database, true)
		await expect(invocation.enclose(async () => {
			const write = insertItem(await invocation.session(), 'a')
			await expect(write).rejects.toBeInstanceOf(DatabaseError)
			await expect(write).rejects.toMatchObject({ sqlState: '25006' })
			expect(storedIds()).toEqual([])
			await invocation.commit()
		})).rejects.toThrow(QueryRefusedError)
		expect(storedIds()).toEqual([])
	})
})

describe('a write invocation on SQLite keeps its enclosure', () => {
	test('a handler that throws after writing, across an await, keeps nothing', async () => {
		const invocation = new InvocationTransaction(database, false)
		await expect(invocation.enclose(async () => {
			await insertItem(await invocation.session(), 'a')
			await tick(5)
			await insertItem(await invocation.session(), 'b')
			throw new Error('handler failed')
		})).rejects.toThrow('handler failed')
		expect(storedIds()).toEqual([])
		expect(transactions).toBe(1)
	})
})
