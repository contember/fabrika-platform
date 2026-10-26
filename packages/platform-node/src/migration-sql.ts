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

/** Postgres' `space` (scan.l). Every other character from U+0080 up, a no-break space included, is part of a name. */
const isSpace = (char: string): boolean => /[ \t\n\r\f\v]/.test(char)
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
	/** `text` is the literal's value for a plain `'…'` string; an `E'…'` string, whose escapes are not decoded, has none. */
	| { readonly kind: 'string'; readonly text: string | undefined; readonly line: number }
	| { readonly kind: 'dollar'; readonly body: string; readonly line: number }
	| { readonly kind: 'punct'; readonly char: string; readonly line: number }

/**
 * The tokens of `sql`. Comments (`--`, nested `/* *\/`), string literals (`''`, `E''` with backslash escapes), quoted
 * identifiers (`""` unescaped) and dollar-quoted bodies are each one token, so a keyword inside them is no word.
 */
export function sqlTokens(sql: string): SqlToken[] {
	return lexSql(sql).tokens
}

/**
 * The tokens of `sql`, and the line of the first string, quoted identifier, dollar-quoted body or block comment that
 * never closes. Text after it is one token, which a check of names cannot read.
 */
export function lexSql(sql: string): { readonly tokens: SqlToken[]; readonly unterminated: number | undefined } {
	const tokens: SqlToken[] = []
	let unterminated: number | undefined
	const open = (closed: boolean, at: number): void => {
		if (!closed) unterminated ??= at
	}
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
		const tag = char === '$' ? dollarTagAt(sql, index) : undefined
		if (char === '\n') {
			line++
			index++
		} else if (isSpace(char)) {
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
			open(nesting === 0, line)
			skipTo(at)
		} else if (char === "'" || ((char === 'E' || char === 'e') && next === "'")) {
			const escapes = char !== "'"
			const startLine = line
			let at = index + (escapes ? 2 : 1)
			let text = ''
			while (at < sql.length) {
				if (escapes && sql[at] === '\\') at += 2
				else if (sql[at] === "'" && sql[at + 1] === "'") {
					text += "'"
					at += 2
				} else if (sql[at] === "'") break
				else text += sql[at++] ?? ''
			}
			tokens.push({ kind: 'string', text: escapes ? undefined : text, line: startLine })
			open(at < sql.length, startLine)
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
			open(at < sql.length, startLine)
			skipTo(at + 1)
		} else if (tag !== undefined) {
			const end = sql.indexOf(tag, index + tag.length)
			tokens.push({ kind: 'dollar', body: sql.slice(index + tag.length, end === -1 ? sql.length : end), line })
			open(end !== -1, line)
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
	return { tokens, unterminated }
}

export interface Statement {
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
export function topLevelStatements(sql: string): Statement[] {
	return statementsOf(sqlTokens(sql))
}

/** Splits lexed text into its statements at every `;` token: `topLevelStatements` over any lexer's tokens. */
export function statementsOf(all: readonly SqlToken[]): Statement[] {
	const statements: Statement[] = []
	let tokens: SqlToken[] = []
	for (const token of all) {
		if (token.kind === 'punct' && token.char === ';') {
			if (tokens[0] !== undefined) statements.push({ tokens, line: tokens[0].line })
			tokens = []
		} else tokens.push(token)
	}
	if (tokens[0] !== undefined) statements.push({ tokens, line: tokens[0].line })
	return statements
}

export const upperWord = (token: SqlToken | undefined): string | undefined => (token?.kind === 'word' ? token.text.toUpperCase() : undefined)

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
