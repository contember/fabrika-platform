// The backstop: operation trees that an unrestricted Kysely builds (what a defeated wrapper could hand over),
// each grafted onto a statement the layer itself built, against the guard alone. Kysely is pinned; these run on
// every upgrade, because the guard reads Kysely's internal node shapes.

import { describe, expect, test } from 'bun:test'
import {
	AliasNode,
	AndNode,
	BinaryOperationNode,
	type DeleteQueryNode,
	DummyDriver,
	ExplainNode,
	expressionBuilder,
	FromNode,
	IdentifierNode,
	type InsertQueryNode,
	Kysely,
	type OperationNode,
	OperatorNode,
	OrNode,
	ParensNode,
	PostgresAdapter,
	PostgresIntrospector,
	PostgresQueryCompiler,
	SelectionNode,
	type SelectQueryNode,
	sql,
	TableNode,
	type UpdateQueryNode,
	UsingNode,
	ValueListNode,
	ValueNode,
	WhereNode,
} from 'kysely'
import { nameSet } from '../builtins'
import { subquery } from '../condition-nodes'
import { finishSelect, startSelect, type TableShape } from '../description'
import { QueryRefusedError } from '../errors'
import { assertAllowedTree, type GuardContext } from '../guard'
import {
	acknowledgement,
	allOf,
	anyOf,
	claimNode,
	column,
	deleteNode,
	equals,
	everything,
	existsNode,
	inList,
	insertNode,
	lockNode,
	scopedWhere,
	selectNode,
	updateNode,
} from '../nodes'

interface AttackDB {
	notes: { id: string; workspace_id: string; title: string; body: string | null; word_count: number; data: { a: string } }
	note_comments: { id: string; note_id: string; workspace_id: string; body: string }
	secrets: { id: string; value: string }
}

const k = new Kysely<AttackDB>({
	dialect: {
		createAdapter: () => new PostgresAdapter(),
		createDriver: () => new DummyDriver(),
		createIntrospector: (db) => new PostgresIntrospector(db),
		createQueryCompiler: () => new PostgresQueryCompiler(),
	},
})
const eb = expressionBuilder<AttackDB, 'notes'>()
const compiler = new PostgresQueryCompiler()

const foreignKey = [{ childColumn: 'note_id', parentColumn: 'id' }, { childColumn: 'workspace_id', parentColumn: 'workspace_id' }]
const scope = inList('notes', 'workspace_id', ['w1'])
const selectContext: GuardContext = { root: 'SelectQueryNode', table: 'notes', joins: { note_comments: foreignKey }, scope }

const commentsShape: TableShape = { table: 'note_comments', visible: nameSet(['id', 'body']), joinable: {}, dates: nameSet([]), json: nameSet([]) }
const notesShape: TableShape = {
	table: 'notes',
	visible: nameSet(['id', 'title', 'workspace_id']),
	joinable: { note_comments: { shape: commentsShape, readActions: ['notes.read'], on: foreignKey } },
	dates: nameSet([]),
	json: nameSet([]),
}

function legitSelect(): SelectQueryNode {
	const start = startSelect<{ id: string }, Record<string, never>>(notesShape)
	return selectNode(finishSelect(start, start), ['id', 'title'], scope)
}

function legitJoin(): SelectQueryNode {
	const start = startSelect<{ id: string }, { note_comments: { id: string; body: string } }>(notesShape)
	const built = start.join('note_comments', (c) => c.columns(['body']).where('body', '=', 'x'))
	return selectNode(finishSelect(built, start), ['id'], scope)
}

function select(properties: Partial<SelectQueryNode>): SelectQueryNode {
	return { ...legitSelect(), ...properties }
}

function withCondition(condition: OperationNode): SelectQueryNode {
	return select({ where: scopedWhere(condition, scope) })
}

function refuses(node: OperationNode, context: GuardContext, message?: string): void {
	expect(() => assertAllowedTree(node, context)).toThrow(QueryRefusedError)
	if (message !== undefined) {
		expect(() => assertAllowedTree(node, context)).toThrow(message)
	}
}

