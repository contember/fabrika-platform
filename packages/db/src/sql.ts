// `ctx.sql(Row)`…``: one statement of the application's own SQL, for a site that declares `sql: 'read' | 'write'`. The
// template's static text is classified before anything is sent: an interpolation is always a bound parameter (`$n`),
// never SQL. The statement runs in the site's session — the invocation's transaction, or a job's fenced one — so it
// commits and rolls back with every `ctx.db` handle. The name rules are defense in depth; the runtime role
// (`run_<id>`, DML only) is what bounds a statement they admit.

import {
	dmlForeignSchema,
	frameworkReference,
	lexSql,
	nameReferences,
	nameText,
	nestedStatement,
	parenthesizedTarget,
	refusedFunctionCall,
	type SqlToken,
	statementKind,
	topLevelStatements,
	unicodeIdentifier,
	upperWord,
} from '@fabrika/platform-node/sql'
import { z } from 'zod/v4'
import { freeze, hasOwn, isArray, ownDescriptor, ownKeys, parseList } from './builtins'
import { runApplicationStatement, type Session, type SqlParameter } from './database'
import { type QueryRefusal, QueryRefusedError, SqlRowError } from './errors'
import { isPlainIdentifier } from './identifier'
import { dayText } from './temporal'

/** What a site declares: `'read'` runs queries only, `'write'` also `INSERT`, `UPDATE` and `DELETE`. */
export type SqlMode = 'read' | 'write'

/** A value an interpolation binds: a scalar, a `Date` (bound as ISO text), or a list of strings or numbers (an array). */
export type SqlValue = string | number | boolean | bigint | Date | null | readonly (string | number)[]

/** One test of a capability's scope on a table: the column holds the value, or one of the list. */
export interface ScopeTest {
	readonly column: string
	readonly value: string | readonly string[]
}

/** A capability's predicate on one table: every row (`'all'`), or an OR of AND groups; no group matches nothing. */
export type ScopeTerms = 'all' | readonly (readonly ScopeTest[])[]

/** What a fragment's table is to its statement: read, or the target of its UPDATE or DELETE. */
export type ScopeUse = 'read' | 'update' | 'delete'

/**
 * The scope of `capability` on `table` for `use`, as the data layer predicates its handles; throws when it does not
 * reach it for that use.
 */
export type ScopeOf = (capability: unknown, table: string, use: ScopeUse) => ScopeTerms

/** The operation a write statement performs on one of its targets. */
export type WriteOperation = 'insert' | 'update' | 'delete'

/** Throws for a table no statement may write with `operation`: a reference table. */
export type WriteTarget = (table: string, operation: WriteOperation) => void

/**
 * `ctx.sql.scope(capability, table, alias?)`: the capability's whole predicate on one table, as SQL with bound values.
 * A fragment is a frozen object with no prototype; what it holds lives in this module's registry, read through
 * methods captured at load, so no object an application builds or changes is ever taken for one.
 */
export interface SqlScope {
	readonly kind: 'sql-scope'
}

interface ScopeData {
	readonly site: SqlSite
	readonly capability: unknown
	readonly table: string
	readonly alias: string
}

const scopes = new WeakMap<object, ScopeData>()
// Bound once at load: a later patch of WeakMap.prototype or Function.prototype changes neither.
const registered = WeakMap.prototype.get.bind(scopes)
const register = WeakMap.prototype.set.bind(scopes)
const withoutPrototype = Object.setPrototypeOf

function newScope(data: ScopeData): SqlScope {
	const scope: SqlScope = { kind: 'sql-scope' }
	withoutPrototype(scope, null)
	freeze(scope)
	register(scope, freeze({ site: data.site, capability: data.capability, table: data.table, alias: data.alias }))
	return scope
}

/** What `value` holds when it is a fragment this module built; `undefined` for anything else. */
function scopeOf(value: unknown): ScopeData | undefined {
	return typeof value === 'object' && value !== null ? registered(value) : undefined
}

/** `ctx.sql(Row)`: the tag for rows of `Row`, and `scope` for the capability's predicate inside its text. */
export interface SqlTag {
	<S extends z.core.$ZodType>(row: S): (text: TemplateStringsArray, ...values: readonly (SqlValue | SqlScope)[]) => Promise<z.output<S>[]>
	scope(capability: unknown, table: string, alias?: string): SqlScope
}

