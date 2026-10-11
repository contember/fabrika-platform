/**
 * Statements a migration file may not contain at the top level: they end or split the runner's transaction, or
 * change the session settings (timeouts, `search_path`, role) the runner owns. `SET` covers `SET ROLE` and
 * `SET SESSION AUTHORIZATION`; `COMMIT` and `ROLLBACK` cover their `PREPARED` forms.
 */
const REFUSED_FIRST_WORDS: ReadonlySet<string> = new Set([
	'BEGIN',
	'START',
	'COMMIT',
	'END',
	'ROLLBACK',
	'ABORT',
	'SAVEPOINT',
	'RELEASE',
	'SET',
	'RESET',
	'DISCARD',
	'LISTEN',
	'NOTIFY',
	'LOCK',
	'VACUUM',
	'CALL',
])

/**
 * What an application migration's `CREATE [OR REPLACE] …` may not make: database code, which runs on a later write
 * where the data layer cannot see it, or binds a function to run implicitly. `SCHEMA` because the runner creates the
 * application's one schema, and a `CREATE SCHEMA` may carry `CREATE TRIGGER` and `GRANT` as its elements.
 */
const EXECUTABLE_OBJECTS: ReadonlySet<string> = new Set([
	'FUNCTION',
	'PROCEDURE',
	'TRIGGER',
	'RULE',
	'VIEW',
	'POLICY',
	'EXTENSION',
	'LANGUAGE',
	'AGGREGATE',
	'OPERATOR',
	'CAST',
	'CONVERSION',
	'TRANSFORM',
	'SCHEMA',
])

/** Words between `CREATE [OR REPLACE]` and the kind of object: `CREATE TEMP RECURSIVE VIEW`, `CREATE EVENT TRIGGER`. */
const CREATE_MODIFIERS: ReadonlySet<string> = new Set([
	'TEMP',
	'TEMPORARY',
	'RECURSIVE',
	'MATERIALIZED',
	'CONSTRAINT',
	'EVENT',
	'TRUSTED',
	'PROCEDURAL',
	'DEFAULT',
])

/** Top-level statements an application migration may not contain besides those `CREATE`s. */
const EXECUTABLE_FIRST_WORDS: ReadonlySet<string> = new Set(['DO', 'GRANT', 'REVOKE'])

/** The functions a column default may call; anything else it calls runs on every insert, unseen by the data layer. */
const DEFAULT_FUNCTIONS: ReadonlySet<string> = new Set(['now', 'gen_random_uuid'])

/**
 * Words that end a column default's expression at its own depth: none of them may continue an expression there, so
 * what follows (a `CHECK`, `REFERENCES t (id)`, `AS IDENTITY (…)`, `WHERE`) is not part of the default.
 */
const DEFAULT_ENDS: ReadonlySet<string> = new Set([
	'AS',
	'CHECK',
	'CONSTRAINT',
	'DEFERRABLE',
	'DELETE',
	'DO',
	'FOR',
	'FROM',
	'GENERATED',
	'INITIALLY',
	'INSERT',
	'ON',
	'PARTITION',
	'PRIMARY',
	'REFERENCES',
	'RETURNING',
	'TABLESPACE',
	'UNIQUE',
	'UPDATE',
	'USING',
	'VALUES',
	'WHERE',
])

/** How many leading words `statementStarts` reports: enough for `CREATE OR REPLACE TRUSTED PROCEDURAL LANGUAGE`. */
const LEADING_WORDS = 6

export interface StatementStart {
	/** The leading words of a top-level statement, upper-cased, up to the first non-word token and at most six. */
	readonly words: readonly string[]
	/** 1-based line of the statement's first word. */
	readonly line: number
}

const isWordStart = (char: string): boolean => /[A-Za-z_\u0080-\uffff]/.test(char)
const isWordPart = (char: string): boolean => /[A-Za-z0-9_$\u0080-\uffff]/.test(char)
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/

