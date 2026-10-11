// What the names of one SQL statement reach: schemas, relations, framework tables and functions. Runtime-neutral,
// like the lexer: the migration classifier, the runner and `ctx.sql` (`@fabrika/platform-node/sql`) share it.

import { type SqlToken, upperWord } from './migration-sql'

export const isName = (token: SqlToken | undefined): boolean => token?.kind === 'word' || token?.kind === 'quoted'
export const isPunct = (token: SqlToken | undefined, char: string): boolean => token?.kind === 'punct' && token.char === char

/** Postgres' NAMEDATALEN - 1: a longer identifier is truncated, quoted or not. */
const MAX_IDENTIFIER_BYTES = 63
const encoder = new TextEncoder()

function truncateIdentifier(name: string): string {
	if (encoder.encode(name).length <= MAX_IDENTIFIER_BYTES) return name
	let truncated = ''
	let bytes = 0
	for (const char of name) {
		bytes += encoder.encode(char).length
		if (bytes > MAX_IDENTIFIER_BYTES) break
		truncated += char
	}
	return truncated
}

/** A name as Postgres stores it: an unquoted one with only ASCII folded to lower case, either truncated to 63 bytes. */
export function nameText(token: SqlToken | undefined): string | undefined {
	if (token?.kind === 'word') return truncateIdentifier(token.text.replace(/[A-Z]/g, (char) => char.toLowerCase()))
	if (token?.kind === 'quoted') return truncateIdentifier(token.text)
	return undefined
}

/** The index past a name at `index`, schema-qualified or not, or `undefined` when no name is there. */
export function afterName(tokens: readonly SqlToken[], index: number): number | undefined {
	if (!isName(tokens[index])) return undefined
	return isPunct(tokens[index + 1], '.') && isName(tokens[index + 2]) ? index + 3 : index + 1
}

/** A possibly schema-qualified object name: `qualifier` is set only when the statement wrote one. */
export interface ObjectName {
	readonly qualifier: string | undefined
	readonly name: string
}

/** The name at `index` (`name` or `schema.name`), or `undefined`. */
export function objectNameAt(tokens: readonly SqlToken[], index: number): ObjectName | undefined {
	const first = nameText(tokens[index])
	if (first === undefined) return undefined
	const second = isPunct(tokens[index + 1], '.') ? nameText(tokens[index + 2]) : undefined
	return second === undefined ? { qualifier: undefined, name: first } : { qualifier: first, name: second }
}

/** The index past the words `words` at `index`, or `index` itself when they are not all there. */
export function skipWords(tokens: readonly SqlToken[], index: number, ...words: readonly string[]): number {
	return words.every((word, offset) => upperWord(tokens[index + offset]) === word) ? index + words.length : index
}

/** The token lists between the commas at parenthesis depth 0 of `tokens`. */
export function splitAtCommas(tokens: readonly SqlToken[]): SqlToken[][] {
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
export function closingParenthesis(tokens: readonly SqlToken[], open: number): number | undefined {
	let depth = 0
	for (let index = open; index < tokens.length; index++) {
		if (isPunct(tokens[index], '(')) depth++
		else if (isPunct(tokens[index], ')') && --depth === 0) return index
	}
	return undefined
}

/** The index of the first word `word` at parenthesis depth 0 at or after `from`, or `undefined`. */
export function wordAtDepthZero(tokens: readonly SqlToken[], word: string, from = 0): number | undefined {
	let depth = 0
	for (let index = from; index < tokens.length; index++) {
		if (isPunct(tokens[index], '(')) depth++
		else if (isPunct(tokens[index], ')')) depth--
		else if (depth === 0 && upperWord(tokens[index]) === word) return index
	}
	return undefined
}

/**
 * What a statement is, for a refusal to name: its first word, and after `CREATE`, `ALTER` or `DROP` (past `OR
 * REPLACE`) the kind of object. A statement that does not begin with a word is named by its first token.
 */
export function statementKind(tokens: readonly SqlToken[]): string {
	const first = upperWord(tokens[0])
	if (first === undefined) {
		const token = tokens[0]
		if (token?.kind === 'punct') return token.char
		if (token?.kind === 'quoted') return `"${token.text}"`
		return 'a statement'
	}
	if (first !== 'CREATE' && first !== 'ALTER' && first !== 'DROP') return first
	const kind = upperWord(tokens[skipWords(tokens, 1, 'OR', 'REPLACE')])
	return kind === undefined ? first : `${first} ${kind}`
}

/**
 * The first schema a DDL statement names other than `schema`, `pg_catalog` included: every qualified name counts,
 * since a DDL statement has no table alias to qualify a column with, and so does any unqualified `pg_…` name, which
 * resolves to the catalog (`LIKE pg_authid`, `REFERENCES pg_class`).
 */
export function ddlForeignSchema(tokens: readonly SqlToken[], schema: string): string | undefined {
	for (let index = 0; index < tokens.length; index++) {
		const name = nameText(tokens[index])
		if (name === undefined) continue
		if (isPunct(tokens[index + 1], '.')) {
			if (name !== schema) return name
			index += 2
		} else if (name.startsWith('pg_')) return 'pg_catalog'
	}
	return undefined
}

/** How a name is used where it stands; `operator` is the operator `OPERATOR(schema.op)` names. */
export type NameRole = 'relation' | 'call' | 'type' | 'operator' | 'other'

/** One name of a statement: `qualifier` is the first part of a two- or three-part name. */
export interface NameReference {
	readonly qualifier: string | undefined
	readonly name: string
	readonly parts: number
	readonly role: NameRole
	readonly line: number
}

/** Words after which a name is a relation that a column list may follow (`INSERT INTO t (a)`), never a call. */
const RELATION_WITH_COLUMNS: ReadonlySet<string> = new Set(['INTO', 'UPDATE', 'TABLE', 'REFERENCES'])

/** Words after which a name is a relation, or a table function when `(` follows it (`FROM generate_series(1, 3)`). */
const RELATION_OR_FUNCTION: ReadonlySet<string> = new Set(['FROM', 'JOIN', 'USING'])

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
	'INTO',
	'LOOP',
	'THEN',
])

