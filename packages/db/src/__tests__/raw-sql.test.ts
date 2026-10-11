// `ctx.sql`: the classifier and the binding need no database; the rest runs on a REAL Postgres as the runtime role
// `run_<id>` (`testDatabase`), and skips cleanly (with a reason) when FABRIKA_TEST_POSTGRES_URL is unset:
//
//   docker run --rm -d -p 55433:5432 -e POSTGRES_PASSWORD=postgres postgres:17
//   FABRIKA_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres bun test packages/db/src/__tests__/raw-sql.test.ts

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { type InvocationTransaction, runApplicationStatement, type Session } from '../database'
import { DatabaseError, QueryRefusedError, SqlRowError } from '../errors'
import { bindScopedDatabase, type DataAccess, dataAccessOf, type DataSite } from '../framework'
import { classifySql, type SqlMode, type SqlTag, sqlTag } from '../sql'
import { scoped } from '../store'
import { type TestDatabase, testDatabase } from '../testing'
import { TestAuthority } from './fixtures/authority'
import { migration } from './fixtures/schema'
import { tables } from './fixtures/tables'

const SCHEMA = 'app_notes'

/** The parts of a tagged template, as the engine hands them to a tag. */
function parts(text: TemplateStringsArray): readonly string[] {
	return [...text]
}

/** The refusal `classifySql` gives the template, or `undefined` when it admits it. */
function refusal(text: readonly string[], mode: SqlMode = 'write'): string | undefined {
	try {
		classifySql(text, mode, SCHEMA)
		return undefined
	} catch (error) {
		if (error instanceof QueryRefusedError) {
			return error.message
		}
		throw error
	}
}

/** A tag over a session that is never reached: what a refused statement must not do. */
function unsentTag(mode: SqlMode): { sql: SqlTag; sent: () => number } {
	let sent = 0
	const site = {
		mode,
		check() {},
		session(): Promise<Session> {
			sent++
			return Promise.reject(new Error('the statement reached the session'))
		},
	}
	return { sql: sqlTag(site, SCHEMA), sent: () => sent }
}

const Row = z.object({ v: z.string() })

