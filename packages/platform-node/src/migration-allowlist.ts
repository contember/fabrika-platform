// The statements an application migration may hold (ADR-0017). An allowlist at every level the runner reads: a
// statement, a clause of `ALTER TABLE`, an element of `CREATE TABLE`. A form it does not name is refused, so a form
// a later Postgres adds is refused too. The expressions inside an allowed statement are Postgres' to parse; the
// catalog check (`database-code.ts`) reads what they left before the commit.

import { type SqlToken, topLevelStatements, upperWord } from './migration-sql'

/** What an application migration may drop: its own tables, indexes and types, and any database code left from before. */
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

/** Words after which a name is a relation in DML: a qualified one there names a schema, not a table. */
const RELATION_KEYWORDS: ReadonlySet<string> = new Set(['INTO', 'UPDATE', 'JOIN', 'TABLE'])

/** Words that end a `FROM`/`USING` list at its own depth, so a later `,` separates no relations. */
const LIST_ENDS: ReadonlySet<string> = new Set([
	'WHERE',
	'GROUP',
	'HAVING',
	'WINDOW',
	'ORDER',
	'LIMIT',
	'OFFSET',
	'RETURNING',
	'FETCH',
	'FOR',
	'UNION',
	'EXCEPT',
	'INTERSECT',
	'SET',
	'VALUES',
	'SELECT',
])

/** Functions whose `FROM` is an argument (`EXTRACT(epoch FROM t.at)`), not a relation list. */
const FROM_ARGUMENT_FUNCTIONS: ReadonlySet<string> = new Set(['EXTRACT', 'SUBSTRING', 'TRIM', 'OVERLAY', 'POSITION'])

const isName = (token: SqlToken | undefined): boolean => token?.kind === 'word' || token?.kind === 'quoted'
const isPunct = (token: SqlToken | undefined, char: string): boolean => token?.kind === 'punct' && token.char === char

/** A name as Postgres resolves it: an unquoted one folded to lower case. */
function nameText(token: SqlToken | undefined): string | undefined {
	if (token?.kind === 'word') return token.text.toLowerCase()
	if (token?.kind === 'quoted') return token.text
	return undefined
}

/** The index past a name at `index`, schema-qualified or not, or `undefined` when no name is there. */
function afterName(tokens: readonly SqlToken[], index: number): number | undefined {
	if (!isName(tokens[index])) return undefined
	return isPunct(tokens[index + 1], '.') && isName(tokens[index + 2]) ? index + 3 : index + 1
}

/** The index past the words `words` at `index`, or `index` itself when they are not all there. */
function skipWords(tokens: readonly SqlToken[], index: number, ...words: readonly string[]): number {
	return words.every((word, offset) => upperWord(tokens[index + offset]) === word) ? index + words.length : index
}

/** The token lists between the commas at parenthesis depth 0 of `tokens`. */
function splitAtCommas(tokens: readonly SqlToken[]): SqlToken[][] {
	const parts: SqlToken[][] = [[]]
	let depth = 0
	for (const token of tokens) {
		if (isPunct(token, '(')) depth++
		else if (isPunct(token, ')')) depth--
		if (depth === 0 && isPunct(token, ',')) parts.push([])
		else parts[parts.length - 1]?.push(token)
	}
	return parts
}

/** The index of the `)` that closes the `(` at `open`, or `undefined`. */
function closingParenthesis(tokens: readonly SqlToken[], open: number): number | undefined {
	let depth = 0
	for (let index = open; index < tokens.length; index++) {
		if (isPunct(tokens[index], '(')) depth++
		else if (isPunct(tokens[index], ')') && --depth === 0) return index
	}
	return undefined
}

/**
 * The first schema a DDL statement names other than the application's own, `pg_catalog` included: every qualified
 * name counts, since a DDL statement has no table alias to qualify a column with.
 */
function qualifiedSchema(tokens: readonly SqlToken[], schema: string): string | undefined {
	for (let index = 0; index + 2 < tokens.length; index++) {
		const qualifier = nameText(tokens[index])
		if (qualifier !== undefined && isPunct(tokens[index + 1], '.') && qualifier !== schema) return qualifier
	}
	return undefined
}

/**
 * The first schema a DML statement reaches other than the application's own, `pg_catalog` included: a qualified
 * relation (`UPDATE x.t`, `FROM x.t`, after a `,` of a `FROM` list), a qualified call (`x.f(`), a qualified type
 * (`::x.t`, `AS x.t`) or a three-part name. A two-part name anywhere else is a column of a table or an alias. An
 * unqualified relation whose name starts with `pg_` resolves to the catalog and counts as `pg_catalog`.
 */
