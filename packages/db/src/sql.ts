// `ctx.sql(Row)`…``: one statement of the application's own SQL, for a site that declares `sql: 'read' | 'write'`. The
// template's static text is classified before anything is sent: an interpolation is always a bound parameter (`$n` on
// Postgres, `?n` on SQLite), never SQL. The statement runs in the site's session — the invocation's transaction, or a
// job's fenced one — so it commits and rolls back with every `ctx.db` handle. The hard rules keep it inside the
// platform (the framework's tables, the catalog, the transaction); what it does with the application's own data is the
// approver's to review, since the `sql:` declaration marks the site for a closer look (ADR-0012, ADR-0050).

import {
	dmlForeignSchema,
	frameworkReference,
	lexSql,
	lexSqlite,
	nameReferences,
	nestedStatement,
	parenthesizedTarget,
	refusedFunctionCall,
	type SqlToken,
	statementKind,
	statementsOf,
	unicodeIdentifier,
	upperWord,
} from '@fabrika/platform-node/sql'
import { z } from 'zod/v4'
import { freeze, hasOwn, isArray, isSafeInteger, OBJECT_PROTOTYPE, ownDescriptor, ownKeys, parseList, prototypeOf } from './builtins'
import { runApplicationStatement, type Session, type SqlParameter } from './database'
import { type QueryRefusal, QueryRefusedError, SqlRowError } from './errors'
import { isPlainIdentifier } from './identifier'
import { dayText } from './temporal'

/** What a site declares: `'read'` runs queries only, `'write'` also `INSERT`, `UPDATE` and `DELETE`. */
export type SqlMode = 'read' | 'write'

/** A value an interpolation binds: a scalar, a `Date` (bound as ISO text), or a list of strings or numbers. */
export type SqlValue = string | number | boolean | bigint | Date | null | readonly (string | number)[]

/** The database a statement is classified for: Postgres in the application's schema, or a Durable Object's SQLite. */
export type SqlDatabase = { readonly dialect: 'postgres'; readonly schema: string } | { readonly dialect: 'sqlite' }

/** One test of a capability's scope on a table: the column holds the value, or one of the list. */
export interface ScopeTest {
	readonly column: string
	readonly value: string | readonly string[]
}

/** A capability's predicate on one table: every row (`'all'`), or an OR of AND groups; no group matches nothing. */
export type ScopeTerms = 'all' | readonly (readonly ScopeTest[])[]

/** What a fragment's table is to its statement, as its author states it: read, or the target of an UPDATE or DELETE. */
export type ScopeUse = 'read' | 'update' | 'delete'

/** The scope of `capability` on `table` for `use`, as the data layer predicates its handles; throws when it does not reach it. */
export type ScopeOf = (capability: unknown, table: string, use: ScopeUse) => ScopeTerms

/** The third argument of `ctx.sql.scope`: the table's alias in the statement, and what the statement does with it. */
export interface SqlScopeOptions {
	/** The table's name in the statement; the table's own name by default. */
	readonly alias?: string
	/** `'update'` or `'delete'` where the statement writes the table, which needs that operation's action; `'read'` by default. */
	readonly use?: ScopeUse
}

/**
 * `ctx.sql.scope(capability, table, { alias, use })`: the capability's whole predicate on one table, as SQL with bound
 * values. A fragment is a frozen object with no prototype; what it holds lives in this module's registry, read through
 * methods captured at load, so no object an application builds or changes is ever taken for one.
 */
export interface SqlScope {
	readonly kind: 'sql-scope'
}

interface ScopeData {
	readonly site: SqlSite
	readonly alias: string
	readonly terms: ScopeTerms
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
	register(scope, freeze({ site: data.site, alias: data.alias, terms: data.terms }))
	return scope
}

/** What `value` holds when it is a fragment this module built; `undefined` for anything else. */
function scopeOf(value: unknown): ScopeData | undefined {
	return typeof value === 'object' && value !== null ? registered(value) : undefined
}