/** The site a tag is made for: its mode, its binding to the invocation, and the session its statements run in. */
export interface SqlSite {
	readonly mode: SqlMode
	/** Throws unless the work running now is the invocation the tag was made for. */
	check(): void
	session(): Promise<Session>
	/** Fails the site's transaction (the invocation's, or a job's fenced one), so it commits nothing. */
	fail(): void
}

const READ_STATEMENTS: ReadonlySet<string> = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE'])
const WRITE_STATEMENTS: ReadonlySet<string> = new Set(['INSERT', 'UPDATE', 'DELETE'])
const WRITE_WORDS: ReadonlySet<string> = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE'])
/** `FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE`, `FOR KEY SHARE`: what follows `FOR` in a locking clause. */
const LOCK_WORDS: ReadonlySet<string> = new Set(['UPDATE', 'NO', 'SHARE', 'KEY'])
/** ctx.sql calls reviewed built-ins only: the functions the migrations declare are not known at runtime. */
const NO_DECLARED_FUNCTIONS: ReadonlySet<string> = new Set()

const ALLOWED_STATEMENTS = "SELECT, WITH, VALUES or TABLE, and INSERT, UPDATE or DELETE on a site that declares sql: 'write'"

function refuse(reason: QueryRefusal, message: string): never {
	throw new QueryRefusedError(reason, `ctx.sql: ${message}`)
}

const isPunct = (token: SqlToken | undefined, char: string): boolean => token?.kind === 'punct' && token.char === char
const isDigit = (token: SqlToken | undefined): boolean => token?.kind === 'punct' && token.char >= '0' && token.char <= '9'

/** The template's static parts. A call with a plain array, or a text with an invalid escape, is refused. */
function templateParts(text: unknown): readonly string[] {
	const raw: unknown = isArray(text) && hasOwn(text, 'raw') ? ownDescriptor(text, 'raw')?.value : undefined
	if (!isArray(text) || !Object.isFrozen(text) || !isArray(raw) || !Object.isFrozen(raw) || raw.length !== text.length) {
		refuse('sql_template', 'it is a tagged template: write ctx.sql(Row)`select …`, never call it with a string or an array')
	}
	const parts: string[] = []
	for (let index = 0; index < text.length; index++) {
		const part: unknown = text[index]
		if (typeof part !== 'string') {
			refuse('sql_template', 'the template has an invalid escape sequence')
		}
		parts.push(part)
	}
	return parts
}

/** The statement's text, each interpolation a `$n` placeholder between the static parts. */
function statementText(parts: readonly string[]): string {
	let text = parts[0] ?? ''
	for (let index = 1; index < parts.length; index++) {
		const part = parts[index] ?? ''
		if (/^[0-9]/.test(part)) {
			refuse('sql_template', `a digit right after the value \${…} number ${index} would join its placeholder; put a space between them`)
		}
		text += `$${index}${part}`
	}
	return text
}

/** How many `$n` placeholders the lexer sees outside literals, quoted names, dollar-quoted bodies and comments. */
function placeholderCount(tokens: readonly SqlToken[]): number {
	let count = 0
	for (let index = 0; index + 1 < tokens.length; index++) {
		if (isPunct(tokens[index], '$') && isDigit(tokens[index + 1])) count++
	}
	return count
}

/** The first `SELECT … INTO`: it creates a table. `INSERT INTO` is the one `INTO` a statement may hold. */
function selectInto(tokens: readonly SqlToken[]): SqlToken | undefined {
	for (let index = 0; index < tokens.length; index++) {
		if (upperWord(tokens[index]) === 'INTO' && upperWord(tokens[index - 1]) !== 'INSERT') return tokens[index]
	}
	return undefined
}

