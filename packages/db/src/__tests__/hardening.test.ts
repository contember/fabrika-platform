// The two attacks that succeeded against the spike both patched globals in the same process: the Kysely compiler
// after the guard ran, and the built-ins the allowlists use. Loading the layer freezes the compiler, and the guard
// and every policy and allowlist check keep their own references to the built-ins, so both now fail.

import { describe, expect, test } from 'bun:test'
import { DefaultQueryCompiler, PostgresQueryCompiler } from 'kysely'
import { z } from 'zod/v4'
import { Database } from '../database'
import { CapabilityError, QueryRefusedError } from '../errors'
import { bindScopedDatabase, dataAccessOf } from '../framework'
import * as postgres from '../postgres'
import { defineStore, scoped } from '../store'
import { TestAuthority } from './fixtures/authority'
import { call, type Outcome, recordingLayer } from './fixtures/harness'
import { patchedChecks } from './fixtures/patch'
import { RecordingDialect } from './fixtures/recording-dialect'
import { tables } from './fixtures/tables'

describe('the compiler cannot be patched after the guard ran', () => {
	test('its prototypes are frozen once the layer is loaded', () => {
		recordingLayer()
		expect(Object.isFrozen(PostgresQueryCompiler.prototype)).toBe(true)
		expect(Object.isFrozen(DefaultQueryCompiler.prototype)).toBe(true)
	})

	test('replacing compileQuery (to drop the WHERE) throws', () => {
		const original = PostgresQueryCompiler.prototype.compileQuery
		expect(() => {
			PostgresQueryCompiler.prototype.compileQuery = function(node, queryId) {
				return original.call(this, { ...node, where: undefined }, queryId)
			}
		}).toThrow(TypeError)
		expect(Reflect.set(DefaultQueryCompiler.prototype, 'visitWhere', () => {})).toBe(false)
	})
})

describe('the connection factory cannot be replaced by an application module', () => {
	test('openPostgres, Database.fromDialect and Database.fromEngine are read-only, and no new static can be added', () => {
		const original = postgres.openPostgres
		const observed: string[] = []
		const wrapper = (options: postgres.PostgresOptions): Database => {
			observed.push(options.url)
			return original(options)
		}
		expect(Object.isFrozen(Database)).toBe(true)
		expect(Reflect.set(postgres, 'openPostgres', wrapper)).toBe(false)
		expect(Reflect.defineProperty(postgres, 'openPostgres', { value: wrapper })).toBe(false)
		expect(Reflect.defineProperty(Database, 'fromDialect', { value: wrapper })).toBe(false)
		expect(Reflect.set(Database, 'fromEngine', wrapper)).toBe(false)
		expect(Reflect.deleteProperty(Database, 'fromDialect')).toBe(false)
		expect(Reflect.set(Database, 'open', wrapper)).toBe(false)
		expect(Object.isFrozen(original)).toBe(true)
		expect(postgres.openPostgres).toBe(original)
		expect(() => postgres.openPostgres({ url: 'postgres://user:synthetic-secret@127.0.0.1:1/x', schema: 'Bad-Schema' })).toThrow(QueryRefusedError)
		expect(observed).toEqual([])
	})
})