/** `ctx.sql(Row)`: the tag for rows of `Row`, and `scope` for the capability's predicate inside its text. */
export interface SqlTag {
	<S extends z.core.$ZodType>(row: S): (text: TemplateStringsArray, ...values: readonly (SqlValue | SqlScope)[]) => Promise<z.output<S>[]>
	scope(capability: unknown, table: string, options?: SqlScopeOptions): SqlScope
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

const POSTGRES_READS: ReadonlySet<string> = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE'])
const SQLITE_READS: ReadonlySet<string> = new Set(['SELECT', 'WITH', 'VALUES'])
const WRITE_STATEMENTS: ReadonlySet<string> = new Set(['INSERT', 'UPDATE', 'DELETE'])
const WRITE_WORDS: ReadonlySet<string> = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE'])
/** `FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE`, `FOR KEY SHARE`: what follows `FOR` in a locking clause. */
const LOCK_WORDS: ReadonlySet<string> = new Set(['UPDATE', 'NO', 'SHARE', 'KEY'])
/** ctx.sql calls reviewed built-ins only: the functions the migrations declare are not known at runtime. */
const NO_DECLARED_FUNCTIONS: ReadonlySet<string> = new Set()
/** What starts a parameter SQLite binds by name or by position (`?`, `:x`, `@x`, `$x`, `#x`): only the tag writes one. */
const SQLITE_PARAMETER_STARTS: ReadonlySet<string> = new Set(['?', ':', '@', '$', '#'])

function refuse(reason: QueryRefusal, message: string): never {
	throw new QueryRefusedError(reason, `ctx.sql: ${message}`)
}

const isPunct = (token: SqlToken | undefined, char: string): boolean => token?.kind === 'punct' && token.char === char
const isDigit = (token: SqlToken | undefined): boolean => token?.kind === 'punct' && token.char >= '0' && token.char <= '9'

/** The character that opens a placeholder the tag writes: `$1` on Postgres, `?1` on SQLite. */
const markerOf = (database: SqlDatabase): string => (database.dialect === 'postgres' ? '$' : '?')

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

/** The statement's text, each interpolation a placeholder (`$n` or `?n`) between the static parts. */
function statementText(parts: readonly string[], marker: string): string {
	let text = parts[0] ?? ''
	for (let index = 1; index < parts.length; index++) {
		const part = parts[index] ?? ''
		if (/^[0-9]/.test(part)) {
			refuse('sql_template', `a digit right after the value \${…} number ${index} would join its placeholder; put a space between them`)
		}
		text += `${marker}${index}${part}`
	}
	return text
}

/**
 * The tokens of the statement `parts` make, refused unless each placeholder the tag writes is one the lexer sees at
 * code level (not in a literal, a quoted name, a dollar body or a comment) and the text writes none of its own.
 */
function placedTokens(parts: readonly string[], database: SqlDatabase): readonly SqlToken[] {
	const marker = markerOf(database)
	const written = database.dialect === 'postgres' ? /\$[0-9]/ : /\?[0-9]/
	for (const part of parts) {
		if (written.test(part)) {
			refuse(
				'sql_template',
				`the text holds ${marker} and a digit, which reads as a positional parameter; interpolate the value with \${…}, a literal one too`,
			)
		}
	}
	const { tokens, unterminated } = database.dialect === 'postgres' ? lexSql(statementText(parts, marker)) : lexSqlite(statementText(parts, marker))
	if (unterminated !== undefined) {
		refuse('sql_template', `a string, quoted name, dollar-quoted body or comment at line ${unterminated} never closes`)
	}
	let placed = 0
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]
		if (isPunct(token, marker) && isDigit(tokens[index + 1])) {
			placed++
		} else if (database.dialect === 'sqlite' && token?.kind === 'punct' && SQLITE_PARAMETER_STARTS.has(token.char)) {
			refuse(
				'sql_template',
				`${token.char} at line ${token.line} starts a parameter the text writes, which nothing binds; interpolate the value with \${…}`,
			)
		}
	}
	if (placed !== parts.length - 1) {
		refuse(
			'sql_template',
			'a value ${…} inside a string literal, a quoted name, a dollar-quoted body or a comment is not bound; interpolate a whole value',
		)
	}
	return tokens
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
 * The first name, quoted name or string literal SQLite could read as a framework (`fabrika_*`) or catalog (`sqlite_*`)
 * object. SQLite folds names case-insensitively, quoted ones too, and takes a string where only a name may stand
 * (`FROM 'fabrika_x'`), so every form counts.
 */
