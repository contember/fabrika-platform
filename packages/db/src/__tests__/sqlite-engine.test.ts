// The SQLite engine of the data layer over a bun:sqlite stand-in for a Durable Object's storage: its transactions,
// its forms of LIKE, of the lock modifiers and of bound values, and its constraint errors. workerd itself is not here.

import { beforeEach, describe, expect, test } from 'bun:test'
import {
	BinaryOperationNode,
	FromNode,
	type OperationNode,
	OperatorNode,
	SelectionNode,
	type SelectQueryNode,
	SqliteQueryCompiler,
	TableNode,
	ValueNode,
} from 'kysely'
import {
	type Database,
	InvocationTransaction,
	runFixedStatement,
	type Session,
	sessionOf,
	TRANSACTION_HELD_LOG_MS,
	TRANSACTION_HELD_REPORT_MS,
} from '../database'
import { DatabaseError, QueryRefusedError } from '../errors'
import type { GuardContext } from '../guard'
import { acknowledgement, column, containsPattern, equals, insertNode, lockNode, scopedWhere } from '../nodes'
import { openSqlite, type SqliteStorage } from '../sqlite'
import { type BunSqliteStorage, bunSqliteStorage } from '../sqlite-bun'

const SCHEMA = `
create table orgs (id text primary key) strict;
create table items (
	id text primary key,
	org text not null references orgs (id),
	title text not null unique check (length(title) <= 20),
	done integer,
	at text,
	n integer
) strict;
insert into orgs (id) values ('o1');
`

let storage: BunSqliteStorage
let statements: string[]
let database: Database
let session: Session

/** The storage, recording every statement the engine sends. */
function recording(inner: BunSqliteStorage): SqliteStorage {
	return {
		sql: {
			exec: (query, ...bindings) => {
				statements.push(query)
				return inner.sql.exec(query, ...bindings)
			},
		},
		transaction: (closure) => inner.transaction(closure),
		transactionSync: (closure) => inner.transactionSync(closure),
	}
}

beforeEach(() => {
	storage = bunSqliteStorage()
	storage.sql.exec(SCHEMA)
	statements = []
	database = openSqlite(recording(storage))
	session = sessionOf({ database })
})

const insertItem = (target: Session, id: string, title: string): Promise<readonly unknown[]> =>
	runFixedStatement(target, "insert into items (id, org, title) values (?, 'o1', ?)", [id, title])

function ids(): string[] {
	return storage.sql.exec('select id from items order by id').toArray().map(({ id }) => String(id))
}

const scope = equals('items', 'org', 'o1')
const selectContext: GuardContext = { root: 'SelectQueryNode', table: 'items', joins: {}, scope }

function selectIds(where: OperationNode): SelectQueryNode {
	return Object.freeze({
		kind: 'SelectQueryNode',
		from: FromNode.create([TableNode.create('items')]),
		selections: [SelectionNode.create(column('items', 'id'))],
		where: scopedWhere(where, scope),
	})
}

async function matching(operator: 'ilike' | 'not ilike', text: string): Promise<string[]> {
	const where = BinaryOperationNode.create(column('items', 'title'), OperatorNode.create(operator), ValueNode.create(containsPattern(text)))
	const rows = await session.run<{ id: string }>(selectIds(where), selectContext)
	return rows.map((row) => row.id).sort()
}

async function failure(work: Promise<unknown>): Promise<unknown> {
	try {
		await work
	} catch (error) {
		return error
	}
	throw new Error('expected the work to fail')
}

describe('transactions', () => {
	test('a transaction that throws after an await rolls back everything it wrote', async () => {
		const error = await failure(session.transaction(async (tx) => {
			await insertItem(tx, 'i1', 'one')
			await Bun.sleep(1)
			await insertItem(tx, 'i2', 'two')
			throw new Error('the handler failed')
		}))
		expect(error).toBeInstanceOf(Error)
		expect(ids()).toEqual([])
	})

	test('a transaction that resolves commits', async () => {
		const answer = await session.transaction(async (tx) => {
			await insertItem(tx, 'i1', 'one')
			await Bun.sleep(1)
			await insertItem(tx, 'i2', 'two')
			return 'done'
		})
		expect(answer).toBe('done')
		expect(ids()).toEqual(['i1', 'i2'])
	})

	test('a nested transaction runs in the outer one', async () => {
		const error = await failure(session.transaction(async (outer) => {
			await outer.transaction(async (inner) => {
				expect(inner).toBe(outer)
				await insertItem(inner, 'i1', 'one')
			})
			expect(ids()).toEqual(['i1'])
			throw new Error('the outer work failed')
		}))
		expect(error).toBeInstanceOf(Error)
		expect(ids()).toEqual([])
	})

	test('two transactions run one after the other', async () => {
		const order: string[] = []
		const first = session.transaction(async (tx) => {
			order.push('first begins')
			await insertItem(tx, 'i1', 'one')
			await Bun.sleep(5)
			order.push('first ends')
		})
		const second = session.transaction(async (tx) => {
			order.push('second begins')
			await insertItem(tx, 'i2', 'two')
		})
		await Promise.all([first, second])
		expect(order).toEqual(['first begins', 'first ends', 'second begins'])
		expect(ids()).toEqual(['i1', 'i2'])
	})
})