function dmlSchema(tokens: readonly SqlToken[], schema: string): string | undefined {
	const lists: { fromList: boolean; opener: string | undefined }[] = [{ fromList: false, opener: undefined }]
	let relationNext = false
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]
		const top = lists[lists.length - 1] ?? { fromList: false, opener: undefined }
		const word = upperWord(token)
		if (isPunct(token, '(')) {
			lists.push({ fromList: false, opener: upperWord(tokens[index - 1]) })
			relationNext = false
			continue
		}
		if (isPunct(token, ')')) {
			if (lists.length > 1) lists.pop()
			relationNext = false
			continue
		}
		if (isPunct(token, ',')) {
			relationNext = top.fromList
			continue
		}
		if (word !== undefined && LIST_ENDS.has(word)) top.fromList = false
		if (word === 'FROM' || word === 'USING') {
			const argument = word === 'FROM'
				&& (upperWord(tokens[index - 1]) === 'DISTINCT' || (top.opener !== undefined && FROM_ARGUMENT_FUNCTIONS.has(top.opener)))
			relationNext = !argument
			top.fromList = !argument
			continue
		}
		if (word !== undefined && RELATION_KEYWORDS.has(word)) {
			relationNext = true
			continue
		}
		if (relationNext && (word === 'ONLY' || word === 'LATERAL')) continue
		const inRelation = relationNext
		relationNext = false
		const qualifier = nameText(token)
		if (qualifier === undefined) continue
		if (!isPunct(tokens[index + 1], '.')) {
			if (inRelation && qualifier.startsWith('pg_')) return 'pg_catalog'
			continue
		}
		if (qualifier === schema) continue
		const castTarget = (isPunct(tokens[index - 1], ':') && isPunct(tokens[index - 2], ':')) || upperWord(tokens[index - 1]) === 'AS'
		const call = isPunct(tokens[index + 3], '(')
		const threePart = isPunct(tokens[index + 3], '.')
		if (inRelation || castTarget || call || threePart) return qualifier
	}
	return undefined
}

/** Why one `ALTER TABLE` clause is outside the allowlist, or `undefined`. */
function disallowedAlterClause(clause: readonly SqlToken[]): string | undefined {
	const [action, next] = [upperWord(clause[0]), upperWord(clause[1])]
	if (action === 'ADD') return next === 'EXCLUDE' ? 'ALTER TABLE … ADD EXCLUDE' : undefined
	if (action === 'DROP') return undefined
	if (action === 'VALIDATE' && next === 'CONSTRAINT') return undefined
	if (action === 'ALTER' && next !== 'CONSTRAINT') {
		const column = afterName(clause, next === 'COLUMN' ? 2 : 1)
		const allowed = column !== undefined
			&& COLUMN_ACTIONS.some((words) => words.every((word, offset) => upperWord(clause[column + offset]) === word))
		return allowed ? undefined : `ALTER TABLE … ALTER COLUMN … ${upperWord(clause[column ?? 2]) ?? ''}`.trimEnd()
	}
	return `ALTER TABLE … ${action ?? 'an action'}`
}

function disallowedAlterTable(tokens: readonly SqlToken[]): string | undefined {
	if (upperWord(tokens[2]) === 'ALL' && upperWord(tokens[3]) === 'IN') return 'ALTER TABLE ALL IN TABLESPACE'
	const start = skipWords(tokens, skipWords(tokens, 2, 'IF', 'EXISTS'), 'ONLY')
	const named = afterName(tokens, start)
	if (named === undefined) return 'ALTER TABLE'
	const rest = tokens.slice(isPunct(tokens[named], '*') ? named + 1 : named)
	// RENAME TO, RENAME [COLUMN] a TO b and RENAME CONSTRAINT a TO b each stand alone.
	if (upperWord(rest[0]) === 'RENAME') return undefined
	for (const clause of splitAtCommas(rest)) {
		const refused = disallowedAlterClause(clause)
		if (refused !== undefined) return refused
	}
	return undefined
}

/** `CREATE TABLE [IF NOT EXISTS] <name> (<columns and constraints>)` and nothing after it; `LIKE` without `INCLUDING`. */
function disallowedCreateTable(tokens: readonly SqlToken[]): string | undefined {
	const named = afterName(tokens, skipWords(tokens, 2, 'IF', 'NOT', 'EXISTS'))
	if (named === undefined || !isPunct(tokens[named], '(')) return 'CREATE TABLE other than a column list'
	const close = closingParenthesis(tokens, named)
	if (close === undefined) return 'CREATE TABLE other than a column list'
	if (close !== tokens.length - 1) return `CREATE TABLE … ${upperWord(tokens[close + 1]) ?? firstTokenLabel(tokens[close + 1])}`
	for (const element of splitAtCommas(tokens.slice(named + 1, close))) {
		// `LIKE … INCLUDING` copies defaults, constraints and indexes from a table the check has not seen.
		if (upperWord(element[0]) === 'LIKE' && element.some((token) => upperWord(token) === 'INCLUDING')) return 'CREATE TABLE … LIKE … INCLUDING'
	}
	return undefined
}

function firstTokenLabel(token: SqlToken | undefined): string {
	if (token?.kind === 'punct') return token.char
	if (token?.kind === 'quoted') return `"${token.text}"`
	return 'a statement'
}