function sqliteNameRefusal(tokens: readonly SqlToken[]): { readonly name: string; readonly line: number; readonly catalog: boolean } | undefined {
	for (const token of tokens) {
		const text = token.kind === 'word' || token.kind === 'quoted' || token.kind === 'string' ? token.text : undefined
		const name = text?.toLowerCase()
		if (name === undefined) continue
		if (name.startsWith('fabrika_')) return { name: text ?? name, line: token.line, catalog: false }
		if (name.startsWith('sqlite_')) return { name: text ?? name, line: token.line, catalog: true }
	}
	return undefined
}

/**
 * The SQL `parts` make, with a bound placeholder for each value, or a `QueryRefusedError` that names what is refused.
 * On both dialects: more than one statement, any statement but a query (and `INSERT`/`UPDATE`/`DELETE` for
 * `'write'`), a `'read'` statement that writes or locks, a value placed where it would not be bound, and a `fabrika_*`
 * name. On Postgres also a nested statement of another kind, `SELECT … INTO`, a `U&` name, a `pg_*` name, a qualified
 * name outside `schema` and a function outside the reviewed built-ins; on SQLite also a `sqlite_*` name, and a
 * parameter the text writes itself. workerd's authorizer bounds SQLite's functions, PRAGMAs and DDL.
 */
