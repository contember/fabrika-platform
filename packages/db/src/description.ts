import { inSet, isSafeInteger, type NameSet, nameSet, namesOf, ownEntry, ownKeys, parseList } from './builtins'
import { QueryRefusedError } from './errors'
import { isPlainIdentifier } from './identifier'

export type Primitive = string | number | bigint | boolean | Date
export type ComparisonOperator = '=' | '<>' | '<' | '<=' | '>' | '>='
export type PatternOperator = 'like' | 'ilike' | 'not like' | 'not ilike'
export type ListOperator = 'in' | 'not in'
export type NullOperator = 'is' | 'is not'
export type AllowedOperator = ComparisonOperator | PatternOperator | ListOperator | NullOperator

const OPERATOR_LIST: readonly AllowedOperator[] = [
	'=',
	'<>',
	'<',
	'<=',
	'>',
	'>=',
	'like',
	'ilike',
	'not like',
	'not ilike',
	'in',
	'not in',
	'is',
	'is not',
]
const OPERATORS = nameSet(OPERATOR_LIST)

function isOperator(value: unknown): value is AllowedOperator {
	return inSet(OPERATORS, value)
}

export interface Compare {
	readonly kind: 'compare'
	readonly column: string
	readonly operator: AllowedOperator
	readonly value: Primitive | readonly Primitive[] | null
}

/** A case-insensitive substring match; the text's `%`, `_` and `\` match literally. */
export interface Contains {
	readonly kind: 'contains'
	readonly column: string
	readonly text: string
}

export interface AnyOf {
	readonly kind: 'any'
	readonly conditions: readonly (Compare | Contains)[]
}

export type Condition = Compare | Contains | AnyOf

/** What a select may name: the visible columns of its table and of the children it may join. */
export interface TableShape {
	readonly table: string
	readonly visible: NameSet
	readonly joinable: Readonly<Record<string, JoinShape>>
	/** The `date` columns, which a read answers as `YYYY-MM-DD` text. */
	readonly dates: NameSet
}

export interface JoinShape {
	readonly shape: TableShape
	readonly readAction: string
	/** The composite foreign key: child column = parent column, for each pair. */
	readonly on: readonly { readonly childColumn: string; readonly parentColumn: string }[]
}

export interface JoinState {
	readonly join: JoinShape
	readonly select: SelectState
}

export interface SelectState {
	/** Identifies the description a callback received, so it cannot return one from elsewhere. */
	readonly origin: object
	readonly table: string
	readonly columns: readonly string[] | undefined
	readonly conditions: readonly Condition[]
	readonly orderBy: readonly { readonly column: string; readonly direction: 'asc' | 'desc' }[]
	readonly limit: number | undefined
	readonly offset: number | undefined
	readonly joins: readonly JoinState[]
}

type Comparable<V> = Exclude<V, null | undefined>
type Columns<Row> = keyof Row & string
type StringColumn<Row> = { [K in Columns<Row>]: Comparable<Row[K]> extends string ? K : never }[Columns<Row>]
type NullableColumn<Row> = { [K in Columns<Row>]: null extends Row[K] ? K : never }[Columns<Row>]

export type ConditionTuple<Row> =
	| {
		[K in Columns<Row>]: readonly [K, ComparisonOperator, Comparable<Row[K]>] | readonly [K, ListOperator, readonly Comparable<Row[K]>[]]
	}[Columns<Row>]
	| { [K in StringColumn<Row>]: readonly [K, PatternOperator | 'contains', string] }[StringColumn<Row>]

type Prefixed<C extends string, J> = { [K in keyof J & string as `${C}.${K}`]: J[K] }
export type NoColumns = Record<never, never>

const selectToken: unique symbol = Symbol('scoped-select')

let readState: <Row, Selected, Children>(select: ScopedSelect<Row, Selected, Children>) => SelectState
let readShape: <Row, Selected, Children>(select: ScopedSelect<Row, Selected, Children>) => TableShape

/**
 * The only query surface a store callback sees: a frozen description, not a Kysely builder. There is nothing to
 * execute, no raw SQL entry point, and no way to name a table other than this one and its declared children.
 */
export class ScopedSelect<Row, Selected, Children> {
	readonly #state: SelectState
	readonly #shape: TableShape
	readonly #types: { readonly row?: Row; readonly selected?: Selected; readonly children?: Children } = {}