describe('like', () => {
	beforeEach(async () => {
		const titles = { percent: 'a%b', any: 'axb', underscore: 'a_b', backslash: 'a\\b', upper: 'ABC' }
		for (const [id, title] of Object.entries(titles)) {
			await insertItem(session, id, title)
		}
	})

	test("the pattern's %, _ and \\ match literally", async () => {
		expect(await matching('ilike', '%')).toEqual(['percent'])
		expect(await matching('ilike', '_')).toEqual(['underscore'])
		expect(await matching('ilike', '\\')).toEqual(['backslash'])
		expect(statements.at(-1)).toContain(" like ? escape '\\'")
	})

	test('ilike is case-insensitive for ASCII, and not ilike its complement', async () => {
		expect(await matching('ilike', 'abc')).toEqual(['upper'])
		expect(await matching('not ilike', 'B')).toEqual([])
		expect(await matching('not ilike', 'x')).toEqual(['backslash', 'percent', 'underscore', 'upper'])
		expect(statements.at(-1)).toContain(" not like ? escape '\\'")
	})
})

describe('locks', () => {
	test('a locked select runs without its lock modifier', async () => {
		await insertItem(session, 'i1', 'one')
		const rows = await session.transaction((tx) =>
			tx.run<{ id: string }>(lockNode('items', 'id', scope, 'update'), { ...selectContext, lock: 'update' })
		)
		expect(rows).toEqual([{ id: 'i1' }])
		const sql = statements.at(-1) ?? ''
		expect(sql).toStartWith('select')
		expect(sql).not.toContain('for update')
		expect(sql).not.toContain('for share')
	})
})

describe('binding', () => {
	const insertContext: GuardContext = { root: 'InsertQueryNode', table: 'items', joins: {}, scope: undefined }
	const insertValues = (values: Record<string, string | number | bigint | boolean | Date>) =>
		session.run(
			insertNode('items', new Map(Object.entries({ id: 'i1', org: 'o1', title: 'one', ...values })), acknowledgement('items', 'id', undefined)),
			insertContext,
		)

	test('a Date binds as ISO text, a boolean as 1 or 0, a safe bigint as a number', async () => {
		const at = new Date('2026-03-04T05:06:07.891Z')
		expect(await insertValues({ at, done: true, n: 9_007_199_254_740_991n })).toEqual([{ id: 'i1' }])
		await session.run(
			insertNode('items', new Map(Object.entries({ id: 'i2', org: 'o1', title: 'two', done: false })), acknowledgement('items', 'id', undefined)),
			insertContext,
		)
		expect(storage.sql.exec('select id, at, done, n from items order by id').toArray()).toEqual([
			{ id: 'i1', at: '2026-03-04T05:06:07.891Z', done: 1, n: 9_007_199_254_740_991 },
			{ id: 'i2', at: null, done: 0, n: null },
		])
	})

	test('an invalid Date and an unsafe bigint are refused before they reach the database', async () => {
		const refused: Record<string, Date | bigint>[] = [{ at: new Date(Number.NaN) }, { n: 9_007_199_254_740_992n }]
		for (const values of refused) {
			const error = await failure(insertValues(values))
			expect(error).toBeInstanceOf(QueryRefusedError)
			expect(error instanceof QueryRefusedError && error.reason).toBe('invalid_value')
		}
		expect(statements).toEqual([])
		expect(ids()).toEqual([])
	})
})

