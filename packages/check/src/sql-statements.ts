// The SQL statements of an application's server modules, read from their text and never run: Control records each by
// file and the digest of its text, so a statement that changes in a site already declared `sql` waits for review
// (ADR-0050 §3). Statements are found by syntax only, so the reading errs towards a tagged template too many.

import { type AstNode, child, parseModule, positionOf, staticKey, walk } from './ast'
import { isServerModule, isSkippedPath, isSourceFile } from './layout'

/** One tagged template that may run SQL. */
export interface SqlStatement {
	/** The line of the template's tag, from 1. */
	readonly line: number
	/** The template between its backticks, `${…}` as written, with the whitespace around each line break and blank lines dropped. */
	readonly text: string
}

/** A module's statements, or `null` when the parser refuses its text. */
export type SqlStatementsResult = readonly SqlStatement[] | null

/** The modules whose statements are read: the application's server source under `src/`, tests excluded. */
export const isSqlStatementSource = (path: string): boolean => isSourceFile(path) && isServerModule(path) && !isSkippedPath(path)

/**
 * Every tagged template of the module whose tag may be `ctx.sql`: `ctx.sql(Row)` and `tx.sql(Row)`, a parameter or
 * variable that holds the tag under any name, and any other expression, called or not. Only a tag that is a member
 * other than `.sql` (`String.raw`, `styled.div`) is a template of something else.
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

/** Whether a tag, or the callee of a called tag, is anything but a member whose static name is not `sql`. */
function maySql(tag: AstNode): boolean {
	const bare = transparent(tag)
	const callee = bare.type === 'CallExpression' ? child(bare, 'callee') : bare
	const target = callee === undefined ? undefined : transparent(callee)
	if (target?.type !== 'MemberExpression') return true
	const name = staticKey(target, 'property')
	return name === undefined || name === 'sql'
}

const TRANSPARENT = new Set([
	'ChainExpression',
	'ParenthesizedExpression',
	'TSNonNullExpression',
	'TSAsExpression',
	'TSSatisfiesExpression',
	'TSTypeAssertion',
	'TSInstantiationExpression',
])

/** Strips the wrappers that leave the value an expression denotes as it is, type assertions included. */
function transparent(node: AstNode): AstNode {
	let current = node
	for (let inner = child(current, 'expression'); TRANSPARENT.has(current.type) && inner !== undefined; inner = child(current, 'expression')) {
		current = inner
	}
	return current
}

/**
 * Re-indenting a statement changes nothing it runs. A line break stays: it ends a `--` comment, so joining two lines
 * may comment out a condition.
 */
function statementText(source: string): string {
	return source.replace(/[ \t]*(?:\r\n|\n|\r)\s*/g, '\n').trim()
}
