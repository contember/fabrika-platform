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
import { Database, type InvocationTransaction, runApplicationStatement, type Session } from '../database'
import { CapabilityError, DatabaseError, QueryRefusedError, SqlRowError } from '../errors'
import { bindScopedDatabase, type DataAccess, dataAccessOf, type DataSite } from '../framework'
import { classifySql, type ScopeTerms, type SqlMode, type SqlTag, sqlTag } from '../sql'
import { scoped } from '../store'
import { type TestDatabase, testDatabase } from '../testing'
import { TestAuthority } from './fixtures/authority'
import { RecordingDialect } from './fixtures/recording-dialect'
import { migration } from './fixtures/schema'
import { tables } from './fixtures/tables'

const SCHEMA = 'app_notes'

/** The parts of a tagged template, as the engine hands them to a tag. */
function parts(text: TemplateStringsArray, ..._values: unknown[]): readonly string[] {
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
		fail() {},
		session(): Promise<Session> {
			sent++
			return Promise.reject(new Error('the statement reached the session'))
		},
	}
	return {
		sql: sqlTag(
			site,
			SCHEMA,
			() => {
				throw new QueryRefusedError('unknown_table', 'no table reaches this tag')
			},
			() => {},
		),
		sent: () => sent,
	}
}

/** The template object the engine hands a tag. */
function template(text: TemplateStringsArray, ..._values: unknown[]): TemplateStringsArray {
	return text
}

/** Calls `tag` with `undefined` as its one value, as a handler whose types were defeated would. */
function withUndefined(tag: unknown, text: TemplateStringsArray): Promise<unknown> {
	return Promise.resolve().then(() => (typeof tag === 'function' ? Reflect.apply(tag, undefined, [text, undefined]) : undefined))
}

const Row = z.object({ v: z.string() })
const Title = z.object({ title: z.string() })

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

/** A tag whose scopes answer `terms` for every capability and table, over a session that is never reached. */
function scopedTag(terms: ScopeTerms): { sql: SqlTag; sent: () => number } {
	let sent = 0
	const mode: SqlMode = 'read'
	const site = {
		mode,
		check() {},
		fail() {},
		session(): Promise<Session> {
			sent++
			return Promise.reject(new Error('the statement reached the session'))
		},
	}
	return { sql: sqlTag(site, SCHEMA, () => terms, () => {}), sent: () => sent }
}

const REACHED = 'the statement reached the session'
const ONE: ScopeTerms = [[{ column: 'organization_id', value: 'o1' }]]