const updateScope = BinaryOperationNode.create(column('notes', 'id'), OperatorNode.create('='), ValueNode.create('n1'))
const updateContext: GuardContext = { root: 'UpdateQueryNode', table: 'notes', joins: {}, scope: updateScope }
const legitUpdate = (properties: Partial<UpdateQueryNode> = {}): UpdateQueryNode => ({
	...updateNode('notes', new Map([['title', 'x']]), 'version', scopedWhere(undefined, updateScope), acknowledgement('notes', 'id', 'version')),
	...properties,
})
const deleteContext: GuardContext = { root: 'DeleteQueryNode', table: 'notes', joins: {}, scope: updateScope }
const legitDelete = (properties: Partial<DeleteQueryNode> = {}): DeleteQueryNode => ({
	...deleteNode('notes', scopedWhere(undefined, updateScope), 'id'),
	...properties,
})
const insertContext: GuardContext = { root: 'InsertQueryNode', table: 'notes', joins: {}, scope: undefined }
const legitInsert = (properties: Partial<InsertQueryNode> = {}): InsertQueryNode => ({
	...insertNode('notes', new Map([['title', 'x']]), acknowledgement('notes', 'id', 'version')),
	...properties,
})

describe('statements the layer builds pass and compile', () => {
	test('select, join, update, delete and insert', () => {
		const statements: [OperationNode, GuardContext][] = [
			[legitSelect(), selectContext],
			[legitJoin(), selectContext],
			[legitUpdate(), updateContext],
			[legitDelete(), deleteContext],
			[legitInsert(), insertContext],
		]
		for (const [node, context] of statements) {
			expect(() => assertAllowedTree(node, context)).not.toThrow()
		}
		expect(compiler.compileQuery(legitJoin(), { queryId: 'q' }).sql).toContain(
			'inner join "note_comments" on "note_comments"."note_id" = "notes"."id" and "note_comments"."workspace_id" = "notes"."workspace_id" and ("note_comments"."body" = $1)',
		)
	})
})

describe('the scope predicate has one of the shapes the layer builds', () => {
	const scopedBy = (predicate: OperationNode): [SelectQueryNode, GuardContext] => [
		select({ where: scopedWhere(equals('notes', 'title', 'x'), predicate) }),
		{ ...selectContext, scope: predicate },
	]
	const workspaces = inList('notes', 'workspace_id', ['w1'])
	const organizations = inList('notes', 'organization_id', ['o1', 'o2'])

	test('true, an AND of column = value, a membership, and a parenthesized OR of memberships pass', () => {
		const shapes = [
			everything(),
			allOf([equals('notes', 'id', 'n1'), allOf([equals('notes', 'workspace_id', 'w1'), equals('notes', 'organization_id', 'o1')])]),
			workspaces,
			anyOf([workspaces, organizations]),
			anyOf([workspaces, organizations, inList('notes', 'region_id', ['r1'])]),
		]
		for (const shape of shapes) {
			const [node, context] = scopedBy(shape)
			expect(() => assertAllowedTree(node, context)).not.toThrow()
		}
		expect(compiler.compileQuery(scopedBy(anyOf([workspaces, organizations]))[0], { queryId: 'q' }).sql).toContain(
			'where ("notes"."title" = $1) and ("notes"."workspace_id" in ($2) or "notes"."organization_id" in ($3, $4))',
		)
	})

	test('nothing looser: an OR without its parenthesis, or with a leaf that is not a membership of this table', () => {
		const shapes = [
			OrNode.create(workspaces, organizations),
			ParensNode.create(OrNode.create(workspaces, ValueNode.createImmediate(true))),
			ParensNode.create(OrNode.create(workspaces, equals('notes', 'organization_id', 'o1'))),
			ParensNode.create(OrNode.create(workspaces, inList('note_comments', 'organization_id', ['o1']))),
			ParensNode.create(OrNode.create(workspaces, ParensNode.create(organizations))),
			ParensNode.create(workspaces),
			BinaryOperationNode.create(column('notes', 'workspace_id'), OperatorNode.create('in'), ValueListNode.create([])),
			BinaryOperationNode.create(column('notes', 'workspace_id'), OperatorNode.create('in'), ValueListNode.create([ValueNode.createImmediate(true)])),
			BinaryOperationNode.create(column('notes', 'workspace_id'), OperatorNode.create('not in'), ValueListNode.create([ValueNode.create('w1')])),
			AndNode.create(equals('notes', 'id', 'n1'), workspaces),
			AndNode.create(equals('notes', 'id', 'n1'), ValueNode.createImmediate(true)),
			BinaryOperationNode.create(column('notes', 'id'), OperatorNode.create('<>'), ValueNode.create('n1')),
			ValueNode.createImmediate(false),
		]
		for (const shape of shapes) {
			const [node, context] = scopedBy(shape)
			refuses(node, context, 'the scope predicate must be true')
		}
	})
})

