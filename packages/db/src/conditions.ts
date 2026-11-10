// Structured row conditions: the `when` of a table action and of a relation source. One parse over values nobody
// type-checked, one predicate builder, and the value of a condition on an insert's own row. Index loops and the
// captured built-ins only, as in the policy parse. No Kysely runtime: `@fabrika/db/tables` reads the parse in a
// browser; `condition-nodes.ts` builds the predicate.

import type { ColumnTestArtifact, ConditionArtifact, RowsTestArtifact } from '@fabrika/auth-core'
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

/** `{ some: { table: … } }` or `{ none: { table: … } }` at the end of a path: over the rows naming the row it reaches. */
export type RowsTest =
	| { readonly some: { readonly [table: string]: ConditionPolicy } }
	| { readonly none: { readonly [table: string]: ConditionPolicy } }

/**
 * A condition as a policy writes it: `{ column: test, … }` (all of them), `{ 'fk_column.column': test }` along a
 * foreign key, `{ anyOf: […] }`, `{ allOf: […] }`, `{ not: … }`, or `{ some: { table: … } }` and `{ none: { table: … } }`
 * over the rows of `table` whose foreign key names the row; `{ 'fk_column': { some: { table: … } } }` over the rows
 * naming the row a path reaches.
 */
export type ConditionPolicy<Col extends string = string> =
	| { readonly anyOf: readonly ConditionPolicy<Col>[] }
	| { readonly allOf: readonly ConditionPolicy<Col>[] }
	| { readonly not: ConditionPolicy<Col> }
	| { readonly some: { readonly [table: string]: ConditionPolicy } }
	| { readonly none: { readonly [table: string]: ConditionPolicy } }
	| { readonly [C in Col | `${Col}.${string}`]?: ColumnTest | RowsTest }

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
		/**
		 * `key in (select table.column from table where <term>)`, or its negation for `none`, over the row `hops` reach
		 * from the condition's own row (none: the row itself).
		 */
		readonly kind: 'some'
		readonly hops: readonly ConditionHop[]
		readonly negated: boolean
		readonly key: string
		readonly table: string
		readonly column: string
		readonly term: ConditionModel
	}
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
	/** The columns the column list declares NOT NULL: a path under `not` follows only these. */
	readonly notNull: NameSet
}

/** A path follows at most this many foreign keys: each hop is one more subquery in every statement the condition scopes. */
export const MAX_CONDITION_HOPS = 3
const MAX_CONDITION_DEPTH = 8
const OPERATORS: readonly ConditionOperator[] = freeze(['eq', 'notEq', 'in', 'notIn', 'isNull', 'lt', 'lte', 'gt', 'gte'])
const CONNECTIVES = freeze(['anyOf', 'allOf', 'not', 'some', 'none'])

/**
 * Whether a path may follow `from.column` to the row of `to` whose `key` it holds. A hop reads its target unscoped, so
 * the rule admits only one that stays where the row is (its own container or parent), stays in its tenant (a foreign
 * key that also holds every ancestor the two tables share), or reaches what every site reads (a reference table).
 * `backward` is a `some` reading the rows of `from` that name a row of `to`: those must stay in that row's tenant, so
 * a reference row, which every tenant's rows name, is no shortcut there.
 */
export type HopRule = (from: string, column: string, to: string, key: string, backward: boolean) => boolean

/** Parses `input` as a condition over `table`. `hops` is the rule a path's foreign keys are held to. */
export function parseCondition(
	input: unknown,
	table: ConditionTable,
	tables: (name: string) => ConditionTable | undefined,
	what: string,
	hops: HopRule,
): ConditionModel {
	return parseNode(input, table, tables, what, hops, 0, 0, false)
}

const HOP_LIMIT = `a path follows at most ${MAX_CONDITION_HOPS} foreign keys, a some or none counted as one`

/**
 * `level` counts the `some` and `none` subqueries around the node: each takes one of a path's foreign keys. `negated`
 * holds under any `not` around it.
 */
