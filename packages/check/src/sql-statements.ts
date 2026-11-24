// The SQL statements of an application's server modules, read from their text and never run: Control records each by
// file and the digest of its text, so a statement that changes in a site already declared `sql` waits for review
// (ADR-0050 §3). Every tagged template counts: `ctx.sql` may be held under any name, a member's included.

import { child, parseModule, positionOf, walk } from './ast'
import { isServerModule, isSkippedPath, isSourceFile } from './layout'

/** One tagged template that may run SQL. */
export interface SqlStatement {
	/** The line of the template's tag, from 1. */
	readonly line: number
	/**
	 * The template between its backticks, exactly as written, `${…}` included: whitespace may stand in a quoted literal
	 * or end a `--` comment, so re-indenting a statement is a change too.
	 */
	readonly text: string
}

/** A module's statements, or `null` when the parser refuses its text. */
export type SqlStatementsResult = readonly SqlStatement[] | null

/** The modules whose statements are read: the application's server source under `src/`, tests excluded. */
export const isSqlStatementSource = (path: string): boolean => isSourceFile(path) && isServerModule(path) && !isSkippedPath(path)

/**
 * Every tagged template of the module: `ctx.sql(Row)` and `tx.sql(Row)`, and the tag held by a parameter, a variable or
 * an object under any name. Telling a `String.raw` from an alias would take what the code runs, so it is not tried.
 */
export function readSqlStatements(file: string, text: string): SqlStatementsResult {
	const parsed = parseModule(file, text)
	if (!parsed.ok) return null
	const statements: SqlStatement[] = []
	walk(parsed.module.program, (node) => {
		if (node.type !== 'TaggedTemplateExpression') return
		const quasi = child(node, 'quasi')
		if (quasi === undefined) return
		const start = quasi['start']
		const end = quasi['end']
		if (typeof start !== 'number' || typeof end !== 'number') return
		statements.push({ line: positionOf(node).line, text: text.slice(start + 1, end - 1) })
	})
	return statements
}