	constructor(token: symbol, state: SelectState, shape: TableShape) {
		if (token !== selectToken) {
			throw new QueryRefusedError('a query description is created by the store only')
		}
		this.#state = Object.freeze(state)
		this.#shape = shape
		Object.freeze(this)
	}

	static {
		readState = (select) => select.#state
		readShape = (select) => select.#shape
	}

	/** The columns to return; without it, every visible column. */
	columns<const C extends Columns<Row>>(columns: readonly C[]): ScopedSelect<Row, Pick<Row, C>, Children> {
		const names = parseList(columns, (name) => this.#column(name))
		if (names === undefined || names.length === 0) {
			throw new QueryRefusedError('columns needs a non-empty plain array of column names')
		}
		return this.#next({ columns: names })
	}

	where<C extends Columns<Row>>(column: C, operator: ComparisonOperator, value: Comparable<Row[C]>): ScopedSelect<Row, Selected, Children>
	where<C extends Columns<Row>>(column: C, operator: ListOperator, values: readonly Comparable<Row[C]>[]): ScopedSelect<Row, Selected, Children>
	where<C extends StringColumn<Row>>(column: C, operator: PatternOperator, pattern: string): ScopedSelect<Row, Selected, Children>
	where<C extends NullableColumn<Row>>(column: C, operator: NullOperator, value: null): ScopedSelect<Row, Selected, Children>
	where(column: string, operator: string, value: unknown): ScopedSelect<Row, Selected, Children> {
		return this.#withCondition(this.#parseCondition(column, operator, value))
	}

	/** One OR group of conditions on this table's columns. */
	whereAny(conditions: readonly ConditionTuple<Row>[]): ScopedSelect<Row, Selected, Children>
	whereAny(conditions: readonly (readonly unknown[])[]): ScopedSelect<Row, Selected, Children> {
		const parsed = parseList(conditions, (condition) => {
			const parts = parseList(condition, (part) => part)
			if (parts === undefined || parts.length !== 3) {
				throw new QueryRefusedError('whereAny takes [column, operator, value] conditions, each a plain array')
			}
			return this.#parseCondition(parts[0], parts[1], parts[2])
		})
		if (parsed === undefined || parsed.length === 0) {
			throw new QueryRefusedError('whereAny needs a non-empty plain array of [column, operator, value] conditions')
		}
		return this.#withCondition({ kind: 'any', conditions: parsed })
	}

	/** A case-insensitive substring match in which `%` and `_` in the text match themselves. */
	contains(column: StringColumn<Row>, text: string): ScopedSelect<Row, Selected, Children> {
		return this.#withCondition(this.#parseCondition(column, 'contains', text))
	}

	orderBy(column: Columns<Row>, direction: 'asc' | 'desc' = 'asc'): ScopedSelect<Row, Selected, Children> {
		if (direction !== 'asc' && direction !== 'desc') {
			throw new QueryRefusedError(`orderBy direction must be 'asc' or 'desc'`)
		}
		return this.#next({ orderBy: [...this.#state.orderBy, { column: this.#column(column), direction }] })
	}

	limit(limit: number): ScopedSelect<Row, Selected, Children> {
		return this.#next({ limit: count(limit, 'limit') })
	}

	offset(offset: number): ScopedSelect<Row, Selected, Children> {
		return this.#next({ offset: count(offset, 'offset') })
	}

	/** An inner join to a declared child; its columns come back prefixed (`note_comments.body`). */
	join<C extends keyof Children & string, J>(
		child: C,
		build: (q: ScopedSelect<Children[C], Children[C], NoColumns>) => ScopedSelect<Children[C], J, NoColumns>,
	): ScopedSelect<Row, Selected & Prefixed<C, J>, Children> {
		const join = typeof child === 'string' ? ownEntry(this.#shape.joinable, child) : undefined
		if (join === undefined) {
			const children = ownKeys(this.#shape.joinable).join(', ') || 'none'
			throw new QueryRefusedError(`${String(child)} is not a joinable child of ${this.#state.table} (joinable: ${children})`)
		}
		const start = startSelect<Children[C], NoColumns>(join.shape)
		const select = finishSelect(build(start), start)
		if (select.joins.length > 0 || select.orderBy.length > 0 || select.limit !== undefined || select.offset !== undefined) {
			throw new QueryRefusedError('a joined child takes columns and where conditions only')
		}
		return this.#next({ joins: [...this.#state.joins, { join, select }] })
	}

	#next<S>(changes: Partial<Omit<SelectState, 'origin' | 'table'>>): ScopedSelect<Row, S, Children> {
		return new ScopedSelect(selectToken, { ...this.#state, ...changes }, this.#shape)
	}

	#withCondition(condition: Condition): ScopedSelect<Row, Selected, Children> {
		return this.#next({ conditions: [...this.#state.conditions, condition] })
	}

	#column(name: unknown): string {
		return columnOf(this.#shape, name)
	}

	#parseCondition(column: unknown, operator: unknown, value: unknown): Compare | Contains {
		return parseCondition(this.#shape, column, operator, value)
	}
}
Object.freeze(ScopedSelect.prototype)
Object.freeze(ScopedSelect)

/** A column the shape lets a query name; a hidden one is refused like a missing one. */
export function columnOf(shape: TableShape, name: unknown): string {
	const columns = namesOf(shape.visible).join(', ')
	if (typeof name !== 'string') {
		throw new QueryRefusedError(
			`a column is named by a string, not by ${typeof name === 'object' ? 'an expression' : typeof name} (columns: ${columns})`,
		)
	}
	if (!isPlainIdentifier(name) || !inSet(shape.visible, name)) {
		throw new QueryRefusedError(`${name} is not a column of ${shape.table} (columns: ${columns})`)
	}
	return name
}

/** One `[column, operator, value]` condition over a caller's values, checked before anything reads it further. */
export function parseCondition(shape: TableShape, column: unknown, operator: unknown, value: unknown): Compare | Contains {
	const name = columnOf(shape, column)
	if (operator === 'contains') {
		if (typeof value !== 'string') {
			throw new QueryRefusedError('contains takes a string')
		}
		return { kind: 'contains', column: name, text: value }
	}
	if (!isOperator(operator)) {
		throw new QueryRefusedError(`operator ${String(operator)} is not allowed (allowed: ${OPERATOR_LIST.join(', ')}, contains)`)
	}
	const allowed = operator
	if (allowed === 'in' || allowed === 'not in') {
		const list = parseList(value, (item) => {
			if (!isPrimitive(item)) {
				throw new QueryRefusedError(`${allowed} takes plain values only`)
			}
			return item
		})
		if (list === undefined || list.length === 0) {
			throw new QueryRefusedError(`${allowed} needs a non-empty plain array of values`)
		}
		return { kind: 'compare', column: name, operator: allowed, value: list }
	}
	if (allowed === 'is' || allowed === 'is not') {
		if (value !== null) {
			throw new QueryRefusedError(`${allowed} takes null only`)
		}
		return { kind: 'compare', column: name, operator: allowed, value: null }
	}
	if (!isPrimitive(value)) {
		throw new QueryRefusedError('where takes a plain value (string, number, bigint, boolean or Date), not an expression')
	}
	return { kind: 'compare', column: name, operator: allowed, value }
}

export function startSelect<Row, Children>(shape: TableShape): ScopedSelect<Row, Row, Children> {
	const state: SelectState = {
		origin: Object.freeze({}),
		table: shape.table,
		columns: undefined,
		conditions: [],
		orderBy: [],
		limit: undefined,
		offset: undefined,
		joins: [],
	}
	return new ScopedSelect(selectToken, state, shape)
}

/** The description a callback returned; it must derive from the one it received. */
export function finishSelect<Row, Children>(built: unknown, start: ScopedSelect<Row, Row, Children>): SelectState {
	if (!(built instanceof ScopedSelect)) {
		throw new QueryRefusedError('the query callback must return the description it received')
	}
	const state = readState(built)
	const expected = readState(start)
	if (state.origin !== expected.origin || readShape(built) !== readShape(start)) {
		throw new QueryRefusedError('the query callback must return the description it received, not one from another query')
	}
	return state
}

export function isPrimitive(value: unknown): value is Primitive {
	const type = typeof value
	return type === 'string' || type === 'number' || type === 'bigint' || type === 'boolean' || value instanceof Date
}

function count(value: unknown, what: string): number {
	if (typeof value !== 'number' || !isSafeInteger(value) || value < 0) {
		throw new QueryRefusedError(`${what} must be a non-negative integer`)
	}
	return value
}