describe('a scope held through relations or narrowed by a condition', () => {
	const subqueries = { note_members: ['note_id', 'principal_id', 'expires_at'], secrets: ['id'] }
	const scopedBy = (predicate: OperationNode): [SelectQueryNode, GuardContext] => [
		select({ where: scopedWhere(equals('notes', 'title', 'x'), predicate) }),
		{ ...selectContext, scope: predicate, subqueries },
	]
	const workspaces = inList('notes', 'workspace_id', ['w1'])
	const members = (where: OperationNode, table = 'note_members', selected = 'note_id') =>
		BinaryOperationNode.create(column('notes', 'id'), OperatorNode.create('in'), subquery(table, selected, where))
	const mine = equals('note_members', 'principal_id', 'user:alice')
	const unexpired = anyOf([
		BinaryOperationNode.create(column('note_members', 'expires_at'), OperatorNode.create('is'), ValueNode.createImmediate(null)),
		BinaryOperationNode.create(column('note_members', 'expires_at'), OperatorNode.create('>'), ValueNode.create(new Date(0))),
	])
	const open = BinaryOperationNode.create(column('notes', 'word_count'), OperatorNode.create('<'), ValueNode.create(100))

	test("a relation's rows, beside values or after a Ref's chain, and a reach AND a parenthesized condition pass", () => {
		const related = members(allOf([mine, unexpired]))
		const shapes = [
			related,
			anyOf([workspaces, related]),
			allOf([equals('notes', 'id', 'n1'), related]),
			AndNode.create(workspaces, ParensNode.create(open)),
			AndNode.create(everything(), ParensNode.create(open)),
			AndNode.create(anyOf([workspaces, related]), ParensNode.create(open)),
		]
		for (const shape of shapes) {
			const [node, context] = scopedBy(shape)
			expect(() => assertAllowedTree(node, context)).not.toThrow()
		}
	})

	test('a condition never stands in for the reach, and a relation subquery is anchored on its principal', () => {
		const shapes = [
			open,
			ParensNode.create(open),
			AndNode.create(ParensNode.create(open), workspaces),
			AndNode.create(workspaces, open),
			members(unexpired),
			members(allOf([unexpired, mine])),
			members(mine, 'secrets', 'id'),
			members(mine, 'note_members', 'body'),
			members(mine, 'notes', 'id'),
			AndNode.create(equals('notes', 'id', 'n1'), workspaces),
		]
		for (const shape of shapes) {
			const [node, context] = scopedBy(shape)
			refuses(node, context, 'the scope predicate must be true')
		}
	})

	test('a subquery reads only a table the layer admits', () => {
		const [node, context] = scopedBy(members(mine))
		refuses(node, { ...context, subqueries: {} }, 'the scope predicate must be true')
	})
})

