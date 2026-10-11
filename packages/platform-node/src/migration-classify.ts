// What an application migration may hold (ADR-0017): every statement is paved, a deviation the approver reviews,
// or refused. A refusal is an escape from the schema, the transaction or the platform, or a form the classifier
// does not recognise: an allowlist at every level, so a form a later Postgres adds is refused, not executed.
// Runtime-neutral: Control classifies a commit's migrations in a Worker, the runner before it applies them.

import { lexSql, type SqlToken, topLevelStatements, upperWord } from './migration-sql'
import { PG_CATALOG_FUNCTIONS, SQL_KEYWORDS } from './pg-catalog-names'
import { routineSignature } from './routine-signature'
import {
	afterName,
	closingParenthesis,
	ddlForeignSchema,
	dmlForeignSchema,
	frameworkReference,
	functionUse,
	isName,
	isPunct,
	nameReferences,
	nameText,
	nestedStatement,
	objectNameAt,
	refusedFunctionCall,
	skipWords,
	splitAtCommas,
	statementKind,
	unicodeIdentifier,
	wordAtDepthZero,
} from './sql-names'

/**
 * A database object a migration declares, named as the catalog check names it (`trigger deals.audit`). A `serial
 * column` is the column whose sequence the catalog check admits.
 */
export type DatabaseObjectKind =
	| 'function'
	| 'procedure'
	| 'trigger'
	| 'view'
	| 'materialized view'
	| 'rule'
	| 'policy'
	| 'sequence'
	| 'serial column'

export interface DatabaseObject {
	readonly kind: DatabaseObjectKind
	/** `<name>`; `<name>(<typname>,…)` for a routine; `<table>.<name>` for a trigger, a rule, a policy and a serial column. */
	readonly name: string
}

type RoutineKind = 'function' | 'procedure'

/** Database code and unusual expressions: allowed, and shown to the approver as needing closer review. */
export type DeviationKind =
	| 'function'
	| 'procedure'
	| 'trigger'
	| 'view'
	| 'materialized view'
	| 'rule'
	| 'policy'
	| 'sequence'
	| 'do'
	| 'expression'

/** One deviation. Its approval key is `kind` + `object`: a line moves when the file is edited, the key does not. */
export interface MigrationDeviation {
	readonly kind: DeviationKind
	/**
	 * The object's name; `<table>.<column>` for a serial column's sequence; `block <n>` for the n-th `DO` of the file;
	 * `<where> calls <function>` for an expression, where `<where>` is a column, a constraint, a table or an index.
	 */
	readonly object: string
	readonly file: string
	readonly line: number
}

export interface MigrationRefusal {
	/** What is refused, phrased to precede "is not allowed". */
	readonly reason: string
	readonly file: string
	readonly line: number
}

/** How one statement changes the set of declared objects, in file order. */
export type ManifestChange =
	| { readonly change: 'create'; readonly object: DatabaseObject }
	| { readonly change: 'drop'; readonly object: DatabaseObject }
	| { readonly change: 'drop table'; readonly table: string }
	| { readonly change: 'rename table'; readonly from: string; readonly to: string }
	| { readonly change: 'rename'; readonly from: DatabaseObject; readonly to: DatabaseObject }
	| { readonly change: 'drop routines'; readonly kind: RoutineKind; readonly name: string }
	| { readonly change: 'rename routines'; readonly kind: RoutineKind; readonly from: string; readonly to: string }
	| { readonly change: 'rename column'; readonly table: string; readonly from: string; readonly to: string }

export interface MigrationClassification {
	readonly file: string
	/** One per refused statement, in order. A file with a refusal does not run. */
	readonly refused: readonly MigrationRefusal[]
	readonly deviations: readonly MigrationDeviation[]
	/** The objects the file creates. */
	readonly objects: readonly DatabaseObject[]
	readonly changes: readonly ManifestChange[]
}

export interface ClassifyMigrationOptions {
	readonly file: string
	/** The functions and procedures the whole migration set declares in the schema: a body or an expression may call them. */
	readonly functions?: ReadonlySet<string>
	/** The framework's own bundle, which alone may name the framework's `fabrika_*` tables. */
	readonly framework?: boolean
}

export interface MigrationFile {
	readonly name: string
	readonly sql: string
	readonly framework?: boolean
}

export interface MigrationSetClassification {
	readonly files: readonly MigrationClassification[]
	/** The manifest: every object the files declare and do not drop, in order. The catalog check admits exactly these. */
	readonly objects: readonly DatabaseObject[]
}

const LANGUAGES: ReadonlySet<string> = new Set(['sql', 'plpgsql'])
const SERIAL_TYPES: ReadonlySet<string> = new Set(['serial', 'serial2', 'serial4', 'serial8', 'smallserial', 'bigserial'])
const TABLE_CONSTRAINTS: ReadonlySet<string> = new Set(['CONSTRAINT', 'CHECK', 'UNIQUE', 'PRIMARY', 'FOREIGN', 'EXCLUDE', 'LIKE'])
const FILE_TABLE_PREFIX = 'fabrika_files_'

/** What an application migration may drop: its own tables, indexes and types, and its database code. */
const DROPPABLE: ReadonlySet<string> = new Set([
	'TABLE',
	'INDEX',
	'TYPE',
	'TRIGGER',
	'FUNCTION',
	'PROCEDURE',
	'ROUTINE',
	'AGGREGATE',
	'RULE',
	'VIEW',
	'MATERIALIZED',
	'POLICY',
	'SEQUENCE',
	'DOMAIN',
	'OPERATOR',
	'STATISTICS',
	'EXTENSION',
])

/** The `ALTER [COLUMN] <name>` actions a migration may take. */
const COLUMN_ACTIONS: readonly (readonly string[])[] = [
	['TYPE'],
	['SET', 'DATA'],
	['SET', 'DEFAULT'],
	['DROP', 'DEFAULT'],
	['SET', 'NOT'],
	['DROP', 'NOT'],
	['ADD', 'GENERATED'],
	['SET', 'GENERATED'],
	['DROP', 'IDENTITY'],
	['RESTART'],
]

/** Statements a function or `DO` body may begin with, PL/pgSQL control flow included; an assignment also may. */
const BODY_STATEMENTS: ReadonlySet<string> = new Set([
	'SELECT',
	'INSERT',
	'UPDATE',
	'DELETE',
	'WITH',
	'VALUES',
	'PERFORM',
	'RETURN',
	'RAISE',
	'IF',
	'ELSIF',
	'ELSEIF',
	'ELSE',
	'END',
	'BEGIN',
	'DECLARE',
	'LOOP',
	'WHILE',
	'FOR',
	'FOREACH',
	'EXIT',
	'CONTINUE',
	'CASE',
	'WHEN',
	'GET',
	'ASSERT',
	'NULL',
	'OPEN',
	'FETCH',
	'MOVE',
	'CLOSE',
	'CALL',
	'EXCEPTION',
])

/** The first rows a rule's action may begin with. */
const RULE_ACTIONS: ReadonlySet<string> = new Set(['NOTHING', 'SELECT', 'INSERT', 'UPDATE', 'DELETE'])

interface Context {
	readonly schema: string
	readonly functions: ReadonlySet<string>
	readonly framework: boolean
	doBlocks: number
}

