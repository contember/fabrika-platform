// The store against a recording dialect: what reaches the connection, and what never does.
// Each refusal asserts that no statement was sent.

import { describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import type { Ref } from '../capability'
import { CapabilityError, NotFoundError, QueryRefusedError } from '../errors'
import { TestAuthority } from './fixtures/authority'
import { call, type Outcome, recordingLayer } from './fixtures/harness'

function refused(outcome: Outcome, kind: typeof CapabilityError | typeof QueryRefusedError, message?: string): void {
	expect(outcome.error).toBeInstanceOf(kind)
	if (message !== undefined) {
		expect(outcome.error?.message).toContain(message)
	}
	expect(outcome.statements).toEqual([])
}

describe('every statement carries its scope predicate', () => {
	test('a list is scoped to the Within values, after the caller conditions in parentheses', async () => {
		const layer = recordingLayer()
		const outcome = await layer.attempt(() => layer.stores.notes.search(layer.within('notes.read', ['w1', 'w2']), 'x'))
		expect(outcome.statements.map((statement) => statement.sql)).toEqual([
			'select "notes"."id", "notes"."title" from "notes" where (("notes"."title" ilike $1 or "notes"."body" ilike $2)) and "notes"."workspace_id" in ($3, $4) order by "notes"."title" asc limit $5',
		])
		expect(outcome.statements[0]?.parameters).toEqual(['%x%', '%x%', 'w1', 'w2', 50])
	})

	test('an object is addressed by its key and every container of its chain', async () => {
		const layer = recordingLayer()
		const note = layer.noteRef('notes.read', 'n1', 'w1')
		const outcome = await layer.attempt(() => layer.stores.notes.get(note))
		expect(outcome.error).toBeInstanceOf(NotFoundError)
		expect(outcome.statements[0]?.sql).toEndWith('from "notes" where "notes"."id" = $1 and "notes"."workspace_id" = $2')
		expect(outcome.statements[0]?.parameters).toEqual(['n1', 'w1'])
	})

	test('get, update, remove and move each include the whole chain', async () => {
		const layer = recordingLayer()
		const scope = '"notes"."id" = $'
		const container = '"notes"."workspace_id" = $'
		const outcomes = [
			await layer.attempt(() => layer.stores.notes.get(layer.noteRef('notes.read'))),
			await layer.attempt(() => layer.stores.notes.update(layer.noteRef('notes.write'), { title: 'x' }, 1)),
			await layer.attempt(() => layer.stores.notes.remove(layer.noteRef('notes.delete'))),
			await layer.attempt(() => layer.stores.notes.move(layer.noteRef('notes.delete'), layer.workspaceRef('notes.write', 'w2'))),
		]
		const statements = outcomes.flatMap((outcome) => outcome.statements)
		expect(statements.length).toBe(5)
		for (const statement of statements) {
			expect(statement.sql).toContain(scope)
			expect(statement.sql).toContain(container)
			expect(statement.parameters).toContain('n1')
			expect(statement.parameters).toContain('w1')
		}
	})

	test('a versioned update checks the version inside parentheses, then reads once to tell 404 from 409', async () => {
		const layer = recordingLayer()
		const outcome = await layer.attempt(() => layer.stores.notes.update(layer.noteRef('notes.write'), { title: 'x' }, 3))
		expect(outcome.error).toBeInstanceOf(NotFoundError)
		expect(outcome.statements.map((statement) => statement.sql)).toEqual([
			'update "notes" set "title" = $1, "version" = "notes"."version" + $2 where ("notes"."version" = $3) and "notes"."id" = $4 and "notes"."workspace_id" = $5 returning "notes"."id", "notes"."workspace_id", "notes"."title", "notes"."body", "notes"."word_count", "notes"."created_by", "notes"."version", "notes"."created_at"',
			'select "notes"."id" from "notes" where "notes"."id" = $1 and "notes"."workspace_id" = $2 limit $3',
		])
	})

	test('an insert stamps the key, the container, the version and the principal', async () => {
		const layer = recordingLayer()
		const outcome = await layer.attempt(() => layer.stores.notes.create(layer.workspaceRef('notes.write', 'w2'), { title: 't', body: null }))
		const [statement] = outcome.statements
		expect(statement?.sql).toStartWith(
			'insert into "notes" ("title", "body", "id", "version", "created_by", "workspace_id") values ($1, $2, $3, $4, $5, $6)',
		)
		expect(statement?.parameters.slice(3)).toEqual([1, 'user:alice', 'w2'])
		expect(String(statement?.parameters[2])).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
	})

	test('a child row is addressed by its key and its parent chain', async () => {
		const layer = recordingLayer()
		const note = layer.noteRef('notes.write', 'n1', 'w1')
		const edit = await layer.attempt(() => layer.stores.comments.edit(note, 'c1', 'changed'))
		const add = await layer.attempt(() => layer.stores.comments.add(note, 'new'))
		expect(edit.statements[0]?.sql).toContain(
			'where "note_comments"."id" = $2 and "note_comments"."note_id" = $3 and "note_comments"."workspace_id" = $4',
		)
		expect(add.statements[0]?.sql).toStartWith('insert into "note_comments" ("body", "id", "note_id", "workspace_id")')
		expect(add.statements[0]?.parameters.slice(2)).toEqual(['n1', 'w1'])
	})

	test('a join is ON the composite foreign key, and its columns come back prefixed', async () => {
		const layer = recordingLayer()
		const outcome = await layer.attempt(() => layer.stores.notes.withComments(layer.within('notes.read'), ['n1']))
		expect(outcome.statements[0]?.sql).toBe(
			'select "notes"."id", "notes"."title", "note_comments"."id" as "note_comments.id", "note_comments"."body" as "note_comments.body" from "notes" inner join "note_comments" on "note_comments"."note_id" = "notes"."id" and "note_comments"."workspace_id" = "notes"."workspace_id" where ("notes"."id" in ($1)) and "notes"."workspace_id" in ($2) order by "notes"."id" asc',
		)
	})

	test('an aggregate counts within the scope', async () => {
		const layer = recordingLayer()
		const outcome = await layer.attempt(() => layer.stores.comments.countPerNote(layer.within('notes.read', ['w1'])))
		expect(outcome.statements[0]?.sql).toBe(
			'select "note_comments"."note_id", count(*) as "count" from "note_comments" where "note_comments"."workspace_id" in ($1) group by "note_comments"."note_id"',
		)
	})

	test('a top-level table lists by its own key and inserts the object the Ref names', async () => {
		const layer = recordingLayer()
		const list = await layer.attempt(() => layer.stores.workspaces.list(layer.within('notes.read', ['w1', 'w2'])))
		const create = await layer.attempt(() => layer.stores.workspaces.create(layer.workspaceRef('workspaces.create', 'w9'), 'Nine'))
		expect(list.statements[0]?.sql).toContain('where "workspaces"."id" in ($1, $2)')
		expect(create.statements[0]?.parameters).toEqual(['Nine', 'w9', 'user:alice'])
	})

	test('an empty Within answers [] without a query; Within.all scopes to true', async () => {
		const layer = recordingLayer()
		expect(await layer.stores.notes.list(layer.within('notes.read', []), { limit: 10, offset: 0 })).toEqual([])
		expect(await layer.stores.notes.countPerWorkspace(layer.within('notes.read', []))).toEqual([])
		expect(layer.dialect.log).toEqual([])
		const all = await layer.attempt(() => layer.stores.notes.list(layer.within('notes.read', 'all'), { limit: 10, offset: 0 }))
		expect(all.statements[0]?.sql).toContain('where true order by')
	})

	test('a column with its own read action is never returned, selected or filtered', async () => {
		const layer = recordingLayer()
		const outcome = await layer.attempt(() => layer.stores.notes.all(layer.within('notes.read')))
		expect(outcome.statements[0]?.sql).not.toContain('internal')
		refused(
			await layer.attempt(() => call(layer.raw.notes, 'select', layer.within('notes.read'), (q: unknown) => call(q, 'columns', ['internal']))),
			QueryRefusedError,
			'internal is not a column of notes',
		)
		refused(
			await layer.attempt(() => call(layer.raw.notes, 'select', layer.within('notes.read'), (q: unknown) => call(q, 'where', 'internal', '=', 'x'))),
			QueryRefusedError,
		)
	})

	test('contains matches % and _ literally', async () => {
		const layer = recordingLayer()
		const outcome = await layer.attempt(() => layer.stores.notes.titled(layer.within('notes.read'), '50%_off\\'))
		expect(outcome.statements[0]?.parameters[0]).toBe('%50\\%\\_off\\\\%')
	})
})

describe('capabilities are checked on every operation', () => {
	test('a read Ref passed to remove through a widened handle (method bivariance, no cast)', async () => {
		const layer = recordingLayer()
		const widened: { remove(ref: Ref<string, string>): Promise<void> } = layer.raw.notes
		refused(
			await layer.attempt(() => widened.remove(layer.noteRef('notes.read'))),
			CapabilityError,
			'delete on notes requires notes.delete; the capability holds notes.read',
		)
	})

	test('a Within of the wrong action cannot list', async () => {
		const layer = recordingLayer()
		refused(
			await layer.attempt(() => call(layer.raw.notes, 'select', layer.within('notes.write'), (q: unknown) => q)),
			CapabilityError,
			'requires notes.read',
		)
	})

	test('a Ref of the wrong dimension cannot address a note', async () => {
		const layer = recordingLayer()
		refused(await layer.attempt(() => call(layer.raw.notes, 'get', layer.workspaceRef('notes.read'))), CapabilityError, 'needs a ref of note')
	})

	test('a Within where a Ref is needed, and a Ref where a Within is needed', async () => {
		const layer = recordingLayer()
		refused(await layer.attempt(() => call(layer.raw.notes, 'get', layer.within('notes.read'))), CapabilityError, 'needs a Ref')
		refused(
			await layer.attempt(() => call(layer.raw.notes, 'select', layer.workspaceRef('notes.read'), (q: unknown) => q)),
			CapabilityError,
			'needs a Within',
		)
	})

	test('a structurally matching object is not a capability', async () => {
		const layer = recordingLayer()
		const forged: Ref<'note', 'notes.read'> = { '~capability': { kind: 'ref', dimension: 'note', action: 'notes.read' } }
		refused(await layer.attempt(() => layer.stores.notes.get(forged)), CapabilityError, 'not a capability')
	})

	test('an object created from a capability prototype is not a capability', async () => {
		const layer = recordingLayer()
		const copy: unknown = Object.create(Object.getPrototypeOf(layer.noteRef('notes.read')))
		refused(await layer.attempt(() => call(layer.raw.notes, 'get', copy)), CapabilityError)
	})

	test('a capability minted for another caller is refused', async () => {
		const layer = recordingLayer()
		const foreign = new TestAuthority('user:bob').ref('note', 'notes.read', 'n2', { workspace: 'w2' })
		refused(await layer.attempt(() => layer.stores.notes.get(foreign)), CapabilityError)
	})

	test('a Ref without its container in the chain cannot form a full predicate', async () => {
		const layer = recordingLayer()
		const partial = layer.capabilities.ref('note', 'notes.read', 'n1')
		refused(await layer.attempt(() => layer.stores.notes.get(partial)), CapabilityError, 'carries no workspace')
	})

	test('an operation the table declares no action for is refused', async () => {
		const layer = recordingLayer()
		const secret = layer.capabilities.ref('secret', 'secrets.admin', 's1')
		refused(await layer.attempt(() => call(layer.raw.secrets, 'remove', secret)), CapabilityError, 'secrets allows no delete')
		refused(await layer.attempt(() => call(layer.raw.secrets, 'insert', secret, {})), CapabilityError, 'secrets allows no insert')
	})

	test('a child row cannot be reached with a workspace Ref', async () => {
		const layer = recordingLayer()
		refused(
			await layer.attempt(() => call(layer.raw.comments, 'insert', layer.workspaceRef('notes.write'), { body: 'x' })),
			CapabilityError,
			'needs a ref of note',
		)
		refused(await layer.attempt(() => call(layer.raw.comments, 'remove', layer.workspaceRef('notes.write'), 'c1')), CapabilityError)
	})

	test('a move needs the delete action at the source and the insert action at the target', async () => {
		const layer = recordingLayer()
		refused(
			await layer.attempt(() => call(layer.raw.notes, 'move', layer.noteRef('notes.write'), layer.workspaceRef('notes.write', 'w2'))),
			CapabilityError,
			'requires notes.delete',
		)
		refused(
			await layer.attempt(() => call(layer.raw.notes, 'move', layer.noteRef('notes.delete'), layer.workspaceRef('notes.read', 'w2'))),
			CapabilityError,
			'requires notes.write',
		)
	})

	test("a join to a child whose read action differs from the capability's is refused", async () => {
		const layer = recordingLayer()
		const build = (q: unknown) => call(q, 'join', 'note_flags', (f: unknown) => f)
		refused(
			await layer.attempt(() => call(layer.raw.notes, 'select', layer.within('notes.read'), build)),
			CapabilityError,
			'joining note_flags requires notes.delete',
		)
	})
})

describe('the query description cannot express anything but scoped reads (types defeated)', () => {
	const select = (layer: ReturnType<typeof recordingLayer>, build: (q: unknown) => unknown) =>
		layer.attempt(() => call(layer.raw.notes, 'select', layer.within('notes.read'), build))

	const cases: readonly (readonly [string, (q: unknown) => unknown])[] = [
		['where(sql`true or 1=1`)', (q) => call(q, 'where', sql`true or 1=1`)],
		["where('title', '=', sql`(select value from secrets)`)", (q) => call(q, 'where', 'title', '=', sql`(select value from secrets limit 1)`)],
		["where('title', '= $1) or (true', 'x') operator injection", (q) => call(q, 'where', 'title', '= $1) or (true', 'x')],
		["where('title', 'in', [sql`...`])", (q) => call(q, 'where', 'title', 'in', [sql`(select 1)`])],
		["where('title', 'in', [])", (q) => call(q, 'where', 'title', 'in', [])],
		["where('title', 'is', 'x')", (q) => call(q, 'where', 'title', 'is', 'x')],
		["where('title', '=', ['a', 'b']) (a bound array)", (q) => call(q, 'where', 'title', '=', ['a', 'b'])],
		["where('title', '=', { json: true })", (q) => call(q, 'where', 'title', '=', { json: true })],
		['whereAny([[sql`true`, "=", 1]])', (q) => call(q, 'whereAny', [[sql`true`, '=', 1]])],
		['whereAny([])', (q) => call(q, 'whereAny', [])],
		['.union(...)', (q) => call(q, 'union', q)],
		["where('id', 'in', eb => eb.selectFrom('secrets'))", (q) => call(q, 'where', 'id', 'in', () => sql`select id from secrets`)],
		['clearWhere()', (q) => call(q, 'clearWhere')],
		['execute() inside the callback', (q) => call(q, 'execute')],
		["selectFrom('secrets') through the description", (q) => call(q, 'selectFrom', 'secrets')],
		["join('secrets')", (q) => call(q, 'join', 'secrets', (s: unknown) => s)],
		["columns(['id', 'value from secrets --'])", (q) => call(q, 'columns', ['id', 'value from secrets --'])],
		["columns(['secrets.value']) (dotted reference)", (q) => call(q, 'columns', ['secrets.value'])],
		["columns(['TITLE']) (not a column)", (q) => call(q, 'columns', ['TITLE'])],
		["orderBy('id', sql`desc; drop table notes`)", (q) => call(q, 'orderBy', 'id', sql`desc; drop table notes`)],
		['limit(sql`1 union select ...`)', (q) => call(q, 'limit', sql`1 union select * from secrets`)],
		['limit(-1)', (q) => call(q, 'limit', -1)],
		['modifyEnd(sql`...`)', (q) => call(q, 'modifyEnd', sql`for update`)],
		['$call', (q) => call(q, '$call', (b: unknown) => b)],
		['with (CTE)', (q) => call(q, 'with', 's', () => q)],
		['withPlugin', (q) => call(q, 'withPlugin', {})],
		['callback returns a plain object', () => ({ table: 'secrets' })],
		['forge a description via q.constructor', (q) => call(q, 'constructor')],
		['join callback returns a foreign object', (q) => call(q, 'join', 'note_comments', () => ({}))],
		['join callback orders the child', (q) => call(q, 'join', 'note_comments', (c: unknown) => call(c, 'orderBy', 'id'))],
	]

	for (const [label, build] of cases) {
		test(label, async () => {
			const outcome = await select(recordingLayer(), build)
			expect(outcome.error).toBeInstanceOf(Error)
			expect(outcome.statements).toEqual([])
		})
	}

	test('new on the description class is refused', async () => {
		const layer = recordingLayer()
		const outcome = await select(layer, (q) => {
			const constructor: unknown = Object.getPrototypeOf(q)?.constructor
			if (typeof constructor !== 'function') {
				throw new TypeError('no constructor')
			}
			return Reflect.construct(constructor, [Symbol('scoped-select'), { table: 'secrets' }, {}])
		})
		refused(outcome, QueryRefusedError, 'created by the store only')
	})

	test('a description from another table or query is refused', async () => {
		const layer = recordingLayer()
		let captured: unknown
		await layer.attempt(() => call(layer.raw.notes, 'select', layer.within('notes.read'), (q: unknown) => (captured = q)))
		const outcome = await layer.attempt(() => call(layer.raw.notes, 'select', layer.within('notes.read'), () => captured))
		refused(outcome, QueryRefusedError, 'not one from another query')
		const comments = await layer.attempt(() => call(layer.raw.comments, 'select', layer.noteRef('notes.read'), () => captured))
		refused(comments, QueryRefusedError)
	})

	test('the description is frozen', async () => {
		const layer = recordingLayer()
		await layer.attempt(() =>
			call(layer.raw.notes, 'select', layer.within('notes.read'), (q: unknown) => {
				expect(Object.isFrozen(q)).toBe(true)
				expect(Object.isFrozen(Object.getPrototypeOf(q))).toBe(true)
				return q
			})
		)
	})
})

describe('writes take declared columns and plain values only', () => {
	test('an unknown key is refused, not dropped, even from a variable the types let through', async () => {
		const layer = recordingLayer()
		const values = { title: 'x', body: null, workspace_id: 'w9' }
		refused(
			await layer.attempt(() => layer.stores.notes.create(layer.workspaceRef('notes.write'), values)),
			QueryRefusedError,
			'workspace_id is not an insert column of notes',
		)
	})

	test('the key, the version, the scope columns and created_by cannot be written', async () => {
		const layer = recordingLayer()
		const write = layer.noteRef('notes.write')
		refused(
			await layer.attempt(() => call(layer.raw.notes, 'insert', layer.workspaceRef('notes.write'), { title: 'x', id: 'chosen' })),
			QueryRefusedError,
			'id is not',
		)
		refused(
			await layer.attempt(() => call(layer.raw.notes, 'update', write, { version: 999 }, { expectVersion: 1 })),
			QueryRefusedError,
			'version is not',
		)
		refused(
			await layer.attempt(() => call(layer.raw.notes, 'update', write, { workspace_id: 'w9' }, { expectVersion: 1 })),
			QueryRefusedError,
			'workspace_id is not',
		)
		refused(
			await layer.attempt(() => call(layer.raw.notes, 'update', write, { created_by: 'user:eve' }, { expectVersion: 1 })),
			QueryRefusedError,
			'created_by is not',
		)
	})

	test('a value must be plain: no expression, no JSON object, no array', async () => {
		const layer = recordingLayer()
		const target = layer.workspaceRef('notes.write')
		for (const title of [sql`(select value from secrets limit 1)`, { a: 1 }, ['a', 'b']]) {
			refused(await layer.attempt(() => call(layer.raw.notes, 'insert', target, { title, body: null })), QueryRefusedError, 'takes a plain value')
		}
		refused(await layer.attempt(() => call(layer.raw.notes, 'insert', target, ['title'])), QueryRefusedError, 'takes an object')
	})

	test('a versioned table needs expectVersion; an empty update is refused', async () => {
		const layer = recordingLayer()
		refused(
			await layer.attempt(() => call(layer.raw.notes, 'update', layer.noteRef('notes.write'), { title: 'x' })),
			QueryRefusedError,
			'expectVersion',
		)
		const rename = layer.workspaceRef('workspaces.admin')
		refused(await layer.attempt(() => call(layer.raw.workspaces, 'update', rename, {})), QueryRefusedError, 'nothing to update')
	})

	test('a child update takes a non-empty key', async () => {
		const layer = recordingLayer()
		refused(await layer.attempt(() => call(layer.raw.comments, 'remove', layer.noteRef('notes.write'), '')), QueryRefusedError)
		refused(await layer.attempt(() => call(layer.raw.comments, 'remove', layer.noteRef('notes.write'), { id: 'c1' })), QueryRefusedError)
	})

	test('an aggregate takes visible columns and at least one aggregate', async () => {
		const layer = recordingLayer()
		const within = layer.within('notes.read')
		refused(await layer.attempt(() => call(layer.raw.notes, 'aggregate', within, { groupBy: ['workspace_id'] })), QueryRefusedError, 'needs count')
		refused(
			await layer.attempt(() => call(layer.raw.notes, 'aggregate', within, { count: true, sum: ['internal'] })),
			QueryRefusedError,
			'internal is not a column',
		)
		refused(
			await layer.attempt(() => call(layer.raw.notes, 'aggregate', within, { count: true, groupBy: 'workspace_id' })),
			QueryRefusedError,
			'list of column names',
		)
		refused(
			await layer.attempt(() => call(layer.raw.notes, 'aggregate', within, { count: true, where: (q: unknown) => call(q, 'columns', ['id']) })),
			QueryRefusedError,
			'where conditions only',
		)
	})
})