describe('ctx.sql.scope, before anything is sent', () => {
	test('a fragment is a frozen object without a prototype, and nothing an application builds or patches passes for one', async () => {
		const { sql, sent } = scopedTag('all')
		const fragment = sql.scope({}, 'notes', 'n')
		expect(Object.getPrototypeOf(fragment)).toBeNull()
		expect(Object.isFrozen(fragment)).toBe(true)
		expect(Reflect.set(fragment, 'kind', 'other')).toBe(false)
		await expect(sql(Row)`select n.id as v from notes n where ${{ kind: 'sql-scope' }}`).rejects.toThrow('is an object')
		const get = Object.getOwnPropertyDescriptor(WeakMap.prototype, 'get')
		Object.defineProperty(WeakMap.prototype, 'get', { value: () => ({ site: {}, parts: ['(true)'], values: [] }), configurable: true, writable: true })
		try {
			await expect(sql(Row)`select n.id as v from notes n where ${{ kind: 'sql-scope' }}`).rejects.toThrow('is an object')
		} finally {
			if (get !== undefined) Object.defineProperty(WeakMap.prototype, 'get', get)
		}
		expect(sent()).toBe(0)
	})

	test('a fragment of another site is refused, whether that site still runs or ended', async () => {
		const own = scopedTag(ONE)
		const other = scopedTag('all')
		await expect(own.sql(Row)`select n.id as v from notes n where ${other.sql.scope({}, 'notes', 'n')}`).rejects.toThrow(
			'a ctx.sql.scope(…) of another invocation or site is refused',
		)
		expect(own.sent()).toBe(0)
	})

	test('a fragment inside a literal, a quoted name, a dollar body or a comment is refused, also one with no value', async () => {
		for (const terms of ['all', [], ONE] satisfies ScopeTerms[]) {
			const { sql, sent } = scopedTag(terms)
			const scope = sql.scope({}, 'notes', 'n')
			const refused = [
				() => sql(Row)`select n.id as v from notes n where '${scope}' <> ''`,
				() => sql(Row)`select n.id as v from notes n where "${scope}" is null`,
				() => sql(Row)`select n.id as v from notes n where true -- ${scope}`,
				() => sql(Row)`select n.id as v from notes n where true /* ${scope} */`,
				() => sql(Row)`select n.id as v from notes n where $$ ${scope} $$ <> ''`,
			]
			for (const statement of refused) await expect(statement()).rejects.toThrow('is not bound; interpolate a whole value')
			expect(sent()).toBe(0)
		}
	})

	test('a fragment stands alone, joined by AND, at the top of a WHERE or JOIN … ON clause without a top-level OR', async () => {
		const { sql } = scopedTag(ONE)
		const scope = () => sql.scope({}, 'notes', 'n')
		const admitted = [
			() => sql(Row)`select n.id as v from notes n where ${scope()}`,
			() => sql(Row)`select n.id as v from notes n where (n.title = ${'a'} or n.title = ${'b'}) and ${scope()} order by n.id`,
			() => sql(Row)`select n.id as v from notes n where ${scope()} and n.trashed is distinct from true`,
			() => sql(Row)`select w.id as v from workspaces w join notes n on n.workspace_id = w.id and ${scope()} where w.name = ${'x'}`,
			() => sql(Row)`select w.id as v from workspaces w where w.id in (select n.workspace_id from notes n where ${scope()})`,
		]
		for (const statement of admitted) await expect(statement()).rejects.toThrow(REACHED)
		const refused: readonly [() => Promise<unknown>, string][] = [
			[() => sql(Row)`select n.id as v from notes n where n.title = ${'public'} or ${scope()}`, 'has an OR at its top level'],
			[() => sql(Row)`select n.id as v from notes n where n.title = ${'a'} or n.trashed and ${scope()}`, 'has an OR at its top level'],
			[() => sql(Row)`select n.id as v from notes n where ${scope()} and n.title = ${'a'} or true`, 'has an OR at its top level'],
			[() => sql(Row)`select n.id as v from notes n where not ${scope()}`, 'must stand alone, joined by AND'],
			[() => sql(Row)`select n.id as v from notes n where ${scope()} = false`, 'must stand alone, joined by AND'],
			[() => sql(Row)`select n.id as v from notes n where (${scope()})`, 'stands inside parentheses'],
			[() => sql(Row)`select ${scope()} as v from notes n`, 'stands outside a WHERE or JOIN … ON clause'],
			[() => sql(Row)`select n.id as v from notes n where n.word_count between 1 and ${scope()}`, 'put BETWEEN … AND … in parentheses'],
		]
		for (const [statement, message] of refused) await expect(statement()).rejects.toThrow(message)
	})
})

