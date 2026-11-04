// Structured row conditions: the `when` of a table action and of a relation source. One parse over values nobody
// type-checked, one predicate builder, and the value of a condition on an insert's own row. Index loops and the
// captured built-ins only, as in the policy parse. No Kysely runtime: `@fabrika/db/tables` reads the parse in a
// browser; `condition-nodes.ts` builds the predicate.

import type { ColumnTestArtifact, ConditionArtifact } from '@fabrika/auth-core'
import { freeze, hasOwn, inSet, isArray, type NameSet, ownEntry, ownKeys, parseList, plainRecord } from './builtins'
import type { Primitive } from './description'
import { PolicyError } from './errors'

/** A literal a condition compares with. `{ now: true }` is the statement's clock, never the text `now`. */
export type ConditionLiteral = string | number | boolean
export interface NowOperand {
	readonly now: true
}
/** The parsed clock operand, compared by identity: no literal, the text `now` included, is ever it. */
export const NOW: NowOperand = freeze({ now: true })

/** One test of a column: exactly one operator. */
export interface ColumnTest {
	readonly eq?: ConditionLiteral
	readonly notEq?: ConditionLiteral
	readonly in?: readonly ConditionLiteral[]
	readonly notIn?: readonly ConditionLiteral[]
	readonly isNull?: boolean
	readonly lt?: ConditionLiteral | NowOperand
	readonly lte?: ConditionLiteral | NowOperand
	readonly gt?: ConditionLiteral | NowOperand
	readonly gte?: ConditionLiteral | NowOperand
}

/**
 * A condition as a policy writes it: `{ column: test, … }` (all of them), `{ 'fk_column.column': test }` along a
 * foreign key, or `{ anyOf: […] }`, `{ allOf: […] }`, `{ not: … }`.
 */
export type ConditionPolicy<Col extends string = string> =
	| { readonly anyOf: readonly ConditionPolicy<Col>[] }
	| { readonly allOf: readonly ConditionPolicy<Col>[] }
	| { readonly not: ConditionPolicy<Col> }
	| { readonly [C in Col | `${Col}.${string}`]?: ColumnTest }

export type ConditionOperator = 'eq' | 'notEq' | 'in' | 'notIn' | 'isNull' | 'lt' | 'lte' | 'gt' | 'gte'

/** One foreign-key hop of a path: `column` of the table it leaves references `key` of `table`. */
export interface ConditionHop {
	readonly column: string
	readonly table: string
	readonly key: string
}

export type ConditionModel =
	| { readonly kind: 'all'; readonly terms: readonly ConditionModel[] }
	| { readonly kind: 'any'; readonly terms: readonly ConditionModel[] }
	| { readonly kind: 'not'; readonly term: ConditionModel }
	| {
		readonly kind: 'test'
		readonly hops: readonly ConditionHop[]
		readonly column: string
		readonly operator: ConditionOperator
		readonly value: ConditionLiteral | readonly ConditionLiteral[] | boolean | NowOperand
	}

/** What the parse reads of each table: its columns, its foreign keys and its typed columns. */
export interface ConditionTable {
	readonly name: string
	readonly columns: NameSet
	readonly foreignKeys: readonly { readonly columns: readonly string[]; readonly table: string; readonly references: readonly string[] }[]
	readonly timestamps: NameSet
	readonly json: NameSet
}

/** A path follows at most this many foreign keys: each hop is one more subquery in every statement the condition scopes. */
export const MAX_CONDITION_HOPS = 3
const MAX_CONDITION_DEPTH = 8
const OPERATORS: readonly ConditionOperator[] = freeze(['eq', 'notEq', 'in', 'notIn', 'isNull', 'lt', 'lte', 'gt', 'gte'])
const CONNECTIVES = freeze(['anyOf', 'allOf', 'not'])

/**
 * Whether a path may follow `from.column` to `to`. A hop reads its target unscoped, so the rule admits only one that
 * stays where the row is (its own container or parent) or reaches what every site reads (a reference table).
 */
export type HopRule = (from: string, column: string, to: string) => boolean

/**
 * Parses `input` as a condition over `table`. `hops` is the rule a path's foreign keys are held to, or `false` when a
 * path follows none (a relation source's condition and an insert's are judged on the row itself).
 */
export function parseCondition(
	input: unknown,
	table: ConditionTable,
	tables: (name: string) => ConditionTable | undefined,
	what: string,
	hops: HopRule | false,
): ConditionModel {
	return parseNode(input, table, tables, what, hops, 0)
}