describe('the static text', () => {
	test('a query, a join report and a write are admitted, with each value a $n placeholder', () => {
		const org = 'o1'
		const report = (text: TemplateStringsArray, ..._values: unknown[]) => classifySql(parts(text), 'read', SCHEMA)
		expect(
			report`select w.name, count(*)::int as notes from notes n join workspaces w on w.id = n.workspace_id where n.organization_id = ${org} group by w.name`,
		).toBe(
			'select w.name, count(*)::int as notes from notes n join workspaces w on w.id = n.workspace_id where n.organization_id = $1 group by w.name',
		)
		expect(refusal(parts`with recent as (select * from notes where created_at > ${'x'}) select count(*) from recent`, 'read')).toBeUndefined()
		expect(refusal(parts`select * from app_notes.notes where id = any(${'x'})`, 'read')).toBeUndefined()
		expect(refusal(parts`update notes set title = ${'t'} where id = ${'i'} returning id`)).toBeUndefined()
		expect(refusal(parts`insert into notes (id) select id from workspaces where name = lower(${'n'})`)).toBeUndefined()
		expect(refusal(parts`select * from notes where title = 'costs: 1 $' || ${'x'}`, 'read')).toBeUndefined()
	})

	test('each refused statement kind', () => {
		const refused: readonly [readonly string[], string][] = [
			[parts`create table t (id int)`, 'CREATE TABLE is refused'],
			[parts`drop table notes`, 'DROP TABLE is refused'],
			[parts`alter table notes add column x int`, 'ALTER TABLE is refused'],
			[parts`truncate notes`, 'TRUNCATE is refused'],
			[parts`begin`, 'BEGIN is refused'],
			[parts`commit`, 'COMMIT is refused'],
			[parts`rollback`, 'ROLLBACK is refused'],
			[parts`savepoint s`, 'SAVEPOINT is refused'],
			[parts`set role postgres`, 'SET is refused'],
			[parts`set local statement_timeout = 0`, 'SET is refused'],
			[parts`reset all`, 'RESET is refused'],
			[parts`copy notes to program 'id'`, 'COPY is refused'],
			[parts`copy (select 1) to stdout`, 'COPY is refused'],
			[parts`listen jobs`, 'LISTEN is refused'],
			[parts`notify jobs`, 'NOTIFY is refused'],
			[parts`lock notes`, 'LOCK is refused'],
			[parts`call p()`, 'CALL is refused'],
			[parts`do $$ begin end $$`, 'DO is refused'],
			[parts`explain analyze delete from notes`, 'EXPLAIN is refused'],
			[parts`merge into notes using workspaces on true when matched then delete`, 'MERGE is refused'],
			[parts`grant select on notes to public`, 'GRANT is refused'],
			[parts`select 1; select 2`, 'it runs one statement, and the template holds 2'],
			[parts`  `, 'the template holds no statement'],
			[parts`with x as (copy notes to stdout) select 1`, 'COPY at line 1 is refused inside another statement'],
			[parts`delete from (notes)`, 'DELETE at line 1 is refused inside another statement'],
			[parts`select * into copied from notes`, 'SELECT … INTO at line 1 creates a table'],
		]
		for (const [text, expected] of refused) {
			expect({ text: text.join('${…}'), refused: refusal(text) }).toEqual({ text: text.join('${…}'), refused: expect.stringContaining(expected) })
		}
	})

	test("a 'read' site runs queries only: no write, no data-modifying CTE, no lock", () => {
		expect(refusal(parts`insert into notes (id) values (${'x'})`, 'read')).toContain("sql: 'read' runs queries only, and the statement holds INSERT")
		expect(refusal(parts`with gone as (delete from notes returning id) select count(*) from gone`, 'read')).toContain('holds DELETE at line 1')
		expect(refusal(parts`select * from notes for update`, 'read')).toContain('a locking clause (FOR UPDATE)')
		expect(refusal(parts`select * from notes for key share`, 'read')).toContain('a locking clause (FOR KEY')
		expect(refusal(parts`select * from notes for update`, 'write')).toBeUndefined()
	})

	test('names outside the schema, framework tables and catalog relations', () => {
		const refused: readonly [readonly string[], string][] = [
			[parts`select * from app_other.notes`, "the schema 'app_other' is outside the application's"],
			[parts`select * from information_schema.tables`, "the schema 'information_schema'"],
			[parts`select * from pg_catalog.pg_class`, "'pg_class' at line 1 is a catalog name"],
			[parts`select rolpassword from pg_authid`, "'pg_authid' at line 1 is a catalog name"],
			[parts`select * from "pg_roles"`, "'pg_roles' at line 1 is a catalog name"],
			[parts`select 1::pg_catalog.int4`, "the schema 'pg_catalog'"],
			[parts`select * from fabrika_job_leases`, "'fabrika_job_leases' at line 1 is the framework's"],
			[parts`delete from fabrika_migrations`, "'fabrika_migrations' at line 1 is the framework's"],
			[parts`select * from notes n join "FABRIKA_webhook_bindings" b on true`, "'FABRIKA_webhook_bindings' at line 1 is the framework's"],
			[parts`select * from U&"pg_\\0061uthid"`, 'a U&"…" name is refused'],
		]
		for (const [text, expected] of refused) {
			expect({ text: text.join('${…}'), refused: refusal(text) }).toEqual({ text: text.join('${…}'), refused: expect.stringContaining(expected) })
		}
	})

	test('a function outside the reviewed built-ins', () => {
		for (
			const name of [
				'query_to_xml',
				'cursor_to_xml',
				'pg_read_file',
				'lo_import',
				'lo_unlink',
				'dblink',
				'set_config',
				'pg_advisory_lock',
				'nextval',
				'my_fn',
			]
		) {
			expect(refusal([`select ${name}('x')`])).toContain(`${name}(…) at line 1 is not a reviewed built-in function`)
		}
		expect(refusal(parts`select app_notes.my_fn(1)`)).toContain('app_notes.my_fn(…) at line 1 is not a reviewed built-in function')
		expect(refusal(parts`select (notes).f(1) from notes`)).toContain('is not a reviewed built-in function')
		expect(refusal(parts`select lower(title), count(*), coalesce(body, ''), date_trunc('day', created_at) from notes group by 1, 4`)).toBeUndefined()
	})

	test('a value lands only where it is bound', () => {
		const inside = 'is not bound; interpolate a whole value'
		expect(refusal(parts`select * from notes where title = '${'x'}'`)).toContain(inside)
		expect(refusal(parts`select * from notes where title = $q$${'x'}$q$`)).toContain(inside)
		expect(refusal(parts`select * from "notes${'x'}"`)).toContain(inside)
		expect(refusal(parts`select 1 -- ${'x'}`)).toContain(inside)
		expect(refusal(parts`select 1 /* ${'x'} */`)).toContain(inside)
		expect(refusal(parts`select title${'x'} from notes`)).toContain(inside)
		expect(refusal(parts`select $${'x'}`)).toContain('never closes')
		expect(refusal(parts`select ${'x'}0`)).toContain('a digit right after the value ${…} number 1')
		expect(refusal(parts`select $1, ${'x'}`)).toContain('reads as a positional parameter')
		expect(refusal(parts`select 'open`)).toContain('at line 1 never closes')
	})
})

