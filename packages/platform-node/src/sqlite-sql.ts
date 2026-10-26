// SQLite's lexical rules (tokenize.c), emitting the Postgres lexer's `SqlToken` shape so the same name and statement
// checks read both. Runtime-neutral: a Worker (an application's Durable Object) loads it.

import type { SqlToken } from './migration-sql'

/** SQLite's space (`sqlite3Isspace`), and the UTF-8 byte-order mark, which its tokenizer skips as space anywhere. */
const isSpace = (char: string): boolean => /[ \t\n\r\f\v﻿]/.test(char)
/** Every character from U+0080 up but the byte-order mark is part of a name, as SQLite reads any byte from 0x80. */
const isWordStart = (char: string): boolean => /[A-Za-z_\u0080-﻾＀-￿]/.test(char)
const isWordPart = (char: string): boolean => /[A-Za-z0-9_$\u0080-﻾＀-￿]/.test(char)

/**
 * The tokens of `sql` as SQLite reads it, and the line of the first string, quoted name or block comment that never
 * closes. `'…'` (with `''`) is a string; `"…"`, `` `…` `` (each with its doubled quote) and `[…]` (no escape) are quoted
 * names; `--` runs to a line feed and `/* *\/` does not nest. There is no `E''` string and no dollar quoting, so a `\`
 * or a `$` is no quote: `E'\'; DROP …` is a string, then a `;`.
 */
export function lexSqlite(sql: string): { readonly tokens: SqlToken[]; readonly unterminated: number | undefined } {
	const tokens: SqlToken[] = []
	let unterminated: number | undefined
	let line = 1
	let index = 0
	const skipTo = (end: number): void => {
		for (let at = index; at < end && at < sql.length; at++) if (sql[at] === '\n') line++
		index = Math.min(end, sql.length)
	}
	/** The body of a quote that `close` ends, `close` doubled standing for itself; `doubles` false for `[…]`. */
	const quoted = (close: string, doubles: boolean): { readonly text: string; readonly line: number } => {
		const startLine = line
		let at = index + 1
		let text = ''
		while (at < sql.length) {
			if (doubles && sql[at] === close && sql[at + 1] === close) {
				text += close
				at += 2
			} else if (sql[at] === close) break
			else text += sql[at++] ?? ''
		}
		if (at >= sql.length) unterminated ??= startLine
		skipTo(at + 1)
		return { text, line: startLine }
	}
	while (index < sql.length) {
		const char = sql[index] ?? ''
		const next = sql[index + 1] ?? ''
		if (char === '\n') {
			line++
			index++
		} else if (isSpace(char)) {
			index++
		} else if (char === '-' && next === '-') {
			// SQLite ends a comment at a line feed only: a carriage return does not end it.
			const end = sql.indexOf('\n', index + 2)
			skipTo(end === -1 ? sql.length : end)
		} else if (char === '/' && next === '*') {
			const end = sql.indexOf('*/', index + 2)
			if (end === -1) unterminated ??= line
			skipTo(end === -1 ? sql.length : end + 2)
		} else if (char === "'") {
			const body = quoted("'", true)
			tokens.push({ kind: 'string', text: body.text, line: body.line })
		} else if (char === '"' || char === '`') {
			const body = quoted(char, true)
			tokens.push({ kind: 'quoted', text: body.text, line: body.line })
		} else if (char === '[') {
			const body = quoted(']', false)
			tokens.push({ kind: 'quoted', text: body.text, line: body.line })
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