describe('constraint errors', () => {
	const SECRET = 'secret-row-value'

	async function refusal(text: string, parameters: (string | null)[]): Promise<DatabaseError> {
		const error = await failure(runFixedStatement(session, text, parameters))
		if (!(error instanceof DatabaseError)) {
			throw new Error('expected a DatabaseError')
		}
		expect(error.message).not.toContain(SECRET)
		expect(error.message).not.toContain('items')
		return error
	}

	test('each constraint failure maps to its SQLSTATE, and the error names no row value', async () => {
		await runFixedStatement(session, "insert into items (id, org, title) values (?, 'o1', ?)", [SECRET, SECRET])
		const insert = 'insert into items (id, org, title) values (?, ?, ?)'
		expect((await refusal(insert, [SECRET, 'o1', 'other'])).sqlState).toBe('23505')
		expect((await refusal(insert, ['i2', 'o1', SECRET])).sqlState).toBe('23505')
		expect((await refusal(insert, ['i3', SECRET, 'third'])).sqlState).toBe('23503')
		expect((await refusal(insert, ['i4', 'o1', `${SECRET}-longer-than-twenty`])).sqlState).toBe('23514')
		expect((await refusal(insert, ['i5', 'o1', null])).sqlState).toBe('23502')
	})

	test('any other failure carries no SQLSTATE', async () => {
		expect((await refusal(`select * from missing_${SECRET.replaceAll('-', '_')}`, [])).sqlState).toBeNull()
	})
})

describe('the engine', () => {
	test("the compiler's prototype chain is frozen", () => {
		expect(Object.isFrozen(SqliteQueryCompiler.prototype)).toBe(true)
		expect(() => {
			Object.defineProperty(SqliteQueryCompiler.prototype, 'compileQuery', { value: () => undefined })
		}).toThrow(TypeError)
	})

	test('sql.exec refuses transaction statements, as workerd does', () => {
		for (
			const text of ['BEGIN', 'begin transaction', 'COMMIT', 'end', 'ROLLBACK', 'SAVEPOINT s', 'RELEASE s', 'select 1; commit', '-- a comment\nbegin']
		) {
			expect(() => bunSqliteStorage().sql.exec(text)).toThrow()
		}
	})

	test('transactionSync commits what it wrote, or nothing when it throws', () => {
		expect(() =>
			storage.transactionSync(() => {
				storage.sql.exec("insert into items (id, org, title) values ('i1', 'o1', 'one')")
				throw new Error('failed')
			})
		).toThrow('failed')
		expect(ids()).toEqual([])
		storage.transactionSync(() => storage.sql.exec("insert into items (id, org, title) values ('i1', 'o1', 'one')"))
		expect(ids()).toEqual(['i1'])
	})
})

describe('an invocation encloses its work in the transaction on SQLite', () => {
	const insertItem = (into: Session, id: string) => runFixedStatement(into, "insert into items (id, org, title) values (?1, 'o1', ?1)", [id])
	const ids = () => storage.sql.exec('select id from items order by id').toArray().map((row) => row['id'])

	test('commit() decides, and the COMMIT runs once the work returned', async () => {
		const invocation = new InvocationTransaction(database, false)
		const answer = await invocation.enclose(async () => {
			await insertItem(await invocation.session(), 'a')
			// The handler awaits its own I/O inside the transaction.
			await new Promise((resolve) => setTimeout(resolve, 5))
			await insertItem(await invocation.session(), 'b')
			await invocation.commit()
			return 'answered'
		}, { site: 'test', held: () => {} })
		expect(answer).toBe('answered')
		expect(ids()).toEqual(['a', 'b'])
		expect(invocation.ended).toBe(true)
		expect(invocation.released).toBe(true)
		await invocation.rollback()
		expect(ids()).toEqual(['a', 'b'])
	})

	test('rollback() inside the work discards what it wrote, and the work still answers', async () => {
		const invocation = new InvocationTransaction(database, false)
		const answer = await invocation.enclose(async () => {
			await insertItem(await invocation.session(), 'a')
			await invocation.rollback()
			return 'refused'
		}, { site: 'test', held: () => {} })
		expect(answer).toBe('refused')
		expect(ids()).toEqual([])
	})

	test('work that throws, or returns without committing, keeps nothing', async () => {
		const thrown = new InvocationTransaction(database, false)
		await expect(thrown.enclose(async () => {
			await insertItem(await thrown.session(), 'a')
			throw new Error('handler failed')
		}, { site: 'test', held: () => {} })).rejects.toThrow('handler failed')
		const undecided = new InvocationTransaction(database, false)
		await undecided.enclose(async () => {
			await insertItem(await undecided.session(), 'b')
		}, { site: 'test', held: () => {} })
		expect(ids()).toEqual([])
	})

	test('a failed statement the handler caught makes commit() throw, and nothing commits', async () => {
		const invocation = new InvocationTransaction(database, false)
		await expect(invocation.enclose(async () => {
			const own = await invocation.session()
			await insertItem(own, 'a')
			await insertItem(own, 'a').catch(() => undefined)
			await invocation.commit()
		}, { site: 'test', held: () => {} })).rejects.toThrow(QueryRefusedError)
		expect(ids()).toEqual([])
	})

	test('a framework transaction inside the work nests in it, and rolls back with it', async () => {
		const invocation = new InvocationTransaction(database, false)
		await invocation.enclose(async () => {
			await sessionOf({ database }).transaction((nested) => insertItem(nested, 'a'))
			await expect(
				sessionOf({ database }).transaction(async (nested) => {
					await insertItem(nested, 'b')
					throw new Error('nested failed')
				}),
			).rejects.toThrow('nested failed')
			expect(ids()).toEqual(['a'])
			await invocation.rollback()
		}, { site: 'test', held: () => {} })
		expect(ids()).toEqual([])
	})

	test('a statement after the work ended is refused', async () => {
		const invocation = new InvocationTransaction(database, false)
		const own = await invocation.enclose(async () => {
			const session = await invocation.session()
			await invocation.commit()
			return session
		}, { site: 'test', held: () => {} })
		await expect(insertItem(own, 'late')).rejects.toThrow(QueryRefusedError)
		await expect(invocation.session()).rejects.toThrow(QueryRefusedError)
	})
})