function parseNode(
	input: unknown,
	table: ConditionTable,
	tables: (name: string) => ConditionTable | undefined,
	what: string,
	hops: HopRule | false,
	depth: number,
): ConditionModel {
	if (depth > MAX_CONDITION_DEPTH) {
		throw new PolicyError(`${what} nests deeper than ${MAX_CONDITION_DEPTH} levels`)
	}
	const record = plainRecord(input, what)
	const keys = ownKeys(record)
	if (keys.length === 0) {
		throw new PolicyError(`${what} is empty: a condition tests at least one column`)
	}
	const first = keys[0] ?? ''
	if (keys.length === 1 && (first === 'anyOf' || first === 'allOf')) {
		const items = parseList(ownEntry(record, first), (item) => parseNode(item, table, tables, `${what}.${first}`, hops, depth + 1))
		if (items === undefined || items.length === 0) {
			throw new PolicyError(`${what}.${first} takes a non-empty plain array of conditions`)
		}
		return freeze({ kind: first === 'anyOf' ? 'any' : 'all', terms: freeze(items) })
	}
	if (keys.length === 1 && first === 'not') {
		return freeze({ kind: 'not', term: parseNode(ownEntry(record, 'not'), table, tables, `${what}.not`, hops, depth + 1) })
	}
	const terms: ConditionModel[] = []
	for (let index = 0; index < keys.length; index++) {
		const key = keys[index] ?? ''
		for (let connective = 0; connective < CONNECTIVES.length; connective++) {
			if (key === CONNECTIVES[connective]) {
				throw new PolicyError(`${what}: ${key} stands alone in its object; wrap the column tests beside it in allOf`)
			}
		}
		terms[terms.length] = parseTest(key, ownEntry(record, key), table, tables, `${what}.${key}`, hops)
	}
	const only = terms[0]
	return terms.length === 1 && only !== undefined ? only : freeze({ kind: 'all', terms: freeze(terms) })
}

function parseTest(
	path: string,
	input: unknown,
	table: ConditionTable,
	tables: (name: string) => ConditionTable | undefined,
	what: string,
	hops: HopRule | false,
): ConditionModel {
	const segments = splitPath(path)
	if (segments.length - 1 > MAX_CONDITION_HOPS) {
		throw new PolicyError(`${what}: a path follows at most ${MAX_CONDITION_HOPS} foreign keys`)
	}
	if (segments.length > 1 && hops === false) {
		throw new PolicyError(`${what}: this condition is judged on the row itself and follows no foreign key`)
	}
	const followed: ConditionHop[] = []
	let current = table
	for (let index = 0; index < segments.length - 1; index++) {
		const name = segments[index] ?? ''
		const hop = singleForeignKey(current, name, what)
		const target = tables(hop.table)
		if (target === undefined) {
			throw new PolicyError(`${what}: ${current.name}.${name} references ${hop.table}, which has no policy`)
		}
		if (hops === false || !hops(current.name, name, hop.table)) {
			throw new PolicyError(
				`${what}: ${current.name}.${name} leads to ${hop.table}, outside the row's own containment; a path follows a row's container or parent column, or reaches a reference table`,
			)
		}
		followed[followed.length] = hop
		current = target
	}
	const columnName = segments[segments.length - 1] ?? ''
	if (!inSet(current.columns, columnName)) {
		throw new PolicyError(`${what}: ${columnName} is not a column of ${current.name}`)
	}
	if (inSet(current.json, columnName)) {
		throw new PolicyError(`${what}: ${current.name}.${columnName} is a JSON column, which no condition compares`)
	}
	const test = plainRecord(input, what)
	const operators = ownKeys(test)
	if (operators.length !== 1) {
		throw new PolicyError(`${what} takes exactly one operator (${OPERATORS.join(', ')})`)
	}
	const operator = operatorOf(operators[0], what)
	const raw = ownEntry(test, operator)
	return freeze({
		kind: 'test',
		hops: freeze(followed),
		column: columnName,
		operator,
		value: operandOf(operator, raw, inSet(current.timestamps, columnName), what),
	})
}

function splitPath(path: string): readonly string[] {
	const segments: string[] = []
	let start = 0
	for (let index = 0; index <= path.length; index++) {
		if (index === path.length || path[index] === '.') {
			segments[segments.length] = path.slice(start, index)
			start = index + 1
		}
	}
	return segments
}