/** Thrown inside one statement's classification; the statement then contributes only its refusal. */
class Refused extends Error {
	constructor(readonly reason: string, readonly line: number) {
		super(reason)
	}
}

/** What one statement adds when it is not refused. */
interface Collected {
	readonly deviations: { readonly kind: DeviationKind; readonly object: string; readonly line: number }[]
	readonly changes: ManifestChange[]
}

function deviate(out: Collected, kind: DeviationKind, object: string, line: number): void {
	out.deviations.push({ kind, object, line })
}

function declareObject(out: Collected, kind: DeviationKind & DatabaseObjectKind, name: string, line: number): void {
	deviate(out, kind, name, line)
	out.changes.push({ change: 'create', object: { kind, name } })
}

/** The name at `index` in the schema: unqualified or qualified with `schema`, else refused. */
function ownName(tokens: readonly SqlToken[], index: number, context: Context, label: string): string {
	const object = objectNameAt(tokens, index)
	const line = tokens[index]?.line ?? tokens[0]?.line ?? 1
	if (object === undefined) throw new Refused(label, line)
	if (object.qualifier !== undefined && object.qualifier !== context.schema) throw new Refused(`${label} naming the schema ${object.qualifier}`, line)
	return object.name
}

function refuseForeignDdl(tokens: readonly SqlToken[], context: Context, label: string): void {
	const reached = ddlForeignSchema(tokens, context.schema)
	if (reached !== undefined) throw new Refused(`${label} naming the schema ${reached}`, tokens[0]?.line ?? 1)
}

/** A query, a condition or a backfill: no schema but the application's, only allowlisted calls and nested statements. */
function checkQuery(tokens: readonly SqlToken[], context: Context, label: string): void {
	const nested = nestedStatement(tokens)
	if (nested !== undefined) throw new Refused(`${nested.statement} nested in a statement`, nested.line)
	const reached = dmlForeignSchema(tokens, context.schema)
	if (reached !== undefined) throw new Refused(`${label} reaching the schema ${reached}`, tokens[0]?.line ?? 1)
	const call = refusedFunctionCall(tokens, context.schema, context.functions)
	if (call !== undefined) throw new Refused(`a call of ${call.name}`, call.line)
}

/** A stored expression's calls: a paved built-in is plain, a reviewed or declared function a deviation, anything else refused. */
function checkExpression(tokens: readonly SqlToken[], where: string, context: Context, out: Collected): void {
	for (const reference of nameReferences(tokens)) {
		if (reference.role !== 'call') continue
		const use = functionUse(reference, context.schema, context.functions)
		if (use === undefined) throw new Refused(`a call of ${reference.name}`, reference.line)
		if (use !== 'paved') deviate(out, 'expression', `${where} calls ${reference.name}`, reference.line)
	}
}

/** Whether the name at `index` (dotted, subscripted) is the target of a PL/pgSQL assignment. */
function isAssignment(tokens: readonly SqlToken[], index: number): boolean {
	let at = index + 1
	while (isPunct(tokens[at], '.') && isName(tokens[at + 1])) at += 2
	while (isPunct(tokens[at], '[')) {
		let depth = 0
		for (; at < tokens.length; at++) {
			if (isPunct(tokens[at], '[')) depth++
			else if (isPunct(tokens[at], ']') && --depth === 0) break
		}
		at++
	}
	return (isPunct(tokens[at], ':') && isPunct(tokens[at + 1], '=')) || isPunct(tokens[at], '=')
}

/**
 * The first statement of a function or `DO` body that does not begin with an allowlisted word or an assignment. A
 * declaration section (`DECLARE` … `BEGIN`) holds declarations; `THEN` and `ELSE` begin a statement except inside a
 * `CASE` expression.
 */
function refusedBodyStatement(tokens: readonly SqlToken[]): { readonly statement: string; readonly line: number } | undefined {
	let start = true
	let declaring = false
	const cases: ('statement' | 'expression')[] = []
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]
		const word = upperWord(token)
		if (start) {
			if (isPunct(token, ';')) continue
			start = false
			if (isPunct(token, '<') && isPunct(tokens[index + 1], '<')) {
				while (index < tokens.length && !(isPunct(tokens[index], '>') && isPunct(tokens[index + 1], '>'))) index++
				index++
				start = true
				continue
			}
			const allowed = (declaring && word !== 'BEGIN') || (word !== undefined && BODY_STATEMENTS.has(word))
				|| (isName(token) && isAssignment(tokens, index))
			if (!allowed) return { statement: word ?? statementKind(tokens.slice(index)), line: token?.line ?? 1 }
			if (word === 'CASE') {
				cases.push('statement')
				continue
			}
		} else if (word === 'CASE') {
			cases.push('expression')
			continue
		}
		const innermost = cases[cases.length - 1]
		if (word === 'DECLARE') declaring = true
		if (word === 'BEGIN') declaring = false
		if (isPunct(token, ';') || word === 'BEGIN' || word === 'DECLARE') start = true
		else if (word === 'LOOP') start = upperWord(tokens[index - 1]) !== 'END'
		else if (word === 'THEN' || word === 'ELSE') start = innermost !== 'expression'
		else if (word === 'END' && innermost === 'expression') cases.pop()
		else if (word === 'END' && upperWord(tokens[index + 1]) === 'CASE') {
			cases.pop()
			index++
		}
	}
	return undefined
}

/** The tokens of a literal body, on the lines of the file, or `undefined` when the classifier cannot read it. */
function literalBody(token: SqlToken | undefined): SqlToken[] | undefined {
	let text: string | undefined
	if (token?.kind === 'dollar') text = token.body
	else if (token?.kind === 'string') text = token.text
	if (text === undefined || token === undefined) return undefined
	const { tokens, unterminated } = lexSql(text)
	if (unterminated !== undefined) return undefined
	const offset = token.line - 1
	return tokens.map((inner) => ({ ...inner, line: inner.line + offset }))
}

/**
 * A function or `DO` body: no Unicode-escaped name, no framework table, no dynamic `EXECUTE`, only allowlisted
 * statements, no schema but the application's, and only allowlisted calls. A literal inside a body stays data: no
 * statement a body may hold runs a string as SQL.
 */
function checkBody(tokens: readonly SqlToken[], context: Context): void {
	const unicode = unicodeIdentifier(tokens)
	if (unicode !== undefined) throw new Refused('a Unicode-escaped identifier (U&"…")', unicode.line)
	const framework = context.framework ? undefined : frameworkReference(tokens)
	if (framework !== undefined) throw new Refused(`a reference to the framework's ${framework.name}`, framework.line)
	const execute = tokens.find((token) => upperWord(token) === 'EXECUTE')
	if (execute !== undefined) throw new Refused('a dynamic EXECUTE in a body', execute.line)
	const statement = refusedBodyStatement(tokens)
	if (statement !== undefined) throw new Refused(`${statement.statement} in a body`, statement.line)
	checkQuery(tokens, context, 'a body')
}

function checkLanguage(language: string | undefined, line: number): void {
	if (language === undefined) throw new Refused('a body without LANGUAGE', line)
	if (!LANGUAGES.has(language)) throw new Refused(`LANGUAGE ${language}`, line)
}