describe('a relation whose principal is reached through a to-one path', () => {
	const subqueries = { note_members: ['note_id'], people: ['id'], teams: ['id'], orgs: ['id'], accounts: ['id'] }
	const scopedBy = (predicate: OperationNode): [SelectQueryNode, GuardContext] => [
		select({ where: scopedWhere(equals('notes', 'title', 'x'), predicate) }),
		{ ...selectContext, scope: predicate, subqueries },
	]
	const into = (table: string, name: string, target: string, where: OperationNode, selected = 'id') =>
		BinaryOperationNode.create(column(table, name), OperatorNode.create('in'), subquery(target, selected, where))
	/** `notes.id in (select note_id from note_members where person_id in (select id from <tables[0]> where …))`, anchored innermost. */
	const through = (tables: readonly string[], innermost?: OperationNode): OperationNode => {
		const last = tables[tables.length - 1] ?? ''
		let where = innermost ?? equals(last, 'principal_id', 'user:alice')
		for (let index = tables.length - 1; index > 0; index--) {
			where = into(tables[index - 1] ?? '', 'next_id', tables[index] ?? '', where)
		}
		return into('notes', 'id', 'note_members', into('note_members', 'person_id', tables[0] ?? '', where), 'note_id')
	}

	test("the path's subquery passes as the source's anchor, beside values and after a Ref's chain", () => {
		const unexpired = BinaryOperationNode.create(column('note_members', 'expires_at'), OperatorNode.create('is'), ValueNode.createImmediate(null))
		const anchored = into('note_members', 'person_id', 'people', equals('people', 'principal_id', 'user:alice'))
		const related = into('notes', 'id', 'note_members', allOf([anchored, unexpired]), 'note_id')
		for (const shape of [related, anyOf([inList('notes', 'workspace_id', ['w1']), related]), allOf([equals('notes', 'id', 'n1'), related])]) {
			const [node, context] = scopedBy(shape)
			expect(() => assertAllowedTree(node, context)).not.toThrow()
		}
	})

	test('the nesting stops at four subqueries: three tables past the source pass, a fourth is refused', () => {
		const [deepest, context] = scopedBy(through(['people', 'teams', 'orgs']))
		expect(() => assertAllowedTree(deepest, context)).not.toThrow()
		const [deeper, same] = scopedBy(through(['people', 'teams', 'orgs', 'accounts']))
		refuses(deeper, same, 'the scope predicate must be true')
	})

	test("a path's subquery not anchored on the principal, selecting another column or reading an unadmitted table is refused", () => {
		const unanchored = BinaryOperationNode.create(column('people', 'principal_id'), OperatorNode.create('<>'), ValueNode.create('user:alice'))
		const shapes = [
			through(['people'], unanchored),
			into('notes', 'id', 'note_members', into('note_members', 'person_id', 'people', equals('people', 'principal_id', 'x'), 'principal_id'), 'note_id'),
			through(['secrets']),
		]
		for (const shape of shapes) {
			const [node, context] = scopedBy(shape)
			refuses(node, context, 'the scope predicate must be true')
		}
	})
})

describe("a child view's rows read through its parent row", () => {
	const through = { column: 'workspace_id', table: 'workspaces', key: 'id' }
	const subqueries = { workspace_members: ['workspace_id'] }
	const scopedBy = (predicate: OperationNode): [SelectQueryNode, GuardContext] => [
		select({ where: scopedWhere(equals('notes', 'title', 'x'), predicate) }),
		{ ...selectContext, scope: predicate, subqueries, through },
	]
	const parentRows = (where: OperationNode | undefined, table = 'workspaces', selected = 'id', viewColumn = 'workspace_id') =>
		BinaryOperationNode.create(column('notes', viewColumn), OperatorNode.create('in'), subquery(table, selected, where))
	const ref = allOf([equals('workspaces', 'id', 'w1'), equals('workspaces', 'organization_id', 'o1')])
	const related = BinaryOperationNode.create(
		column('workspaces', 'id'),
		OperatorNode.create('in'),
		subquery('workspace_members', 'workspace_id', equals('workspace_members', 'principal_id', 'user:alice')),
	)
	const open = BinaryOperationNode.create(column('notes', 'word_count'), OperatorNode.create('<'), ValueNode.create(100))

	test("the parent's Ref, Within or relation reach, or every parent row, passes after the key's equality and before the view's condition", () => {
		const shapes = [
			parentRows(ref),
			parentRows(inList('workspaces', 'organization_id', ['o1'])),
			parentRows(anyOf([inList('workspaces', 'organization_id', ['o1']), related])),
			parentRows(allOf([ref, related])),
			allOf([equals('notes', 'id', 'n1'), parentRows(ref)]),
			AndNode.create(parentRows(ref), ParensNode.create(open)),
			parentRows(undefined),
			AndNode.create(parentRows(undefined), ParensNode.create(open)),
		]
		for (const shape of shapes) {
			const [node, context] = scopedBy(shape)
			expect(() => assertAllowedTree(node, context)).not.toThrow()
		}
		expect(compiler.compileQuery(scopedBy(parentRows(ref))[0], { queryId: 'q' }).sql).toContain(
			'and "notes"."workspace_id" in (select "workspaces"."id" from "workspaces" where "workspaces"."id" = $2 and "workspaces"."organization_id" = $3)',
		)
	})

	test("nothing wider: no parent but the view's, no other column, no reach the parent's statement would not pass, and never nested", () => {
		const shapes = [
			parentRows(everything()),
			parentRows(open),
			parentRows(ref, 'secrets'),
			parentRows(undefined, 'secrets'),
			parentRows(undefined, 'workspaces', 'organization_id'),
			parentRows(undefined, 'workspaces', 'id', 'id'),
			parentRows(ref, 'workspaces', 'organization_id'),
			parentRows(ref, 'workspaces', 'id', 'id'),
			parentRows(parentRows(ref)),
			anyOf([parentRows(ref), inList('notes', 'workspace_id', ['w1'])]),
			allOf([parentRows(ref), equals('notes', 'id', 'n1')]),
			AndNode.create(ParensNode.create(open), parentRows(ref)),
		]
		for (const shape of shapes) {
			const [node, context] = scopedBy(shape)
			refuses(node, context, 'the scope predicate must be true')
		}
		for (const where of [ref, undefined]) {
			const [node, context] = scopedBy(parentRows(where))
			refuses(node, { ...context, through: undefined }, 'the scope predicate must be true')
		}
	})

	test("no reach of the view's own columns: a chain's equalities, a Within's values or relation rows are refused on a view", () => {
		const viewRelated = BinaryOperationNode.create(
			column('notes', 'workspace_id'),
			OperatorNode.create('in'),
			subquery('workspace_members', 'workspace_id', equals('workspace_members', 'principal_id', 'user:alice')),
		)
		const shapes = [
			equals('notes', 'workspace_id', 'w1'),
			allOf([equals('notes', 'id', 'n1'), equals('notes', 'workspace_id', 'w1')]),
			inList('notes', 'workspace_id', ['w1']),
			viewRelated,
			anyOf([inList('notes', 'workspace_id', ['w1']), viewRelated]),
			AndNode.create(equals('notes', 'workspace_id', 'w1'), viewRelated),
			AndNode.create(inList('notes', 'workspace_id', ['w1']), ParensNode.create(open)),
		]
		for (const shape of shapes) {
			const [node, context] = scopedBy(shape)
			expect(() => assertAllowedTree(node, { ...context, through: undefined })).not.toThrow()
			refuses(node, context, 'the scope predicate must be true')
		}
		const [node, context] = scopedBy(AndNode.create(everything(), ParensNode.create(open)))
		expect(() => assertAllowedTree(node, context)).not.toThrow()
	})
})

