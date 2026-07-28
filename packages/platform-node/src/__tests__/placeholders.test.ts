// The tokeniser is the highest-stakes code in this package: every failure mode is SILENT. A `?`
// rewritten inside a string literal produces a query that still runs and still returns rows, just the
// wrong ones. So the cases below are adversarial rather than representative — quoting inside quoting,
// comments inside strings, strings inside comments, dollar-quotes wearing a `$$` in their body.

import { describe, expect, test } from 'bun:test'
import { rewritePlaceholders } from '../placeholders'

/** Shorthand: rewritten text only. */
function rewrite(sql: string): string {
	return rewritePlaceholders(sql).text
}

describe('rewritePlaceholders — the ordinary case', () => {
	test('numbers placeholders left to right', () => {
		expect(rewrite('SELECT * FROM apps WHERE id = ? AND env = ?')).toBe('SELECT * FROM apps WHERE id = $1 AND env = $2')
	})

	test('reports the count bind() must match', () => {
		expect(rewritePlaceholders('INSERT INTO t (a, b, c) VALUES (?, ?, ?)').count).toBe(3)
		expect(rewritePlaceholders('SELECT 1').count).toBe(0)
	})

	test('leaves SQL without placeholders byte-identical', () => {
		const sql = 'SELECT a, b FROM t /* keep */ WHERE c IS NULL -- keep\n ORDER BY a'
		expect(rewrite(sql)).toBe(sql)
	})

	test('handles a placeholder at the very start and the very end', () => {
		expect(rewrite('? AND a = ?')).toBe('$1 AND a = $2')
	})

	test('rewrites a placeholder in a sub-select and in LIMIT', () => {
		const sql = 'UPDATE jobs SET visible_at = ? WHERE id IN (SELECT id FROM jobs WHERE queue = ? LIMIT ?)'
		expect(rewrite(sql)).toBe('UPDATE jobs SET visible_at = $1 WHERE id IN (SELECT id FROM jobs WHERE queue = $2 LIMIT $3)')
	})
})

describe('rewritePlaceholders — string literals', () => {
	test('a ? inside a string literal is not a placeholder', () => {
		expect(rewrite("SELECT '?' AS q, ? AS p")).toBe("SELECT '?' AS q, $1 AS p")
	})

	test('a doubled quote does not end the literal', () => {
		expect(rewrite("SELECT 'it''s a ? really', ?")).toBe("SELECT 'it''s a ? really', $1")
	})

	test('several literals in a row keep the numbering straight', () => {
		expect(rewrite("SELECT ?, '?', ?, '??', ?")).toBe("SELECT $1, '?', $2, '??', $3")
	})

	test('a backslash does NOT escape in a plain literal (standard_conforming_strings)', () => {
		// The literal is `a\` and closes at the second quote — so the `?` after it IS a placeholder.
		expect(rewrite("SELECT 'a\\', ?")).toBe("SELECT 'a\\', $1")
	})

	test("a backslash DOES escape in an E'…' literal, so its ? stays inside", () => {
		expect(rewrite("SELECT E'a\\'b?c', ?")).toBe("SELECT E'a\\'b?c', $1")
		expect(rewrite("SELECT e'\\'?', ?")).toBe("SELECT e'\\'?', $1")
	})

	test('an identifier merely ending in e does not start an escape string', () => {
		// `code` is one word, so the following literal is a plain one where `\` is literal: it closes at
		// the second quote and the `?` that follows is a real placeholder.
		expect(rewrite("SELECT code'a\\', ?")).toBe("SELECT code'a\\', $1")
	})

	test('a comment sequence inside a literal is just text', () => {
		expect(rewrite("SELECT '-- ? /* ? */', ?")).toBe("SELECT '-- ? /* ? */', $1")
	})

	test('unicode inside a literal does not shift the offsets', () => {
		expect(rewrite("SELECT 'příliš ? žluťoučký', ?")).toBe("SELECT 'příliš ? žluťoučký', $1")
	})

	test('an unterminated literal throws instead of guessing', () => {
		expect(() => rewritePlaceholders("SELECT 'oops, ?")).toThrow('unterminated string literal in SQL')
	})
})

describe('rewritePlaceholders — quoted identifiers', () => {
	test('a ? inside a quoted identifier is not a placeholder', () => {
		expect(rewrite('SELECT "we?ird" FROM t WHERE a = ?')).toBe('SELECT "we?ird" FROM t WHERE a = $1')
	})

	test('a doubled double-quote does not end the identifier', () => {
		expect(rewrite('SELECT "a""b?c" FROM t WHERE a = ?')).toBe('SELECT "a""b?c" FROM t WHERE a = $1')
	})

	test('an unterminated identifier throws', () => {
		expect(() => rewritePlaceholders('SELECT "oops ?')).toThrow('unterminated quoted identifier in SQL')
	})
})