/** `CREATE [OR REPLACE] FUNCTION|PROCEDURE name (args) … AS <body> | RETURN <expression>`. */
function createFunction(tokens: readonly SqlToken[], at: number, kind: 'function' | 'procedure', context: Context, out: Collected): void {
	const label = `CREATE ${kind.toUpperCase()}`
	const line = tokens[0]?.line ?? 1
	const name = ownName(tokens, at, context, label)
	const named = afterName(tokens, at)
	const close = named === undefined || !isPunct(tokens[named], '(') ? undefined : closingParenthesis(tokens, named)
	if (named === undefined || close === undefined) throw new Refused(`${label} without an argument list`, line)
	refuseShadowing(name, kind, line)
	const header: SqlToken[] = [...tokens.slice(0, close + 1)]
	let language: string | undefined
	let body: SqlToken[] | undefined
	for (let index = close + 1; index < tokens.length; index++) {
		const token = tokens[index]
		const word = upperWord(token)
		if (isPunct(token, '(')) {
			const end = closingParenthesis(tokens, index) ?? tokens.length - 1
			header.push(...tokens.slice(index, end + 1))
			index = end
			continue
		}
		if (word === 'SECURITY' && upperWord(tokens[index + 1]) === 'DEFINER') throw new Refused('SECURITY DEFINER', token?.line ?? line)
		if (word === 'SET') throw new Refused(`a SET clause on a ${kind}`, token?.line ?? line)
		if (word === 'SUPPORT' || word === 'TRANSFORM') throw new Refused(`${word} on a ${kind}`, token?.line ?? line)
		if (word === 'BEGIN') throw new Refused('BEGIN ATOMIC; write the body dollar-quoted', token?.line ?? line)
		if (word === 'LANGUAGE') {
			language = nameText(tokens[index + 1])
			if (language === undefined) throw new Refused('a LANGUAGE written as a string', token?.line ?? line)
			checkLanguage(language, token?.line ?? line)
			index++
			continue
		}
		if (word === 'AS') {
			const next = tokens[index + 2]
			body = literalBody(tokens[index + 1])
			if (body === undefined || isPunct(next, ',') || next?.kind === 'string') {
				throw new Refused(`a ${kind} body the classifier cannot read; write it dollar-quoted`, token?.line ?? line)
			}
			index++
			continue
		}
		if (word === 'RETURN') {
			body = tokens.slice(index)
			language ??= 'sql'
			break
		}
		if (token !== undefined) header.push(token)
	}
	if (body === undefined) throw new Refused(`a ${kind} without a body`, line)
	checkLanguage(language, line)
	refuseForeignDdl(header, context, label)
	// An argument default runs at every call that omits the argument, so it is a query like the body.
	const args = tokens.slice(named + 1, close)
	checkQuery(args, context, 'an argument default')
	const signature = routineSignature(args, context.schema)
	if (signature === undefined) throw new Refused(`a ${kind} argument type the classifier cannot name; write the type itself`, line)
	checkBody(body, context)
	declareObject(out, kind, `${name}(${signature})`, line)
}

/**
 * A routine may not take the name of a `pg_catalog` function or of a keyword: Postgres resolves a call across every
 * schema on the path by argument types, so declaring `query_to_xml()` would admit a call of the built-in.
 */
const shadows = (name: string): boolean => PG_CATALOG_FUNCTIONS.has(name) || SQL_KEYWORDS.has(name.toLowerCase())

function refuseShadowing(name: string, kind: RoutineKind, line: number): void {
	if (shadows(name)) {
		throw new Refused(`a ${kind} named ${name}, which a pg_catalog function or a keyword already names`, line)
	}
}

/** `CREATE [OR REPLACE] [CONSTRAINT] TRIGGER name … ON table … [WHEN (…)] EXECUTE FUNCTION fn(…)`. */
function createTrigger(tokens: readonly SqlToken[], at: number, context: Context, out: Collected): void {
	const line = tokens[0]?.line ?? 1
	const name = nameText(tokens[at])
	const on = wordAtDepthZero(tokens, 'ON', at + 1)
	if (name === undefined || on === undefined) throw new Refused('CREATE TRIGGER', line)
	const table = ownName(tokens, on + 1, context, 'CREATE TRIGGER')
	const when = wordAtDepthZero(tokens, 'WHEN', on)
	const whenClose = when === undefined || !isPunct(tokens[when + 1], '(') ? undefined : closingParenthesis(tokens, when + 1)
	const header = when === undefined || whenClose === undefined ? tokens : [...tokens.slice(0, when), ...tokens.slice(whenClose + 1)]
	refuseForeignDdl(header, context, 'CREATE TRIGGER')
	if (when !== undefined && whenClose !== undefined) checkQuery(tokens.slice(when + 2, whenClose), context, 'a trigger condition')
	const execute = wordAtDepthZero(tokens, 'EXECUTE', on)
	const fn = execute === undefined ? undefined : objectNameAt(tokens, execute + 2)
	if (execute === undefined || fn === undefined) throw new Refused('CREATE TRIGGER without EXECUTE FUNCTION', line)
	const use = functionUse(
		{ qualifier: fn.qualifier, name: fn.name, parts: fn.qualifier === undefined ? 1 : 2, role: 'call', line },
		context.schema,
		context.functions,
	)
	if (use === undefined || use === 'expression') throw new Refused(`the trigger function ${fn.name}`, line)
	declareObject(out, 'trigger', `${table}.${name}`, line)
}

/** The tokens of a view's query without a trailing `WITH [CASCADED | LOCAL] CHECK OPTION` or `WITH [NO] DATA`. */
function viewQuery(tokens: readonly SqlToken[]): readonly SqlToken[] {
	for (let index = tokens.length - 1; index >= 0; index--) {
		if (upperWord(tokens[index]) !== 'WITH') continue
		const rest = tokens.slice(index + 1).map((token) => upperWord(token) ?? '')
		const option = rest[rest.length - 1] === 'OPTION' && rest[rest.length - 2] === 'CHECK' && rest.length <= 3
		const data = rest[rest.length - 1] === 'DATA' && rest.length <= 2
		if (option || data) return tokens.slice(0, index)
	}
	return tokens
}

/** `CREATE [OR REPLACE] [RECURSIVE | MATERIALIZED] VIEW [IF NOT EXISTS] name … AS <query>`. */
function createView(tokens: readonly SqlToken[], at: number, kind: 'view' | 'materialized view', context: Context, out: Collected): void {
	const line = tokens[0]?.line ?? 1
	const label = kind === 'view' ? 'CREATE VIEW' : 'CREATE MATERIALIZED VIEW'
	const named = skipWords(tokens, at, 'IF', 'NOT', 'EXISTS')
	const name = ownName(tokens, named, context, label)
	const as = wordAtDepthZero(tokens, 'AS', named)
	if (as === undefined) throw new Refused(`${label} without a query`, line)
	const header = tokens.slice(0, as)
	const tablespace = header.find((token) => upperWord(token) === 'TABLESPACE')
	if (tablespace !== undefined) throw new Refused(`${label} … TABLESPACE`, tablespace.line)
	refuseForeignDdl(header, context, label)
	const query = viewQuery(tokens.slice(as + 1))
	const first = upperWord(query[0])
	if (!(first === 'SELECT' || first === 'WITH' || first === 'VALUES' || isPunct(query[0], '('))) {
		throw new Refused(`${label} … AS ${statementKind(query)}`, line)
	}
	checkQuery(query, context, 'a view')
	declareObject(out, kind, name, line)
}

