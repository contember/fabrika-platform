// The table policies as data (`@fabrika/db/tables`), the connection the framework makes at boot, and the generated
// locator. The policy parse is one: `readTables` over unchecked values refuses what `defineTables` refuses.

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { applicationDatabaseSchema } from '../../../platform-node/src/application-postgres-migrations'
import { applicationSchema, Database } from '../database'
import { CapabilityError, PolicyError, QueryRefusedError } from '../errors'
import { scoped } from '../store'
import { isTables, readTables, tablePolicies } from '../tables'
import { TestAuthority } from './fixtures/authority'
import { RecordingDialect } from './fixtures/recording-dialect'
import { columns } from './fixtures/schema'
import { tables } from './fixtures/tables'

const notes = {
	scope: { dimension: 'note', key: 'id', in: { dimension: 'workspace', column: 'workspace_id' } },
	actions: { read: 'notes.read', insert: 'notes.write' },
	insert: ['title'],
}
const noteColumns = { notes: ['id', 'workspace_id', 'title'] }

describe('the policies as data', () => {
	test('tablePolicies gives every table its artifact form, with every optional field present', () => {
		const artifacts = tablePolicies(tables)
		const { notes: noteTable, note_comments: comments, countries, contact_messages: inbox } = artifacts
		expect(Object.keys(artifacts)).toEqual(Object.keys(columns))
		expect(noteTable).toEqual({
			scope: { mode: 'dimension', dimension: 'note', key: 'id', container: { dimension: 'workspace', column: 'workspace_id' } },
			actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write', delete: 'notes.delete' },
			insert: ['title', 'body', 'word_count', 'internal'],
			update: ['title', 'body', 'word_count'],
			version: 'version',
			createdBy: 'created_by',
			columns: { internal: { read: 'notes.delete' }, title: { read: 'notes.read' } },
		})
		expect(comments?.scope).toEqual({
			mode: 'child',
			parent: 'notes',
			key: 'id',
			column: 'note_id',
			inherit: ['workspace_id', 'organization_id'],
		})
		expect(countries).toMatchObject({ scope: { mode: 'reference', reason: 'read-only lookup data' }, insert: [], version: null })
		expect(inbox).toMatchObject({
			scope: { mode: 'inbox', form: 'contact' },
			actions: { read: 'contact.read', insert: null, update: null, delete: null },
		})
	})

	test('readTables over the same values gives the same policies', () => {
		const fromValues = readTables(JSON.parse(JSON.stringify(columns)), JSON.parse(JSON.stringify(policiesOf())))
		expect(tablePolicies(fromValues)).toEqual(tablePolicies(tables))
	})

	test('isTables tells defineTables output from artifacts', () => {
		expect(isTables(tables)).toBe(true)
		expect(isTables(tablePolicies(tables))).toBe(false)
	})

	test('the subpath bundles for a browser: no Bun API and no driver', async () => {
		const built = await Bun.build({ entrypoints: [join(import.meta.dir, '..', 'tables.ts')], target: 'browser' })
		expect(built.success).toBe(true)
		const [output] = built.outputs
		const text = output === undefined ? '' : await output.text()
		expect(text).not.toContain('kysely')
		expect(text).not.toMatch(/from ['"]bun['"]/)
	})
})

describe('readTables refuses what nobody type-checked', () => {
	const refusals: readonly (readonly [string, unknown, string])[] = [
		['a misspelt policy field', { notes: { ...notes, insrt: ['title'] } }, 'notes: the policy: insrt is not a field here'],
		['a misspelt action', { notes: { ...notes, actions: { read: 'notes.read', delet: 'notes.write' } } }, 'notes: actions: delet is not a field'],
		[
			'a scope with two modes',
			{ notes: { ...notes, scope: { dimension: 'note', key: 'id', child: 'notes' } } },
			'notes: scope: child is not a field here',
		],
		['a scope with no mode', { notes: { ...notes, scope: { key: 'id' } } }, 'notes: scope takes one mode'],
		['a scope that is not an object', { notes: { ...notes, scope: 'note' } }, 'notes: scope must be a plain object'],
		['a policy that is an array', { notes: [notes] }, 'notes: the policy must be a plain object'],
		['a container with an extra field', { notes: { ...notes, scope: { ...notes.scope, in: { ...notes.scope.in, key: 'id' } } } }, 'scope.in: key'],
		['an inbox with actions', { notes: { scope: { inbox: 'contact', read: 'notes.read' }, actions: { read: 'notes.read' } } }, 'an inbox table'],
		['a child without inherit', { notes: { ...notes, scope: { child: 'notes', key: 'id', column: 'workspace_id' } } }, 'scope.inherit takes'],
		['a column policy with an extra field', { notes: { ...notes, columns: { title: { read: 'notes.read', write: 'x' } } } }, 'columns.title: write'],
		['an action that is not a string', { notes: { ...notes, actions: { read: 7 } } }, 'actions.read must be a non-empty string'],
	]
	for (const [name, policies, message] of refusals) {
		test(name, () => {
			expect(() => readTables(noteColumns, policies)).toThrow(PolicyError)
			expect(() => readTables(noteColumns, policies)).toThrow(message)
		})
	}

	test('an accessor in a policy never runs', () => {
		let ran = false
		const policy = Object.defineProperty({ ...notes }, 'insert', {
			enumerable: true,
			get: () => {
				ran = true
				return ['title']
			},
		})
		expect(() => readTables(noteColumns, { notes: policy })).toThrow('insert is an accessor')
		expect(ran).toBe(false)
	})

	test('a column list that is not a plain object', () => {
		expect(() => readTables(new Map(), {})).toThrow('the column list must be a plain object')
	})
})

describe('the framework connects the layer once', () => {
	const authority = new TestAuthority()

	test('a store and the locator refuse before the framework connected the layer', async () => {
		const database = scoped(tables)
		const notesTable = database.defineStore('notes', (t) => t)
		await expect(notesTable.get(authority.ref('note', 'notes.read', 'n1', { workspace: 'w1', organization: 'o1' }))).rejects.toThrow(
			'the data layer is not connected',
		)
		await expect(database.locate('note', 'n1')).rejects.toThrow('the data layer is not connected')
	})

	test('a second connect is refused, so a module that connected first makes boot fail', () => {
		const database = scoped(tables)
		database.connect({ database: Database.fromDialect(new RecordingDialect()), capabilities: authority })
		expect(() => database.connect({ database: Database.fromDialect(new RecordingDialect()), capabilities: authority })).toThrow(CapabilityError)
	})

	test('the locator selects the containment columns of one object by key, guarded', async () => {
		const dialect = new RecordingDialect()
		const database = scoped(tables)
		database.connect({ database: Database.fromDialect(dialect), capabilities: authority })
		expect(await database.locate('note', 'n1')).toBeNull()
		expect(dialect.log.map((statement) => statement.sql)).toEqual([
			'select "notes"."id", "notes"."workspace_id", "notes"."organization_id" from "notes" where "notes"."id" = $1 limit $2',
		])
		expect(dialect.log[0]?.parameters).toEqual(['n1', 1])
	})

	test('the locator refuses a dimension no table owns and an empty id, before any statement', async () => {
		const dialect = new RecordingDialect()
		const database = scoped(tables)
		database.connect({ database: Database.fromDialect(dialect), capabilities: authority })
		await expect(database.locate('project', 'p1')).rejects.toBeInstanceOf(QueryRefusedError)
		await expect(database.locate('note', '')).rejects.toBeInstanceOf(QueryRefusedError)
		expect(dialect.log).toEqual([])
	})

	test('the tables it carries are the artifact form of its policies', () => {
		expect(scoped(tables).tables).toEqual(tablePolicies(tables))
	})
})

describe('the application schema', () => {
	test('equals the migration runner’s derivation', () => {
		for (const appId of ['notes', 'my-app', 'a1', 'a'.repeat(59)]) {
			expect(applicationSchema(appId)).toBe(applicationDatabaseSchema(appId))
		}
		for (const appId of ['', 'My', '-a', 'a_b', 'a'.repeat(60)]) {
			expect(() => applicationSchema(appId)).toThrow(QueryRefusedError)
			expect(() => applicationDatabaseSchema(appId)).toThrow()
		}
	})
})

/** The literal of `fixtures/tables.ts`, as plain values. */
function policiesOf(): unknown {
	return {
		organizations: {
			scope: { dimension: 'organization', key: 'id' },
			actions: { read: 'notes.read', insert: 'organizations.create' },
			insert: ['name'],
		},
		workspaces: {
			scope: { dimension: 'workspace', key: 'id', in: { dimension: 'organization', column: 'organization_id' } },
			actions: { read: 'notes.read', insert: 'workspaces.create', update: 'workspaces.admin', delete: 'workspaces.admin' },
			insert: ['name'],
			update: ['name'],
			createdBy: 'created_by',
		},
		notes: {
			scope: { dimension: 'note', key: 'id', in: { dimension: 'workspace', column: 'workspace_id' } },
			actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write', delete: 'notes.delete' },
			insert: ['title', 'body', 'word_count', 'internal'],
			update: ['title', 'body', 'word_count'],
			version: 'version',
			createdBy: 'created_by',
			columns: { internal: { read: 'notes.delete' }, title: { read: 'notes.read' } },
		},
		note_comments: {
			scope: { child: 'notes', key: 'id', column: 'note_id', inherit: ['workspace_id', 'organization_id'] },
			actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write', delete: 'notes.write' },
			insert: ['body'],
			update: ['body'],
		},
		note_flags: {
			scope: { child: 'notes', key: 'id', column: 'note_id', inherit: ['workspace_id', 'organization_id'] },
			actions: { read: 'notes.delete', insert: 'notes.write' },
			insert: ['reason'],
		},
		secrets: { scope: { dimension: 'secret', key: 'id' }, actions: { read: 'secrets.admin' } },
		countries: { scope: { reference: 'read-only lookup data' }, actions: { read: 'notes.read' } },
		contact_messages: { scope: { inbox: 'contact', read: 'contact.read' } },
	}
}
