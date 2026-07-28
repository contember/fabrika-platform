// `?` (SQLite/D1) → `$1..$n` (Postgres) — the one real dialect divergence the SQL port papers over.
//
// This is a TOKENISER, not a regex, and deliberately so: a `?` is a placeholder only when it is not
// inside something that quotes or comments it out. A regex that misses one of those cases does not
// fail — it silently rewrites a character inside a string literal, and the query keeps running with
// corrupted data. Every construct below therefore has an explicit scanner, and an UNTERMINATED one
// throws rather than guessing (a loud failure at prepare() beats a wrong query at run time).
//
// Constructs the scanner steps over without touching:
//   'string literal'         — `''` is an escaped quote; backslashes are LITERAL (standard_conforming_strings
//                              has been on by default since PostgreSQL 9.1, and SQLite has no backslash escape)
//   E'escape string'         — the one place a backslash DOES escape, so `E'\'?'` keeps its `?` inside
//   "quoted identifier"      — `""` is an escaped quote
//   $$dollar$$ / $tag$…$tag$ — the body is opaque; only the matching tag closes it
//   -- line comment          — to end of line
//   /* block comment */      — NESTED, per Postgres (SQLite does not nest; see the divergence note below)
//
// And the `?`-family OPERATORS — `??`, `?|`, `?&` (jsonb key-existence on Postgres) — pass through
// VERBATIM. A lone `?` is always a placeholder; a `?` immediately followed by `?`, `|` or `&` is an
// operator and is never renumbered.
//
// Divergences this creates, all unreachable from the common-subset SQL the port mandates but worth
// knowing before someone hand-writes a statement:
//   * `?|` / `?&` / `??` are operators here but would be `?` + `|`/`&`/`?` in SQLite. Write bitwise
//     operators with whitespace (`? | 1`) and they parse as intended on both.
//   * Block comments nest here. `/* a /* b */` is a complete comment to SQLite and unterminated here.
//   * `[bracketed]` identifiers (legal in SQLite) are NOT treated as quotes, because `arr[?]` is a
//     Postgres array subscript containing a real placeholder. Bracket-quoting is not portable anyway.
//   * Backticks are not treated as quotes — Postgres has no backtick syntax, so such SQL fails loudly.

/** One rewritten statement. `count` is exactly how many values `bind()` must supply. */
export interface RewrittenSql {
	/** Postgres-dialect text: every positional `?` replaced by `$1..$n`, left to right. */
	text: string
	/** How many placeholders were rewritten. */
	count: number
}

// Identifier runs, per the Postgres lexer: a letter, `_` or any non-ASCII character starts one; digits
// and `$` may follow. (`$` being a word character is why `a$$b` is an identifier, not a dollar-quote.)
const WORD_START = /[A-Za-z_\u0080-\uffff]/
const WORD_PART = /[A-Za-z0-9_$\u0080-\uffff]/
/** `$$` or `$tag$` at the current position — the opening (and closing) delimiter of a dollar-quoted string. */
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/

/**
 * Rewrite a `?`-placeholder statement into Postgres `$n` form. Throws on an unterminated string,
 * identifier, dollar-quote or block comment — the statement is malformed and no rewriting of it can
 * be trusted.
 */
export function rewritePlaceholders(sql: string): RewrittenSql {
	let out = ''
	let count = 0
	let i = 0

	while (i < sql.length) {
		const ch = sql.charAt(i)

		// `-- …` to end of line (the newline itself is left to the main loop).
		if (ch === '-' && sql.charAt(i + 1) === '-') {
			const end = lineEnd(sql, i)
			out += sql.slice(i, end)
			i = end
			continue
		}

		// `/* … */`, nesting-aware.
		if (ch === '/' && sql.charAt(i + 1) === '*') {
			const end = scanBlockComment(sql, i)
			out += sql.slice(i, end)
			i = end
			continue
		}

		// 'string literal' / "quoted identifier" — neither processes backslashes.
		if (ch === "'" || ch === '"') {
			const end = scanQuoted(sql, i, ch, false)
			out += sql.slice(i, end)
			i = end
			continue
		}

		// $$…$$ / $tag$…$tag$. A `$` that opens no tag (e.g. the `$` of a stray `$1`) is just a character.
		if (ch === '$') {
			const tag = dollarTagAt(sql, i)
			if (tag !== null) {
				const bodyEnd = sql.indexOf(tag, i + tag.length)
				if (bodyEnd === -1) {
					throw new Error(`unterminated dollar-quoted string (${tag}) in SQL`)
				}
				const end = bodyEnd + tag.length
				out += sql.slice(i, end)
				i = end
				continue
			}
			out += ch
			i += 1
			continue
		}

		// A keyword/identifier run. Consuming it whole is what keeps `a$$b` an identifier rather than a
		// dollar-quote, and what makes the `E'…'` check below see only a STANDALONE `E`.
		if (WORD_START.test(ch)) {
			let end = i + 1
			while (end < sql.length && WORD_PART.test(sql.charAt(end))) {
				end += 1
			}
			const word = sql.slice(i, end)
			out += word
			i = end
			// `E'…'` is the one string form where `\` escapes, so `E'\'?'` must keep the `?` inside.
			// The digit check rules out the `e` of a numeric literal (`1e'…'` is not an escape string).
			if ((word === 'E' || word === 'e') && sql.charAt(i) === "'" && !isDigit(sql.charAt(i - 2))) {
				const stringEnd = scanQuoted(sql, i, "'", true)
				out += sql.slice(i, stringEnd)
				i = stringEnd
			}
			continue
		}

		// The placeholder itself — unless it opens a `?`-family operator, which passes through untouched.
		if (ch === '?') {
			const next = sql.charAt(i + 1)
			if (next === '?' || next === '|' || next === '&') {
				out += ch + next
				i += 2
				continue
			}
			count += 1
			out += `$${count}`
			i += 1
			continue
		}

		out += ch
		i += 1
	}

	return { text: out, count }
}

function isDigit(ch: string): boolean {
	return ch >= '0' && ch <= '9'
}

function lineEnd(sql: string, from: number): number {
	const nl = sql.indexOf('\n', from)
	return nl === -1 ? sql.length : nl
}

/** Index just past the `*` `/` that closes the comment opening at `from`. Nesting-aware; throws if unclosed. */
function scanBlockComment(sql: string, from: number): number {
	let depth = 0
	let i = from
	while (i < sql.length) {
		if (sql.charAt(i) === '/' && sql.charAt(i + 1) === '*') {
			depth += 1
			i += 2
			continue
		}
		if (sql.charAt(i) === '*' && sql.charAt(i + 1) === '/') {
			depth -= 1
			i += 2
			if (depth === 0) {
				return i
			}
			continue
		}
		i += 1
	}
	throw new Error('unterminated block comment in SQL')
}

/** Index just past the closing quote of the literal/identifier opening at `from`. Throws if unclosed. */
function scanQuoted(sql: string, from: number, quote: string, backslashEscapes: boolean): number {
	let i = from + 1
	while (i < sql.length) {
		const ch = sql.charAt(i)
		if (backslashEscapes && ch === '\\') {
			i += 2
			continue
		}
		if (ch === quote) {
			// A doubled quote is an escaped quote, not the end.
			if (sql.charAt(i + 1) === quote) {
				i += 2
				continue
			}
			return i + 1
		}
		i += 1
	}
	throw new Error(`unterminated ${quote === '"' ? 'quoted identifier' : 'string literal'} in SQL`)
}

function dollarTagAt(sql: string, from: number): string | null {
	const match = DOLLAR_TAG.exec(sql.slice(from))
	return match === null ? null : match[0]
}