/** `CREATE [OR REPLACE] RULE name AS ON event TO table [WHERE …] DO [ALSO | INSTEAD] action`. */
function createRule(tokens: readonly SqlToken[], at: number, context: Context, out: Collected): void {
	const line = tokens[0]?.line ?? 1
	const name = nameText(tokens[at])
	const to = wordAtDepthZero(tokens, 'TO', at)
	const doIndex = to === undefined ? undefined : wordAtDepthZero(tokens, 'DO', to)
	if (name === undefined || to === undefined || doIndex === undefined) throw new Refused('CREATE RULE', line)
	const table = ownName(tokens, to + 1, context, 'CREATE RULE')
	const where = wordAtDepthZero(tokens, 'WHERE', to)
	const headerEnd = where !== undefined && where < doIndex ? where : doIndex
	refuseForeignDdl(tokens.slice(0, headerEnd), context, 'CREATE RULE')
	let action = skipWords(tokens, skipWords(tokens, doIndex + 1, 'ALSO'), 'INSTEAD')
	if (isPunct(tokens[action], '(')) action++
	const first = upperWord(tokens[action])
	if (first === undefined || !RULE_ACTIONS.has(first)) throw new Refused(`${first ?? statementKind(tokens.slice(action))} in a rule action`, line)
	checkQuery(tokens.slice(headerEnd), context, 'a rule')
	declareObject(out, 'rule', `${table}.${name}`, line)
}

/** `CREATE POLICY name ON table … [USING (…)] [WITH CHECK (…)]`. */
function createPolicy(tokens: readonly SqlToken[], at: number, context: Context, out: Collected): void {
	const line = tokens[0]?.line ?? 1
	const name = nameText(tokens[at])
	if (name === undefined || upperWord(tokens[at + 1]) !== 'ON') throw new Refused('CREATE POLICY', line)
	const table = ownName(tokens, at + 2, context, 'CREATE POLICY')
	const using = wordAtDepthZero(tokens, 'USING', at)
	const withCheck = wordAtDepthZero(tokens, 'WITH', at)
	const starts = [using, withCheck].filter((index) => index !== undefined)
	const expressions = starts.length === 0 ? tokens.length : Math.min(...starts)
	refuseForeignDdl(tokens.slice(0, expressions), context, 'CREATE POLICY')
	checkQuery(tokens.slice(expressions), context, 'a policy')
	declareObject(out, 'policy', `${table}.${name}`, line)
}

/** `CREATE SEQUENCE [IF NOT EXISTS] name [options] [OWNED BY table.column | NONE]`. */
function createSequence(tokens: readonly SqlToken[], at: number, context: Context, out: Collected): void {
	const line = tokens[0]?.line ?? 1
	const named = skipWords(tokens, at, 'IF', 'NOT', 'EXISTS')
	const name = ownName(tokens, named, context, 'CREATE SEQUENCE')
	const owned = tokens.findIndex((token, index) => upperWord(token) === 'OWNED' && upperWord(tokens[index + 1]) === 'BY')
	if (owned === -1) {
		refuseForeignDdl(tokens, context, 'CREATE SEQUENCE')
	} else {
		// `OWNED BY t.c` names a column; only a three-part `schema.t.c` names a schema.
		let end = owned + 2
		const parts: string[] = []
		if (isName(tokens[end])) {
			parts.push(nameText(tokens[end]) ?? '')
			end++
			while (isPunct(tokens[end], '.') && isName(tokens[end + 1])) {
				parts.push(nameText(tokens[end + 1]) ?? '')
				end += 2
			}
		}
		if (parts.length === 3 && parts[0] !== context.schema) throw new Refused(`CREATE SEQUENCE naming the schema ${parts[0]}`, line)
		refuseForeignDdl([...tokens.slice(0, owned), ...tokens.slice(end)], context, 'CREATE SEQUENCE')
	}
	declareObject(out, 'sequence', name, line)
}

/** `DO [LANGUAGE l] <body>`: runs once, inside the migration's transaction. */
function classifyDo(tokens: readonly SqlToken[], context: Context, out: Collected): void {
	const line = tokens[0]?.line ?? 1
	let language = 'plpgsql'
	let literal: SqlToken | undefined
	for (let index = 1; index < tokens.length; index++) {
		if (upperWord(tokens[index]) === 'LANGUAGE') {
			const named = nameText(tokens[index + 1])
			if (named === undefined) throw new Refused('a LANGUAGE written as a string', line)
			language = named
			index++
		} else if (literal === undefined) literal = tokens[index]
		else throw new Refused('DO with more than a body and a LANGUAGE', line)
	}
	const body = literalBody(literal)
	if (body === undefined) throw new Refused('a DO body the classifier cannot read; write it dollar-quoted', line)
	checkLanguage(language, line)
	checkBody(body, context)
	context.doBlocks++
	deviate(out, 'do', `block ${context.doBlocks}`, line)
}

/** One column definition or table constraint of `CREATE TABLE` or `ALTER TABLE … ADD`. */
function classifyElement(element: readonly SqlToken[], table: string, context: Context, out: Collected): void {
	const head = upperWord(element[0])
	if (head !== undefined && TABLE_CONSTRAINTS.has(head)) {
		const where = head === 'CONSTRAINT' ? `${table}.${nameText(element[1]) ?? ''}` : table
		checkExpression(element, where, context, out)
		return
	}
	const column = nameText(element[0])
	if (column === undefined) return
	const type = nameText(element[1])
	if (type !== undefined && SERIAL_TYPES.has(type)) {
		deviate(out, 'sequence', `${table}.${column}`, element[0]?.line ?? 1)
		out.changes.push({ change: 'create', object: { kind: 'serial column', name: `${table}.${column}` } })
	}
	checkExpression(element.slice(1), `${table}.${column}`, context, out)
}

/** `CREATE TABLE [IF NOT EXISTS] <name> (<columns and constraints>)` and nothing after it; `LIKE` without `INCLUDING`. */
function createTable(tokens: readonly SqlToken[], context: Context, out: Collected): void {
	const line = tokens[0]?.line ?? 1
	const nameAt = skipWords(tokens, 2, 'IF', 'NOT', 'EXISTS')
	const named = afterName(tokens, nameAt)
	const close = named === undefined || !isPunct(tokens[named], '(') ? undefined : closingParenthesis(tokens, named)
	if (named === undefined || close === undefined) throw new Refused('CREATE TABLE other than a column list', line)
	if (close !== tokens.length - 1) {
		const after = tokens[close + 1]
		throw new Refused(`CREATE TABLE … ${upperWord(after) ?? statementKind(tokens.slice(close + 1))}`, line)
	}
	refuseForeignDdl(tokens, context, 'CREATE TABLE')
	const table = ownName(tokens, nameAt, context, 'CREATE TABLE')
	for (const element of splitAtCommas(tokens.slice(named + 1, close))) {
		// `LIKE … INCLUDING` copies defaults, constraints and indexes from a table the classifier has not read.
		if (upperWord(element[0]) === 'LIKE' && element.some((token) => upperWord(token) === 'INCLUDING')) {
			throw new Refused('CREATE TABLE … LIKE … INCLUDING', line)
		}
		classifyElement(element, table, context, out)
	}
}

