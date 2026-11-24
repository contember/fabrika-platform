import { describe, expect, test } from 'bun:test'
import { isSqlStatementSource, readSqlStatements } from '../contract'

const texts = (source: string) => readSqlStatements('src/notes/queries.ts', source)?.map((statement) => statement.text)

describe('readSqlStatements', () => {
	test('reads ctx.sql and tx.sql statements, called with a row schema or not, with their lines', () => {
		const source = [
			'export const one = async (ctx) => ctx.sql(Row)`select id from notes where ${ctx.sql.scope(ctx.target, "notes")}`',
			'export const two = (tx) =>',
			'\ttx.sql(Row)`update notes set title = ${title}`',
			'export const three = (ctx) => ctx.sql`select 1`',
		].join('\n')
		expect(readSqlStatements('src/notes/queries.ts', source)).toEqual([
			{ line: 1, text: 'select id from notes where ${ctx.sql.scope(ctx.target, "notes")}' },
			{ line: 3, text: 'update notes set title = ${title}' },
			{ line: 4, text: 'select 1' },
		])
	})

	test('reads a statement through a parameter or variable of any name that holds the tag', () => {
		const source = [
			'export const byOwner = (db: SqlHandle<typeof app, "read">, owner: string) => db(Row)`select * from notes where owner = ${owner}`',
			'export const later = (ctx) => { const run = ctx.sql(Row); return run`select 2` }',
		].join('\n')
		expect(texts(source)).toEqual(['select * from notes where owner = ${owner}', 'select 2'])
	})

	test('a template whose tag is a member other than .sql is not a statement', () => {
		expect(texts('export const a = String.raw`x`; export const b = styled.div`color: red`; export const c = `plain ${1}`')).toEqual([])
	})

	test('a tag behind a type assertion, a non-null assertion or a choice is still read', () => {
		const source = [
			'export const a = (ctx) => (ctx.sql satisfies typeof ctx.sql)(Row)`select 1`',
			'export const b = (ctx) => (ctx.sql as Tag)(Row)`select 2`',
			'export const c = (ctx) => ctx.sql!(Row)`select 3`',
			'export const d = (ctx, other) => (flag ? ctx.sql : other)(Row)`select 4`',
			"export const e = (ctx) => ctx['sql'](Row)`select 5`",
		].join('\n')
		expect(texts(source)).toEqual(['select 1', 'select 2', 'select 3', 'select 4', 'select 5'])
	})

	test('indentation and blank lines are no change; a line break and whitespace inside a line are', () => {
		const indented = 'const q = (ctx) => ctx.sql(Row)`\n\t\tselect id\n\n\t\tfrom notes   \n`'
		const flat = 'const q = (ctx) =>\n\tctx.sql(Row)`select id\nfrom notes`'
		expect(texts(indented)).toEqual(texts(flat))
		expect(texts('const q = (ctx) => ctx.sql(Row)`select  id from notes`')).not.toEqual(texts('const q = (ctx) => ctx.sql(Row)`select id from notes`'))
		// Joining the lines comments the condition out.
		const commented = (separator: string) =>
			texts(`const q = (ctx) => ctx.sql(Row)\`select title from notes where true -- filter${separator}and is_public\``)
		expect(commented(' ')).not.toEqual(commented('\n'))
	})

	test('a module the parser refuses reads as null', () => {
		expect(readSqlStatements('src/notes/queries.ts', 'export const = ctx.sql`select 1`')).toBeNull()
	})
})

describe('isSqlStatementSource', () => {
	test('server modules under src/ only, tests and the SPA excluded', () => {
		expect(isSqlStatementSource('src/notes/queries.ts')).toBe(true)
		expect(isSqlStatementSource('src/notes/endpoints.tsx')).toBe(true)
		expect(isSqlStatementSource('src/notes/__tests__/queries.test.ts')).toBe(false)
		expect(isSqlStatementSource('src/notes/queries.test.ts')).toBe(false)
		expect(isSqlStatementSource('web/app.tsx')).toBe(false)
		expect(isSqlStatementSource('src/notes/schema.json')).toBe(false)
		expect(isSqlStatementSource('src/node_modules/x/index.ts')).toBe(false)
	})
})