function singleForeignKey(table: ConditionTable, name: string, what: string): ConditionHop {
	if (!inSet(table.columns, name)) {
		throw new PolicyError(`${what}: ${name} is not a column of ${table.name}`)
	}
	for (let index = 0; index < table.foreignKeys.length; index++) {
		const key = table.foreignKeys[index]
		if (key !== undefined && key.columns.length === 1 && key.columns[0] === name) {
			return freeze({ column: name, table: key.table, key: key.references[0] ?? '' })
		}
	}
	throw new PolicyError(`${what}: ${table.name}.${name} is not a single-column foreign key, so a path cannot follow it`)
}

function operatorOf(name: unknown, what: string): ConditionOperator {
	for (let index = 0; index < OPERATORS.length; index++) {
		const candidate = OPERATORS[index]
		if (candidate !== undefined && candidate === name) {
			return candidate
		}
	}
	throw new PolicyError(`${what}: ${String(name)} is not an operator (${OPERATORS.join(', ')})`)
}

function literalOf(value: unknown, what: string): ConditionLiteral {
	if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
		return value
	}
	throw new PolicyError(`${what} compares with a string, a finite number or a boolean`)
}

function operandOf(
	operator: ConditionOperator,
	value: unknown,
	timestamp: boolean,
	what: string,
): ConditionLiteral | readonly ConditionLiteral[] | boolean | NowOperand {
	if (operator === 'isNull') {
		if (typeof value !== 'boolean') {
			throw new PolicyError(`${what}.isNull takes true or false`)
		}
		return value
	}
	if (operator === 'in' || operator === 'notIn') {
		const items = parseList(value, (item) => literalOf(item, `${what}.${operator}`))
		if (items === undefined || items.length === 0) {
			throw new PolicyError(`${what}.${operator} takes a non-empty plain array of literals`)
		}
		return freeze(items)
	}
	if (typeof value === 'object' && value !== null && !isArray(value)) {
		const record = plainRecord(value, what)
		const keys = ownKeys(record)
		if (keys.length !== 1 || keys[0] !== 'now' || ownEntry(record, 'now') !== true) {
			throw new PolicyError(`${what}.${operator} takes a literal or { now: true }`)
		}
		if (operator === 'eq' || operator === 'notEq') {
			throw new PolicyError(`${what}.${operator}: { now: true } is compared with lt, lte, gt or gte`)
		}
		if (!timestamp) {
			throw new PolicyError(`${what}: { now: true } is compared with a timestamp column only`)
		}
		return NOW
	}
	return literalOf(value, `${what}.${operator}`)
}

/** The tables a condition's paths reach, each with the key a subquery selects: what the guard admits under it. */
export function conditionReach(condition: ConditionModel, into: Record<string, string>): void {
	if (condition.kind === 'not') {
		conditionReach(condition.term, into)
		return
	}
	if (condition.kind !== 'test') {
		for (let index = 0; index < condition.terms.length; index++) {
			const term = condition.terms[index]
			if (term !== undefined) conditionReach(term, into)
		}
		return
	}
	for (let index = 0; index < condition.hops.length; index++) {
		const hop = condition.hops[index]
		if (hop !== undefined) into[hop.table] = hop.key
	}
}

/** A test's single literal; a list is compared only with in or notIn. */
export function scalar(value: ConditionLiteral | readonly ConditionLiteral[] | boolean | NowOperand): ConditionLiteral {
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return value
	}
	throw new PolicyError('a list is compared with in or notIn')
}

/**
 * The value of `condition` on an insert's own row, under SQL's three-valued logic: a NULL compared is unknown, `not`
 * of unknown stays unknown, and only `true` passes. A path is never judged here: the parse refuses one for an insert.
 */
export function rowSatisfies(condition: ConditionModel, row: ReadonlyMap<string, Primitive | null>, now: Date): boolean {
	return truth(condition, row, now) === true
}

function truth(condition: ConditionModel, row: ReadonlyMap<string, Primitive | null>, now: Date): boolean | undefined {
	switch (condition.kind) {
		case 'all': {
			let result: boolean | undefined = true
			for (let index = 0; index < condition.terms.length; index++) {
				const term = condition.terms[index]
				const value = term === undefined ? undefined : truth(term, row, now)
				if (value === false) return false
				if (value === undefined) result = undefined
			}
			return result
		}
		case 'any': {
			let result: boolean | undefined = false
			for (let index = 0; index < condition.terms.length; index++) {
				const term = condition.terms[index]
				const value = term === undefined ? undefined : truth(term, row, now)
				if (value === true) return true
				if (value === undefined) result = undefined
			}
			return result
		}
		case 'not': {
			const value = truth(condition.term, row, now)
			return value === undefined ? undefined : !value
		}
		case 'test': {
			if (condition.hops.length > 0) return undefined
			const cell = row.has(condition.column) ? row.get(condition.column) : null
			return testTruth(condition, cell ?? null, now)
		}
	}
}