function parseNode(
	input: unknown,
	table: ConditionTable,
	tables: (name: string) => ConditionTable | undefined,
	what: string,
	hops: HopRule,
	depth: number,
	level: number,
	negated: boolean,
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
		const items = parseList(ownEntry(record, first), (item) => parseNode(item, table, tables, `${what}.${first}`, hops, depth + 1, level, negated))
		if (items === undefined || items.length === 0) {
			throw new PolicyError(`${what}.${first} takes a non-empty plain array of conditions`)
		}
		return freeze({ kind: first === 'anyOf' ? 'any' : 'all', terms: freeze(items) })
	}
	if (keys.length === 1 && first === 'not') {
		return freeze({ kind: 'not', term: parseNode(ownEntry(record, 'not'), table, tables, `${what}.not`, hops, depth + 1, level, true) })
	}
	if (keys.length === 1 && (first === 'some' || first === 'none')) {
		return parseSome(first, ownEntry(record, first), [], table, tables, `${what}.${first}`, hops, depth, level, negated)
	}
	const terms: ConditionModel[] = []
	for (let index = 0; index < keys.length; index++) {
		const key = keys[index] ?? ''
		for (let connective = 0; connective < CONNECTIVES.length; connective++) {
			if (key === CONNECTIVES[connective]) {
				throw new PolicyError(`${what}: ${key} stands alone in its object; wrap the column tests beside it in allOf`)
			}
		}
		terms[terms.length] = parseTest(key, ownEntry(record, key), table, tables, `${what}.${key}`, hops, depth, level, negated)
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
	hops: HopRule,
	depth: number,
	level: number,
	negated: boolean,
): ConditionModel {
	const segments = splitPath(path)
	const test = plainRecord(input, what)
	const operators = ownKeys(test)
	const only = operators[0]
	// `{ 'fk_column': { some: … } }`: every segment is a foreign key, and the rows test is one more hop past them.
	const rows = operators.length === 1 && (only === 'some' || only === 'none') ? only : undefined
	const followedCount = rows === undefined ? segments.length - 1 : segments.length
	if (followedCount + (rows === undefined ? 0 : 1) + level > MAX_CONDITION_HOPS) {
		throw new PolicyError(`${what}: ${HOP_LIMIT}`)
	}
	const followed: ConditionHop[] = []
	let current = table
	for (let index = 0; index < followedCount; index++) {
		const name = segments[index] ?? ''
		const hop = singleForeignKey(current, name, what)
		const target = tables(hop.table)
		if (target === undefined) {
			throw new PolicyError(`${what}: ${current.name}.${name} references ${hop.table}, which has no policy`)
		}
		// A hop's subquery reads its target unscoped: on a null key it is false while no row anywhere matches and unknown
		// otherwise, so under `not` the row would turn on rows of every tenant.
		if (negated && !inSet(current.notNull, name)) {
			throw new PolicyError(
				`${what}: ${current.name}.${name} may be null, and under not a path through a null key holds exactly when no row of ${hop.table} in any tenant matches; declare ${current.name}.${name} NOT NULL and run fabrika db codegen, or drop the not`,
			)
		}
		if (!hops(current.name, name, hop.table, hop.key, false)) {
			throw new PolicyError(
				`${what}: ${current.name}.${name} leads to ${hop.table}, outside the row's own containment; a path follows a row's container or parent column, a foreign key that also holds every ancestor the two tables share, or reaches a reference table`,
			)
		}
		followed[followed.length] = hop
		current = target
	}
	if (rows !== undefined) {
		return parseSome(rows, ownEntry(test, rows), freeze(followed), current, tables, `${what}.${rows}`, hops, depth, level + followedCount, negated)
	}
	const columnName = segments[segments.length - 1] ?? ''
	if (!inSet(current.columns, columnName)) {
		throw new PolicyError(`${what}: ${columnName} is not a column of ${current.name}`)
	}
	if (inSet(current.json, columnName)) {
		throw new PolicyError(`${what}: ${current.name}.${columnName} is a JSON column, which no condition compares`)
	}
	if (operators.length !== 1) {
		throw new PolicyError(`${what} takes exactly one operator (${OPERATORS.join(', ')})`)
	}
	const operator = operatorOf(only, what)
	const raw = ownEntry(test, operator)
	return freeze({
		kind: 'test',
		hops: freeze(followed),
		column: columnName,
		operator,
		value: operandOf(operator, raw, inSet(current.timestamps, columnName), what),
	})
}