/** In a `'read'` statement: the first word that writes (a data-modifying CTE) or a locking clause. */
function readRefusal(tokens: readonly SqlToken[]): string | undefined {
	for (let index = 0; index < tokens.length; index++) {
		const word = upperWord(tokens[index])
		if (word === 'FOR' && LOCK_WORDS.has(upperWord(tokens[index + 1]) ?? '')) {
			return `a locking clause (FOR ${upperWord(tokens[index + 1])}) at line ${tokens[index]?.line}`
		}
		if (word !== undefined && WRITE_WORDS.has(word)) return `${word} at line ${tokens[index]?.line}`
	}
	return undefined
}

/**
 * The SQL `parts` make, with `$1…$n` for the values, or a `QueryRefusedError` that names what is refused: more than
 * one statement, any statement but a query (and `INSERT`/`UPDATE`/`DELETE` for `'write'`), a nested statement of
 * another kind, a qualified name outside `schema`, a `fabrika_*` or `pg_*` name, a function call outside the reviewed
 * built-ins, and a value placed where it would not be bound.
 */
export function classifySql(parts: readonly string[], mode: SqlMode, schema: string): string {
	for (const part of parts) {
		if (/\$[0-9]/.test(part)) {
			refuse('sql_template', 'the text holds $ and a digit, which reads as a positional parameter; interpolate the value with ${…}, a literal one too')
		}
	}
	const text = statementText(parts)
	const { tokens: all, unterminated } = lexSql(text)
	if (unterminated !== undefined) {
		refuse('sql_template', `a string, quoted name, dollar-quoted body or comment at line ${unterminated} never closes`)
	}
	if (placeholderCount(all) !== parts.length - 1) {
		refuse(
			'sql_template',
			'a value ${…} inside a string literal, a quoted name, a dollar-quoted body or a comment is not bound; interpolate a whole value',
		)
	}
	const statements = topLevelStatements(text)
	const [statement] = statements
	if (statement === undefined) {
		refuse('sql_statement', 'the template holds no statement')
	}
	if (statements.length > 1) {
		refuse('sql_statement', `it runs one statement, and the template holds ${statements.length}; call ctx.sql once for each`)
	}
	const tokens = statement.tokens
	const first = upperWord(tokens[0]) ?? ''
	if (!READ_STATEMENTS.has(first) && !WRITE_STATEMENTS.has(first)) {
		refuse('sql_statement', `${statementKind(tokens)} is refused; it runs ${ALLOWED_STATEMENTS}`)
	}
	const writes = mode === 'read' ? (WRITE_STATEMENTS.has(first) ? `${first} at line ${statement.line}` : readRefusal(tokens)) : undefined
	if (writes !== undefined) {
		refuse('sql_read_only', `sql: 'read' runs queries only, and the statement holds ${writes}; declare sql: 'write' on a mutation, a job or a webhook`)
	}
	const nested = nestedStatement(tokens) ?? parenthesizedTarget(tokens)
	if (nested !== undefined) {
		refuse('sql_statement', `${nested.statement} at line ${nested.line} is refused inside another statement`)
	}
	const into = selectInto(tokens)
	if (into !== undefined) {
		refuse('sql_statement', `SELECT … INTO at line ${into.line} creates a table; select the rows and insert them with INSERT INTO … SELECT`)
	}
	if (unicodeIdentifier(tokens) !== undefined) {
		refuse('sql_name', 'a U&"…" name is refused: write the name plainly')
	}
	const framework = frameworkReference(tokens)
	if (framework !== undefined) {
		refuse('sql_name', `'${framework.name}' at line ${framework.line} is the framework's; ctx.sql reaches only the application's own tables`)
	}
	for (const reference of nameReferences(tokens)) {
		if (reference.role !== 'call' && reference.name.startsWith('pg_')) {
			refuse('sql_name', `'${reference.name}' at line ${reference.line} is a catalog name; ctx.sql reaches only the application's own tables`)
		}
	}
	const foreign = dmlForeignSchema(tokens, schema)
	if (foreign !== undefined) {
		refuse('sql_name', `the schema '${foreign}' is outside the application's; write its tables' names unqualified`)
	}
	const call = refusedFunctionCall(tokens, schema, NO_DECLARED_FUNCTIONS)
	if (call !== undefined) {
		refuse(
			'sql_function',
			`${call.qualifier === undefined ? '' : `${call.qualifier}.`}${call.name}(…) at line ${call.line} is not a reviewed built-in function`,
		)
	}
	return text
}