/** `CREATE [UNIQUE] INDEX [IF NOT EXISTS] [name] ON [ONLY] table [USING method] (…) …`. */
function createIndex(tokens: readonly SqlToken[], context: Context, out: Collected): void {
	const line = tokens[0]?.line ?? 1
	refuseForeignDdl(tokens, context, 'CREATE INDEX')
	let index = skipWords(tokens, skipWords(tokens, skipWords(tokens, 1, 'UNIQUE'), 'INDEX'), 'CONCURRENTLY')
	index = skipWords(tokens, index, 'IF', 'NOT', 'EXISTS')
	let name: string | undefined
	if (upperWord(tokens[index]) !== 'ON') {
		name = nameText(tokens[index])
		index++
	}
	if (upperWord(tokens[index]) !== 'ON') throw new Refused('CREATE INDEX', line)
	index = skipWords(tokens, index + 1, 'ONLY')
	const table = ownName(tokens, index, context, 'CREATE INDEX')
	index = afterName(tokens, index) ?? index
	if (upperWord(tokens[index]) === 'USING') index += 2
	checkExpression(tokens.slice(index), name ?? table, context, out)
}

/** Why one `ALTER TABLE` clause is outside the allowlist; its expressions are classified as a column's or a table's. */
function alterClause(clause: readonly SqlToken[], table: string, context: Context, out: Collected): void {
	const line = clause[0]?.line ?? 1
	const [action, next] = [upperWord(clause[0]), upperWord(clause[1])]
	if (action === 'ADD') {
		if (next !== undefined && TABLE_CONSTRAINTS.has(next)) {
			classifyElement(clause.slice(1), table, context, out)
			return
		}
		classifyElement(clause.slice(skipWords(clause, skipWords(clause, 1, 'COLUMN'), 'IF', 'NOT', 'EXISTS')), table, context, out)
		return
	}
	if (action === 'DROP') return
	if (action === 'VALIDATE' && next === 'CONSTRAINT') return
	if (action === 'ALTER' && next !== 'CONSTRAINT') {
		const columnAt = next === 'COLUMN' ? 2 : 1
		const column = nameText(clause[columnAt])
		const actionAt = afterName(clause, columnAt)
		const columnAction = actionAt === undefined
			? undefined
			: COLUMN_ACTIONS.find((words) => words.every((word, offset) => upperWord(clause[actionAt + offset]) === word))
		if (actionAt === undefined || column === undefined || columnAction === undefined) {
			throw new Refused(`ALTER TABLE … ALTER COLUMN … ${upperWord(clause[actionAt ?? 2]) ?? ''}`.trimEnd(), line)
		}
		const rest = clause.slice(actionAt + columnAction.length)
		// A default persists in the schema; `TYPE … USING` runs once over the rows, as a backfill does.
		if (columnAction[1] === 'DEFAULT' && columnAction[0] === 'SET') checkExpression(rest, `${table}.${column}`, context, out)
		else if (columnAction[0] === 'TYPE' || columnAction[1] === 'DATA') checkQuery(rest, context, 'ALTER TABLE … USING')
		return
	}
	throw new Refused(`ALTER TABLE … ${action ?? 'an action'}`, line)
}

function alterTable(tokens: readonly SqlToken[], context: Context, out: Collected): void {
	const line = tokens[0]?.line ?? 1
	if (upperWord(tokens[2]) === 'ALL' && upperWord(tokens[3]) === 'IN') throw new Refused('ALTER TABLE ALL IN TABLESPACE', line)
	refuseForeignDdl(tokens, context, 'ALTER TABLE')
	const start = skipWords(tokens, skipWords(tokens, 2, 'IF', 'EXISTS'), 'ONLY')
	const named = afterName(tokens, start)
	if (named === undefined) throw new Refused('ALTER TABLE', line)
	const table = ownName(tokens, start, context, 'ALTER TABLE')
	const rest = tokens.slice(isPunct(tokens[named], '*') ? named + 1 : named)
	// RENAME TO, RENAME [COLUMN] a TO b and RENAME CONSTRAINT a TO b each stand alone.
	if (upperWord(rest[0]) === 'RENAME') {
		const to = upperWord(rest[1]) === 'TO' ? nameText(rest[2]) : undefined
		if (to !== undefined) out.changes.push({ change: 'rename table', from: table, to })
		const columnAt = upperWord(rest[1]) === 'COLUMN' ? 2 : 1
		const from = upperWord(rest[1]) === 'TO' || upperWord(rest[1]) === 'CONSTRAINT' ? undefined : nameText(rest[columnAt])
		const column = upperWord(rest[columnAt + 1]) === 'TO' ? nameText(rest[columnAt + 2]) : undefined
		if (from !== undefined && column !== undefined) out.changes.push({ change: 'rename column', table, from, to: column })
		return
	}
	for (const clause of splitAtCommas(rest)) alterClause(clause, table, context, out)
}

function alterIndexOrType(tokens: readonly SqlToken[], kind: string, context: Context): void {
	const line = tokens[0]?.line ?? 1
	if (kind === 'INDEX') {
		const named = afterName(tokens, skipWords(tokens, 2, 'IF', 'EXISTS'))
		const isRename = named !== undefined && upperWord(tokens[named]) === 'RENAME' && upperWord(tokens[named + 1]) === 'TO'
		if (!isRename) throw new Refused('ALTER INDEX other than RENAME TO', line)
	} else {
		const named = afterName(tokens, 2)
		const action = named === undefined ? undefined : upperWord(tokens[named])
		const isValue = named !== undefined && (action === 'ADD' || action === 'RENAME') && upperWord(tokens[named + 1]) === 'VALUE'
		if (!isValue) throw new Refused('ALTER TYPE other than ADD VALUE or RENAME VALUE', line)
	}
	refuseForeignDdl(tokens, context, `ALTER ${kind}`)
}

/** The kinds of database code `ALTER … RENAME TO` may rename, and what each names in the manifest. */
/** Every declared kind but a serial column, which follows its table and column. */
type CodeKind = Exclude<DatabaseObjectKind, 'serial column'>

const RENAMEABLE: Readonly<Record<string, readonly CodeKind[]>> = {
	FUNCTION: ['function'],
	PROCEDURE: ['procedure'],
	ROUTINE: ['function', 'procedure'],
	VIEW: ['view'],
	SEQUENCE: ['sequence'],
	TRIGGER: ['trigger'],
	RULE: ['rule'],
	POLICY: ['policy'],
}

/**
 * `ALTER FUNCTION|PROCEDURE|ROUTINE name [(args)] RENAME TO new`, `ALTER [MATERIALIZED] VIEW|SEQUENCE [IF EXISTS] name
 * RENAME TO new` and `ALTER TRIGGER|RULE|POLICY name ON table RENAME TO new`: the renamed object is a deviation under
 * its new name, and the manifest follows it. Any other `ALTER` of database code is refused.
 */