/** Why one DDL statement's form is outside the allowlist, as the label the refusal names, or `undefined`. */
function disallowedDdlForm(tokens: readonly SqlToken[], label: string): string | undefined {
	const [first, second] = [upperWord(tokens[0]), upperWord(tokens[1])]
	if (first === 'TRUNCATE') return undefined
	if (first === 'DROP') {
		if (second === undefined || !DROPPABLE.has(second)) return label
		// An extension may live in another schema; CASCADE would drop what other schemas built on it.
		return second === 'EXTENSION' && tokens.some((token) => upperWord(token) === 'CASCADE') ? 'DROP EXTENSION … CASCADE' : undefined
	}
	if (first === 'CREATE' && (second === 'INDEX' || (second === 'UNIQUE' && upperWord(tokens[2]) === 'INDEX'))) return undefined
	if (first === 'CREATE' && second === 'TABLE') return disallowedCreateTable(tokens)
	if (first === 'ALTER' && second === 'TABLE') return disallowedAlterTable(tokens)
	if (first === 'ALTER' && second === 'INDEX') {
		const named = afterName(tokens, skipWords(tokens, 2, 'IF', 'EXISTS'))
		const isRename = named !== undefined && upperWord(tokens[named]) === 'RENAME' && upperWord(tokens[named + 1]) === 'TO'
		return isRename ? undefined : 'ALTER INDEX other than RENAME TO'
	}
	if (first === 'CREATE' && second === 'TYPE') {
		const named = afterName(tokens, 2)
		const isEnum = named !== undefined && upperWord(tokens[named]) === 'AS' && upperWord(tokens[named + 1]) === 'ENUM'
		return isEnum ? undefined : 'CREATE TYPE other than AS ENUM'
	}
	if (first === 'ALTER' && second === 'TYPE') {
		const named = afterName(tokens, 2)
		const action = named === undefined ? undefined : upperWord(tokens[named])
		const isValue = named !== undefined && (action === 'ADD' || action === 'RENAME') && upperWord(tokens[named + 1]) === 'VALUE'
		return isValue ? undefined : 'ALTER TYPE other than ADD VALUE or RENAME VALUE'
	}
	return label
}

/** Why one statement is outside the allowlist, as the label the refusal names, or `undefined` when it is inside. */
function disallowedForm(tokens: readonly SqlToken[], schema: string): string | undefined {
	const [first, second] = [upperWord(tokens[0]), upperWord(tokens[1])]
	// The kind of object follows CREATE, ALTER and DROP; after any other first word comes a name or an expression.
	const kind = first === 'CREATE' || first === 'ALTER' || first === 'DROP' ? second : undefined
	const label = [first, kind].filter((word) => word !== undefined).join(' ') || firstTokenLabel(tokens[0])
	if (first === 'INSERT' || first === 'UPDATE' || first === 'DELETE') {
		const reached = dmlSchema(tokens, schema)
		return reached === undefined ? undefined : `${first} reaching the schema ${reached}`
	}
	if (first === 'COMMENT' && second === 'ON') return undefined
	const form = disallowedDdlForm(tokens, label)
	if (form !== undefined) return form
	const reached = qualifiedSchema(tokens, schema)
	return reached === undefined ? undefined : `${label} naming the schema ${reached}`
}

/**
 * The first top-level statement of an application migration outside the allowlist, with its line:
 *
 * - `CREATE TABLE` with a column list and nothing after it, `LIKE` only without `INCLUDING`;
 * - `ALTER TABLE` with clauses ADD/DROP [COLUMN | CONSTRAINT], ALTER [COLUMN] TYPE/SET DATA TYPE/SET|DROP DEFAULT/
 *   SET|DROP NOT NULL/identity, VALIDATE CONSTRAINT, or one RENAME;
 * - `CREATE [UNIQUE] INDEX`, `ALTER INDEX … RENAME TO`, `CREATE TYPE … AS ENUM`, `ALTER TYPE … ADD|RENAME VALUE`;
 * - `DROP` of a table, an index, a type or leftover database code, `TRUNCATE`, `COMMENT ON`;
 * - `INSERT`, `UPDATE` and `DELETE` for a backfill. `WITH` and `MERGE` are refused.
 *
 * Each names no schema but `schema`: a DDL statement no qualified name at all, a DML statement no qualified relation,
 * call or type. Everything else is refused, `COPY`, `SELECT`, `DO`, `CREATE FUNCTION` and `GRANT` included, because
 * the data layer cannot see what it does and some of it (`COPY … PROGRAM`) escapes the migration's transaction.
 */
export function disallowedStatement(sql: string, schema: string): { readonly statement: string; readonly line: number } | undefined {
	for (const { tokens, line } of topLevelStatements(sql)) {
		const statement = disallowedForm(tokens, schema)
		if (statement !== undefined) return { statement, line }
	}
	return undefined
}