export function classifySql(parts: readonly string[], mode: SqlMode, database: SqlDatabase): string {
	const all = placedTokens(parts, database)
	const statements = statementsOf(all)
	const [statement] = statements
	if (statement === undefined) {
		refuse('sql_statement', 'the template holds no statement')
	}
	if (statements.length > 1) {
		refuse('sql_statement', `it runs one statement, and the template holds ${statements.length}; call ctx.sql once for each`)
	}
	const tokens = statement.tokens
	const first = upperWord(tokens[0]) ?? ''
	const reads = database.dialect === 'postgres' ? POSTGRES_READS : SQLITE_READS
	if (!reads.has(first) && !WRITE_STATEMENTS.has(first)) {
		refuse(
			'sql_statement',
			`${statementKind(tokens)} is refused; it runs ${
				database.dialect === 'postgres' ? 'SELECT, WITH, VALUES or TABLE' : 'SELECT, WITH or VALUES'
			}, and INSERT, UPDATE or DELETE on a site that declares sql: 'write'`,
		)
	}
	const writes = mode === 'read' ? (WRITE_STATEMENTS.has(first) ? `${first} at line ${statement.line}` : readRefusal(tokens)) : undefined
	if (writes !== undefined) {
		refuse('sql_read_only', `sql: 'read' runs queries only, and the statement holds ${writes}; declare sql: 'write' on a mutation, a job or a webhook`)
	}
	const framework = frameworkReference(tokens)
	if (framework !== undefined) {
		refuse('sql_name', `'${framework.name}' at line ${framework.line} is the framework's; ctx.sql reaches only the application's own tables`)
	}
	if (database.dialect === 'sqlite') {
		const name = sqliteNameRefusal(tokens)
		if (name !== undefined) {
			refuse(
				'sql_name',
				`'${name.name}' at line ${name.line} ${
					name.catalog ? "is SQLite's catalog" : "is the framework's"
				}; ctx.sql reaches only the application's own tables`,
			)
		}
		return statementText(parts, markerOf(database))
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
	for (const reference of nameReferences(tokens)) {
		if (reference.role !== 'call' && reference.name.startsWith('pg_')) {
			refuse('sql_name', `'${reference.name}' at line ${reference.line} is a catalog name; ctx.sql reaches only the application's own tables`)
		}
	}
	const foreign = dmlForeignSchema(tokens, database.schema)
	if (foreign !== undefined) {
		refuse('sql_name', `the schema '${foreign}' is outside the application's; write its tables' names unqualified`)
	}
	const call = refusedFunctionCall(tokens, database.schema, NO_DECLARED_FUNCTIONS)
	if (call !== undefined) {
		refuse(
			'sql_function',
			`${call.qualifier === undefined ? '' : `${call.qualifier}.`}${call.name}(…) at line ${call.line} is not a reviewed built-in function`,
		)
	}
	return statementText(parts, markerOf(database))
}

function arrayElement(item: unknown): string | number {
	if (typeof item === 'string') {
		return item
	}
	if (typeof item === 'number' && Number.isFinite(item)) {
		return item
	}
	return refuse('invalid_value', 'a list value holds only strings and finite numbers')
}

/** A Postgres array literal's element: a string quoted, its `"` and `\` escaped. */
function postgresElement(item: string | number): string {
	return typeof item === 'string' ? `"${item.replace(/["\\]/g, (char) => `\\${char}`)}"` : String(item)
}

/**
 * A value as the driver binds it. Unprepared, `Bun.SQL` mis-binds a JS array and sends a `Date` as `Date#toString()`,
 * so a list is a Postgres array literal; SQLite binds no boolean and no bigint, and reads a list as JSON
 * (`json_each`).
 */
function parameterOf(value: unknown, position: number, database: SqlDatabase): SqlParameter {
	if (value === null || typeof value === 'string') {
		return value
	}
	if (typeof value === 'boolean') {
		return database.dialect === 'sqlite' ? (value ? 1 : 0) : value
	}
	if (typeof value === 'bigint') {
		if (database.dialect === 'postgres') return value
		const integer = Number(value)
		return isSafeInteger(integer) ? integer : refuse('invalid_value', `the value \${…} number ${position} is a bigint outside the safe integer range`)
	}
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : refuse('invalid_value', `the value \${…} number ${position} is not a finite number`)
	}
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? refuse('invalid_value', `the value \${…} number ${position} is an invalid Date`) : value.toISOString()
	}
	const items = parseList(value, arrayElement)
	if (items !== undefined) {
		return database.dialect === 'sqlite' ? JSON.stringify(items) : `{${items.map(postgresElement).join(',')}}`
	}
	return refuse(
		'invalid_value',
		`the value \${…} number ${position} is ${
			value === undefined ? 'undefined' : 'an object'
		}; bind a string, number, boolean, bigint, Date, null or a plain list (JSON as JSON.stringify(v))`,
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

/**
 * The predicate `terms` make over `alias`'s columns: static parts around one bound value per test. A list is
 * `= any($n)` on Postgres and `in (select value from json_each(?n))` on SQLite, one parameter either way.
 */
function scopeFragment(
	terms: ScopeTerms,
	alias: string,
	database: SqlDatabase,
): { readonly parts: readonly string[]; readonly values: readonly SqlValue[] } {
	if (terms === 'all') return { parts: ['(true)'], values: [] }
	if (terms.length === 0) return { parts: ['(false)'], values: [] }
	const [listOpen, listClose] = database.dialect === 'postgres' ? [' = any(', ')'] : [' in (select value from json_each(', '))']
	const parts: string[] = []
	const values: SqlValue[] = []
	let text = '('
	// Index loops, never a method of the terms or of Array.prototype: this is the scope of the statement.
	for (let groupIndex = 0; groupIndex < terms.length; groupIndex++) {
		const group = terms[groupIndex] ?? []
		text += `${groupIndex === 0 ? '' : ' or '}(`
		for (let testIndex = 0; testIndex < group.length; testIndex++) {
			const test = group[testIndex]
			if (test === undefined) continue
			const single = typeof test.value === 'string'
			text += `${testIndex === 0 ? '' : ' and '}${alias}.${test.column}${single ? ' = ' : listOpen}`
			parts[parts.length] = text
			values[values.length] = test.value
			text = single ? '' : listClose
		}
		text += ')'
	}
	parts[parts.length] = `${text})`
	return { parts, values }
}

/**
 * The template with every scope spliced in as text around its own values, and the values a parameter each. Before
 * anything is spliced, each interpolation must stand where a value binds (not in a literal, a quoted name, a dollar
 * body or a comment), fragments with no value included, and each fragment must be this site's.
 */
function expandScopes(
	site: SqlSite,
	parts: readonly string[],
	values: readonly unknown[],
	database: SqlDatabase,
): { parts: string[]; values: unknown[] } {
	placedTokens(parts, database)
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
		const rendered = scopeFragment(fragment.terms, fragment.alias, database)
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

const SCOPE_FORM =
	"ctx.sql.scope(capability, table, { alias?, use? }) takes an alias of lowercase letters, digits and _ and use 'read', 'update' or 'delete'"

/** The options of `ctx.sql.scope`, read from a plain object's own data properties; anything else is refused. */
function scopeOptions(options: unknown): { readonly alias: string | undefined; readonly use: ScopeUse } {
	if (options === undefined) {
		return { alias: undefined, use: 'read' }
	}
	if (typeof options === 'string') {
		refuse('invalid_argument', `ctx.sql.scope takes its alias as an option: write ctx.sql.scope(capability, table, { alias: '${options}' })`)
	}
	if (
		typeof options !== 'object' || options === null || isArray(options) || (prototypeOf(options) !== OBJECT_PROTOTYPE && prototypeOf(options) !== null)
	) {
		refuse('invalid_argument', SCOPE_FORM)
	}
	let alias: string | undefined
	let use: ScopeUse = 'read'
	for (const key of ownKeys(options)) {
		const descriptor = ownDescriptor(options, key)
		const value: unknown = descriptor !== undefined && hasOwn(descriptor, 'value') ? descriptor.value : refuse('invalid_argument', SCOPE_FORM)
		if (key === 'alias' && typeof value === 'string') alias = value
		else if (key === 'use' && (value === 'read' || value === 'update' || value === 'delete')) use = value
		else if (value !== undefined) refuse('invalid_argument', SCOPE_FORM)
	}
	return { alias, use }
}

/**
 * `ctx.sql` of one site. Every call first checks that the work running now is the site's invocation, then classifies
 * the text, then binds the values; only then does it reach the session, so a refused statement sends nothing.
 */
export function sqlTag(site: SqlSite, database: SqlDatabase, termsOf: ScopeOf): SqlTag {
	const tag = <S extends z.core.$ZodType>(row: S) => {
		site.check()
		if (!(row instanceof z.core.$ZodType)) {
			site.fail()
			refuse('invalid_argument', 'ctx.sql(Row) takes the zod schema of one row')
		}
		return async (text: TemplateStringsArray, ...values: readonly (SqlValue | SqlScope)[]): Promise<z.output<S>[]> => {
			site.check()
			return failing(site, async () => {
				const expanded = expandScopes(site, templateParts(text), values, database)
				const statement = classifySql(expanded.parts, site.mode, database)
				const parameters = expanded.values.map((value, index) => parameterOf(value, index + 1, database))
				const session = await site.session()
				if (session.readOnly && site.mode === 'write') {
					refuse('read_only', 'this invocation is read-only')
				}
				const rows = await runApplicationStatement(session, statement, parameters, site.mode)
				return rows.map((value, index) => parseRow(row, value, index))
			})
		}
	}
	const scope = (capability: unknown, table: string, options?: SqlScopeOptions): SqlScope => {
		site.check()
		try {
			const { alias, use } = scopeOptions(options)
			const name = alias ?? table
			if (!isPlainIdentifier(table) || !isPlainIdentifier(name)) {
				refuse('invalid_argument', SCOPE_FORM)
			}
			if (use !== 'read' && site.mode !== 'write') {
				refuse('sql_read_only', `sql: 'read' runs queries only, and ctx.sql.scope(…, { use: '${use}' }) is the target of a write; declare sql: 'write'`)
			}
			return newScope({ site, alias: name, terms: termsOf(capability, table, use) })
		} catch (error) {
			site.fail()
			throw error
		}
	}
	return Object.freeze(Object.assign(tag, { scope }))
}