function alterRename(tokens: readonly SqlToken[], context: Context, out: Collected): void {
	const line = tokens[0]?.line ?? 1
	const materialized = upperWord(tokens[1]) === 'MATERIALIZED' && upperWord(tokens[2]) === 'VIEW'
	const kind = materialized ? 'VIEW' : (upperWord(tokens[1]) ?? '')
	const kinds: readonly CodeKind[] = materialized ? ['materialized view'] : Object.hasOwn(RENAMEABLE, kind) ? (RENAMEABLE[kind] ?? []) : []
	const label = statementKind(tokens)
	const at = skipWords(tokens, materialized ? 3 : 2, 'IF', 'EXISTS')
	const onTable = kind === 'TRIGGER' || kind === 'RULE' || kind === 'POLICY'
	let name: string
	let after: number
	let args: readonly SqlToken[] | undefined
	if (onTable) {
		const own = nameText(tokens[at])
		if (own === undefined || upperWord(tokens[at + 1]) !== 'ON') throw new Refused(label, line)
		name = `${ownName(tokens, at + 2, context, label)}.${own}`
		after = afterName(tokens, at + 2) ?? tokens.length
	} else {
		name = ownName(tokens, at, context, label)
		after = afterName(tokens, at) ?? tokens.length
		if (isPunct(tokens[after], '(')) {
			const close = closingParenthesis(tokens, after) ?? tokens.length - 1
			args = tokens.slice(after + 1, close)
			after = close + 1
		}
	}
	const target = nameText(tokens[after + 2])
	if (
		kinds.length === 0 || upperWord(tokens[after]) !== 'RENAME' || upperWord(tokens[after + 1]) !== 'TO' || target === undefined
		|| after + 3 !== tokens.length
	) {
		throw new Refused(`${label} other than RENAME TO`, line)
	}
	refuseForeignDdl(tokens, context, label)
	if (onTable) {
		const renamed = `${name.slice(0, name.indexOf('.'))}.${target}`
		for (const objectKind of kinds) out.changes.push({ change: 'rename', from: { kind: objectKind, name }, to: { kind: objectKind, name: renamed } })
		deviate(out, kinds[0] ?? 'trigger', renamed, line)
		return
	}
	const routines = kinds.filter((objectKind): objectKind is RoutineKind => objectKind === 'function' || objectKind === 'procedure')
	if (routines.length === 0) {
		for (const objectKind of kinds) out.changes.push({ change: 'rename', from: { kind: objectKind, name }, to: { kind: objectKind, name: target } })
		deviate(out, kinds[0] ?? 'view', target, line)
		return
	}
	for (const routine of routines) refuseShadowing(target, routine, line)
	// A procedure's drop and rename list its OUT arguments too, which `proargtypes` leaves out: rename it by name.
	const signatures = routines.map((routine) => (args === undefined || routine === 'procedure' ? undefined : routineSignature(args, context.schema)))
	for (const [index, routine] of routines.entries()) {
		const signature = signatures[index]
		if (args !== undefined && routine === 'function' && signature === undefined) {
			throw new Refused(`a ${routine} argument type the classifier cannot name; write the type itself`, line)
		}
		if (signature === undefined) out.changes.push({ change: 'rename routines', kind: routine, from: name, to: target })
		else {out.changes.push({
				change: 'rename',
				from: { kind: routine, name: `${name}(${signature})` },
				to: { kind: routine, name: `${target}(${signature})` },
			})}
	}
	const shown = signatures[0] === undefined ? target : `${target}(${signatures[0]})`
	deviate(out, routines[0] ?? 'function', shown, line)
}

/** The objects a `DROP` removes from the manifest. */
function dropChanges(tokens: readonly SqlToken[], kind: string, context: Context): ManifestChange[] {
	const objectKinds: Readonly<Record<string, readonly DatabaseObjectKind[]>> = {
		FUNCTION: ['function'],
		PROCEDURE: ['procedure'],
		ROUTINE: ['function', 'procedure'],
		VIEW: ['view'],
		SEQUENCE: ['sequence'],
	}
	const materialized = kind === 'MATERIALIZED'
	const names = skipWords(tokens, materialized ? 3 : 2, 'IF', 'EXISTS')
	if (kind === 'TRIGGER' || kind === 'RULE' || kind === 'POLICY') {
		const name = nameText(tokens[names])
		const table = objectNameAt(tokens, names + 2)
		if (name === undefined || table === undefined || upperWord(tokens[names + 1]) !== 'ON') return []
		const objectKind: DatabaseObjectKind = kind === 'TRIGGER' ? 'trigger' : kind === 'RULE' ? 'rule' : 'policy'
		return [{ change: 'drop', object: { kind: objectKind, name: `${table.name}.${name}` } }]
	}
	const kinds: readonly DatabaseObjectKind[] = materialized ? ['materialized view'] : Object.hasOwn(objectKinds, kind) ? (objectKinds[kind] ?? []) : []
	const changes: ManifestChange[] = []
	for (const part of splitAtCommas(tokens.slice(names))) {
		const object = objectNameAt(part, 0)
		if (object === undefined || (object.qualifier !== undefined && object.qualifier !== context.schema)) continue
		if (kind === 'TABLE') changes.push({ change: 'drop table', table: object.name })
		const open = afterName(part, 0)
		const close = open !== undefined && isPunct(part[open], '(') ? closingParenthesis(part, open) : undefined
		for (const objectKind of kinds) {
			if (objectKind !== 'function' && objectKind !== 'procedure') {
				changes.push({ change: 'drop', object: { kind: objectKind, name: object.name } })
				continue
			}
			// Without an argument list a drop names every overload; with one, only that signature. A procedure's list holds
			// its OUT arguments, which `proargtypes` leaves out, so it drops every overload of the name.
			const listed = open !== undefined && close !== undefined && objectKind === 'function'
			const signature = listed ? routineSignature(part.slice(open + 1, close), context.schema) : undefined
			if (signature === undefined) changes.push({ change: 'drop routines', kind: objectKind, name: object.name })
			else changes.push({ change: 'drop', object: { kind: objectKind, name: `${object.name}(${signature})` } })
		}
	}
	return changes
}

function classifyDrop(tokens: readonly SqlToken[], context: Context, out: Collected): void {
	const line = tokens[0]?.line ?? 1
	const kind = upperWord(tokens[1])
	if (kind === undefined || !DROPPABLE.has(kind)) throw new Refused(statementKind(tokens), line)
	// An extension may live in another schema; CASCADE would drop what other schemas built on it.
	if (kind === 'EXTENSION' && tokens.some((token) => upperWord(token) === 'CASCADE')) throw new Refused('DROP EXTENSION … CASCADE', line)
	refuseForeignDdl(tokens, context, statementKind(tokens))
	out.changes.push(...dropChanges(tokens, kind, context))
}