/**
 * `{ some: { <table>: <condition> } }`: a row of `table` whose foreign key names this row meets the condition; `none`:
 * no such row does. The foreign key is held to the path rule from `table`'s side, so the rows read lie in this row's
 * own tenant: a child's parent column, a contained dimension's container column, or a key that holds the tenant.
 * After a path (`path`), `table` is the row it reaches and `level` counts its hops.
 */
function parseSome(
	kind: 'some' | 'none',
	input: unknown,
	path: readonly ConditionHop[],
	table: ConditionTable,
	tables: (name: string) => ConditionTable | undefined,
	what: string,
	hops: HopRule,
	depth: number,
	level: number,
	negated: boolean,
): ConditionModel {
	if (level + 1 > MAX_CONDITION_HOPS) {
		throw new PolicyError(`${what}: ${HOP_LIMIT}`)
	}
	const record = plainRecord(input, what)
	const names = ownKeys(record)
	const name = names[0] ?? ''
	if (names.length !== 1) {
		throw new PolicyError(`${what} names exactly one table`)
	}
	const child = tables(name)
	if (child === undefined) {
		throw new PolicyError(`${what}: ${name} is not a table with a policy`)
	}
	let found: ConditionHop | undefined
	let count = 0
	for (let index = 0; index < child.foreignKeys.length; index++) {
		const key = child.foreignKeys[index]
		if (key !== undefined && key.columns.length === 1 && key.table === table.name) {
			found = freeze({ column: key.columns[0] ?? '', table: name, key: key.references[0] ?? '' })
			count++
		}
	}
	if (found === undefined || count !== 1) {
		throw new PolicyError(
			found === undefined
				? `${what}: ${name} has no single-column foreign key to ${table.name}`
				: `${what}: ${name} has ${count} single-column foreign keys to ${table.name}, so the rows it names are not one set`,
		)
	}
	if (!hops(name, found.column, table.name, found.key, true)) {
		throw new PolicyError(
			`${what}: ${name}.${found.column} is outside ${table.name}'s containment; the rows read follow a child's parent column, a contained dimension's container column, or a foreign key that also holds every ancestor the two tables share, never a key into a reference table, whose rows every tenant's rows name`,
		)
	}
	const term = parseNode(ownEntry(record, name), child, tables, `${what}.${name}`, hops, depth + 1, level + 1, negated)
	return freeze({ kind: 'some', hops: path, negated: kind === 'none', key: found.key, table: name, column: found.column, term })
}