/** One lexical token of SQL: comments and whitespace are dropped; a literal or a quoted body keeps its contents. */
export type SqlToken =
	| { readonly kind: 'word'; readonly text: string; readonly line: number }
	| { readonly kind: 'quoted'; readonly text: string; readonly line: number }
	| { readonly kind: 'string'; readonly line: number }
	| { readonly kind: 'dollar'; readonly body: string; readonly line: number }
	| { readonly kind: 'punct'; readonly char: string; readonly line: number }

/**
 * The tokens of `sql`. Comments (`--`, nested `/* *\/`), string literals (`''`, `E''` with backslash escapes), quoted
 * identifiers (`""` unescaped) and dollar-quoted bodies are each one token, so a keyword inside them is no word.
 */
export function sqlTokens(sql: string): SqlToken[] {
	const tokens: SqlToken[] = []
	let line = 1
	let index = 0
	/** Moves to `end`, counting the newlines it passes. */
	const skipTo = (end: number): void => {
		for (let at = index; at < end && at < sql.length; at++) if (sql[at] === '\n') line++
		index = Math.min(end, sql.length)
	}
	while (index < sql.length) {
		const char = sql[index] ?? ''
		const next = sql[index + 1] ?? ''
		if (char === '\n') {
			line++
			index++
		} else if (/\s/.test(char)) {
			index++
		} else if (char === '-' && next === '-') {
			const end = sql.indexOf('\n', index)
			skipTo(end === -1 ? sql.length : end)
		} else if (char === '/' && next === '*') {
			let nesting = 0
			let at = index
			while (at < sql.length) {
				if (sql[at] === '/' && sql[at + 1] === '*') {
					nesting++
					at += 2
				} else if (sql[at] === '*' && sql[at + 1] === '/') {
					nesting--
					at += 2
					if (nesting === 0) break
				} else at++
			}
			skipTo(at)
		} else if (char === "'" || ((char === 'E' || char === 'e') && next === "'")) {
			tokens.push({ kind: 'string', line })
			const escapes = char !== "'"
			let at = index + (escapes ? 2 : 1)
			while (at < sql.length) {
				if (escapes && sql[at] === '\\') at += 2
				else if (sql[at] === "'" && sql[at + 1] === "'") at += 2
				else if (sql[at] === "'") break
				else at++
			}
			skipTo(at + 1)
		} else if (char === '"') {
			const startLine = line
			let at = index + 1
			let text = ''
			while (at < sql.length) {
				if (sql[at] === '"' && sql[at + 1] === '"') {
					text += '"'
					at += 2
				} else if (sql[at] === '"') break
				else text += sql[at++] ?? ''
			}
			tokens.push({ kind: 'quoted', text, line: startLine })
			skipTo(at + 1)
		} else if (char === '$' && DOLLAR_TAG.test(sql.slice(index, index + 64))) {
			const tag = DOLLAR_TAG.exec(sql.slice(index, index + 64))?.[0] ?? '$$'
			const end = sql.indexOf(tag, index + tag.length)
			tokens.push({ kind: 'dollar', body: sql.slice(index + tag.length, end === -1 ? sql.length : end), line })
			skipTo(end === -1 ? sql.length : end + tag.length)
		} else if (isWordStart(char)) {
			let at = index + 1
			while (at < sql.length && isWordPart(sql[at] ?? '')) at++
			tokens.push({ kind: 'word', text: sql.slice(index, at), line })
			index = at
		} else {
			tokens.push({ kind: 'punct', char, line })
			index++
		}
	}
	return tokens
}

/**
 * Splits SQL into top-level statements and reports how each begins. A keyword inside a comment, a literal, a quoted
 * identifier or a dollar-quoted body is not a statement, and a `;` inside parentheses does not end one.
 */