describe('a writing invocation measures how long it held the object', () => {
	const insertItem = (into: Session, id: string) => runFixedStatement(into, "insert into items (id, org, title) values (?1, 'o1', ?1)", [id])

	interface Watched {
		readonly logged: string[]
		readonly held: number[]
	}

	type Work = (invocation: InvocationTransaction, advance: (ms: number) => void) => Promise<void>

	/** Runs `work` in an enclosure on a clock the work advances, collecting the log lines and the reported holds. */
	async function watched(readOnly: boolean, work: Work): Promise<Watched> {
		let clock = 1_000_000
		const advance = (ms: number) => {
			clock += ms
		}
		const logged: string[] = []
		const held: number[] = []
		const invocation = new InvocationTransaction(database, readOnly, () => clock)
		const original = console.warn
		console.warn = (...args: unknown[]) => void logged.push(args.map(String).join(' '))
		try {
			await invocation.enclose(() => work(invocation, advance), { site: 'api.notes.create', held: (ms) => void held.push(ms) }).catch(() => undefined)
		} finally {
			console.warn = original
		}
		return { logged, held }
	}

	test('a hold over a second logs the site and the ms, and reports nothing below the threshold', async () => {
		const { logged, held } = await watched(false, async (invocation, advance) => {
			await insertItem(await invocation.session(), 'a')
			advance(TRANSACTION_HELD_LOG_MS + 500)
			await invocation.commit()
		})
		expect(logged).toEqual([`fabrika: api.notes.create: held its object's transaction for ${TRANSACTION_HELD_LOG_MS + 500} ms`])
		expect(held).toEqual([])
		expect(ids()).toEqual(['a'])
	})

	test('a hold over the threshold also reports its ms', async () => {
		const { logged, held } = await watched(false, async (invocation, advance) => {
			advance(TRANSACTION_HELD_REPORT_MS + 1)
			await invocation.commit()
		})
		expect(logged).toHaveLength(1)
		expect(held).toEqual([TRANSACTION_HELD_REPORT_MS + 1])
	})

	test('a fast hold logs and reports nothing', async () => {
		const { logged, held } = await watched(false, async (invocation, advance) => {
			advance(TRANSACTION_HELD_LOG_MS)
			await invocation.commit()
		})
		expect({ logged, held }).toEqual({ logged: [], held: [] })
	})

	test('a read-only invocation holds no transaction and is not measured', async () => {
		const { logged, held } = await watched(true, async (invocation, advance) => {
			advance(TRANSACTION_HELD_REPORT_MS * 2)
			await invocation.commit()
		})
		expect({ logged, held }).toEqual({ logged: [], held: [] })
	})

	test('a hold that rolls back is measured too, whether the work decided it or threw', async () => {
		const decided = await watched(false, async (invocation, advance) => {
			await insertItem(await invocation.session(), 'a')
			advance(TRANSACTION_HELD_REPORT_MS + 2)
			await invocation.rollback()
		})
		const thrown = await watched(false, async (invocation, advance) => {
			await insertItem(await invocation.session(), 'b')
			advance(TRANSACTION_HELD_REPORT_MS + 3)
			throw new Error('handler failed')
		})
		expect([decided.held, thrown.held]).toEqual([[TRANSACTION_HELD_REPORT_MS + 2], [TRANSACTION_HELD_REPORT_MS + 3]])
		expect(ids()).toEqual([])
	})
})