/** Functions whose `FROM` is an argument (`EXTRACT(epoch FROM t.at)`), not a relation list. */
const FROM_ARGUMENT_FUNCTIONS: ReadonlySet<string> = new Set(['EXTRACT', 'SUBSTRING', 'TRIM', 'OVERLAY', 'POSITION', 'NORMALIZE'])

/** Words a `(` may follow without making them a call: syntax, not functions. */
const NOT_CALLS: ReadonlySet<string> = new Set([
	'ALL',
	'ALSO',
	'AND',
	'ANY',
	'ARRAY',
	'AS',
	'ASSERT',
	'BETWEEN',
	'BY',
	'CASE',
	'CAST',
	'CHECK',
	'COALESCE',
	'CONFLICT',
	'CUBE',
	'CURRENT_TIME',
	'CURRENT_TIMESTAMP',
	'CURSOR',
	'DEFAULT',
	'DISTINCT',
	'DO',
	'ELSE',
	'ELSIF',
	'ELSEIF',
	'ESCAPE',
	'EXCEPT',
	'EXISTS',
	'FILTER',
	'FROM',
	'GREATEST',
	'GROUPING',
	'HAVING',
	'IDENTITY',
	'IF',
	'ILIKE',
	'IN',
	'INCLUDE',
	'INSTEAD',
	'INTERSECT',
	'IS',
	'JOIN',
	'KEY',
	'LATERAL',
	'LEAST',
	'LIKE',
	'LIMIT',
	'LOCALTIME',
	'LOCALTIMESTAMP',
	'MATERIALIZED',
	'NEXT',
	'NOT',
	'NULLIF',
	'OFFSET',
	'ON',
	'OR',
	'OVER',
	'PERFORM',
	'QUERY',
	'RETURN',
	'RETURNING',
	'ROLLUP',
	'ROW',
	'ROWS',
	'SELECT',
	'SET',
	'SETS',
	'SIMILAR',
	'SOME',
	'TABLE',
	'THEN',
	'TO',
	'UNION',
	'UNIQUE',
	'USING',
	'VALUES',
	'WHEN',
	'WHERE',
	'WHILE',
	'WITH',
	'WITHIN',
])

/** Type names a modifier in parentheses follows (`varchar(80)`, `timestamp(3)`): a type, not a call. */
const MODIFIED_TYPES: ReadonlySet<string> = new Set([
	'BIT',
	'BPCHAR',
	'CHAR',
	'CHARACTER',
	'DEC',
	'DECIMAL',
	'FLOAT',
	'INTERVAL',
	'NUMERIC',
	'TIME',
	'TIMESTAMP',
	'TIMESTAMPTZ',
	'TIMETZ',
	'VARBIT',
	'VARCHAR',
	'VARYING',
])