describe('the scope predicate is the top-level conjunct', () => {
	test('a statement without a WHERE', () => {
		refuses(select({ where: undefined }), selectContext, 'scope predicate')
	})

	test('`scope or true`', () => {
		refuses(select({ where: WhereNode.create(OrNode.create(scope, ValueNode.createImmediate(true))) }), selectContext, 'scope predicate')
	})

	test('the caller conditions without their parenthesis (`x or true and scope`)', () => {
		const loose = OrNode.create(ValueNode.createImmediate(true), ValueNode.createImmediate(true))
		refuses(select({ where: WhereNode.create(AndNode.create(loose, scope)) }), selectContext, 'scope predicate')
	})

	test('the scope on the left of the conjunction', () => {
		refuses(
			select({ where: WhereNode.create(AndNode.create(scope, ParensNode.create(ValueNode.createImmediate(true)))) }),
			selectContext,
			'scope predicate',
		)
	})

	test('an equal-looking predicate that is not the scope the layer built', () => {
		refuses(select({ where: WhereNode.create(inList('notes', 'workspace_id', ['w1'])) }), selectContext, 'scope predicate')
	})

	test('an insert with a WHERE, and an update of another table', () => {
		const insertWithWhere: InsertQueryNode & { readonly where: WhereNode } = { ...legitInsert(), where: scopedWhere(undefined, updateScope) }
		refuses(insertWithWhere, insertContext, 'InsertQueryNode.where is not allowed')
		refuses(legitUpdate({ table: TableNode.create('secrets') }), updateContext, 'must address notes only')
	})
})