describe('rewritePlaceholders — comments', () => {
	test('a ? in a line comment is not a placeholder', () => {
		expect(rewrite('SELECT ? -- and ? is not one\n, ?')).toBe('SELECT $1 -- and ? is not one\n, $2')
	})

	test('a line comment terminated by CRLF still ends at the newline', () => {
		expect(rewrite('SELECT ? -- ?\r\n, ?')).toBe('SELECT $1 -- ?\r\n, $2')
	})

	test('a line comment running to end-of-input swallows its ?', () => {
		expect(rewrite('SELECT ? -- trailing ?')).toBe('SELECT $1 -- trailing ?')
	})

	test('a ? in a block comment is not a placeholder', () => {
		expect(rewrite('SELECT /* ? ? ? */ ?')).toBe('SELECT /* ? ? ? */ $1')
	})

	test('a multi-line block comment is spanned whole', () => {
		expect(rewrite('SELECT\n/* line ?\n   line ? */\n?')).toBe('SELECT\n/* line ?\n   line ? */\n$1')
	})

	test('block comments NEST, so an inner close does not expose the outer body', () => {
		expect(rewrite('SELECT /* a /* ? */ ? */ ?')).toBe('SELECT /* a /* ? */ ? */ $1')
	})

	test('a quote inside a comment does not open a string', () => {
		expect(rewrite("SELECT /* it's ? */ ?, 'x'")).toBe("SELECT /* it's ? */ $1, 'x'")
	})

	test('an unterminated block comment throws', () => {
		expect(() => rewritePlaceholders('SELECT /* ? ')).toThrow('unterminated block comment in SQL')
		expect(() => rewritePlaceholders('SELECT /* /* ? */ ')).toThrow('unterminated block comment in SQL')
	})

	test('a minus that is not a comment is left alone', () => {
		expect(rewrite('SELECT a - ? - 1')).toBe('SELECT a - $1 - 1')
	})
})

describe('rewritePlaceholders — dollar quoting', () => {
	test('a ? inside $$…$$ is not a placeholder', () => {
		expect(rewrite('SELECT $$ ? $$, ?')).toBe('SELECT $$ ? $$, $1')
	})

	test('a ? inside a TAGGED dollar quote is not a placeholder', () => {
		expect(rewrite('SELECT $tag$ ? $tag$, ?')).toBe('SELECT $tag$ ? $tag$, $1')
	})

	test('a bare $$ inside a tagged body does not close it', () => {
		expect(rewrite('SELECT $fn$ a $$ b ? $$ c $fn$, ?')).toBe('SELECT $fn$ a $$ b ? $$ c $fn$, $1')
	})

	test('a quote inside a dollar-quoted body does not open a string', () => {
		expect(rewrite("SELECT $fn$ it's ? $fn$, ?")).toBe("SELECT $fn$ it's ? $fn$, $1")
	})

	test('a $ that opens no tag is an ordinary character', () => {
		expect(rewrite('SELECT cost$ , ?')).toBe('SELECT cost$ , $1')
	})

	test('$ inside an identifier does not open a dollar quote', () => {
		// `a$$b` is one identifier to the Postgres lexer, so the `?` after it is a real placeholder.
		expect(rewrite('SELECT a$$b FROM t WHERE x = ?')).toBe('SELECT a$$b FROM t WHERE x = $1')
	})

	test('an unterminated dollar quote throws', () => {
		expect(() => rewritePlaceholders('SELECT $tag$ ? ')).toThrow('unterminated dollar-quoted string ($tag$) in SQL')
	})
})

describe('rewritePlaceholders — ?-family operators', () => {
	test('?? ?| and ?& pass through untouched', () => {
		expect(rewrite("SELECT a ?? 'k', b ?| c, d ?& e")).toBe("SELECT a ?? 'k', b ?| c, d ?& e")
		expect(rewritePlaceholders("SELECT a ?| ARRAY['x']").count).toBe(0)
	})

	test('an operator does not consume a following placeholder', () => {
		expect(rewrite('SELECT a ?| ?, ?')).toBe('SELECT a ?| $1, $2')
	})

	test('a lone ? next to other punctuation is still a placeholder', () => {
		expect(rewrite('VALUES (?,?)')).toBe('VALUES ($1,$2)')
		expect(rewrite('SELECT (?)')).toBe('SELECT ($1)')
	})
})

describe('rewritePlaceholders — things that must NOT be treated as quoting', () => {
	test('a bracket subscript is not an identifier quote, so its ? is a placeholder', () => {
		// SQLite allows `[ident]`; Postgres uses brackets for array subscripts. Treating them as quotes
		// would silently swallow a real placeholder — the exact failure this tokeniser exists to avoid.
		expect(rewrite('SELECT arr[?] FROM t WHERE a = ?')).toBe('SELECT arr[$1] FROM t WHERE a = $2')
	})

	test('a backtick is not a quote either', () => {
		expect(rewrite('SELECT `a` , ?')).toBe('SELECT `a` , $1')
	})
})

describe('rewritePlaceholders — a real statement from the codebase', () => {
	test('the guarded run-status UPDATE survives verbatim apart from its placeholders', () => {
		const sql = `UPDATE runs SET status = ?, exit_code = ?, finished_at = ?
					WHERE id = ? AND status IN ('pending','running')`
		expect(rewrite(sql)).toBe(`UPDATE runs SET status = $1, exit_code = $2, finished_at = $3
					WHERE id = $4 AND status IN ('pending','running')`)
	})

	test('the deploy-lock upsert keeps its conflict guard', () => {
		const sql = `INSERT INTO deploy_locks (lock_key, holder, expires_at) VALUES (?, ?, ?)
			ON CONFLICT (lock_key) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
			WHERE deploy_locks.expires_at <= ?`
		expect(rewritePlaceholders(sql).count).toBe(4)
		expect(rewrite(sql)).toContain('WHERE deploy_locks.expires_at <= $4')
	})

	test('a partial-index upsert with a NULL-layer conflict target keeps both placeholders', () => {
		const sql = `INSERT INTO app_secrets (app_id, env, name, value_ref) VALUES (?, NULL, ?, ?)
			ON CONFLICT (app_id, name) WHERE env IS NULL DO UPDATE SET value_ref = excluded.value_ref
			RETURNING *`
		expect(rewritePlaceholders(sql).count).toBe(3)
	})
})