function arrayElement(item: unknown): string {
	if (typeof item === 'string') {
		return `"${item.replace(/["\\]/g, (char) => `\\${char}`)}"`
	}
	if (typeof item === 'number' && Number.isFinite(item)) {
		return String(item)
	}
	return refuse('invalid_value', 'a list value holds only strings and finite numbers')
}

/** A value as the driver binds it. Unprepared, `Bun.SQL` mis-binds a JS array and sends a `Date` as `Date#toString()`. */
function parameterOf(value: unknown, position: number): SqlParameter {
	if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'bigint') {
		return value
	}
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : refuse('invalid_value', `the value \${…} number ${position} is not a finite number`)
	}
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? refuse('invalid_value', `the value \${…} number ${position} is an invalid Date`) : value.toISOString()
	}
	const items = parseList(value, arrayElement)
	if (items !== undefined) {
		return `{${items.join(',')}}`
	}
	return refuse(
		'invalid_value',
		`the value \${…} number ${position} is ${
			value === undefined ? 'undefined' : 'an object'
		}; bind a string, number, boolean, bigint, Date, null or a plain list (JSON as JSON.stringify(v) with ::jsonb)`,
	)
}

function camel(column: string): string {
	return column.replace(/_([a-z0-9])/g, (_match, next: string) => next.toUpperCase())
}

/** A text Postgres sends for a `bigint` or `numeric` column. */
const NUMERIC_TEXT = /^-?[0-9]+(\.[0-9]+)?$/

/**
 * One row as `row` parses it: snake_case columns as camelCase fields, a `Date` as ISO text (a day for a `z.iso.date()`
 * field). No value reaches a message.
 */
function parseRow<S extends z.core.$ZodType>(row: S, value: unknown, index: number): z.output<S> {
	const fields: Record<string, unknown> = {}
	const columnOf = new Map<string, string>()
	const record = typeof value === 'object' && value !== null ? value : {}
	for (const column of ownKeys(record)) {
		const field = camel(column)
		const earlier = columnOf.get(field)
		if (earlier !== undefined) {
			throw new SqlRowError(`ctx.sql: the columns '${earlier}' and '${column}' both become the field '${field}'; rename one with AS`)
		}
		columnOf.set(field, column)
		const cell: unknown = ownDescriptor(record, column)?.value
		Object.defineProperty(fields, field, { value: cell instanceof Date ? dateField(row, field, cell, column) : cell, enumerable: true })
	}
	const parsed = z.safeParse(row, fields)
	if (parsed.success) {
		return parsed.data
	}
	throw new SqlRowError(rowIssue(row, parsed.error.issues[0], fields, columnOf, index))
}

/**
 * A `Date` cell as its field reads it: a day (`YYYY-MM-DD`) for a `z.iso.date()` field, ISO 8601 text otherwise. The
 * driver decodes a `date` column to UTC midnight, which only the row schema tells apart from a timestamp.
 */
function dateField(row: z.core.$ZodType, field: string, value: Date, column: string): string {
	let schema: z.core.$ZodType | undefined = row instanceof z.ZodObject && hasOwn(row.shape, field) ? row.shape[field] : undefined
	while (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault) {
		schema = schema.unwrap()
	}
	return schema instanceof z.ZodISODate ? dayText(value, `ctx.sql: the column '${column}'`) : value.toISOString()
}

/** A top-level field of an object row schema: the one part of an issue's path that is the schema's, not the data's. */
function schemaField(row: z.core.$ZodType, issue: z.core.$ZodIssue | undefined): string | undefined {
	const field = issue?.path[0]
	return typeof field === 'string' && row instanceof z.ZodObject && hasOwn(row.shape, field) ? field : undefined
}

/**
 * The message of a refused row, from the issue's code, its expected type and the schema's own field only: an issue's
 * message, a deeper path (a JSON key, an array index) and the input can all carry the row's values.
 */