export function statementStarts(sql: string): StatementStart[] {
	const starts: StatementStart[] = []
	let words: string[] = []
	let wordsLine = 0
	let count = 0
	let depth = 0
	const finish = (): void => {
		if (count > 0) starts.push({ words, line: wordsLine })
		words = []
		count = 0
	}
	for (const token of sqlTokens(sql)) {
		if (token.kind === 'punct' && token.char === ';' && depth === 0) {
			finish()
			continue
		}
		if (token.kind === 'punct' && token.char === '(') depth++
		else if (token.kind === 'punct' && token.char === ')' && depth > 0) depth--
		if (count === 0) wordsLine = token.line
		if (token.kind === 'word' && count === words.length && words.length < LEADING_WORDS) words.push(token.text.toUpperCase())
		count++
	}
	finish()
	return starts
}

/** Whether a schema qualifier names another application's schema, a platform schema or `public`. */
function isForeignSchema(name: string): boolean {
	return name === 'public' || name.startsWith('app_') || name.startsWith('fabrika')
}

/**
 * The first schema-qualified reference of an application migration (`public.notes`, `"app_other".notes`) to a schema
 * that is not its own, also inside a dollar-quoted body. An application's names resolve through the runner's
 * `search_path`, its own schema; `pg_catalog.` stays allowed. Unquoted names are folded to lower case, as Postgres does.
 */
export function foreignSchemaReference(sql: string): { readonly schema: string; readonly line: number } | undefined {
	const tokens = sqlTokens(sql)
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]
		if (token === undefined) continue
		if (token.kind === 'dollar') {
			const inner = foreignSchemaReference(token.body)
			if (inner !== undefined) return { schema: inner.schema, line: token.line + inner.line - 1 }
			continue
		}
		const dot = tokens[index + 1]
		if ((token.kind !== 'word' && token.kind !== 'quoted') || dot?.kind !== 'punct' || dot.char !== '.') continue
		const schema = token.kind === 'word' ? token.text.toLowerCase() : token.text
		if (isForeignSchema(schema)) return { schema, line: token.line }
	}
	return undefined
}

/** The first refused top-level statement of a migration file, or `undefined`. */
export function refusedStatement(sql: string): { readonly statement: string; readonly line: number } | undefined {
	for (const start of statementStarts(sql)) {
		const [first, second] = start.words
		if (first === undefined) continue
		if (REFUSED_FIRST_WORDS.has(first)) return { statement: first, line: start.line }
		if (first === 'PREPARE' && second === 'TRANSACTION') return { statement: 'PREPARE TRANSACTION', line: start.line }
	}
	return undefined
}

/** `CREATE OR REPLACE TRIGGER` → `CREATE TRIGGER`; the label of a refused statement, or `undefined` when allowed. */
function executableLabel(words: readonly string[]): string | undefined {
	const [first, second] = words
	if (first === undefined) return undefined
	if (EXECUTABLE_FIRST_WORDS.has(first)) return first
	if (first === 'ALTER' && second === 'DEFAULT') return 'ALTER DEFAULT PRIVILEGES'
	if (first !== 'CREATE') return undefined
	const rest = second === 'OR' && words[2] === 'REPLACE' ? words.slice(3) : words.slice(1)
	const modifiers = rest.findIndex((word) => !CREATE_MODIFIERS.has(word))
	const object = modifiers === -1 ? undefined : rest[modifiers]
	if (object === undefined || !EXECUTABLE_OBJECTS.has(object)) return undefined
	return ['CREATE', ...rest.slice(0, modifiers + 1)].join(' ')
}

/**
 * The first top-level statement of an application migration that installs database code (a function, procedure,
 * trigger, rule, view, policy, extension or language, or a `DO` block) or changes grants. Such code would run on a
 * later write, past the data layer; the start check (`@fabrika/db/codegen`) finds one installed before this rule.
 */
export function executableStatement(sql: string): { readonly statement: string; readonly line: number } | undefined {
	for (const start of statementStarts(sql)) {
		const statement = executableLabel(start.words)
		if (statement !== undefined) return { statement, line: start.line }
	}
	return undefined
}