function classifyCreate(tokens: readonly SqlToken[], context: Context, out: Collected): void {
	const line = tokens[0]?.line ?? 1
	const at = skipWords(tokens, 1, 'OR', 'REPLACE')
	const replace = at > 1
	const kind = upperWord(tokens[at])
	const next = upperWord(tokens[at + 1])
	if (!replace && kind === 'TABLE') return createTable(tokens, context, out)
	if (!replace && (kind === 'INDEX' || (kind === 'UNIQUE' && next === 'INDEX'))) return createIndex(tokens, context, out)
	if (!replace && kind === 'TYPE') {
		const named = afterName(tokens, 2)
		const isEnum = named !== undefined && upperWord(tokens[named]) === 'AS' && upperWord(tokens[named + 1]) === 'ENUM'
		if (!isEnum) throw new Refused('CREATE TYPE other than AS ENUM', line)
		return refuseForeignDdl(tokens, context, 'CREATE TYPE')
	}
	if (kind === 'FUNCTION') return createFunction(tokens, at + 1, 'function', context, out)
	if (kind === 'PROCEDURE') return createFunction(tokens, at + 1, 'procedure', context, out)
	if (kind === 'TRIGGER') return createTrigger(tokens, at + 1, context, out)
	if (kind === 'CONSTRAINT' && next === 'TRIGGER') return createTrigger(tokens, at + 2, context, out)
	if (kind === 'VIEW') return createView(tokens, at + 1, 'view', context, out)
	if (kind === 'RECURSIVE' && next === 'VIEW') return createView(tokens, at + 2, 'view', context, out)
	if (!replace && kind === 'MATERIALIZED' && next === 'VIEW') return createView(tokens, at + 2, 'materialized view', context, out)
	if (kind === 'RULE') return createRule(tokens, at + 1, context, out)
	if (!replace && kind === 'POLICY') return createPolicy(tokens, at + 1, context, out)
	if (!replace && kind === 'SEQUENCE') return createSequence(tokens, at + 1, context, out)
	if (kind === 'EVENT') throw new Refused('CREATE EVENT TRIGGER', line)
	throw new Refused(statementKind(tokens), line)
}

/** The targets `COMMENT ON` may name, all objects of the application's schema; `ON` marks one named on a table. */
const COMMENT_TARGETS: Readonly<Record<string, 'name' | 'routine' | 'column' | 'on'>> = {
	TABLE: 'name',
	VIEW: 'name',
	INDEX: 'name',
	SEQUENCE: 'name',
	COLUMN: 'column',
	FUNCTION: 'routine',
	PROCEDURE: 'routine',
	ROUTINE: 'routine',
	CONSTRAINT: 'on',
	TRIGGER: 'on',
	POLICY: 'on',
	RULE: 'on',
}

/**
 * `COMMENT ON <target> IS '…' | NULL` for an object of the application's schema. A name that resolves to the catalog
 * (`pg_…`, a `pg_catalog` function) and a global target (a role, a database) are refused.
 */
function classifyComment(tokens: readonly SqlToken[], context: Context): void {
	const line = tokens[0]?.line ?? 1
	const materialized = upperWord(tokens[2]) === 'MATERIALIZED' && upperWord(tokens[3]) === 'VIEW'
	const target = materialized ? 'VIEW' : (upperWord(tokens[2]) ?? '')
	const form = Object.hasOwn(COMMENT_TARGETS, target) ? COMMENT_TARGETS[target] : undefined
	if (form === undefined) throw new Refused(`COMMENT ON ${statementKind(tokens.slice(2))}`, line)
	let at = materialized ? 4 : 3
	const names: string[] = []
	if (form === 'on') {
		const name = nameText(tokens[at])
		if (name === undefined || upperWord(tokens[at + 1]) !== 'ON') throw new Refused(`COMMENT ON ${target}`, line)
		names.push(ownName(tokens, at + 2, context, `COMMENT ON ${target}`))
		at = afterName(tokens, at + 2) ?? tokens.length
	} else if (form === 'column') {
		const parts: string[] = []
		while (isName(tokens[at])) {
			parts.push(nameText(tokens[at]) ?? '')
			if (!isPunct(tokens[at + 1], '.')) break
			at += 2
		}
		at++
		if (parts.length === 3 && parts[0] !== context.schema) throw new Refused(`COMMENT ON COLUMN naming the schema ${parts[0]}`, line)
		if (parts.length < 2 || parts.length > 3) throw new Refused('COMMENT ON COLUMN', line)
		names.push(parts[parts.length - 2] ?? '')
	} else {
		const name = ownName(tokens, at, context, `COMMENT ON ${target}`)
		if (form === 'routine' && PG_CATALOG_FUNCTIONS.has(name)) throw new Refused(`COMMENT ON a pg_catalog function ${name}`, line)
		names.push(name)
		at = afterName(tokens, at) ?? tokens.length
		if (form === 'routine' && isPunct(tokens[at], '(')) at = (closingParenthesis(tokens, at) ?? tokens.length - 1) + 1
	}
	const catalog = names.find((name) => name.startsWith('pg_'))
	if (catalog !== undefined) throw new Refused(`COMMENT ON ${catalog}, which resolves to pg_catalog`, line)
	const value = tokens[at + 1]
	const isText = (value?.kind === 'string' || value?.kind === 'dollar' || upperWord(value) === 'NULL') && at + 2 === tokens.length
	if (upperWord(tokens[at]) !== 'IS' || !isText) throw new Refused(`COMMENT ON ${target} other than IS '…'`, line)
}

/**
 * The framework names a statement may use: a file collection's table (`fabrika_files_<name>`, `fileTableSql`) is
 * created by the application's own migration, with its indexes. Every other framework name is refused.
 */
function fileTableNames(tokens: readonly SqlToken[]): ReadonlySet<string> {
	const [first, second] = [upperWord(tokens[0]), upperWord(tokens[1])]
	if (first !== 'CREATE') return new Set()
	if (second === 'TABLE') {
		const table = nameText(tokens[skipWords(tokens, 2, 'IF', 'NOT', 'EXISTS')])
		return table?.startsWith(FILE_TABLE_PREFIX) === true ? new Set([table]) : new Set()
	}
	if (second !== 'INDEX' && !(second === 'UNIQUE' && upperWord(tokens[2]) === 'INDEX')) return new Set()
	const on = wordAtDepthZero(tokens, 'ON')
	if (on === undefined) return new Set()
	const table = nameText(tokens[skipWords(tokens, on + 1, 'ONLY')])
	if (table?.startsWith(FILE_TABLE_PREFIX) !== true) return new Set()
	const index = nameText(tokens[on - 1])
	return index?.startsWith(`${table}_`) === true ? new Set([table, index]) : new Set([table])
}

function classifyStatement(tokens: readonly SqlToken[], context: Context, out: Collected): void {
	const line = tokens[0]?.line ?? 1
	const unicode = unicodeIdentifier(tokens)
	if (unicode !== undefined) throw new Refused('a Unicode-escaped identifier (U&"…")', unicode.line)
	const framework = context.framework ? undefined : frameworkReference(tokens, fileTableNames(tokens))
	if (framework !== undefined) throw new Refused(`a reference to the framework's ${framework.name}`, framework.line)
	const first = upperWord(tokens[0])
	if (first === 'INSERT' || first === 'UPDATE' || first === 'DELETE') return checkQuery(tokens, context, first)
	if (first === 'COMMENT' && upperWord(tokens[1]) === 'ON') return classifyComment(tokens, context)
	if (first === 'DO') return classifyDo(tokens, context, out)
	if (first === 'CREATE') return classifyCreate(tokens, context, out)
	if (first === 'DROP') return classifyDrop(tokens, context, out)
	if (first === 'TRUNCATE') return refuseForeignDdl(tokens, context, 'TRUNCATE')
	const second = upperWord(tokens[1])
	if (first === 'ALTER' && second === 'TABLE') return alterTable(tokens, context, out)
	if (first === 'ALTER' && (second === 'INDEX' || second === 'TYPE')) return alterIndexOrType(tokens, second, context)
	if (first === 'ALTER' && second !== undefined && (Object.hasOwn(RENAMEABLE, second) || second === 'MATERIALIZED')) {
		return alterRename(tokens, context, out)
	}
	throw new Refused(statementKind(tokens), line)
}