function rowIssue(
	row: z.core.$ZodType,
	issue: z.core.$ZodIssue | undefined,
	fields: Readonly<Record<string, unknown>>,
	columnOf: ReadonlyMap<string, string>,
	index: number,
): string {
	const field = schemaField(row, issue)
	const cell: unknown = field === undefined ? undefined : ownDescriptor(fields, field)?.value
	if (
		issue?.code === 'invalid_type' && issue.path.length === 1 && issue.expected === 'number' && typeof cell === 'string' && NUMERIC_TEXT.test(cell)
	) {
		return `ctx.sql: the column '${
			columnOf.get(field ?? '') ?? field
		}' arrives as text (Postgres sends bigint and numeric as text); cast it in the SQL (count(*)::int, ::float8) or read it with z.coerce.number()`
	}
	const where = field === undefined ? '' : ` at '${field}'`
	const kind = issue === undefined ? 'refused' : issue.code === 'invalid_type' ? `invalid_type (expected ${issue.expected})` : issue.code
	return `ctx.sql: row ${index + 1} does not match the row schema${where}: ${kind}`
}

/** The predicate `terms` make over `alias`'s columns: static parts around one bound value per test. */
function scopeFragment(terms: ScopeTerms, alias: string): { readonly parts: readonly string[]; readonly values: readonly SqlValue[] } {
	if (terms === 'all') return { parts: ['(true)'], values: [] }
	if (terms.length === 0) return { parts: ['(false)'], values: [] }
	const parts: string[] = []
	const values: SqlValue[] = []
	let text = '('
	terms.forEach((group, groupIndex) => {
		text += `${groupIndex === 0 ? '' : ' or '}(`
		group.forEach((test, testIndex) => {
			text += `${testIndex === 0 ? '' : ' and '}${alias}.${test.column} = ${typeof test.value === 'string' ? '' : 'any('}`
			parts.push(text)
			values.push(test.value)
			text = typeof test.value === 'string' ? '' : ')'
		})
		text += ')'
	})
	parts.push(`${text})`)
	return { parts, values }
}

/** One table a write statement writes, at any depth (a data-modifying CTE too), and how. */
interface Target {
	readonly table: string
	readonly operation: WriteOperation
}

/** The relation an UPDATE or DELETE writes: its table, under its alias (the table's name without one). */
interface Written {
	readonly table: string
	readonly alias: string
	readonly operation: 'update' | 'delete'
}

/** What a statement writes, and for each interpolation, in order, the UPDATE or DELETE of the query block it stands in. */
interface StatementWrites {
	readonly targets: readonly Target[]
	readonly blocks: readonly (Written | undefined)[]
}

/** Words that cannot be an alias: what follows a target that has none. */
const NOT_ALIASES: ReadonlySet<string> = new Set(['SET', 'WHERE', 'USING', 'RETURNING', 'DEFAULT', 'VALUES', 'SELECT', 'ON', 'OVERRIDING'])

/** The target name at `index` (`ONLY` and a schema skipped) and its alias, or `undefined` when no name is there. */
function targetAt(tokens: readonly SqlToken[], index: number): { readonly table: string; readonly alias: string } | undefined {
	const at = upperWord(tokens[index]) === 'ONLY' ? index + 1 : index
	const qualified = isPunct(tokens[at + 1], '.')
	const table = qualified ? nameText(tokens[at + 2]) : nameText(tokens[at])
	if (table === undefined) return undefined
	let next = qualified ? at + 3 : at + 1
	if (upperWord(tokens[next]) === 'AS') next++
	const word = upperWord(tokens[next])
	const alias = tokens[next]?.kind === 'quoted' || (word !== undefined && !NOT_ALIASES.has(word)) ? nameText(tokens[next]) : undefined
	return { table, alias: alias ?? table }
}

/**
 * Every `INSERT INTO`, `UPDATE` and `DELETE FROM` target of the statement, and the query block of each interpolation.
 * A block opens at a `SELECT`, `INSERT`, `UPDATE` or `DELETE` and closes with the parenthesis it stands in, or at the
 * next block of its depth: a subquery, a data-modifying CTE and an `INSERT`'s `SELECT` are blocks of their own.
 * `ON CONFLICT … DO UPDATE` is an UPDATE of the INSERT's target; a locking clause (`FOR UPDATE`) writes nothing.
 */