describe('conditions grafted into the caller parenthesis', () => {
	const cases: [string, OperationNode][] = [
		['sql`true or 1=1`', sql<boolean>`true or 1=1`.toOperationNode()],
		['notes.id in (select secrets.id)', eb('notes.id', 'in', eb.selectFrom('secrets').select('secrets.id')).toOperationNode()],
		['exists (select …)', eb.exists(eb.selectFrom('note_comments').select('note_comments.id')).toOperationNode()],
		['pg_sleep(10) is not null', eb(eb.fn('pg_sleep', [eb.val(10)]), 'is not', null).toOperationNode()],
		['regex operator ~', eb('notes.title', '~', '.*').toOperationNode()],
		['a cast', eb(eb.cast('notes.id', 'text'), '=', 'x').toOperationNode()],
		['a case expression', eb(eb.case().when('notes.id', '=', 'x').then(true).else(false).end(), '=', true).toOperationNode()],
		['a json path reference', eb(eb.ref('notes.data', '->>').key('a'), '=', 'x').toOperationNode()],
		['an unqualified column', eb('id', '=', 'x').toOperationNode()],
		['arithmetic outside SET', eb(eb('notes.word_count', '+', 1), '=', 2).toOperationNode()],
		['a bound JS array', BinaryOperationNode.create(column('notes', 'title'), OperatorNode.create('='), ValueNode.create(['a', 'b']))],
		['a bound JSON object', BinaryOperationNode.create(column('notes', 'title'), OperatorNode.create('='), ValueNode.create({ a: 1 }))],
		['an inline string', BinaryOperationNode.create(column('notes', 'title'), OperatorNode.create('='), ValueNode.createImmediate("x' or '1'='1"))],
	]
	for (const [label, condition] of cases) {
		test(label, () => refuses(withCondition(condition), selectContext))
	}

	test('an accessor property, which could answer the guard and the compiler differently', () => {
		const condition = BinaryOperationNode.create(column('notes', 'title'), OperatorNode.create('='), ValueNode.create('x'))
		const sneaky = Object.defineProperty({ ...condition }, 'rightOperand', { enumerable: true, get: () => ValueNode.create('x') })
		refuses(withCondition(sneaky), selectContext, 'accessor')
	})
})

describe('root properties outside the allowlist', () => {
	const base = () => k.selectFrom('notes').select('notes.id')
	const cases: [string, Partial<SelectQueryNode>][] = [
		['union', { setOperations: base().union(k.selectFrom('secrets').select('secrets.id')).toOperationNode().setOperations }],
		['a CTE', { with: k.with('s', (db) => db.selectFrom('secrets').selectAll()).selectFrom('notes').select('notes.id').toOperationNode().with }],
		['modifyEnd(sql`…`)', { endModifiers: base().modifyEnd(sql`for update`).toOperationNode().endModifiers }],
		['forUpdate()', { endModifiers: base().forUpdate().toOperationNode().endModifiers }],
		['distinctOn', { distinctOn: base().distinctOn('notes.id').toOperationNode().distinctOn }],
		['having', { having: base().groupBy('notes.id').having('notes.id', '=', 'x').toOperationNode().having }],
		['explain', { explain: ExplainNode.create() }],
	]
	for (const [label, properties] of cases) {
		test(label, () => refuses(select(properties), selectContext, 'is not allowed'))
	}
})

describe('the nulls order of an order term', () => {
	const ordered = (nulls: string) => {
		const orderBy = k.selectFrom('notes').select('notes.id').orderBy('notes.id', 'asc').toOperationNode().orderBy
		// An unchecked value, as a tree built outside the layer could carry.
		const items = orderBy?.items.map((item) => {
			const forged = { ...item }
			Reflect.set(forged, 'nulls', nulls)
			return forged
		}) ?? []
		return select({ orderBy: orderBy === undefined ? undefined : { ...orderBy, items } })
	}

	test('nulls first and nulls last pass', () => {
		expect(() => assertAllowedTree(ordered('first'), selectContext)).not.toThrow()
		expect(() => assertAllowedTree(ordered('last'), selectContext)).not.toThrow()
	})

	test('any other text, which Kysely would print raw, is refused', () => {
		refuses(ordered('last, (select secret from secrets)'), selectContext, 'nulls first or nulls last')
	})
})

