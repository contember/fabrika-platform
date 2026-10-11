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
import { hasOwn, isArray, ownDescriptor, ownKeys, parseList } from './builtins'
import { runApplicationStatement, type Session, type SqlParameter } from './database'
import { QueryRefusedError, SqlRowError } from './errors'

/** What a site declares: `'read'` runs queries only, `'write'` also `INSERT`, `UPDATE` and `DELETE`. */
export type SqlMode = 'read' | 'write'

/** A value an interpolation binds: a scalar, a `Date` (bound as ISO text), or a list of strings or numbers (an array). */
export type SqlValue = string | number | boolean | bigint | Date | null | readonly (string | number)[]

/** `ctx.sql(Row)`: the tag for rows of `Row`. */
export type SqlTag = <S extends z.core.$ZodType>(row: S) => (text: TemplateStringsArray, ...values: readonly SqlValue[]) => Promise<z.output<S>[]>

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

function refuse(message: string): never {
	throw new QueryRefusedError(`ctx.sql: ${message}`)
}

const isPunct = (token: SqlToken | undefined, char: string): boolean => token?.kind === 'punct' && token.char === char
const isDigit = (token: SqlToken | undefined): boolean => token?.kind === 'punct' && token.char >= '0' && token.char <= '9'

/** The template's static parts. A call with a plain array, or a text with an invalid escape, is refused. */
function templateParts(text: unknown): readonly string[] {
	const raw: unknown = isArray(text) && hasOwn(text, 'raw') ? ownDescriptor(text, 'raw')?.value : undefined
	if (!isArray(text) || !Object.isFrozen(text) || !isArray(raw) || !Object.isFrozen(raw) || raw.length !== text.length) {
		refuse('it is a tagged template: write ctx.sql(Row)`select …`, never call it with a string or an array')
	}
	const parts: string[] = []
	for (let index = 0; index < text.length; index++) {
		const part: unknown = text[index]
		if (typeof part !== 'string') {
			refuse('the template has an invalid escape sequence')
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
			refuse(`a digit right after the value \${…} number ${index} would join its placeholder; put a space between them`)
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
			refuse('the text holds $ and a digit, which reads as a positional parameter; interpolate the value with ${…}, a literal one too')
		}
	}
	const text = statementText(parts)
	const { tokens: all, unterminated } = lexSql(text)
	if (unterminated !== undefined) {
		refuse(`a string, quoted name, dollar-quoted body or comment at line ${unterminated} never closes`)
	}
	if (placeholderCount(all) !== parts.length - 1) {
		refuse('a value ${…} inside a string literal, a quoted name, a dollar-quoted body or a comment is not bound; interpolate a whole value')
	}
	const statements = topLevelStatements(text)
	const [statement] = statements
	if (statement === undefined) {
		refuse('the template holds no statement')
	}
	if (statements.length > 1) {
		refuse(`it runs one statement, and the template holds ${statements.length}; call ctx.sql once for each`)
	}
	const tokens = statement.tokens
	const first = upperWord(tokens[0]) ?? ''
	if (!READ_STATEMENTS.has(first) && !WRITE_STATEMENTS.has(first)) {
		refuse(`${statementKind(tokens)} is refused; it runs ${ALLOWED_STATEMENTS}`)
	}
	const writes = mode === 'read' ? (WRITE_STATEMENTS.has(first) ? `${first} at line ${statement.line}` : readRefusal(tokens)) : undefined
	if (writes !== undefined) {
		refuse(`sql: 'read' runs queries only, and the statement holds ${writes}; declare sql: 'write' on a mutation, a job or a webhook`)
	}
	const nested = nestedStatement(tokens) ?? parenthesizedTarget(tokens)
	if (nested !== undefined) {
		refuse(`${nested.statement} at line ${nested.line} is refused inside another statement`)
	}
	const into = selectInto(tokens)
	if (into !== undefined) {
		refuse(`SELECT … INTO at line ${into.line} creates a table; select the rows and insert them with INSERT INTO … SELECT`)
	}
	if (unicodeIdentifier(tokens) !== undefined) {
		refuse('a U&"…" name is refused: write the name plainly')
	}
	const framework = frameworkReference(tokens)
	if (framework !== undefined) {
		refuse(`'${framework.name}' at line ${framework.line} is the framework's; ctx.sql reaches only the application's own tables`)
	}
	for (const reference of nameReferences(tokens)) {
		if (reference.role !== 'call' && reference.name.startsWith('pg_')) {
			refuse(`'${reference.name}' at line ${reference.line} is a catalog name; ctx.sql reaches only the application's own tables`)
		}
	}
	const foreign = dmlForeignSchema(tokens, schema)
	if (foreign !== undefined) {
		refuse(`the schema '${foreign}' is outside the application's; write its tables' names unqualified`)
	}
	const call = refusedFunctionCall(tokens, schema, NO_DECLARED_FUNCTIONS)
	if (call !== undefined) {
		refuse(`${call.qualifier === undefined ? '' : `${call.qualifier}.`}${call.name}(…) at line ${call.line} is not a reviewed built-in function`)
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
	return refuse('a list value holds only strings and finite numbers')
}

/** A value as the driver binds it. Unprepared, `Bun.SQL` mis-binds a JS array and sends a `Date` as `Date#toString()`. */
function parameterOf(value: unknown, position: number): SqlParameter {
	if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'bigint') {
		return value
	}
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : refuse(`the value \${…} number ${position} is not a finite number`)
	}
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? refuse(`the value \${…} number ${position} is an invalid Date`) : value.toISOString()
	}
	const items = parseList(value, arrayElement)
	if (items !== undefined) {
		return `{${items.join(',')}}`
	}
	return refuse(
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

/** One row as `row` parses it: snake_case columns as camelCase fields, a `Date` as ISO text. No value reaches a message. */
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
		Object.defineProperty(fields, field, { value: cell instanceof Date ? cell.toISOString() : cell, enumerable: true })
	}
	const parsed = z.safeParse(row, fields)
	if (parsed.success) {
		return parsed.data
	}
	throw new SqlRowError(rowIssue(row, parsed.error.issues[0], fields, columnOf, index))
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

/**
 * `ctx.sql` of one site. Every call first checks that the work running now is the site's invocation, then classifies
 * the text, then binds the values; only then does it reach the session, so a refused statement sends nothing.
 */
export function sqlTag(site: SqlSite, schema: string | undefined): SqlTag {
	return <S extends z.core.$ZodType>(row: S) => {
		site.check()
		if (!(row instanceof z.core.$ZodType)) {
			site.fail()
			refuse('ctx.sql(Row) takes the zod schema of one row')
		}
		return async (text: TemplateStringsArray, ...values: readonly SqlValue[]): Promise<z.output<S>[]> => {
			site.check()
			return failing(site, async () => {
				const statement = classifySql(templateParts(text), site.mode, schema ?? '')
				const parameters = values.map((value, index) => parameterOf(value, index + 1))
				const session = await site.session()
				if (session.readOnly && site.mode === 'write') {
					refuse('this invocation is read-only')
				}
				const rows = await runApplicationStatement(session, statement, parameters)
				return rows.map((value, index) => parseRow(row, value, index))
			})
		}
	}
}
