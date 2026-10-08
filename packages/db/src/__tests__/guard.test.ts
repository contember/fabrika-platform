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
	ValueNode,
	WhereNode,
} from 'kysely'
import { finishSelect, startSelect, type TableShape } from '../description'
import { QueryRefusedError } from '../errors'
import { assertAllowedTree, type GuardContext } from '../guard'
import { column, deleteNode, inList, insertNode, scopedWhere, selectNode, updateNode } from '../nodes'

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

const commentsShape: TableShape = { table: 'note_comments', visible: new Set(['id', 'body']), joinable: new Map() }
const notesShape: TableShape = {
	table: 'notes',
	visible: new Set(['id', 'title', 'workspace_id']),
	joinable: new Map([['note_comments', { shape: commentsShape, readAction: 'notes.read', on: foreignKey }]]),
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
	...updateNode('notes', new Map([['title', 'x']]), 'version', scopedWhere(undefined, updateScope), ['id', 'title']),
	...properties,
})
const deleteContext: GuardContext = { root: 'DeleteQueryNode', table: 'notes', joins: {}, scope: updateScope }
const legitDelete = (properties: Partial<DeleteQueryNode> = {}): DeleteQueryNode => ({
	...deleteNode('notes', scopedWhere(undefined, updateScope), 'id'),
	...properties,
})
const insertContext: GuardContext = { root: 'InsertQueryNode', table: 'notes', joins: {}, scope: undefined }
const legitInsert = (properties: Partial<InsertQueryNode> = {}): InsertQueryNode => ({
	...insertNode('notes', new Map([['title', 'x']]), ['id', 'title']),
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