function statementWrites(tokens: readonly SqlToken[]): StatementWrites {
	const targets: Target[] = []
	const blocks: (Written | undefined)[] = []
	const open: { readonly depth: number; readonly write: Written | undefined }[] = []
	const inserts = new Map<number, { readonly table: string; readonly alias: string }>()
	let depth = 0
	const enter = (write: Written | undefined) => {
		while ((open[open.length - 1]?.depth ?? -1) >= depth) open.pop()
		open.push({ depth, write })
	}
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]
		if (isPunct(token, '(')) {
			depth++
			continue
		}
		if (isPunct(token, ')')) {
			depth--
			while ((open[open.length - 1]?.depth ?? -1) > depth) open.pop()
			for (const level of inserts.keys()) if (level > depth) inserts.delete(level)
			continue
		}
		if (isPunct(token, '$') && isDigit(tokens[index + 1])) {
			blocks.push(open[open.length - 1]?.write)
			continue
		}
		const word = upperWord(token)
		const next = upperWord(tokens[index + 1])
		if (word === 'SELECT') {
			enter(undefined)
		} else if (word === 'INSERT' && next === 'INTO') {
			const target = targetAt(tokens, index + 2)
			enter(undefined)
			if (target !== undefined) {
				inserts.set(depth, target)
				targets.push({ table: target.table, operation: 'insert' })
			}
		} else if (word === 'DELETE' && next === 'FROM') {
			const target = targetAt(tokens, index + 2)
			enter(target === undefined ? undefined : { ...target, operation: 'delete' })
			if (target !== undefined) targets.push({ table: target.table, operation: 'delete' })
		} else if (word === 'UPDATE') {
			const before = upperWord(tokens[index - 1])
			if (before === 'FOR' || before === 'KEY') continue
			const target = before === 'DO' ? inserts.get(depth) : targetAt(tokens, index + 1)
			enter(target === undefined ? undefined : { ...target, operation: 'update' })
			if (target !== undefined) targets.push({ table: target.table, operation: 'update' })
		}
	}
	return { targets, blocks }
}

/** What a fragment on `table` under `alias` is to its block: the relation its UPDATE or DELETE writes, or else read. */
function fragmentUse(written: Written | undefined, table: string, alias: string): ScopeUse {
	return written !== undefined && written.table === table && written.alias === alias ? written.operation : 'read'
}

/** Words that open the clause a scope may stand in. */
const SCOPE_CLAUSES: ReadonlySet<string> = new Set(['WHERE', 'ON'])
/** Words that end a WHERE or ON clause at its own depth. */
const CLAUSE_ENDS: ReadonlySet<string> = new Set([
	'GROUP',
	'ORDER',
	'LIMIT',
	'OFFSET',
	'FETCH',
	'HAVING',
	'WINDOW',
	'UNION',
	'INTERSECT',
	'EXCEPT',
	'RETURNING',
	'FOR',
	'JOIN',
	'LEFT',
	'RIGHT',
	'INNER',
	'FULL',
	'CROSS',
	'NATURAL',
	'WHERE',
	'ON',
	'USING',
	'SET',
	'FROM',
	'SELECT',
	'VALUES',
])
const CONJUNCT_FORM = 'write it as a conjunct of its WHERE or JOIN … ON clause: where (<filter>) and ${ctx.sql.scope(…)}'

/** Whether the token at `position` ends a WHERE or ON clause at its depth; `IS DISTINCT FROM` does not. */
function endsClause(tokens: readonly SqlToken[], position: number): boolean {
	const token = tokens[position]
	const word = upperWord(token)
	if (isPunct(token, ';')) return true
	if (word === undefined || !CLAUSE_ENDS.has(word)) return false
	return word !== 'FROM' || upperWord(tokens[position - 1]) !== 'DISTINCT'
}

/** The index of the token after the `$n` placeholder at `index`. */
function afterPlaceholder(tokens: readonly SqlToken[], index: number): number {
	let next = index + 1
	while (isDigit(tokens[next])) next++
	return next
}

/**
 * A scope must restrict every row its clause admits: it stands alone, joined by AND, at the top level of a WHERE or
 * JOIN … ON clause whose top level holds no OR (`where (<filter>) and ${scope}`). Anything else could reach past it.
 */