describe('tables, joins and selections', () => {
	test('a join to a table that is not a declared child', () => {
		refuses(select({ joins: base().innerJoin('secrets', 'secrets.id', 'notes.id').toOperationNode().joins }), selectContext)
	})

	test('an inner join to a child with a forged ON (workspace <>)', () => {
		const joins = k.selectFrom('notes').innerJoin(
			'note_comments',
			(j) => j.onRef('note_comments.note_id', '=', 'notes.id').onRef('note_comments.workspace_id', '<>', 'notes.workspace_id'),
		)
			.toOperationNode().joins
		refuses(select({ joins }), selectContext, 'composite foreign key')
	})

	test('an inner join ON only part of the composite key', () => {
		const joins = k.selectFrom('notes').innerJoin('note_comments', 'note_comments.note_id', 'notes.id').toOperationNode().joins
		refuses(select({ joins }), selectContext, 'composite foreign key')
	})

	test('a left join to a child', () => {
		const joins = k.selectFrom('notes').leftJoin(
			'note_comments',
			(j) => j.onRef('note_comments.note_id', '=', 'notes.id').onRef('note_comments.workspace_id', '=', 'notes.workspace_id'),
		)
			.toOperationNode().joins
		refuses(select({ joins }), selectContext, 'only inner joins')
	})

	test('a cross join through the FROM list', () => {
		refuses(select({ from: FromNode.create([TableNode.create('notes'), TableNode.create('note_comments')]) }), selectContext, 'exactly one table')
	})

	test('a schema-qualified table', () => {
		refuses(select({ from: FromNode.create([TableNode.createWithSchema('other_app', 'notes')]) }), selectContext, 'schema-qualified')
	})

	test('a scalar subquery in the selection', () => {
		const selections =
			k.selectFrom('notes').select((e) => e.selectFrom('secrets').select('secrets.value').limit(1).as('v')).toOperationNode().selections
		refuses(select({ selections }), selectContext, 'subqueries')
	})

	test('select * and an unqualified column', () => {
		refuses(select({ selections: k.selectFrom('notes').selectAll().toOperationNode().selections }), selectContext, 'select *')
		refuses(select({ selections: k.selectFrom('notes').select('id').toOperationNode().selections }), selectContext, 'table-qualified')
	})

	test('an aggregate outside the allowlist, and count(distinct …)', () => {
		const stringAgg =
			k.selectFrom('notes').select((e) => e.fn.agg<string>('string_agg', ['notes.title', sql.lit(',')]).as('all')).toOperationNode().selections
		const distinct = k.selectFrom('notes').select((e) => e.fn.count('notes.id').distinct().as('n')).toOperationNode().selections
		refuses(select({ selections: stringAgg }), selectContext)
		refuses(select({ selections: distinct }), selectContext, 'aggregate function not allowed')
	})

	test('an alias that is not a plain name', () => {
		const selections = [SelectionNode.create(AliasNode.create(column('notes', 'id'), IdentifierNode.create('x" from secrets --')))]
		refuses(select({ selections }), selectContext, 'plain names')
	})

	test('orderBy with a raw direction', () => {
		refuses(select({ orderBy: k.selectFrom('notes').orderBy(sql`notes.id; drop table notes`).toOperationNode().orderBy }), selectContext, 'raw SQL')
	})
})

describe('row locks', () => {
	const lockContext: GuardContext = { ...selectContext, joins: {}, lock: 'share' }

	test("the layer's destination check passes with the lock flag, and compiles to for share", () => {
		const node = lockNode('notes', 'id', scope)
		expect(() => assertAllowedTree(node, lockContext)).not.toThrow()
		expect(compiler.compileQuery(node, { queryId: 'q' }).sql).toEndWith('limit $2 for share')
	})

	test('a lock without the flag, and any other modifier with it, is refused', () => {
		refuses(lockNode('notes', 'id', scope), selectContext, 'is not allowed')
		const forUpdate = { ...existsNode('notes', 'id', scope), endModifiers: base().forUpdate().toOperationNode().endModifiers }
		refuses(forUpdate, lockContext, 'row locks are not allowed')
		const rawModifier = { ...existsNode('notes', 'id', scope), endModifiers: base().modifyEnd(sql`for share`).toOperationNode().endModifiers }
		refuses(rawModifier, lockContext)
	})

	test("a getForUpdate's lock passes only with the update flag; no other lock passes with it", () => {
		const updateContext: GuardContext = { ...lockContext, lock: 'update' }
		const forUpdate = lockNode('notes', 'id', scope, 'update')
		expect(() => assertAllowedTree(forUpdate, updateContext)).not.toThrow()
		expect(compiler.compileQuery(forUpdate, { queryId: 'q' }).sql).toEndWith('limit $2 for update')
		refuses(forUpdate, lockContext, 'row locks are not allowed')
		refuses(forUpdate, selectContext, 'is not allowed')
		refuses(lockNode('notes', 'id', scope), updateContext, 'row locks are not allowed')
		for (const builder of [base().forUpdate().noWait(), base().forUpdate().skipLocked(), base().forNoKeyUpdate(), base().forKeyShare()]) {
			const node = { ...existsNode('notes', 'id', scope), endModifiers: builder.toOperationNode().endModifiers }
			refuses(node, updateContext)
		}
		const of = { ...existsNode('notes', 'id', scope), endModifiers: base().forUpdate(['notes']).toOperationNode().endModifiers }
		refuses(of, updateContext, 'row locks are not allowed')
	})
})

