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

export interface StatementStart {
	/** The first two words of a top-level statement, upper-cased; fewer when the statement has fewer. */
	readonly words: readonly string[]
	/** 1-based line of the statement's first word. */
	readonly line: number
}

const isWordStart = (char: string): boolean => /[A-Za-z_\u0080-\uffff]/.test(char)
const isWordPart = (char: string): boolean => /[A-Za-z0-9_$\u0080-\uffff]/.test(char)
/** Sticky: matched at a position of the whole text, since a tag has no length limit. */
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y

function dollarTagAt(sql: string, index: number): string | undefined {
	DOLLAR_TAG.lastIndex = index
	return DOLLAR_TAG.exec(sql)?.[0]
}

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
			// Postgres ends a comment at a line feed or a carriage return, so a CR-only line ending ends one too.
			let end = index + 2
			while (end < sql.length && sql[end] !== '\n' && sql[end] !== '\r') end++
			skipTo(end)
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
		} else if (char === '$' && dollarTagAt(sql, index) !== undefined) {
			const tag = dollarTagAt(sql, index) ?? '$$'
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

interface Statement {
	/** The statement's tokens, without the `;` that ends it. */
	readonly tokens: readonly SqlToken[]
	/** 1-based line of the statement's first token. */
	readonly line: number
}

/**
 * Splits SQL into top-level statements at every `;` outside a comment, a literal, a quoted identifier or a
 * dollar-quoted body. Postgres admits a `;` inside parentheses only in a rule's actions, so splitting there too only
 * makes a check stricter.
 */
function topLevelStatements(sql: string): Statement[] {
	const statements: Statement[] = []
	let tokens: SqlToken[] = []
	for (const token of sqlTokens(sql)) {
		if (token.kind === 'punct' && token.char === ';') {
			if (tokens[0] !== undefined) statements.push({ tokens, line: tokens[0].line })
			tokens = []
		} else tokens.push(token)
	}
	if (tokens[0] !== undefined) statements.push({ tokens, line: tokens[0].line })
	return statements
}

const upperWord = (token: SqlToken | undefined): string | undefined => (token?.kind === 'word' ? token.text.toUpperCase() : undefined)

/** Reports how each top-level statement begins. A keyword inside a comment, a literal or a quoted body is no statement. */
export function statementStarts(sql: string): StatementStart[] {
	return topLevelStatements(sql).map(({ tokens, line }) => {
		const words: string[] = []
		for (const token of tokens.slice(0, 2)) {
			const word = upperWord(token)
			if (word === undefined) break
			words.push(word)
		}
		return { words, line }
	})
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

/** What an application migration may drop: its own tables, indexes and types, and any database code left from before. */
const DROPPABLE: ReadonlySet<string> = new Set([
	'TABLE',
	'INDEX',
	'TYPE',
	'TRIGGER',
	'FUNCTION',
	'PROCEDURE',
	'AGGREGATE',
	'RULE',
	'VIEW',
	'MATERIALIZED',
	'POLICY',
	'SEQUENCE',
	'DOMAIN',
	'OPERATOR',
])

/** The index past a name at `index`, schema-qualified or not, or `undefined` when no name is there. */
function afterName(tokens: readonly SqlToken[], index: number): number | undefined {
	const isName = (token: SqlToken | undefined): boolean => token?.kind === 'word' || token?.kind === 'quoted'
	if (!isName(tokens[index])) return undefined
	const dot = tokens[index + 1]
	return dot?.kind === 'punct' && dot.char === '.' && isName(tokens[index + 2]) ? index + 3 : index + 1
}

/** The upper-cased words at parenthesis depth 0, so a keyword inside a column list or an expression is not one. */
function outerWords(tokens: readonly SqlToken[]): string[] {
	const words: string[] = []
	let depth = 0
	for (const token of tokens) {
		if (token.kind === 'punct' && token.char === '(') depth++
		else if (token.kind === 'punct' && token.char === ')') depth--
		else if (depth === 0 && token.kind === 'word') words.push(token.text.toUpperCase())
	}
	return words
}

const follows = (words: readonly string[], first: string, second: string): boolean =>
	words.some((word, index) => word === first && words[index + 1] === second)

/** Why one statement is outside the allowlist, as the label the refusal names, or `undefined` when it is inside. */
function disallowedForm(tokens: readonly SqlToken[]): string | undefined {
	const [first, second] = [upperWord(tokens[0]), upperWord(tokens[1])]
	// The kind of object follows CREATE, ALTER and DROP; after any other first word comes a name or an expression.
	const kind = first === 'CREATE' || first === 'ALTER' || first === 'DROP' ? second : undefined
	const label = [first, kind].filter((word) => word !== undefined).join(' ') || punctLabel(tokens[0])
	if (first === 'INSERT' || first === 'UPDATE' || first === 'DELETE') return undefined
	if (first === 'COMMENT' && second === 'ON') return undefined
	if (first === 'DROP') return second !== undefined && DROPPABLE.has(second) ? undefined : label
	if (first === 'CREATE' && (second === 'INDEX' || (second === 'UNIQUE' && upperWord(tokens[2]) === 'INDEX'))) return undefined
	if (first === 'CREATE' && second === 'TABLE') {
		// `LIKE … INCLUDING` copies defaults, constraints and indexes from a table the check has not seen.
		if (tokens.some((token) => upperWord(token) === 'INCLUDING')) return 'CREATE TABLE … LIKE … INCLUDING'
		return outerWords(tokens).includes('AS') ? 'CREATE TABLE … AS' : undefined
	}
	if (first === 'ALTER' && second === 'TABLE') {
		const words = outerWords(tokens)
		if (follows(words, 'SET', 'SCHEMA')) return 'ALTER TABLE … SET SCHEMA'
		return follows(words, 'OWNER', 'TO') ? 'ALTER TABLE … OWNER TO' : undefined
	}
	const named = afterName(tokens, 2)
	if (first === 'CREATE' && second === 'TYPE') {
		const isEnum = named !== undefined && upperWord(tokens[named]) === 'AS' && upperWord(tokens[named + 1]) === 'ENUM'
		return isEnum ? undefined : 'CREATE TYPE other than AS ENUM'
	}
	if (first === 'ALTER' && second === 'TYPE') {
		const action = named === undefined ? undefined : upperWord(tokens[named])
		const isValue = (action === 'ADD' || action === 'RENAME') && upperWord(tokens[(named ?? 0) + 1]) === 'VALUE'
		return isValue ? undefined : 'ALTER TYPE other than ADD VALUE or RENAME VALUE'
	}
	return label
}

function punctLabel(token: SqlToken | undefined): string {
	if (token?.kind === 'punct') return token.char
	if (token?.kind === 'quoted') return `"${token.text}"`
	return 'a statement'
}

/**
 * The first top-level statement of an application migration outside the allowlist: `CREATE TABLE` (without
 * `LIKE … INCLUDING` or `AS`), `ALTER TABLE` (without `SET SCHEMA` or `OWNER TO`), `CREATE [UNIQUE] INDEX`,
 * `CREATE TYPE … AS ENUM`, `ALTER TYPE … ADD VALUE`/`RENAME VALUE`, `DROP` of a table, an index, a type or leftover
 * database code, `COMMENT ON`, and `INSERT`/`UPDATE`/`DELETE` for a backfill. Everything else is refused, `COPY`,
 * `SELECT`, `DO`, `CREATE FUNCTION` and `GRANT` included, because the data layer cannot see what it does and some of it
 * (`COPY … PROGRAM`) escapes the migration's transaction. The expressions inside an allowed statement are Postgres'
 * to parse; `databaseCodeCheck` reads them from the catalog before the commit.
 */
export function disallowedStatement(sql: string): { readonly statement: string; readonly line: number } | undefined {
	for (const { tokens, line } of topLevelStatements(sql)) {
		const statement = disallowedForm(tokens)
		if (statement !== undefined) return { statement, line }
	}
	return undefined
}