/** `columns`: a column list may follow; `function`: a table function may; `list`: a `FROM` list, which `(` may group. */
type RelationSlot = 'columns' | 'function' | 'list' | undefined

/**
 * Every name of a DML statement, a query or an expression, with its role. A name in a relation position (after
 * `FROM`, `JOIN`, `USING`, `INTO`, `UPDATE`, `TABLE`, `REFERENCES`, or a `,` of a `FROM` list) is a relation; a name
 * that `(` follows is a call, unless it is syntax or a type with a modifier; a name after `::` or `AS` is a type. A
 * two-part name anywhere else is a column of a table or an alias (`d.note`, `NEW.stage`).
 */
export function nameReferences(tokens: readonly SqlToken[]): NameReference[] {
	const references: NameReference[] = []
	const lists: { fromList: boolean; opener: string | undefined }[] = [{ fromList: false, opener: undefined }]
	let slot: RelationSlot
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]
		const top = lists[lists.length - 1] ?? { fromList: false, opener: undefined }
		const word = upperWord(token)
		if (isPunct(token, ';')) {
			lists.splice(0, lists.length, { fromList: false, opener: undefined })
			slot = undefined
			continue
		}
		if (isPunct(token, '(')) {
			// `FROM (a JOIN b)` and `FROM ONLY (t)` group relations: the first name inside is still one.
			const grouping = slot === 'list'
			lists.push({ fromList: grouping, opener: upperWord(tokens[index - 1]) })
			slot = grouping ? 'list' : undefined
			continue
		}
		if (isPunct(token, ')')) {
			if (lists.length > 1) lists.pop()
			slot = undefined
			continue
		}
		if (isPunct(token, ',')) {
			slot = top.fromList ? 'list' : undefined
			continue
		}
		if (word !== undefined && LIST_ENDS.has(word)) top.fromList = false
		if (word !== undefined && RELATION_OR_FUNCTION.has(word)) {
			// `EXCLUDE USING gist (…)` names an index method, which is neither a relation nor a call.
			if (word === 'USING' && upperWord(tokens[index - 1]) === 'EXCLUDE') {
				index++
				continue
			}
			const argument = word === 'FROM'
				&& (upperWord(tokens[index - 1]) === 'DISTINCT' || (top.opener !== undefined && FROM_ARGUMENT_FUNCTIONS.has(top.opener)))
			// `USING (…)` is a join's column list or a policy's expression, never a group of relations.
			slot = argument ? undefined : word === 'USING' ? 'function' : 'list'
			if (word !== 'JOIN') top.fromList = slot !== undefined
			continue
		}
		// `(expression).f(…)` calls `f` through field selection; no schema rule can read its target, so it is refused.
		if (isPunct(token, '.') && isPunct(tokens[index - 1], ')') && isName(tokens[index + 1]) && isPunct(tokens[index + 2], '(')) {
			references.push({ qualifier: '(…)', name: `(…).${nameText(tokens[index + 1]) ?? ''}`, parts: 2, role: 'call', line: token?.line ?? 0 })
			index++
			continue
		}
		if (word === 'OPERATOR' && isPunct(tokens[index + 1], '(')) {
			const close = closingParenthesis(tokens, index + 1) ?? tokens.length - 1
			const inner = tokens.slice(index + 2, close)
			const qualified = isName(inner[0]) && isPunct(inner[1], '.')
			const symbol = inner.slice(qualified ? 2 : 0).map((part) => (part.kind === 'punct' ? part.char : '')).join('')
			references.push({
				qualifier: qualified ? nameText(inner[0]) : undefined,
				name: symbol,
				parts: qualified ? 2 : 1,
				role: 'operator',
				line: token?.line ?? 0,
			})
			slot = undefined
			index = close
			continue
		}
		if (word !== undefined && RELATION_WITH_COLUMNS.has(word)) {
			slot = 'columns'
			continue
		}
		if (slot !== undefined && (word === 'ONLY' || word === 'LATERAL' || word === 'STRICT')) continue
		const inSlot = slot
		slot = undefined
		if (!isName(token)) continue
		const parts: string[] = [nameText(token) ?? '']
		let end = index
		while (parts.length < 3 && isPunct(tokens[end + 1], '.') && isName(tokens[end + 2])) {
			parts.push(nameText(tokens[end + 2]) ?? '')
			end += 2
		}
		const castTarget = (isPunct(tokens[index - 1], ':') && isPunct(tokens[index - 2], ':')) || upperWord(tokens[index - 1]) === 'AS'
		const followedByParenthesis = isPunct(tokens[end + 1], '(')
		const syntax = parts.length === 1 && token?.kind === 'word' && word !== undefined && (NOT_CALLS.has(word) || MODIFIED_TYPES.has(word))
		// PL/pgSQL `v t%ROWTYPE` and `v t.c%TYPE` read a relation; `ext.t 'literal'` is a typed literal.
		const percentType = isPunct(tokens[end + 1], '%') && (upperWord(tokens[end + 2]) === 'TYPE' || upperWord(tokens[end + 2]) === 'ROWTYPE')
		const typedLiteral = parts.length > 1 && tokens[end + 1]?.kind === 'string'
		let role: NameRole = 'other'
		if (castTarget || typedLiteral) role = 'type'
		else if (percentType) role = 'relation'
		else if (followedByParenthesis && !syntax && inSlot !== 'columns') role = 'call'
		else if (inSlot !== undefined) role = 'relation'
		references.push({
			qualifier: parts.length > 1 ? parts[0] : undefined,
			name: parts[parts.length - 1] ?? '',
			parts: parts.length,
			role,
			line: token?.line ?? 0,
		})
		index = end
	}
	return references
}