describe('patched built-ins do not disable the guard', () => {
	test('with Array.find and Array.some patched, a grant inside the Within still filters on the row’s own key', async () => {
		const layer = recordingLayer()
		const onlyNotes = layer.capabilities.within('workspace', 'notes.read', [], [], [{ dimension: 'note', values: ['n1'] }])
		const outcome = await patchedChecks(
			{ find: { dimension: 'note', column: 'workspace_id' }, some: false },
			() => layer.attempt(() => layer.stores.notes.search(onlyNotes, 'x')),
		)
		expect(outcome.statements[0]?.sql).toContain('and "notes"."id" in ($3) order by')
		expect(outcome.statements[0]?.sql).not.toContain('"notes"."workspace_id" in')
	})

	test('with Array.find patched, a ctx.sql.scope container grant still binds its own column', async () => {
		const dialect = new RecordingDialect()
		const authority = new TestAuthority('user:alice')
		const layer = scoped(tables)
		bindScopedDatabase(layer, { database: Database.fromDialect(dialect), capabilities: authority })
		const access = dataAccessOf(layer)
		const session = access.direct()
		const sql = access.sql({ mode: 'read', check() {}, session: async () => session, fail: () => session.fail() })
		const inOrganization = authority.within('workspace', 'notes.read', [], [{ dimension: 'organization', values: ['o1'] }])
		await patchedChecks(
			{ find: { dimension: 'organization', column: 'title' } },
			() => sql(z.object({}))`select n.id from notes n where ${sql.scope(inOrganization, 'notes', 'n')}`,
		)
		const sent = dialect.log.map((statement) => statement.sql)
		expect(sent).toHaveLength(1)
		expect(sent[0]).toContain('n.organization_id = any(')
		expect(sent[0]).not.toContain('n.title')
	})

	test('with Set.has, Array.find, Object.hasOwn, Object.keys and Object.getOwnPropertyDescriptor patched, an injected operator is still refused', async () => {
		const layer = recordingLayer()
		const injected = '= $1) or true or ("notes"."title" ='
		const outcome = await patchedChecks(
			{
				setHas: true,
				find: injected,
				hasOwn: true,
				keys: [],
				getOwnPropertyDescriptor: undefined,
				isArray: false,
			},
			() => layer.attempt(() => call(layer.raw.notes, 'select', layer.within('notes.read'), (q: unknown) => call(q, 'where', 'title', injected, 'x'))),
		)
		expect(outcome.error).toBeInstanceOf(QueryRefusedError)
		expect(outcome.error?.message).toContain('not allowed')
		expect(outcome.statements).toEqual([])
	})
})

describe('patched built-ins do not disable the policy and allowlist checks', () => {
	const allowAll = { setHas: true, includes: true, some: true, hasOwnProperty: true, hasOwn: true } as const

	function refused(outcome: Outcome, kind: typeof CapabilityError | typeof QueryRefusedError, message: string): void {
		expect(outcome.error).toBeInstanceOf(kind)
		expect(outcome.error?.message).toContain(message)
		expect(outcome.statements).toEqual([])
	}

	test('the patches are in effect while the store runs', async () => {
		const seen = await patchedChecks(allowAll, async () => {
			const hasOwnProperty: unknown = Reflect.get(Object.prototype, 'hasOwnProperty')
			return [new Set().has('x'), ['a'].includes('b'), typeof hasOwnProperty === 'function' && Reflect.apply(hasOwnProperty, {}, ['x'])]
		})
		expect(seen).toEqual([true, true, true])
	})

	test('a scope column in update data is still refused', async () => {
		const layer = recordingLayer()
		const outcome = await patchedChecks(
			allowAll,
			() =>
				layer.attempt(() =>
					call(layer.raw.notes, 'update', layer.noteRef('notes.write'), { workspace_id: 'w2', organization_id: 'o2' }, { expectVersion: 1 })
				),
		)
		refused(outcome, QueryRefusedError, 'workspace_id is not an update column of notes')
	})

	test('a restricted column is still never selected, filtered or aggregated', async () => {
		const layer = recordingLayer()
		const within = layer.within('notes.read')
		const attempts = [
			() => call(layer.raw.notes, 'select', within, (q: unknown) => call(q, 'columns', ['internal'])),
			() => call(layer.raw.notes, 'select', within, (q: unknown) => call(q, 'where', 'internal', '=', 'x')),
			() => call(layer.raw.notes, 'aggregate', within, { min: ['internal'] }),
		]
		for (const attempt of attempts) {
			refused(await patchedChecks(allowAll, () => layer.attempt(attempt)), QueryRefusedError, 'internal is not a column of notes')
		}
	})

	test('a chain entry the table carries no column for is still refused', async () => {
		const layer = recordingLayer()
		const deeper = layer.capabilities.ref('note', 'notes.read', 'n1', { workspace: 'w1', organization: 'o1', region: 'eu' })
		const outcome = await patchedChecks(allowAll, () => layer.attempt(() => layer.stores.notes.get(deeper)))
		refused(outcome, CapabilityError, 'lies in region')
	})

	test('a table that is not a store table is still refused', async () => {
		const layer = recordingLayer()
		const outcome = await patchedChecks(
			allowAll,
			() => layer.attempt(() => Reflect.apply(defineStore, undefined, [layer.stores.database, 'hasOwnProperty', (t: unknown) => t])),
		)
		refused(outcome, QueryRefusedError, 'hasOwnProperty is not a dimension table')
	})
})