function testTruth(test: Extract<ConditionModel, { kind: 'test' }>, cell: Primitive | null, now: Date): boolean | undefined {
	if (test.operator === 'isNull') {
		return (cell === null) === test.value
	}
	if (cell === null) {
		return undefined
	}
	const value = test.value
	if (test.operator === 'in' || test.operator === 'notIn') {
		let found = false
		if (isArray(value)) {
			for (let index = 0; index < value.length; index++) {
				if (same(cell, value[index])) found = true
			}
		}
		return test.operator === 'in' ? found : !found
	}
	const right: Primitive = value === NOW ? now : scalar(value)
	const order = compare(cell, right)
	if (order === undefined) return undefined
	switch (test.operator) {
		case 'eq':
			return order === 0
		case 'notEq':
			return order !== 0
		case 'lt':
			return order < 0
		case 'lte':
			return order <= 0
		case 'gt':
			return order > 0
		case 'gte':
			return order >= 0
	}
}

function same(left: Primitive, right: ConditionLiteral | undefined): boolean {
	return right !== undefined && compare(left, right) === 0
}

/** Orders two values the way both dialects compare a column with a bound value of its type; `undefined` across types. */
function compare(left: Primitive, right: Primitive): number | undefined {
	const a = left instanceof Date ? left.getTime() : left
	const b = right instanceof Date ? right.getTime() : typeof right === 'string' && left instanceof Date ? Date.parse(right) : right
	if (typeof a === 'boolean' || typeof b === 'boolean') {
		return typeof a === typeof b ? (a === b ? 0 : a ? 1 : -1) : undefined
	}
	if (typeof a === 'string' && typeof b === 'string') {
		return a < b ? -1 : a > b ? 1 : 0
	}
	if ((typeof a === 'number' || typeof a === 'bigint') && (typeof b === 'number' || typeof b === 'bigint')) {
		return a < b ? -1 : a > b ? 1 : 0
	}
	return undefined
}

export function hasOwnCondition(record: Readonly<Record<string, ConditionModel>>, action: string): boolean {
	return hasOwn(record, action)
}

/** A condition as the artifact records it: the policy's own form, a path written back as `fk_column.column`. */
export function conditionArtifact(condition: ConditionModel): ConditionArtifact {
	switch (condition.kind) {
		case 'all':
			return { allOf: artifactsOf(condition.terms) }
		case 'any':
			return { anyOf: artifactsOf(condition.terms) }
		case 'not':
			return { not: conditionArtifact(condition.term) }
		case 'test': {
			let path = ''
			for (let index = 0; index < condition.hops.length; index++) {
				path += `${condition.hops[index]?.column ?? ''}.`
			}
			const test: Record<string, ColumnTestArtifact> = {}
			test[path + condition.column] = testArtifact(condition)
			return test
		}
	}
}

function artifactsOf(terms: readonly ConditionModel[]): ConditionArtifact[] {
	const artifacts: ConditionArtifact[] = []
	for (let index = 0; index < terms.length; index++) {
		const term = terms[index]
		if (term !== undefined) artifacts[artifacts.length] = conditionArtifact(term)
	}
	return artifacts
}

function testArtifact(test: Extract<ConditionModel, { kind: 'test' }>): ColumnTestArtifact {
	const value = test.value
	switch (test.operator) {
		case 'isNull':
			return { isNull: value === true }
		case 'in':
		case 'notIn': {
			const list: ConditionLiteral[] = []
			if (isArray(value)) {
				for (let index = 0; index < value.length; index++) list[list.length] = value[index] ?? ''
			}
			return test.operator === 'in' ? { in: list } : { notIn: list }
		}
		case 'eq':
			return { eq: scalar(value) }
		case 'notEq':
			return { notEq: scalar(value) }
		case 'lt':
			return { lt: value === NOW ? { now: true } : scalar(value) }
		case 'lte':
			return { lte: value === NOW ? { now: true } : scalar(value) }
		case 'gt':
			return { gt: value === NOW ? { now: true } : scalar(value) }
		case 'gte':
			return { gte: value === NOW ? { now: true } : scalar(value) }
	}
}