/**
 * The first schema a DML statement, a query or a function body reaches other than `schema`, `pg_catalog` included: a
 * qualified relation, call or type, or a three-part name. An unqualified relation whose name starts with `pg_`
 * resolves to the catalog and counts as `pg_catalog`.
 */
export function dmlForeignSchema(tokens: readonly SqlToken[], schema: string): string | undefined {
	for (const reference of nameReferences(tokens)) {
		if (reference.qualifier === undefined) {
			if (reference.role === 'relation' && reference.name.startsWith('pg_')) return 'pg_catalog'
			continue
		}
		// A field-selection call has no schema to reach; the call allowlist refuses it.
		if (reference.qualifier === schema || reference.qualifier === '(…)') continue
		if (reference.role === 'operator') {
			if (reference.qualifier !== 'pg_catalog') return reference.qualifier
			continue
		}
		if (reference.role !== 'other' || reference.parts === 3) return reference.qualifier
	}
	return undefined
}

/** Words that begin a statement. Of these only `NESTED_STATEMENTS` may stand in parentheses inside another one. */
const STATEMENT_WORDS: ReadonlySet<string> = new Set([
	'ABORT',
	'ALTER',
	'ANALYZE',
	'BEGIN',
	'CALL',
	'CHECKPOINT',
	'CLUSTER',
	'COMMENT',
	'COMMIT',
	'COPY',
	'CREATE',
	'DELETE',
	'DISCARD',
	'DO',
	'DROP',
	'EXECUTE',
	'EXPLAIN',
	'GRANT',
	'IMPORT',
	'INSERT',
	'LISTEN',
	'LOAD',
	'LOCK',
	'MERGE',
	'NOTIFY',
	'PREPARE',
	'REFRESH',
	'REINDEX',
	'RELEASE',
	'RESET',
	'REVOKE',
	'ROLLBACK',
	'SAVEPOINT',
	'SECURITY',
	'SELECT',
	'SET',
	'TABLE',
	'TRUNCATE',
	'UPDATE',
	'VACUUM',
	'VALUES',
	'WITH',
])
const NESTED_STATEMENTS: ReadonlySet<string> = new Set(['SELECT', 'VALUES', 'WITH', 'TABLE', 'INSERT', 'UPDATE', 'DELETE'])

/** The statement a `WITH name [(…)] AS [[NOT] MATERIALIZED] (…), …` at `index` ends in, or `undefined` if it is no CTE list. */
function withTerminal(tokens: readonly SqlToken[], index: number): SqlToken | undefined {
	let at = skipWords(tokens, index + 1, 'RECURSIVE')
	for (;;) {
		if (!isName(tokens[at])) return undefined
		at++
		if (isPunct(tokens[at], '(')) at = (closingParenthesis(tokens, at) ?? tokens.length) + 1
		if (upperWord(tokens[at]) !== 'AS') return undefined
		at = skipWords(tokens, skipWords(tokens, at + 1, 'NOT'), 'MATERIALIZED')
		if (!isPunct(tokens[at], '(')) return undefined
		at = (closingParenthesis(tokens, at) ?? tokens.length) + 1
		if (!isPunct(tokens[at], ',')) return tokens[at]
		at++
	}
}

