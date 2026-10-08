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

const isWordStart = (char: string): boolean => /[A-Za-z_\u0080-￿]/.test(char)
const isWordPart = (char: string): boolean => /[A-Za-z0-9_$\u0080-￿]/.test(char)
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/

/**
 * Splits SQL into top-level statements and reports how each begins. Comments (`--`, nested `/* *\/`), string
 * literals (`''`, `E''` with backslash escapes), quoted identifiers and dollar-quoted bodies are skipped, so a
 * keyword inside them is not a statement. A `;` inside parentheses does not end a statement.
 */
export function statementStarts(sql: string): StatementStart[] {
	const starts: StatementStart[] = []
	let words: string[] = []
	let wordsLine = 0
	let tokens = 0
	let depth = 0
	let line = 1
	let index = 0
	const finish = (): void => {
		if (tokens > 0) starts.push({ words, line: wordsLine })
		words = []
		tokens = 0
	}
	/** Moves to `end`, counting the newlines it passes. */
	const skipTo = (end: number): void => {
		for (let at = index; at < end && at < sql.length; at++) if (sql[at] === '\n') line++
		index = Math.min(end, sql.length)
	}
	const token = (word: string | undefined): void => {
		if (tokens === 0) wordsLine = line
		if (word !== undefined && tokens === words.length && words.length < 2) words.push(word.toUpperCase())
		tokens++
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
			token(undefined)
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
			token(undefined)
			let at = index + 1
			while (at < sql.length) {
				if (sql[at] === '"' && sql[at + 1] === '"') at += 2
				else if (sql[at] === '"') break
				else at++
			}
			skipTo(at + 1)
		} else if (char === '$' && DOLLAR_TAG.test(sql.slice(index, index + 64))) {
			token(undefined)
			const tag = DOLLAR_TAG.exec(sql.slice(index, index + 64))?.[0] ?? '$$'
			const end = sql.indexOf(tag, index + tag.length)
			skipTo(end === -1 ? sql.length : end + tag.length)
		} else if (isWordStart(char)) {
			let at = index + 1
			while (at < sql.length && isWordPart(sql[at] ?? '')) at++
			token(sql.slice(index, at))
			index = at
		} else if (char === ';' && depth === 0) {
			finish()
			index++
		} else {
			if (char === '(') depth++
			else if (char === ')' && depth > 0) depth--
			token(undefined)
			index++
		}
	}
	finish()
	return starts
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