function checkConjunct(tokens: readonly SqlToken[], index: number): void {
	const line = tokens[index]?.line
	let depth = 0
	let start = -1
	for (let position = index - 1; position >= 0 && start === -1; position--) {
		const token = tokens[position]
		const word = upperWord(token)
		if (isPunct(token, ')')) depth++
		else if (isPunct(token, '(')) {
			if (depth === 0) refuse('sql_scope', `ctx.sql.scope(…) at line ${line} stands inside parentheses; ${CONJUNCT_FORM}`)
			depth--
		} else if (depth === 0 && word !== undefined && SCOPE_CLAUSES.has(word)) start = position
		else if (depth === 0 && endsClause(tokens, position)) break
	}
	if (start === -1) refuse('sql_scope', `ctx.sql.scope(…) at line ${line} stands outside a WHERE or JOIN … ON clause; ${CONJUNCT_FORM}`)
	const next = afterPlaceholder(tokens, index)
	let end = tokens.length
	depth = 0
	for (let position = next; position < tokens.length && end === tokens.length; position++) {
		const token = tokens[position]
		if (isPunct(token, '(')) depth++
		else if (isPunct(token, ')')) {
			if (depth === 0) end = position
			else depth--
		} else if (depth === 0 && endsClause(tokens, position)) end = position
	}
	depth = 0
	for (let position = start + 1; position < end; position++) {
		const token = tokens[position]
		if (isPunct(token, '(')) depth++
		else if (isPunct(token, ')')) depth--
		else if (depth === 0 && upperWord(token) === 'OR') {
			refuse(
				'sql_scope',
				`the clause that holds ctx.sql.scope(…) at line ${line} has an OR at its top level, which reaches past the scope; ${CONJUNCT_FORM}`,
			)
		} else if (depth === 0 && upperWord(token) === 'BETWEEN') {
			refuse('sql_scope', `put BETWEEN … AND … in parentheses in the clause that holds ctx.sql.scope(…) at line ${line}`)
		}
	}
	const before = upperWord(tokens[index - 1])
	const after = next === end ? 'END' : upperWord(tokens[next])
	if ((index - 1 !== start && before !== 'AND') || (after !== 'END' && after !== 'AND')) {
		refuse('sql_scope', `ctx.sql.scope(…) at line ${line} must stand alone, joined by AND; ${CONJUNCT_FORM}`)
	}
}

/**
 * Before any scope is spliced in, each interpolation must stand where a value binds (not in a literal, a quoted name,
 * a dollar-quoted body or a comment), and each scope where it restricts every row of its clause.
 */
function checkInterpolations(parts: readonly string[], values: readonly unknown[]): void {
	for (const part of parts) {
		if (/\$[0-9]/.test(part)) {
			refuse('sql_template', 'the text holds $ and a digit, which reads as a positional parameter; interpolate the value with ${…}, a literal one too')
		}
	}
	const { tokens, unterminated } = lexSql(statementText(parts))
	if (unterminated !== undefined) {
		refuse('sql_template', `a string, quoted name, dollar-quoted body or comment at line ${unterminated} never closes`)
	}
	if (placeholderCount(tokens) !== parts.length - 1) {
		refuse(
			'sql_template',
			'a value ${…} inside a string literal, a quoted name, a dollar-quoted body or a comment is not bound; interpolate a whole value',
		)
	}
	let interpolation = 0
	for (let index = 0; index + 1 < tokens.length; index++) {
		if (!isPunct(tokens[index], '$') || !isDigit(tokens[index + 1])) continue
		if (scopeOf(values[interpolation]) !== undefined) checkConjunct(tokens, index)
		interpolation++
	}
}

/**
 * The template with every scope spliced in as text around its own values, and the values a parameter each. Each
 * fragment is rendered for what its relation is to its query block: the one its UPDATE or DELETE writes, or read.
 */