/**
 * The first nested statement a nested position may not hold: in parentheses (a CTE body, a subquery) and after a
 * CTE list, anything but a query or `INSERT`/`UPDATE`/`DELETE`, whose names the same checks read. `MERGE` among them.
 */
export function nestedStatement(tokens: readonly SqlToken[]): { readonly statement: string; readonly line: number } | undefined {
	for (let index = 0; index + 1 < tokens.length; index++) {
		const next = isPunct(tokens[index], '(') ? tokens[index + 1] : upperWord(tokens[index]) === 'WITH' ? withTerminal(tokens, index) : undefined
		const word = next?.kind === 'word' ? upperWord(next) : undefined
		if (word !== undefined && STATEMENT_WORDS.has(word) && !NESTED_STATEMENTS.has(word)) return { statement: word, line: next?.line ?? 1 }
		if (upperWord(tokens[index]) === 'WITH' && next !== undefined && word === undefined) return { statement: 'WITH', line: next.line }
	}
	return undefined
}

/**
 * The first data-changing statement whose target is in parentheses (`UPDATE ONLY (t)`, `DELETE FROM (t)`): the
 * classifier reads a target as the name after the keyword, so it refuses the form rather than read through a group.
 */
export function parenthesizedTarget(tokens: readonly SqlToken[]): { readonly statement: string; readonly line: number } | undefined {
	for (let index = 0; index < tokens.length; index++) {
		const word = upperWord(tokens[index])
		let at: number
		if (word === 'UPDATE' || word === 'INTO') at = index + 1
		else if (word === 'DELETE' && upperWord(tokens[index + 1]) === 'FROM') at = index + 2
		else continue
		at = skipWords(tokens, at, 'ONLY')
		if (isPunct(tokens[at], '(')) return { statement: word, line: tokens[at]?.line ?? 1 }
	}
	return undefined
}

/** The relations a DML statement or a query names, in order: what its static text reads or writes. */
export function dmlRelations(tokens: readonly SqlToken[]): NameReference[] {
	return nameReferences(tokens).filter((reference) => reference.role === 'relation')
}

/**
 * Whether a name is the framework's (`fabrika_…`): its tables share the application's schema and hold its secrets,
 * leases and deliveries. Case-insensitive, so a quoted `"FABRIKA_x"` counts too.
 */
export function isFrameworkName(name: string): boolean {
	return name.toLowerCase().startsWith('fabrika_')
}

/** The first framework name among `tokens` that `allowed` does not hold, with its line. */
export function frameworkReference(
	tokens: readonly SqlToken[],
	allowed: ReadonlySet<string> = new Set(),
): { readonly name: string; readonly line: number } | undefined {
	for (const token of tokens) {
		const name = nameText(token)
		if (name !== undefined && isFrameworkName(name) && !allowed.has(name)) return { name, line: token.line }
	}
	return undefined
}

/** `U&"…"`: an identifier whose escapes the lexer does not decode, so a name rule cannot read it. */
export function unicodeIdentifier(tokens: readonly SqlToken[]): { readonly line: number } | undefined {
	for (let index = 0; index + 2 < tokens.length; index++) {
		const token = tokens[index]
		if (token?.kind === 'word' && token.text.toUpperCase() === 'U' && isPunct(tokens[index + 1], '&') && tokens[index + 2]?.kind === 'quoted') {
			return { line: token.line }
		}
	}
	return undefined
}

/**
 * Reviewed `pg_catalog` functions a stored expression may call without a deviation: no side effect, no read of
 * another row, no SQL run from a string. Trusted by name, resolved unqualified.
 */
const PAVED_FUNCTIONS: ReadonlySet<string> = new Set([
	'now',
	'gen_random_uuid',
	'lower',
	'upper',
	'length',
	'char_length',
	'octet_length',
	'btrim',
	'ltrim',
	'rtrim',
	'trim',
	'abs',
	'round',
	'trunc',
	'floor',
	'ceil',
	'ceiling',
	'date_trunc',
	'timezone',
	'date_part',
	'extract',
	'array_length',
	'cardinality',
	'to_tsvector',
	'to_tsquery',
	'int2',
	'int4',
	'int8',
	'float4',
	'float8',
	'numeric',
	'text',
	'varchar',
	'bpchar',
	'bool',
	'date',
	'time',
	'timetz',
	'timestamp',
	'timestamptz',
	'interval',
])