describe('the tag, before anything is sent', () => {
	test('a refused statement, a refused value and a plain-string call never reach the session', async () => {
		const { sql, sent } = unsentTag('write')
		await expect(sql(Row)`drop table notes`).rejects.toThrow('DROP TABLE is refused')
		await expect(sql(Row)`select query_to_xml(${'select 1'}, true, true, '')`).rejects.toThrow('query_to_xml(…) at line 1')
		await expect(withUndefined(sql(Row), template`select * from notes where id = ${0}`)).rejects.toThrow('the value ${…} number 1 is undefined')
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

describe('ctx.sql.scope of an app capability reaches what ctx.db.app reaches', () => {
	const dialect = new RecordingDialect()
	const authority = new TestAuthority('user:alice')
	const layer = scoped(tables)
	bindScopedDatabase(layer, { database: Database.fromDialect(dialect), capabilities: authority })
	const access = dataAccessOf(layer)
	const session = access.direct()
	const sql = access.sql({ mode: 'read', check() {}, session: async () => session, fail: () => session.fail() })

	test('a dimension or child table by its read action: every row', async () => {
		dialect.log.length = 0
		await sql(z.object({}))`select n.id from notes n where ${sql.scope(authority.app('notes.read'), 'notes', 'n')}`
		await sql(z.object({}))`select c.id from note_comments c where ${sql.scope(authority.app('notes.read'), 'note_comments', 'c')}`
		await sql(z.object({}))`select f.id from note_flags f where ${sql.scope(authority.app('notes.delete'), 'note_flags', 'f')}`
		expect(dialect.log.map((statement) => statement.sql)).toEqual([
			'select n.id from notes n where (true)',
			'select c.id from note_comments c where (true)',
			'select f.id from note_flags f where (true)',
		])
	})

	test('a dimension or child table by any other action is refused, as ctx.db.app does not list it', () => {
		expect(() => sql.scope(authority.app('secrets.admin'), 'notes')).toThrow(
			'an app capability of secrets.admin does not reach notes: ctx.db.app lists it for its read action notes.read or one of its appRead (notes.export) only',
		)
		expect(() => sql.scope(authority.app('notes.write'), 'notes')).toThrow(
			'ctx.db.app lists it for its read action notes.read or one of its appRead (notes.export) only',
		)
		expect(() => sql.scope(authority.app('notes.read'), 'note_flags')).toThrow('ctx.db.app lists it for its read action notes.delete only')
		expect(() => sql.scope(authority.app('notes.read'), 'secrets')).toThrow(CapabilityError)
	})

	test('an action of the appRead of a dimension table reads every row; one of its appCount reads none, so it is refused', async () => {
		dialect.log.length = 0
		await sql(z.object({}))`select n.id from notes n where ${sql.scope(authority.app('notes.export'), 'notes', 'n')}`
		expect(dialect.log.map((statement) => statement.sql)).toEqual(['select n.id from notes n where (true)'])
		expect(() => sql.scope(authority.app('notes.count'), 'notes')).toThrow(
			'an app capability of notes.count only counts notes (its appCount): it reads no row, so list and a scope fragment need its read action notes.read',
		)
	})

	test('an application table by any action its policy names, and by no other', async () => {
		dialect.log.length = 0
		await sql(z.object({}))`select s.id from settings s where ${sql.scope(authority.app('settings.read'), 'settings', 's')}`
		await sql(z.object({}))`select s.id from settings s where ${sql.scope(authority.app('settings.edit'), 'settings', 's')}`
		expect(dialect.log.map((statement) => statement.sql)).toEqual([
			'select s.id from settings s where (true)',
			'select s.id from settings s where (true)',
		])
		expect(() => sql.scope(authority.app('notes.read'), 'settings')).toThrow(
			'an app capability of notes.read does not reach settings: settings does not name the action',
		)
	})

	test('a reference or inbox table is refused, whatever its read action', () => {
		expect(() => sql.scope(authority.app('notes.read'), 'countries')).toThrow(
			'an app capability does not reach countries: ctx.db.app lists application, dimension and child tables only',
		)
		expect(() => sql.scope(authority.app('contact.read'), 'contact_messages')).toThrow('an app capability does not reach contact_messages')
	})
})

describe("ctx.sql.scope takes the statement's operation: a fragment on its UPDATE or DELETE target needs that operation's action", () => {
	const dialect = new RecordingDialect()
	const authority = new TestAuthority('user:alice')
	const layer = scoped(tables)
	bindScopedDatabase(layer, { database: Database.fromDialect(dialect), capabilities: authority })
	const access = dataAccessOf(layer)
	const session = access.direct()
	const sql = access.sql({ mode: 'write', check() {}, session: async () => session, fail: () => session.fail() })
	const reader = access.sql({ mode: 'read', check() {}, session: async () => session, fail: () => session.fail() })
	const Row = z.object({})
	const note = <const A extends string>(action: A) => authority.ref('note', action, 'n1', { workspace: 'w1', organization: 'o1' })
	const sent = () => dialect.log.map((statement) => statement.sql)

	test('a write under a read action is refused, whatever the grant kind', async () => {
		dialect.log.length = 0
		await expect(sql(Row)`update notes set title = ${'x'} where ${sql.scope(authority.app('notes.read'), 'notes')}`).rejects.toThrow(
			'an app capability writes application tables only: UPDATE of notes',
		)
		await expect(sql(Row)`update notes set title = ${'x'} where ${sql.scope(note('notes.read'), 'notes')}`).rejects.toThrow(
			'UPDATE of notes needs its update action notes.write; the capability holds notes.read',
		)
		await expect(sql(Row)`delete from notes where ${sql.scope(note('notes.write'), 'notes')}`).rejects.toThrow(
			'DELETE of notes needs its delete action notes.delete; the capability holds notes.write',
		)
		const within = authority.within('workspace', 'notes.read', ['w1'])
		await expect(sql(Row)`update notes set title = ${'x'} where ${sql.scope(within, 'notes')}`).rejects.toThrow(
			'UPDATE of notes needs its update action notes.write; the capability holds notes.read',
		)
		await expect(sql(Row)`update settings set value = ${'x'} where ${sql.scope(authority.app('settings.read'), 'settings')}`).rejects.toThrow(
			'UPDATE of settings needs its update action settings.edit; the capability holds settings.read',
		)
		await expect(
			sql(Row)`update settings set value = ${'x'} where ${sql.scope(authority.within('workspace', 'settings.read', ['w1']), 'settings')}`,
		).rejects.toThrow('a scoped site writes no application table: UPDATE of settings')
		expect(sent()).toEqual([])
	})

	test("the operation's own action writes its rows, and a fragment elsewhere in the statement reads", async () => {
		dialect.log.length = 0
		await sql(Row)`update notes set title = ${'x'} where ${sql.scope(note('notes.write'), 'notes')}`
		await sql(Row)`delete from notes n where ${sql.scope(note('notes.delete'), 'notes', 'n')}`
		await sql(Row)`update notes set title = ${'x'} where ${sql.scope(authority.within('workspace', 'notes.write', ['w1']), 'notes')}`
		await sql(Row)`update settings set value = ${'x'} where ${sql.scope(authority.app('settings.edit'), 'settings')}`
		await sql(Row)`delete from note_comments c where c.note_id in (select n.id from notes n where ${
			sql.scope(authority.within('workspace', 'notes.read', ['w1']), 'notes', 'n')
		})`
		await sql(Row)`insert into note_comments (id, note_id, workspace_id, organization_id, body)
			select ${'c1'}, n.id, n.workspace_id, n.organization_id, ${'copied'} from notes n where ${sql.scope(note('notes.read'), 'notes', 'n')}`
		expect(sent()).toHaveLength(6)
		expect(sent()[3]).toBe('update settings set value = $1 where (true)')
	})

	test('a read under an action the table does not name, or a list under one its Within does not read with, is refused', async () => {
		expect(() => reader.scope(note('secrets.admin'), 'notes')).toThrow('notes does not name the action secrets.admin')
		expect(() => reader.scope(authority.within('workspace', 'notes.write', ['w1']), 'notes')).toThrow(
			'a Within of notes.write does not read notes: it reads with its read action notes.read',
		)
		await expect(
			sql(Row)`select n.id from notes n where ${sql.scope(authority.within('workspace', 'notes.write', ['w1']), 'notes', 'n')}`,
		).rejects.toThrow('a Within of notes.write does not read notes: it reads with its read action notes.read')
	})

	test('a scoped site reads an application table with its read action, as ctx.db.app does', async () => {
		dialect.log.length = 0
		await reader(Row)`select s.id from settings s where ${reader.scope(authority.within('workspace', 'settings.read', ['w1']), 'settings', 's')}`
		expect(sent()).toEqual(['select s.id from settings s where (true)'])
		expect(() => reader.scope(note('notes.read'), 'settings')).toThrow('a scoped site reads settings with its read action settings.read only')
	})

	test('a reference table as a write target is refused, with a fragment or without', async () => {
		dialect.log.length = 0
		await expect(sql(Row)`update countries set name = ${'x'} where code = ${'CZ'}`).rejects.toThrow(
			'countries is a reference table, which no statement writes: its rows come from a migration',
		)
		await expect(sql(Row)`insert into countries (code, name) values (${'PL'}, ${'Poland'})`).rejects.toThrow('countries is a reference table')
		await expect(sql(Row)`delete from countries where code = ${'CZ'}`).rejects.toThrow('countries is a reference table')
		await expect(sql(Row)`with gone as (delete from countries returning code) select code from gone`).rejects.toThrow(
			'countries is a reference table',
		)
		await sql(Row)`delete from contact_messages returning id`
		expect(sent()).toEqual(['delete from contact_messages returning id'])
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
			throw new QueryRefusedError('ended', 'ctx.sql was used after its invocation ended')
		}
	}
	const site: DataSite = { kind: readOnly ? 'query' : 'mutation', unscoped: {}, principal: 'user:alice', check, session: () => transaction.session() }
	const sql = data.sql({ mode, check, session: () => transaction.session(), fail: () => transaction.fail() })
	return { transaction, sql, handles: data.handles(site) }
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
			"ctx.sql: row 1 does not match the row schema at 'title': invalid_type (expected number)",
		)
		await expect(work.sql(Row)`select 'a' as v_x, 'b' as "vX"`).rejects.toThrow("the columns 'v_x' and 'vX' both become the field 'vX'")
		await expect(work.transaction.commit()).rejects.toThrow('a statement of this invocation failed')
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
	test('a caught refusal still fails the invocation: a refused statement after a write, a refused value before any', async () => {
		const work = invocation('write')
		await work.sql(z.object({}))`insert into organizations (id, name) values ('o6', 'Six')`
		await work.sql(z.object({}))`drop table notes`.catch(() => undefined)
		await expect(work.transaction.commit()).rejects.toThrow('a statement of this invocation failed')

		const unopened = invocation('write')
		await withUndefined(unopened.sql(z.object({})), template`select ${0}`).catch(() => undefined)
		await unopened.sql(z.object({}))`insert into organizations (id, name) values ('o7', 'Seven')`
		await expect(unopened.transaction.commit()).rejects.toThrow('a statement of this invocation failed')

		const reader = invocation('read', true)
		expect(await reader.sql(Count)`select count(*)::int as n from organizations where id in ('o6', 'o7')`).toEqual([{ n: 0 }])
		await reader.transaction.rollback()
	})

	test('a caught row mismatch of UPDATE … RETURNING fails the invocation, and the update is not kept', async () => {
		const work = invocation('write')
		await work.sql(z.object({ name: z.number() }))`update workspaces set name = 'Renamed' where id = 'w1' returning name`.catch(() => undefined)
		await expect(work.transaction.commit()).rejects.toThrow('a statement of this invocation failed')
		const reader = invocation('read', true)
		expect(await reader.sql(Title)`select name as title from workspaces where id = 'w1'`).toEqual([{ title: 'Alpha' }])
		await reader.transaction.rollback()
	})

	test("a caught refusal fails a job's fenced transaction too", async () => {
		const committed = data.transaction(async (session) => {
			const sql = data.sql({ mode: 'write', check() {}, session: async () => session, fail: () => session.fail() })
			await sql(z.object({}))`insert into organizations (id, name) values ('o8', 'Eight')`
			await sql(z.object({}))`truncate notes`.catch(() => undefined)
		})
		await expect(committed).rejects.toThrow('a statement of this transaction failed')
		const reader = invocation('read', true)
		expect(await reader.sql(Count)`select count(*)::int as n from organizations where id = 'o8'`).toEqual([{ n: 0 }])
		await reader.transaction.rollback()
	})

	test("a row error names the column and the issue's kind, never a value nor the schema's own message", async () => {
		const work = invocation('read', true)
		const Rejecting = z.object({ name: z.string().refine(() => false, { error: (issue) => `Rejected value: ${String(issue.input)}` }) })
		const refused = work.sql(Rejecting)`select name from workspaces where id = 'w2'`
		await expect(refused).rejects.toThrow("ctx.sql: row 1 does not match the row schema at 'name': custom")
		await expect(work.sql(Rejecting)`select name from workspaces where id = 'w2'`).rejects.not.toThrow('Beta')
		const Nested = z.object({ data: z.record(z.string(), z.number()) })
		await expect(work.sql(Nested)`select jsonb_build_object('private-key', 'x') as data`).rejects.toThrow(
			"ctx.sql: row 1 does not match the row schema at 'data': invalid_type (expected number)",
		)
		await expect(work.sql(Nested)`select jsonb_build_object('private-key', 'x') as data`).rejects.not.toThrow('private-key')
		await work.transaction.rollback()
	})
})

describe.skipIf(opened === null)("ctx.sql.scope: the capability's whole predicate, as bound values", () => {
	const Id = z.object({ id: z.string() })
	const ids = async (scopeOf: (sql: SqlTag) => ReturnType<SqlTag['scope']>): Promise<string[]> => {
		const work = invocation('read', true)
		try {
			const rows = await work.sql(Id)`select n.id from notes n where ${scopeOf(work.sql)} and n.title = 'scoped' order by n.id`
			return rows.map((row) => row.id)
		} finally {
			await work.transaction.rollback()
		}
	}

	beforeAll(async () => {
		const writer = invocation('write')
		await writer.sql(z.object({}))`insert into notes (id, workspace_id, organization_id, title, created_by, version)
			values ('scope-1', 'w1', 'o1', 'scoped', 'u', 1), ('scope-2', 'w2', 'o1', 'scoped', 'u', 1), ('scope-3', 'w3', 'o2', 'scoped', 'u', 1)`
		await writer.transaction.commit()
	})

	test("a Ref matches its object's column and every link of its chain, so a moved container is out", async () => {
		const w1 = alice.ref('workspace', 'notes.read', 'w1', { organization: 'o1' })
		expect(await ids((sql) => sql.scope(w1, 'notes', 'n'))).toEqual(['scope-1'])
		const stale = alice.ref('workspace', 'notes.read', 'w1', { organization: 'o2' })
		expect(await ids((sql) => sql.scope(stale, 'notes', 'n'))).toEqual([])
		const note = alice.ref('note', 'notes.write', 'scope-2', { workspace: 'w2', organization: 'o1' })
		expect(await ids((sql) => sql.scope(note, 'notes', 'n'))).toEqual(['scope-2'])
		const organization = alice.ref('organization', 'notes.read', 'o1')
		expect(await ids((sql) => sql.scope(organization, 'notes', 'n'))).toEqual(['scope-1', 'scope-2'])
	})

	test("a Within matches its values, each container grant on its own column, every row for 'all' and none when empty", async () => {
		const mixed = alice.within('workspace', 'notes.read', ['w2'], [{ dimension: 'organization', values: ['o2'] }])
		expect(await ids((sql) => sql.scope(mixed, 'notes', 'n'))).toEqual(['scope-2', 'scope-3'])
		expect(await ids((sql) => sql.scope(alice.within('organization', 'notes.read', 'all'), 'notes', 'n'))).toEqual(['scope-1', 'scope-2', 'scope-3'])
		expect(await ids((sql) => sql.scope(alice.within('workspace', 'notes.read', []), 'notes', 'n'))).toEqual([])
	})

	test('an app capability matches every row of a table ctx.db.app lists for its action, and is refused any other', async () => {
		expect(await ids((sql) => sql.scope(alice.app('notes.read'), 'notes', 'n'))).toEqual(['scope-1', 'scope-2', 'scope-3'])
		const writer = invocation('write')
		await writer.sql(z.object({}))`insert into settings (id, value) values ('setting-1', 'a'), ('setting-2', 'b')`
		await writer.transaction.commit()
		const work = invocation('read', true)
		try {
			const settings = async (action: string) =>
				(await work.sql(Id)`select s.id from settings s where ${work.sql.scope(alice.app(action), 'settings', 's')} order by s.id`).map((row) => row.id)
			expect(await settings('settings.read')).toEqual(['setting-1', 'setting-2'])
			expect(await settings('settings.edit')).toEqual(['setting-1', 'setting-2'])
			expect(() => work.sql.scope(alice.app('notes.read'), 'settings')).toThrow('settings does not name the action')
			expect(() => work.sql.scope(alice.app('secrets.admin'), 'notes')).toThrow(
				'ctx.db.app lists it for its read action notes.read or one of its appRead (notes.export) only',
			)
			expect(() => work.sql.scope(alice.app('notes.read'), 'countries')).toThrow('an app capability does not reach countries')
		} finally {
			await work.transaction.rollback()
		}
	})

	test('the values are parameters: a value that would be SQL matches nothing', async () => {
		const hostile = alice.ref('workspace', 'notes.read', "w1' or true --", { organization: 'o1' })
		expect(await ids((sql) => sql.scope(hostile, 'notes', 'n'))).toEqual([])
	})

	test('a table the capability does not reach, an unknown table, a bad alias and a foreign scope are refused', async () => {
		const work = invocation('read', true)
		const note = alice.ref('note', 'notes.read', 'scope-1', { workspace: 'w1', organization: 'o1' })
		expect(() => work.sql.scope(note, 'workspaces')).toThrow('a Ref of note does not reach workspaces')
		expect(() => work.sql.scope(alice.within('workspace', 'notes.read', ['w1']), 'secrets')).toThrow('a Within of workspace does not reach secrets')
		expect(() => work.sql.scope(note, 'invoices')).toThrow('invoices is not a table of src/db/tables.ts')
		expect(() => work.sql.scope(note, 'notes', 'n; drop')).toThrow('an alias of lowercase letters')
		await work.transaction.rollback()
		const other = invocation('read', true)
		const foreign = other.sql.scope(note, 'notes', 'n')
		const mine = invocation('read', true)
		await expect(mine.sql(Id)`select n.id from notes n where ${foreign}`).rejects.toThrow('a ctx.sql.scope(…) of another invocation or site is refused')
		await other.transaction.rollback()
		await mine.transaction.rollback()
	})
})