/**
 * Classifies one application migration. Paved: `CREATE TABLE` (a column list and nothing after it), `ALTER TABLE`
 * column, constraint and rename clauses, `CREATE [UNIQUE] INDEX`, `ALTER INDEX … RENAME TO`, `CREATE TYPE … AS ENUM`,
 * `ALTER TYPE … ADD|RENAME VALUE`, `DROP`, `TRUNCATE`, `COMMENT ON` and `INSERT`/`UPDATE`/`DELETE` backfills.
 * Deviations: functions, procedures, triggers, views, rules, policies, sequences (a serial column's too), their
 * `ALTER … RENAME TO`, `DO`, and a stored expression that calls anything but a paved built-in. Refused: a schema
 * other than `schema` (`pg_catalog` relations included), a framework `fabrika_*` name, `SECURITY DEFINER`, a function
 * `SET` clause, a language other than `sql` and `plpgsql`, a body that is not literal or that holds dynamic `EXECUTE`
 * or a statement outside its allowlist, a call outside the function allowlist, and every form not named here:
 * `COPY`, `GRANT`, `REVOKE`, roles, extensions, event triggers, domains (codegen cannot bind one), `SELECT`, `WITH`
 * and `MERGE` among them. Transaction control and
 * `SET`/`RESET` are refused for every plan before this runs (`refusedStatement`).
 */
export function classifyMigration(sql: string, schema: string, options: ClassifyMigrationOptions): MigrationClassification {
	const context: Context = { schema, functions: options.functions ?? new Set(), framework: options.framework === true, doBlocks: 0 }
	const refused: MigrationRefusal[] = []
	const deviations: MigrationDeviation[] = []
	const changes: ManifestChange[] = []
	const keys = new Set<string>()
	const { unterminated } = lexSql(sql)
	if (unterminated !== undefined) {
		refused.push({ reason: 'a literal, a quoted name or a comment that never closes', file: options.file, line: unterminated })
	}
	for (const { tokens, line } of topLevelStatements(sql)) {
		const out: Collected = { deviations: [], changes: [] }
		try {
			classifyStatement(tokens, context, out)
		} catch (error) {
			if (!(error instanceof Refused)) throw error
			refused.push({ reason: error.reason, file: options.file, line: error.line || line })
			continue
		}
		for (const deviation of out.deviations) {
			const key = `${deviation.kind} ${deviation.object}`
			if (keys.has(key)) continue
			keys.add(key)
			deviations.push({ ...deviation, file: options.file })
		}
		changes.push(...out.changes)
	}
	const objects = changes.flatMap((change) => (change.change === 'create' ? [change.object] : []))
	return { file: options.file, refused, deviations, objects, changes }
}

/** The names of the functions and procedures a migration creates or renames to in `schema`, read without classifying them. */
export function declaredFunctions(sql: string, schema: string): string[] {
	const names: string[] = []
	for (const { tokens } of topLevelStatements(sql)) {
		const first = upperWord(tokens[0])
		const at = first === 'CREATE' ? skipWords(tokens, 1, 'OR', 'REPLACE') : 1
		const kind = upperWord(tokens[at])
		if ((first !== 'CREATE' && first !== 'ALTER') || (kind !== 'FUNCTION' && kind !== 'PROCEDURE' && (first === 'CREATE' || kind !== 'ROUTINE'))) {
			continue
		}
		const object = objectNameAt(tokens, at + 1)
		if (object === undefined || (object.qualifier !== undefined && object.qualifier !== schema)) continue
		if (first === 'CREATE') {
			names.push(object.name)
			continue
		}
		const rename = tokens.findIndex((token, index) => upperWord(token) === 'RENAME' && upperWord(tokens[index + 1]) === 'TO')
		const target = rename === -1 ? undefined : nameText(tokens[rename + 2])
		if (target !== undefined) names.push(target)
	}
	// A name a built-in or a keyword already holds is refused where it is declared, and never admits a call.
	return names.filter((name) => !shadows(name))
}

const objectKey = (object: DatabaseObject): string => `${object.kind} ${object.name}`
const ON_TABLE: ReadonlySet<DatabaseObjectKind> = new Set(['trigger', 'rule', 'policy', 'serial column'])
/** `f` of `f(int4,text)`. */
const routineName = (name: string): string => name.slice(0, name.indexOf('('))

/**
 * The manifest of a migration set, folded in file order: a create adds an object (a replace keeps it), a drop removes
 * it, dropping a table removes its triggers, rules and policies, and renaming a table renames them. A `CASCADE` may
 * drop more than the manifest removes; a stale entry only admits an object that no longer exists.
 */
export function migrationManifest(classifications: readonly MigrationClassification[]): DatabaseObject[] {
	const objects = new Map<string, DatabaseObject>()
	const onTable = (table: string): DatabaseObject[] =>
		[...objects.values()].filter((object) => ON_TABLE.has(object.kind) && object.name.startsWith(`${table}.`))
	for (const { changes } of classifications) {
		for (const change of changes) {
			if (change.change === 'create') objects.set(objectKey(change.object), change.object)
			else if (change.change === 'drop') objects.delete(objectKey(change.object))
			else if (change.change === 'drop table') { for (const object of onTable(change.table)) objects.delete(objectKey(object)) }
			else if (change.change === 'rename') {
				if (objects.delete(objectKey(change.from))) objects.set(objectKey(change.to), change.to)
			} else if (change.change === 'drop routines' || change.change === 'rename routines') {
				const name = change.change === 'drop routines' ? change.name : change.from
				for (const object of [...objects.values()]) {
					if (object.kind !== change.kind || routineName(object.name) !== name) continue
					objects.delete(objectKey(object))
					if (change.change === 'rename routines') {
						const renamed: DatabaseObject = { kind: object.kind, name: `${change.to}${object.name.slice(name.length)}` }
						objects.set(objectKey(renamed), renamed)
					}
				}
			} else if (change.change === 'rename column') {
				const from: DatabaseObject = { kind: 'serial column', name: `${change.table}.${change.from}` }
				if (objects.delete(objectKey(from))) {
					objects.set(objectKey({ kind: 'serial column', name: `${change.table}.${change.to}` }), {
						kind: 'serial column',
						name: `${change.table}.${change.to}`,
					})
				}
			} else {
				for (const object of onTable(change.from)) {
					objects.delete(objectKey(object))
					const renamed: DatabaseObject = { kind: object.kind, name: `${change.to}${object.name.slice(change.from.length)}` }
					objects.set(objectKey(renamed), renamed)
				}
			}
		}
	}
	return [...objects.values()]
}

/**
 * Classifies a whole migration set in order. A body or an expression may call a function any file of the set
 * declares; the manifest is what the catalog check admits.
 */
export function classifyMigrations(files: readonly MigrationFile[], schema: string): MigrationSetClassification {
	const functions = new Set(files.flatMap((file) => declaredFunctions(file.sql, schema)))
	const classified = files.map((file) => classifyMigration(file.sql, schema, { file: file.name, functions, framework: file.framework === true }))
	return { files: classified, objects: migrationManifest(classified) }
}