/**
 * Reviewed `pg_catalog` functions a function body, a view or a backfill may call, and a stored expression may call as
 * a deviation: pure string, number, date, JSON, array, text-search and aggregate functions, `pg_sleep`, and the
 * built-in trigger function. None runs SQL from a string, touches a file, a large object, a lock, a setting, another
 * database or a sequence named by a string.
 */
const REVIEWED_FUNCTIONS: ReadonlySet<string> = new Set([
	'concat',
	'concat_ws',
	'format',
	'substring',
	'substr',
	'replace',
	'split_part',
	'strpos',
	'position',
	'overlay',
	'left',
	'right',
	'lpad',
	'rpad',
	'repeat',
	'reverse',
	'initcap',
	'translate',
	'regexp_replace',
	'regexp_match',
	'regexp_matches',
	'regexp_split_to_array',
	'starts_with',
	'md5',
	'sha256',
	'encode',
	'to_char',
	'to_date',
	'to_timestamp',
	'to_number',
	'mod',
	'power',
	'sqrt',
	'exp',
	'ln',
	'log',
	'sign',
	'div',
	'random',
	'age',
	'clock_timestamp',
	'statement_timestamp',
	'transaction_timestamp',
	'make_date',
	'make_time',
	'make_timestamp',
	'make_timestamptz',
	'make_interval',
	'date_bin',
	'justify_days',
	'justify_hours',
	'isfinite',
	'to_json',
	'to_jsonb',
	'json_build_object',
	'jsonb_build_object',
	'json_build_array',
	'jsonb_build_array',
	'json_agg',
	'jsonb_agg',
	'json_object_agg',
	'jsonb_object_agg',
	'jsonb_set',
	'jsonb_insert',
	'jsonb_strip_nulls',
	'jsonb_typeof',
	'json_typeof',
	'jsonb_array_length',
	'json_array_length',
	'jsonb_array_elements',
	'jsonb_array_elements_text',
	'jsonb_each',
	'jsonb_each_text',
	'jsonb_object_keys',
	'jsonb_extract_path',
	'jsonb_extract_path_text',
	'jsonb_pretty',
	'row_to_json',
	'array_agg',
	'array_append',
	'array_prepend',
	'array_cat',
	'array_remove',
	'array_replace',
	'array_position',
	'array_positions',
	'array_to_string',
	'string_to_array',
	'array_upper',
	'array_lower',
	'unnest',
	'generate_series',
	'generate_subscripts',
	'count',
	'sum',
	'avg',
	'min',
	'max',
	'bool_and',
	'bool_or',
	'every',
	'string_agg',
	'row_number',
	'rank',
	'dense_rank',
	'lag',
	'lead',
	'first_value',
	'last_value',
	'num_nonnulls',
	'num_nulls',
	'ts_rank',
	'ts_headline',
	'plainto_tsquery',
	'phraseto_tsquery',
	'websearch_to_tsquery',
	'setweight',
	'pg_sleep',
	'suppress_redundant_updates_trigger',
])

/** How a call is admitted: `paved` and `reviewed` built-ins, `expression`-only ones, and the migrations' own functions. */
export type FunctionUse = 'paved' | 'reviewed' | 'declared'

/**
 * How a call of `call` is admitted, or `undefined` when it is not. A function the migrations declare in `schema` may be
 * called unqualified or qualified with `schema`; a built-in only unqualified, since a qualified one names `pg_catalog`.
 */
export function functionUse(call: NameReference, schema: string, functions: ReadonlySet<string>): FunctionUse | undefined {
	if (call.parts > 2 || (call.qualifier !== undefined && call.qualifier !== schema)) return undefined
	if (functions.has(call.name)) return 'declared'
	if (call.qualifier !== undefined) return undefined
	if (PAVED_FUNCTIONS.has(call.name)) return 'paved'
	if (REVIEWED_FUNCTIONS.has(call.name)) return 'reviewed'
	return undefined
}

/**
 * The first call among `tokens` that a body, a query or a backfill may not make: anything but a paved or reviewed
 * built-in, or a function the migrations declare in `schema`. An allowlist, because a built-in such as
 * `query_to_xml`, `dblink` or `lo_import` runs SQL from a string or reaches past the schema, which no name rule sees.
 */
export function refusedFunctionCall(tokens: readonly SqlToken[], schema: string, functions: ReadonlySet<string>): NameReference | undefined {
	for (const reference of nameReferences(tokens)) {
		if (reference.role !== 'call') continue
		const use = functionUse(reference, schema, functions)
		if (use === undefined) return reference
	}
	return undefined
}