describe("a queue claim's lock and an insert's conflict", () => {
	const claimContext: GuardContext = { ...selectContext, joins: {}, lock: 'claim' }
	const claim = () => {
		const start = startSelect(notesShape)
		const state = finishSelect(start, start)
		return claimNode(state, ['id', 'title'], { due: 'title', attempts: 'id', now: new Date(0), maxAttempts: 10 }, scope, nameSet([]))
	}

	test('a claim passes only with the claim flag, and compiles to for update skip locked', () => {
		expect(() => assertAllowedTree(claim(), claimContext)).not.toThrow()
		expect(compiler.compileQuery(claim(), { queryId: 'q' }).sql).toEndWith('for update skip locked')
		refuses(claim(), { ...claimContext, lock: 'update' }, 'row locks are not allowed')
		refuses(claim(), selectContext, 'is not allowed')
		for (const builder of [base().forUpdate(), base().forUpdate().noWait(), base().forShare().skipLocked(), base().forUpdate(['notes']).skipLocked()]) {
			const node = { ...existsNode('notes', 'id', scope), endModifiers: builder.toOperationNode().endModifiers }
			refuses(node, claimContext)
		}
	})

	test('on conflict (columns) do nothing passes only with the conflict flag; do update never', () => {
		const values = new Map([['id', 'n1'], ['title', 'x']])
		const node = insertNode('notes', values, acknowledgement('notes', 'id', undefined), ['title'])
		const conflictContext: GuardContext = { ...insertContext, onConflict: 'nothing' }
		expect(() => assertAllowedTree(node, conflictContext)).not.toThrow()
		expect(compiler.compileQuery(node, { queryId: 'q' }).sql).toContain('on conflict ("title") do nothing')
		refuses(node, insertContext, 'is not allowed')
		const update =
			k.insertInto('notes').values({ id: 'n1', workspace_id: 'w1', title: 'x', word_count: 1, data: { a: 'b' } }).onConflict((oc) =>
				oc.column('id').doUpdateSet({ title: 'y' })
			).toOperationNode().onConflict
		refuses(legitInsert({ onConflict: update }), conflictContext, 'an insert admits only on conflict (columns) do nothing')
		const constraint =
			k.insertInto('notes').values({ id: 'n1', workspace_id: 'w1', title: 'x', word_count: 1, data: { a: 'b' } }).onConflict((oc) =>
				oc.constraint('notes_pkey').doNothing()
			).toOperationNode().onConflict
		refuses(legitInsert({ onConflict: constraint }), conflictContext, 'an insert admits only on conflict (columns) do nothing')
	})
})

describe('roots', () => {
	test('a delete in a select context', () => {
		refuses(legitDelete(), selectContext, 'expected a SelectQueryNode')
	})

	test('insert … select from secrets', () => {
		const values = k.insertInto('notes').columns(['title']).expression(k.selectFrom('secrets').select('secrets.value')).toOperationNode().values
		refuses(legitInsert({ values }), insertContext, 'subqueries')
	})

	test('insert … on conflict do update', () => {
		const onConflict =
			k.insertInto('notes').values({ id: 'n1', workspace_id: 'w1', title: 'x', word_count: 1, data: { a: 'b' } }).onConflict((oc) =>
				oc.column('id').doUpdateSet({ title: 'y' })
			).toOperationNode().onConflict
		refuses(legitInsert({ onConflict }), insertContext, 'is not allowed')
	})

	test('update … from secrets', () => {
		refuses(legitUpdate({ from: FromNode.create([TableNode.create('secrets')]) }), updateContext, 'is not allowed')
	})

	test('update returning a subquery', () => {
		const returning =
			k.updateTable('notes').set({ title: 'x' }).returning((e) => e.selectFrom('secrets').select('secrets.value').as('v')).toOperationNode().returning
		refuses(legitUpdate({ returning }), updateContext, 'subqueries')
	})

	test('delete … using secrets', () => {
		refuses(legitDelete({ using: UsingNode.create([TableNode.create('secrets')]) }), deleteContext, 'is not allowed')
	})
})

function base() {
	return k.selectFrom('notes').select('notes.id')
}