describe('the tag, before anything is sent', () => {
	test('a refused statement, a refused value and a plain-string call never reach the session', async () => {
		const { sql, sent } = unsentTag('write')
		await expect(sql(Row)`drop table notes`).rejects.toThrow('DROP TABLE is refused')
		await expect(sql(Row)`select query_to_xml(${'select 1'}, true, true, '')`).rejects.toThrow('query_to_xml(…) at line 1')
		await expect(sql(Row)`select * from notes where id = ${undefined}`).rejects.toThrow('the value ${…} number 1 is undefined')
		await expect(sql(Row)`select * from notes where id = ${Number.NaN}`).rejects.toThrow('is not a finite number')
		await expect(sql(Row)`select * from notes where created_at = ${new Date(Number.NaN)}`).rejects.toThrow('is an invalid Date')
		await expect(Reflect.apply(sql(Row), undefined, [['select 1']])).rejects.toThrow('it is a tagged template')
		await expect(Reflect.apply(sql(Row), undefined, [Object.freeze(Object.assign(['select 1'], { raw: ['select 1'] }))])).rejects.toThrow(
			'it is a tagged template',
		)
		expect(() => Reflect.apply(sql, undefined, [{ parse: () => [] }])).toThrow('ctx.sql(Row) takes the zod schema of one row')
		expect(sent()).toBe(0)
	})

	test("a 'read' tag refuses a write before it is sent", async () => {
		const { sql, sent } = unsentTag('read')
		await expect(sql(Row)`update notes set title = ${'x'}`).rejects.toThrow("sql: 'read' runs queries only")
		expect(sent()).toBe(0)
	})
})

const label = 'raw-sql.test.ts'
const migrations = mkdtempSync(join(tmpdir(), 'fabrika-db-raw-sql-'))
writeFileSync(join(migrations, '20261012120000_init.sql'), migration)
const opened: TestDatabase | null = await testDatabase({ migrations, label })
const alice = new TestAuthority('user:alice')
let data: DataAccess

beforeAll(() => {
	if (opened === null) {
		return
	}
	const layer = scoped(tables)
	bindScopedDatabase(layer, { database: opened.database, capabilities: alice })
	data = dataAccessOf(layer)
})

afterAll(async () => {
	await opened?.close()
})

/** One invocation, its `ctx.sql` and its `ctx.db` handles, bound to it as the framework binds them. */
function invocation(mode: SqlMode, readOnly = false) {
	const transaction: InvocationTransaction = data.invocation(readOnly)
	const check = () => {
		if (transaction.ended) {
			throw new QueryRefusedError('ctx.sql was used after its invocation ended')
		}
	}
	const site: DataSite = { kind: readOnly ? 'query' : 'mutation', unscoped: {}, principal: 'user:alice', check, session: () => transaction.session() }
	return { transaction, sql: data.sql({ mode, check, session: () => transaction.session() }), handles: data.handles(site) }
}