function expandScopes(
	site: SqlSite,
	parts: readonly string[],
	values: readonly unknown[],
	termsOf: ScopeOf,
	writeTarget: WriteTarget,
): { parts: string[]; values: unknown[] } {
	checkInterpolations(parts, values)
	const writes: StatementWrites = site.mode === 'write' ? statementWrites(lexSql(statementText(parts)).tokens) : { targets: [], blocks: [] }
	for (const target of writes.targets) writeTarget(target.table, target.operation)
	const expanded: string[] = [parts[0] ?? '']
	const bound: unknown[] = []
	for (let index = 0; index < values.length; index++) {
		const value = values[index]
		const after = parts[index + 1] ?? ''
		const fragment = scopeOf(value)
		if (fragment === undefined) {
			bound.push(value)
			expanded.push(after)
			continue
		}
		if (fragment.site !== site) {
			refuse('sql_scope', 'a ctx.sql.scope(…) of another invocation or site is refused; build it with this ctx.sql')
		}
		const terms = termsOf(fragment.capability, fragment.table, fragmentUse(writes.blocks[index], fragment.table, fragment.alias))
		const rendered = scopeFragment(terms, fragment.alias)
		expanded[expanded.length - 1] += rendered.parts[0] ?? ''
		for (let position = 0; position < rendered.values.length; position++) {
			bound.push(rendered.values[position])
			expanded.push(rendered.parts[position + 1] ?? '')
		}
		expanded[expanded.length - 1] += after
	}
	return { parts: expanded, values: bound }
}

/**
 * `work`, failing the site's transaction when it throws: a handler that catches a refused statement, value or row must
 * not commit what it wrote around it.
 */
async function failing<T>(site: SqlSite, work: () => Promise<T>): Promise<T> {
	try {
		return await work()
	} catch (error) {
		site.fail()
		throw error
	}
}

const WRITE_USES: readonly ScopeUse[] = ['update', 'delete']

/**
 * Throws unless `capability` reaches `table` for some use the site may make of it: reading, or on a `'write'` site
 * the target of an UPDATE or a DELETE. The statement's own use is checked when the tag renders the fragment.
 */
function reaches(site: SqlSite, termsOf: ScopeOf, capability: unknown, table: string): void {
	try {
		termsOf(capability, table, 'read')
	} catch (error) {
		if (site.mode !== 'write') throw error
		for (const use of WRITE_USES) {
			try {
				termsOf(capability, table, use)
				return
			} catch {
				// The read refusal names what a read needs, which is what most fragments are.
			}
		}
		throw error
	}
}

/**
 * `ctx.sql` of one site. Every call first checks that the work running now is the site's invocation, then classifies
 * the text, then binds the values; only then does it reach the session, so a refused statement sends nothing.
 */
export function sqlTag(site: SqlSite, schema: string | undefined, termsOf: ScopeOf, writeTarget: WriteTarget): SqlTag {
	const tag = <S extends z.core.$ZodType>(row: S) => {
		site.check()
		if (!(row instanceof z.core.$ZodType)) {
			site.fail()
			refuse('invalid_argument', 'ctx.sql(Row) takes the zod schema of one row')
		}
		return async (text: TemplateStringsArray, ...values: readonly (SqlValue | SqlScope)[]): Promise<z.output<S>[]> => {
			site.check()
			return failing(site, async () => {
				const expanded = expandScopes(site, templateParts(text), values, termsOf, writeTarget)
				const statement = classifySql(expanded.parts, site.mode, schema ?? '')
				const parameters = expanded.values.map((value, index) => parameterOf(value, index + 1))
				const session = await site.session()
				if (session.readOnly && site.mode === 'write') {
					refuse('read_only', 'this invocation is read-only')
				}
				const rows = await runApplicationStatement(session, statement, parameters)
				return rows.map((value, index) => parseRow(row, value, index))
			})
		}
	}
	const scope = (capability: unknown, table: string, alias?: string): SqlScope => {
		site.check()
		try {
			const name = alias ?? table
			if (!isPlainIdentifier(table) || !isPlainIdentifier(name)) {
				refuse('invalid_argument', 'ctx.sql.scope(capability, table, alias?) takes a table name and an alias of lowercase letters, digits and _')
			}
			reaches(site, termsOf, capability, table)
			return newScope({ site, capability, table, alias: name })
		} catch (error) {
			site.fail()
			throw error
		}
	}
	return Object.freeze(Object.assign(tag, { scope }))
}