export function splitPath(path: string): readonly string[] {
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

export function singleForeignKey(table: ConditionTable, name: string, what: string): ConditionHop {
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

/** The tables a condition's subqueries read, each with the column it selects: what the guard admits under it. */
export function conditionReach(condition: ConditionModel, select: (table: string, column: string) => void): void {
	if (condition.kind === 'not') {
		conditionReach(condition.term, select)
		return
	}
	if (condition.kind === 'some') {
		for (let index = 0; index < condition.hops.length; index++) {
			const hop = condition.hops[index]
			if (hop !== undefined) select(hop.table, hop.key)
		}
		select(condition.table, condition.column)
		conditionReach(condition.term, select)
		return
	}
	if (condition.kind !== 'test') {
		for (let index = 0; index < condition.terms.length; index++) {
			const term = condition.terms[index]
			if (term !== undefined) conditionReach(term, select)
		}
		return
	}
	for (let index = 0; index < condition.hops.length; index++) {
		const hop = condition.hops[index]
		if (hop !== undefined) select(hop.table, hop.key)
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
 * One step of the rows an insert's condition reads: from the rows reached so far, the rows of `table` whose `to` column
 * holds their `from` column. A path's hop goes to the row a foreign key names (`from` the key column, `to` the target's
 * key); a `some` goes back to the rows naming it (`from` the referenced key, `to` the naming column).
 */
export interface ReadStep {
	readonly from: string
	readonly table: string
	readonly to: string
}

/**
 * Every sequence of steps from an insert's own row to the rows its condition reads, each one no other extends: the rows
 * the insert locks, step by step, before it judges them. Empty when the condition reads the row alone.
 */
export function readPaths(condition: ConditionModel): readonly (readonly ReadStep[])[] {
	const paths: (readonly ReadStep[])[] = []
	const hopSteps = (prefix: readonly ReadStep[], hops: readonly ConditionHop[]): ReadStep[] => {
		const steps: ReadStep[] = [...prefix]
		for (let index = 0; index < hops.length; index++) {
			const hop = hops[index]
			if (hop !== undefined) steps[steps.length] = freeze({ from: hop.column, table: hop.table, to: hop.key })
		}
		return steps
	}
	const visit = (node: ConditionModel, prefix: readonly ReadStep[]): void => {
		if (node.kind === 'not') {
			visit(node.term, prefix)
		} else if (node.kind === 'test') {
			if (node.hops.length > 0) paths[paths.length] = freeze(hopSteps(prefix, node.hops))
		} else if (node.kind === 'some') {
			const steps = hopSteps(prefix, node.hops)
			steps[steps.length] = freeze({ from: node.key, table: node.table, to: node.column })
			paths[paths.length] = freeze(steps)
			visit(node.term, steps)
		} else {
			for (let index = 0; index < node.terms.length; index++) {
				const term = node.terms[index]
				if (term !== undefined) visit(term, prefix)
			}
		}
	}
	visit(condition, [])
	const kept: (readonly ReadStep[])[] = []
	for (let index = 0; index < paths.length; index++) {
		const path = paths[index] ?? []
		let extended = false
		for (let other = 0; other < paths.length && !extended; other++) {
			const longer = paths[other] ?? []
			extended = other !== index && longer.length > path.length && startsWith(longer, path)
		}
		if (!extended) kept[kept.length] = path
	}
	return freeze(kept)
}

function startsWith(path: readonly ReadStep[], prefix: readonly ReadStep[]): boolean {
	for (let index = 0; index < prefix.length; index++) {
		const step = prefix[index]
		const same = path[index]
		if (step === undefined || same === undefined || step.from !== same.from || step.table !== same.table || step.to !== same.to) return false
	}
	return true
}

/**
 * Why `condition` cannot be judged on an inserted row, or `undefined` when it can. The insert locks every row its
 * condition reads, which holds a column test and a row a `some` found until the commit, but not a row inserted meanwhile:
 * that turns `none`, and a `some` under `not`, false. And no row names the inserted row before it exists.
 */
export function insertProblem(condition: ConditionModel, table: string): string | undefined {
	const visit = (node: ConditionModel, negated: boolean, past: boolean): string | undefined => {
		if (node.kind === 'not') return visit(node.term, true, past)
		if (node.kind === 'test') return undefined
		if (node.kind === 'some') {
			if (!past && node.hops.length === 0) {
				return "an insert's condition takes no some or none of the rows naming the inserted row: no row names a row that does not exist yet; follow a path first, such as { project_id: { some: … } }"
			}
			if (node.table === table) {
				return `an insert's condition takes no some of ${table}'s own rows: it is judged after the write, so the inserted row would count itself`
			}
			if (node.negated || negated) {
				return "an insert's condition takes no none, and no some under not: a row inserted before the commit could make it false, which no lock on the rows it read holds"
			}
			return visit(node.term, negated, true)
		}
		for (let index = 0; index < node.terms.length; index++) {
			const term = node.terms[index]
			const problem = term === undefined ? undefined : visit(term, negated, past)
			if (problem !== undefined) return problem
		}
		return undefined
	}
	return visit(condition, false, false)
}

/**
 * The value of `condition` on an insert's own row, under SQL's three-valued logic: a NULL compared is unknown, `not`
 * of unknown stays unknown, and only `true` passes. A condition with a path is judged in SQL on the written row instead.
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
		case 'some':
			return undefined
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
		case 'some': {
			const rows: Record<string, ConditionArtifact> = {}
			rows[condition.table] = conditionArtifact(condition.term)
			const named: RowsTestArtifact = condition.negated ? { none: rows } : { some: rows }
			if (condition.hops.length === 0) return named
			const test: Record<string, RowsTestArtifact> = {}
			test[pathText(condition.hops).slice(0, -1)] = named
			return test
		}
		case 'test': {
			const test: Record<string, ColumnTestArtifact> = {}
			test[pathText(condition.hops) + condition.column] = testArtifact(condition)
			return test
		}
	}
}

/** Each hop's column followed by a dot: the prefix of a path's text. */
function pathText(hops: readonly ConditionHop[]): string {
	let path = ''
	for (let index = 0; index < hops.length; index++) {
		path += `${hops[index]?.column ?? ''}.`
	}
	return path
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