/** Past a cast's type name (`character varying(20)`, `timestamp(3) with time zone`, `text[]`); a type modifier is digits. */
function afterTypeName(tokens: readonly SqlToken[], from: number): number {
	let index = from
	while (index < tokens.length) {
		const token = tokens[index]
		if (token?.kind === 'punct' && (token.char === '.' || token.char === '[' || token.char === ']')) {
			index++
			continue
		}
		if (token?.kind !== 'word' && token?.kind !== 'quoted') return index
		if (token.kind === 'word' && DEFAULT_ENDS.has(token.text.toUpperCase())) return index
		const open = tokens[index + 1]
		if (open?.kind !== 'punct' || open.char !== '(') {
			index++
			continue
		}
		let close = index + 2
		while (/^[0-9,]$/.test(punctChar(tokens[close]))) close++
		// Anything but digits in the parentheses makes the word a call, which the caller must see.
		if (punctChar(tokens[close]) !== ')') return index
		index = close + 1
	}
	return index
}

function punctChar(token: SqlToken | undefined): string {
	return token?.kind === 'punct' ? token.char : ''
}

/** `pg_catalog` in `pg_catalog.now(`, read backwards from the function name at `index`. */
function qualifierOf(tokens: readonly SqlToken[], index: number): string | undefined {
	const dot = tokens[index - 1]
	const schema = tokens[index - 2]
	if (dot?.kind !== 'punct' || dot.char !== '.') return undefined
	if (schema?.kind === 'word') return schema.text.toLowerCase()
	if (schema?.kind === 'quoted') return schema.text
	return undefined
}

/**
 * The first function a default expression starting at `tokens[from]` calls that is not `now()` or `gen_random_uuid()`
 * (unqualified or in `pg_catalog`). The expression ends at a `,`, `;` or `)` of its own depth, or at a `DEFAULT_ENDS`
 * word there. Any word followed by `(` counts as a call, so `COALESCE(…)` is refused too; a cast's type modifier is not.
 */
function disallowedCall(tokens: readonly SqlToken[], from: number): { readonly call: string; readonly line: number } | undefined {
	let depth = 0
	for (let index = from; index < tokens.length; index++) {
		const token = tokens[index]
		if (token === undefined) break
		if (token.kind === 'punct') {
			if (token.char === '(') depth++
			else if (token.char === ')') {
				if (depth === 0) return undefined
				depth--
			} else if (depth === 0 && (token.char === ',' || token.char === ';')) return undefined
			else if (token.char === ':' && punctChar(tokens[index + 1]) === ':') index = afterTypeName(tokens, index + 2) - 1
			continue
		}
		if (token.kind === 'word' && depth === 0 && DEFAULT_ENDS.has(token.text.toUpperCase())) return undefined
		if ((token.kind !== 'word' && token.kind !== 'quoted') || punctChar(tokens[index + 1]) !== '(') continue
		const name = token.kind === 'word' ? token.text.toLowerCase() : token.text
		const qualifier = qualifierOf(tokens, index)
		if (DEFAULT_FUNCTIONS.has(name) && (qualifier === undefined || qualifier === 'pg_catalog')) continue
		return { call: qualifier === undefined ? name : `${qualifier}.${name}`, line: token.line }
	}
	return undefined
}

/**
 * The first column default of a migration (`DEFAULT <expression>` in a column definition, `SET DEFAULT`, a domain's)
 * that calls a function other than `now()` and `gen_random_uuid()`. `DEFAULT VALUES`, `= DEFAULT` and
 * `BY DEFAULT AS IDENTITY` hold no expression and pass.
 */
export function refusedDefault(sql: string): { readonly call: string; readonly line: number } | undefined {
	const tokens = sqlTokens(sql)
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]
		if (token?.kind !== 'word' || token.text.toUpperCase() !== 'DEFAULT') continue
		const refused = disallowedCall(tokens, index + 1)
		if (refused !== undefined) return refused
	}
	return undefined
}

/** The first disallowed call of one default expression as the catalog prints it (`pg_get_expr`), or `undefined`. */
export function defaultExpressionCall(expression: string): string | undefined {
	return disallowedCall(sqlTokens(expression), 0)?.call
}