const Count = z.object({ n: z.number() })

async function notesTitled(title: string): Promise<number> {
	const reader = invocation('read', true)
	try {
		const [row] = await reader.sql(Count)`select count(*)::int as n from notes where title = ${title}`
		return row?.n ?? -1
	} finally {
		await reader.transaction.rollback()
	}
}

async function seed(): Promise<void> {
	const writer = invocation('write')
	await writer.sql(z.object({}))`insert into organizations (id, name) values ('o1', 'One'), ('o2', 'Two')`
	await writer.sql(
		z.object({}),
	)`insert into workspaces (id, organization_id, name, created_by) values ('w1', 'o1', 'Alpha', 'u'), ('w2', 'o1', 'Beta', 'u'), ('w3', 'o2', 'Gamma', 'u')`
	await writer.transaction.commit()
}

describe.skipIf(opened === null)('ctx.sql on Postgres, as the runtime role', () => {
	beforeAll(seed)

	test("a join report answers in the invocation's transaction, with the handles' writes, and rolls back with it", async () => {
		const work = invocation('write')
		const note = Bun.randomUUIDv7()
		await work.sql(z.object({}))`insert into notes (id, workspace_id, organization_id, title, created_by, version)
			values (${note}, 'w1', 'o1', 'report me', 'u', 1)`
		const own = await work.handles.target(alice.ref('note', 'notes.read', note, { workspace: 'w1', organization: 'o1' }), 'on')
		expect(await Reflect.apply(Reflect.get(own, 'get'), own, [])).toMatchObject({ id: note, title: 'report me' })
		const Report = z.object({ workspace: z.string(), organizationName: z.string(), notes: z.number() })
		const rows = await work.sql(Report)`select w.name as workspace, o.name as organization_name, count(n.id)::int as notes
			from workspaces w join organizations o on o.id = w.organization_id left join notes n on n.workspace_id = w.id
			where w.organization_id = ${'o1'} group by w.name, o.name order by w.name`
		expect(rows).toEqual([
			{ workspace: 'Alpha', organizationName: 'One', notes: 1 },
			{ workspace: 'Beta', organizationName: 'One', notes: 0 },
		])
		expect(await notesTitled('report me')).toBe(0)
		await work.transaction.rollback()
		expect(await notesTitled('report me')).toBe(0)

		const kept = invocation('write')
		await kept.sql(z.object({}))`insert into notes (id, workspace_id, organization_id, title, created_by, version)
			values (${Bun.randomUUIDv7()}, 'w2', 'o1', 'kept', 'u', 1)`
		await kept.transaction.commit()
		expect(await notesTitled('kept')).toBe(1)
	})

	test('an interpolated value is a parameter, of every bindable type', async () => {
		const work = invocation('read', true)
		const hostile = "x'); drop table notes; --"
		const at = new Date('2026-10-12T08:30:00.000Z')
		const Bound = z.object({
			text: z.string(),
			flag: z.boolean(),
			big: z.string(),
			at: z.string(),
			none: z.null(),
			listed: z.boolean(),
			count: z.number(),
		})
		const [row] = await work.sql(Bound)`select ${hostile}::text as text, ${true}::bool as flag, ${9007199254740993n}::int8 as big,
			${at}::timestamptz as at, ${null}::text as none, 'b' = any(${['a', 'b"', 'b']}::text[]) as listed, cardinality(${[1, 2, 3]}::int[]) as count`
		expect(row).toEqual({ text: hostile, flag: true, big: '9007199254740993', at: at.toISOString(), none: null, listed: true, count: 3 })
		await work.transaction.rollback()
		expect(await notesTitled(hostile)).toBe(0)
	})

	test("a 'read' site cannot write: refused in the text, and a query's transaction is READ ONLY under it", async () => {
		const mutation = invocation('read')
		await expect(mutation.sql(z.object({}))`delete from notes`).rejects.toThrow("sql: 'read' runs queries only")
		expect(mutation.transaction.opened).toBe(false)
		await mutation.transaction.rollback()

		const query = invocation('read', true)
		const session = await query.transaction.session()
		const write = runApplicationStatement(session, "insert into organizations (id, name) values ('o9', 'Nine')", [])
		await expect(write).rejects.toBeInstanceOf(DatabaseError)
		await expect(write).rejects.toMatchObject({ sqlState: '25006' })
		await expect(query.transaction.commit()).rejects.toThrow('a statement of this invocation failed')
	})

	test('a captured ctx.sql is refused once its invocation ended', async () => {
		const work = invocation('read', true)
		const kept = work.sql(Count)
		await kept`select 1::int as n`
		await work.transaction.commit()
		await expect(kept`select 1::int as n`).rejects.toThrow('after its invocation ended')
	})

	test('rows: snake_case to camelCase, Date to ISO, and a bigint column named with its fix', async () => {
		const work = invocation('read', true)
		const Stamped = z.object({ createdAt: z.iso.datetime(), wordCount: z.number() })
		const note = invocation('write')
		await note.sql(z.object({}))`insert into notes (id, workspace_id, organization_id, title, created_by, version, word_count)
			values (${Bun.randomUUIDv7()}, 'w3', 'o2', 'stamped', 'u', 1, 7)`
		await note.transaction.commit()
		expect(await work.sql(Stamped)`select created_at, word_count from notes where title = 'stamped'`).toEqual([
			{ createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/), wordCount: 7 },
		])
		const counted = work.sql(z.object({ notes: z.number() }))`select count(*) as notes from notes`
		await expect(counted).rejects.toBeInstanceOf(SqlRowError)
		await expect(work.sql(z.object({ notes: z.number() }))`select count(*) as notes from notes`).rejects.toThrow(
			"ctx.sql: the column 'notes' arrives as text (Postgres sends bigint and numeric as text); cast it in the SQL (count(*)::int, ::float8) or read it with z.coerce.number()",
		)
		expect(await work.sql(z.object({ notes: z.coerce.number() }))`select count(*) as notes from notes where title = 'stamped'`).toEqual([{ notes: 1 }])
		await expect(work.sql(z.object({ title: z.number() }))`select title from notes where title = 'stamped'`).rejects.toThrow(
			"ctx.sql: row 1 does not match the row schema at 'title': Invalid input: expected number, received string",
		)
		await expect(work.sql(Row)`select 'a' as v_x, 'b' as "vX"`).rejects.toThrow("the columns 'v_x' and 'vX' both become the field 'vX'")
		await work.transaction.commit()
	})

	test('a statement the database refuses fails the invocation: nothing it wrote commits', async () => {
		const work = invocation('write')
		await work.sql(z.object({}))`insert into organizations (id, name) values ('o5', 'Five')`
		await expect(work.sql(z.object({}))`insert into organizations (id, name) values ('o1', 'Again')`).rejects.toMatchObject({ sqlState: '23505' })
		await expect(work.transaction.commit()).rejects.toThrow('a statement of this invocation failed')
		const reader = invocation('read', true)
		expect(await reader.sql(Count)`select count(*)::int as n from organizations where id = 'o5'`).toEqual([{ n: 0 }])
		await reader.transaction.rollback()
	})

	test("the migration ledger: refused by name, and the runtime role's permission denied past the name rule", async () => {
		const work = invocation('write')
		await expect(work.sql(z.object({}))`delete from fabrika_migrations`).rejects.toThrow("'fabrika_migrations' at line 1 is the framework's")
		const session = await work.transaction.session()
		await expect(runApplicationStatement(session, 'delete from fabrika_migrations', [])).rejects.toMatchObject({ sqlState: '42501' })
		await expect(work.transaction.commit()).rejects.toThrow('a statement of this invocation failed')
	})
})
