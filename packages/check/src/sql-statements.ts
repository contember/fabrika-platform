// The SQL statements of an application's server modules, read from their text and never run: Control records each by
// file and the digest of its text, so a statement that changes in a site already declared `sql` waits for review
// (ADR-0050 §3). Statements are found by syntax only, so the reading errs towards a tagged template too many.

import { type AstNode, child, memberSuffix, parseModule, positionOf, unwrap, walk } from './ast'
import { isServerModule, isSkippedPath, isSourceFile } from './layout'

/** One tagged template that may run SQL. */
export interface SqlStatement {
	/** The line of the template's tag, from 1. */
	readonly line: number
	/** The template between its backticks, `${…}` as written, with each line break and the whitespace around it one space. */
	readonly text: string
}

/** A module's statements, or `null` when the parser refuses its text. */
export type SqlStatementsResult = readonly SqlStatement[] | null

/** The modules whose statements are read: the application's server source under `src/`, tests excluded. */
export const isSqlStatementSource = (path: string): boolean => isSourceFile(path) && isServerModule(path) && !isSkippedPath(path)

/**
 * Every tagged template of the module whose tag may be `ctx.sql`: `ctx.sql(Row)` and `tx.sql(Row)`, a function parameter
 * or variable that holds the tag under any name, called or not. A tag reached through a member other than `.sql`
 * (`String.raw`, `styled.div`) is a template of something else.
 */
export function readSqlStatements(file: string, text: string): SqlStatementsResult {
	const parsed = parseModule(file, text)
	if (!parsed.ok) return null
	const statements: SqlStatement[] = []
	walk(parsed.module.program, (node) => {
		if (node.type !== 'TaggedTemplateExpression') return
		const tag = child(node, 'tag')
		const quasi = child(node, 'quasi')
		if (tag === undefined || quasi === undefined || !maySql(tag)) return
		const start = quasi['start']
		const end = quasi['end']
		if (typeof start !== 'number' || typeof end !== 'number') return
		statements.push({ line: positionOf(node).line, text: statementText(text.slice(start + 1, end - 1)) })
	})
	return statements
}

/** A tag, or the callee of a called tag, that is an identifier or a member chain ending in `.sql`. */
function maySql(tag: AstNode): boolean {
	const bare = unwrap(tag)
	const callee = bare.type === 'CallExpression' ? child(bare, 'callee') : bare
	if (callee === undefined) return false
	const target = unwrap(callee)
	if (target.type === 'Identifier') return true
	const suffix = memberSuffix(target)
	return suffix.length > 0 && suffix[suffix.length - 1] === 'sql'
}

/** Re-indenting a statement or breaking its lines elsewhere changes nothing it runs; whitespace inside a line is kept. */
function statementText(source: string): string {
	return source.replace(/[ \t]*(?:\r\n|\n|\r)\s*/g, ' ').trim()
}
