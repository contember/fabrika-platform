// @fabrika/db/testing-sqlite — the database test kit of an application on SQLite (Cloudflare, ADR-0065), for test files
// only. A test database is a fresh in-memory bun:sqlite database shaped like a Durable Object's storage, migrated by
// the object's own runner and opened with the object's engine; the isolation fixtures and the table probe are
// `@fabrika/db/testing`'s. No backend is needed, so it never skips. There is no role separation on SQLite: the fixture
// seeds through the same storage the application writes.

import { APPLICATION_MIGRATION_BUNDLE } from '@fabrika/platform-node'
import { Database as BunDatabase } from 'bun:sqlite'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod/v4'
import type { Primitive } from './description'
import { FILES_TABLE, FRAMEWORK_MIGRATION_BUNDLE } from './migrations'
import { SQLITE_FRAMEWORK_MIGRATIONS, SQLITE_NOW_FORMAT } from './migrations-sqlite'
import { refuseInProduction } from './production'
import { openSqlite, type SqliteValue } from './sqlite'
import { bunSqliteStorage } from './sqlite-bun'
import { migrateSqlite, type SqliteMigrationBundle } from './sqlite-migrate'
import type { TableProbe } from './store'
import {
	type CheckConstraint,
	checkLimit,
	foreignKeyLimit,
	type InsertedRow,
	MAX_REMOVED_ROWS,
	probeTable,
	randomHex,
	removalLimit,
	type SampleValue,
	type SeedColumn,
	type SeedingBackend,
	SeedLimitError,
	type TestDatabase,
	testSeeding,
	typeLimit,
} from './testing-shared'

export { ChildTable, defineChildStore, defineStore, DimensionTable, type TableProbe } from './store'
export {
	type ApplicationRow,
	type IsolationWorlds,
	type SampleValue,
	SEEDED_OBJECT_VERSION,
	type SeededApplicationRows,
	type SeededRow,
	SeedLimitError,
	type TestDatabase,
	type WorldRow,
} from './testing-shared'

const MODULE = '@fabrika/db/testing-sqlite'
refuseInProduction(MODULE)
const release = process.env['FABRIKA_RELEASE']
if (release !== undefined && release !== '') {
	throw new Error(`${MODULE} is a test helper and does not load in a release (FABRIKA_RELEASE is set)`)
}

export interface TestDatabaseOptions {
	/** The application's `db/migrations/` directory. */
	readonly migrations: string | URL
	/** The test file. `@fabrika/db/testing` names it when it skips; this kit never skips. */
	readonly label: string
}

type Exec = (query: string, ...bindings: SqliteValue[]) => Record<string, SqliteValue>[]

const TEXT_TYPES: ReadonlySet<string> = new Set(['TEXT', 'VARCHAR', 'CHAR'])
const NUMBER_TYPES: ReadonlySet<string> = new Set(['INTEGER', 'INT', 'BIGINT', 'SMALLINT', 'REAL', 'DOUBLE', 'FLOAT'])
const TIMESTAMP_TYPES: ReadonlySet<string> = new Set(['TIMESTAMP', 'TIMESTAMPTZ', 'DATETIME'])

/** A declared type without its length or precision (`VARCHAR(80)` → `VARCHAR`), as `@fabrika/db/codegen-sqlite` reads it. */
function baseType(declared: string): string {
	return declared.trim().toUpperCase().replace(/\s*\(.*\)$/s, '')
}

/** A sample for a required column the test does not care about, by the declared types `@fabrika/db/codegen-sqlite` accepts. */
function sampleOf(table: string, column: string, declared: string): Primitive {
	const type = baseType(declared)
	if (type === 'UUID') return crypto.randomUUID()
	if (TEXT_TYPES.has(type)) return `s${randomHex()}`
	if (NUMBER_TYPES.has(type)) return 1
	if (type === 'BOOLEAN') return false
	// A day is `YYYY-MM-DD` and a timestamp ISO text in UTC: the forms the layer writes and reads on SQLite.
	if (type === 'DATE') return new Date().toISOString().slice(0, 10)
	if (TIMESTAMP_TYPES.has(type)) return new Date().toISOString()
	throw typeLimit(table, column, declared)
}

const tableRows = z.array(z.object({ name: z.string(), wr: z.number() }))
const columnRows = z.array(
	z.object({ name: z.string(), type: z.string(), notnull: z.number(), dflt_value: z.string().nullable(), pk: z.number(), hidden: z.number() }),
)
const schemaRows = z.array(z.object({ name: z.string(), sql: z.string() }))

/** Every column of the database's ordinary tables. */
function readColumns(exec: Exec): SeedColumn[] {
	const tables = tableRows.parse(exec(`SELECT name, wr FROM pragma_table_list WHERE schema = 'main' AND type = 'table' ORDER BY name`))
		.filter((table) => !table.name.startsWith('sqlite_'))
	const columns: SeedColumn[] = []
	for (const table of tables) {
		const declared = columnRows.parse(exec('SELECT name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid', table.name))
		const keyColumns = declared.filter((column) => column.pk > 0)
		for (const column of declared) {
			const type = baseType(column.type)
			// An INTEGER PRIMARY KEY of a rowid table is the rowid: never null, assigned when an insert omits it.
			const rowid = table.wr === 0 && keyColumns.length === 1 && column.pk === 1 && type === 'INTEGER'
			columns.push({
				table: table.name,
				name: column.name,
				type: column.type,
				// SQLite lets a primary key other than the rowid hold NULL unless it says NOT NULL; a seeded row's key never does.
				nullable: !rowid && column.notnull === 0 && column.pk === 0,
				defaulted: rowid || column.dflt_value !== null || column.hidden === 2 || column.hidden === 3,
				text: TEXT_TYPES.has(type),
				uuid: type === 'UUID',
				sample: () => sampleOf(table.name, column.name, column.type),
			})
		}
	}
	return columns
}

/** One token of a `CREATE TABLE` text: a bare word, a quoted name, a string literal's value, or anything else. */
interface Token {
	readonly kind: 'word' | 'name' | 'string' | 'other'
	readonly text: string
	readonly start: number
	readonly end: number
}

const QUOTE_ENDS: ReadonlyMap<string, string> = new Map([
	["'", "'"],
	['"', '"'],
	['`', '`'],
	['[', ']'],
])
const WORD = /[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*/y
const NUMBER = /(?:[0-9]|\.[0-9])[0-9A-Za-z_.]*/y
const SPACE = /\s+/y

/** The tokens of a statement as SQLite reads it, comments and white space dropped. */
function tokenize(sql: string): Token[] {
	const tokens: Token[] = []
	let index = 0
	const sticky = (pattern: RegExp): string | undefined => {
		pattern.lastIndex = index
		return pattern.exec(sql)?.[0]
	}
	while (index < sql.length) {
		const start = index
		const char = sql.charAt(index)
		const space = sticky(SPACE)
		if (space !== undefined) {
			index += space.length
		} else if (sql.startsWith('--', index)) {
			const end = sql.indexOf('\n', index)
			index = end === -1 ? sql.length : end + 1
		} else if (sql.startsWith('/*', index)) {
			const end = sql.indexOf('*/', index + 2)
			index = end === -1 ? sql.length : end + 2
		} else if (QUOTE_ENDS.has(char)) {
			const close = QUOTE_ENDS.get(char) ?? char
			let text = ''
			index += 1
			for (;;) {
				const end = sql.indexOf(close, index)
				if (end === -1) throw new Error('an unterminated quote in the schema; SQLite stored a statement it could not have parsed')
				text += sql.slice(index, end)
				index = end + 1
				if (close === ']' || sql.charAt(index) !== close) break
				text += close
				index += 1
			}
			tokens.push({ kind: char === "'" ? 'string' : 'name', text, start, end: index })
		} else {
			const word = sticky(WORD)
			const number = word === undefined ? sticky(NUMBER) : undefined
			const text = word ?? number ?? char
			index += text.length
			// `X'00'` is a blob literal, not the column x.
			const blob = word !== undefined && word.toUpperCase() === 'X' && sql.charAt(index) === "'"
			tokens.push({ kind: word !== undefined && !blob ? 'word' : 'other', text, start, end: index })
		}
	}
	return tokens
}

function isWord(token: Token | undefined, keyword: string): boolean {
	return token?.kind === 'word' && token.text.toUpperCase() === keyword
}

function isPunctuation(token: Token | undefined, text: string): boolean {
	return token?.kind === 'other' && token.text === text
}

/** The index of the parenthesis that closes the one at `open`, or -1. */
function closing(tokens: readonly Token[], open: number): number {
	let depth = 0
	for (let index = open; index < tokens.length; index++) {
		if (isPunctuation(tokens[index], '(')) depth++
		if (isPunctuation(tokens[index], ')') && --depth === 0) return index
	}
	return -1
}

/** The definitions of a `CREATE TABLE` body: each column and each table constraint, as its tokens. */
function definitions(tokens: readonly Token[]): Token[][] {
	const open = tokens.findIndex((token) => isPunctuation(token, '('))
	const close = open === -1 ? -1 : closing(tokens, open)
	if (close === -1) return []
	const parts: Token[][] = [[]]
	let depth = 0
	for (const token of tokens.slice(open + 1, close)) {
		if (isPunctuation(token, '(')) depth++
		if (isPunctuation(token, ')')) depth--
		if (depth === 0 && isPunctuation(token, ',')) {
			parts.push([])
		} else {
			parts.at(-1)?.push(token)
		}
	}
	return parts.filter((part) => part.length > 0)
}

const TABLE_CONSTRAINTS: ReadonlySet<string> = new Set(['CONSTRAINT', 'CHECK', 'PRIMARY', 'UNIQUE', 'FOREIGN'])

/** The values of `<column> IN ('a', 'b', …)`, parenthesized or not, or none for any other expression. */
function listedValues(expression: readonly Token[], column: string): string[] {
	let tokens = expression
	while (isPunctuation(tokens[0], '(') && closing(tokens, 0) === tokens.length - 1) {
		tokens = tokens.slice(1, -1)
	}
	// The subject may be parenthesized too: `(("status")) IN (…)`.
	let depth = 0
	while (isPunctuation(tokens[depth], '(')) depth++
	const subject = tokens[depth]
	for (let index = 1; index <= depth; index++) {
		if (!isPunctuation(tokens[depth + index], ')')) return []
	}
	const list = depth * 2 + 1
	const named = subject?.kind === 'word' || subject?.kind === 'name'
	if (!named || subject.text.toLowerCase() !== column.toLowerCase() || !isWord(tokens[list], 'IN') || !isPunctuation(tokens[list + 1], '(')) return []
	if (!isPunctuation(tokens.at(-1), ')') || closing(tokens, list + 1) !== tokens.length - 1) return []
	const items = tokens.slice(list + 2, -1)
	const values: string[] = []
	for (let index = 0; index < items.length; index++) {
		const item = items[index]
		if (index % 2 === 1) {
			if (!isPunctuation(item, ',')) return []
		} else if (item?.kind === 'string') {
			values.push(item.text)
		} else {
			return []
		}
	}
	return items.length % 2 === 1 ? values : []
}

/** Every CHECK of a table as `sqlite_schema` stores its `CREATE TABLE`: a column's and the table's, by the columns it names. */
function tableChecks(table: string, sql: string, columns: readonly string[]): CheckConstraint[] {
	const byName = new Map(columns.map((name) => [name.toLowerCase(), name]))
	const checks: CheckConstraint[] = []
	for (const definition of definitions(tokenize(sql))) {
		// A column definition starts with its name, which no CHECK is.
		const first = definition[0]
		const start = first?.kind === 'word' && TABLE_CONSTRAINTS.has(first.text.toUpperCase()) ? 0 : 1
		let depth = 0
		for (let index = start; index < definition.length; index++) {
			const token = definition[index]
			if (isPunctuation(token, '(')) depth++
			if (isPunctuation(token, ')')) depth--
			if (depth !== 0 || !isWord(token, 'CHECK') || !isPunctuation(definition[index + 1], '(')) continue
			const close = closing(definition, index + 1)
			if (close === -1) break
			const expression = definition.slice(index + 2, close)
			const named = new Set<string>()
			expression.forEach((part, at) => {
				const column = part.kind === 'name' || (part.kind === 'word' && !isPunctuation(expression[at + 1], '('))
					? byName.get(part.text.toLowerCase())
					: undefined
				if (column !== undefined) named.add(column)
			})
			const constraint = isWord(definition[index - 2], 'CONSTRAINT') ? definition[index - 1]?.text : undefined
			const [only] = named
			const from = expression[0]?.start ?? 0
			const to = expression.at(-1)?.end ?? 0
			checks.push({
				// SQLite names an unnamed CHECK by its expression's text in the error it fails with.
				name: constraint ?? sql.slice(from, to),
				table,
				columns: [...named],
				values: named.size === 1 && only !== undefined ? listedValues(expression, only) : [],
			})
			index = close
		}
	}
	return checks
}

const foreignKeyRows = z.array(z.object({ id: z.number(), seq: z.number(), table: z.string(), from: z.string(), to: z.string().nullable() }))
const keyRows = z.array(z.object({ name: z.string(), pk: z.number() }))
const rowidRows = z.array(z.object({ id: z.number() }))

/** A foreign key of `table` and the columns of the table it references, in order. */
interface Referrer {
	readonly table: string
	readonly columns: readonly string[]
	readonly refs: readonly string[]
}

/** Every foreign key of the database's tables, by the table it references; a key that names no columns references its primary key. */
function readReferrers(exec: Exec): ReadonlyMap<string, readonly Referrer[]> {
	const tables = tableRows.parse(exec(`SELECT name, wr FROM pragma_table_list WHERE schema = 'main' AND type = 'table' ORDER BY name`))
		.filter((table) => !table.name.startsWith('sqlite_'))
	const referrers = new Map<string, Referrer[]>()
	for (const table of tables) {
		const keys = new Map<number, { table: string; columns: string[]; refs: (string | null)[] }>()
		for (
			const row of foreignKeyRows.parse(exec('SELECT id, seq, "table", "from", "to" FROM pragma_foreign_key_list(?) ORDER BY id, seq', table.name))
		) {
			const key = keys.get(row.id) ?? { table: row.table, columns: [], refs: [] }
			key.columns.push(row.from)
			key.refs.push(row.to)
			keys.set(row.id, key)
		}
		for (const key of keys.values()) {
			const primary = keyRows.parse(exec('SELECT name, pk FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk', key.table)).map((column) => column.name)
			const refs = key.refs.map((ref, index) => ref ?? primary[index] ?? '')
			referrers.set(key.table, [...(referrers.get(key.table) ?? []), { table: table.name, columns: key.columns, refs }])
		}
	}
	return referrers
}

/** Every CHECK constraint of the database's tables. */
function readChecks(exec: Exec, columns: readonly SeedColumn[]): CheckConstraint[] {
	const tables = schemaRows.parse(exec(`SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND sql IS NOT NULL ORDER BY name`))
	return tables
		.filter((table) => !table.name.startsWith('sqlite_'))
		.flatMap((table) => tableChecks(table.name, table.sql, columns.filter((column) => column.table === table.name).map((column) => column.name)))
}

/** A value the seeding writes, as a Durable Object binds it: a boolean 0 or 1, a `Date` its ISO text. */
function binding(value: SampleValue): SqliteValue {
	if (typeof value === 'boolean') return value ? 1 : 0
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) throw new SeedLimitError('the isolation fixture cannot write an invalid Date')
		return value.toISOString()
	}
	if (typeof value === 'bigint') {
		const number = Number(value)
		if (!Number.isSafeInteger(number)) throw new SeedLimitError('the isolation fixture cannot write a bigint outside the safe integer range on SQLite')
		return number
	}
	return value
}

/** A CHECK or foreign key violation of a seeded row, as the generator limit it is; `undefined` for any other failure. */
function seedLimit(error: unknown, table: string): SeedLimitError | undefined {
	const message = error instanceof Error ? error.message : ''
	const check = /^CHECK constraint failed: (.*)$/s.exec(message)
	if (check !== null) return checkLimit(check[1] ?? 'unnamed', table)
	// SQLite names no foreign key in its error.
	if (message.startsWith('FOREIGN KEY constraint failed')) return foreignKeyLimit('unnamed', table)
	return undefined
}

function quoted(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`
}

function migrationsDirectory(migrations: string | URL): string {
	return migrations instanceof URL ? fileURLToPath(migrations) : migrations
}

/** The application's migrations: every `.sql` file of the directory by name, as `fabrika app build` bundles them for the object. */
function applicationMigrations(directory: string): SqliteMigrationBundle['migrations'] {
	if (!existsSync(directory)) {
		throw new Error(`No migrations directory at ${directory}; create the first migration with fabrika db new <slug>`)
	}
	const names = readdirSync(directory).filter((name) => name.endsWith('.sql')).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
	return names.map((name) => ({ name, sql: readFileSync(join(directory, name), 'utf8') }))
}

/**
 * A fresh in-memory database with the framework's and the application's migrations applied by the runner a Durable
 * Object boots with (`@fabrika/db/sqlite-migrate`), opened with its engine (`@fabrika/db/sqlite`). Never `null`: it
 * needs no backend, so it never skips; its type is still assignable to `@fabrika/db/testing`'s, so a generated test
 * that checks for `null` compiles against both kits.
 */
export async function testDatabase(options: TestDatabaseOptions): Promise<TestDatabase> {
	refuseInProduction(MODULE)
	const migrations = applicationMigrations(migrationsDirectory(options.migrations))
	const sqlite = new BunDatabase(':memory:')
	const storage = bunSqliteStorage(sqlite)
	try {
		await migrateSqlite({ exec: storage.sql.exec, transactionSync: (fn) => storage.transactionSync(fn) }, [
			{ bundle: FRAMEWORK_MIGRATION_BUNDLE, migrations: SQLITE_FRAMEWORK_MIGRATIONS },
			{ bundle: APPLICATION_MIGRATION_BUNDLE, migrations },
		])
	} catch (error) {
		sqlite.close()
		throw error
	}
	const exec: Exec = (query, ...bindings) => storage.sql.exec(query, ...bindings).toArray()
	const columns = readColumns(exec)
	const withoutRowid = new Set(
		tableRows.parse(exec(`SELECT name, wr FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND wr = 1`)).map((table) => table.name),
	)
	const referrers = readReferrers(exec)
	/** A removal finds a table's rows again by their rowid; a table without one is a limit of the fixture. */
	const requireRowid = (table: string): void => {
		if (withoutRowid.has(table)) {
			throw new SeedLimitError(`the isolation fixture cannot remove the rows of ${table}, a WITHOUT ROWID table; declare it with a rowid`)
		}
	}
	const backend: SeedingBackend = {
		columns,
		checks: async () => readChecks(exec, columns),
		async insert(table, row) {
			const names = [...row.keys()]
			const target = quoted(table)
			const statement = names.length === 0
				? `INSERT INTO ${target} DEFAULT VALUES RETURNING *`
				: `INSERT INTO ${target} (${names.map(quoted).join(', ')}) VALUES (${names.map(() => '?').join(', ')}) RETURNING *`
			try {
				return exec(statement, ...names.map((name) => binding(row.get(name) ?? null)))[0] ?? {}
			} catch (error) {
				throw seedLimit(error, table) ?? error
			}
		},
		async firstRow(table, selected) {
			return exec(`SELECT ${selected.map(quoted).join(', ')} FROM ${quoted(table)} LIMIT 1`)[0]
		},
		async insertFile(file) {
			exec(
				`INSERT INTO ${quoted(FILES_TABLE)} (id, kind, status, object_key, size, sha256, content_type, name, created_at, object_version)
				VALUES (?, ?, 'live', ?, 0, ?, 'application/octet-stream', 'seeded', strftime('${SQLITE_NOW_FORMAT}', 'now'), ?)`,
				file.id,
				file.kind,
				file.objectKey,
				file.sha256,
				file.objectVersion,
			)
		},
		async remove(rows: readonly InsertedRow[]) {
			// One object, one writer: nothing writes between finding the rows and deleting them. The foreign keys are checked
			// at the commit, so rows that refer to each other go together.
			storage.transactionSync(() => {
				exec('PRAGMA defer_foreign_keys = ON')
				const found = new Map<string, Set<number>>()
				let count = 0
				let level = new Map<string, number[]>()
				const add = (table: string, rowid: number): void => {
					let rowids = found.get(table)
					if (rowids === undefined) {
						rowids = new Set()
						found.set(table, rowids)
					}
					if (rowids.has(rowid)) return
					if (++count > MAX_REMOVED_ROWS) throw removalLimit()
					rowids.add(rowid)
					level.set(table, [...(level.get(table) ?? []), rowid])
				}
				for (const row of rows) {
					const where = [...row.match.keys()].map((column) => `${quoted(column)} = ?`).join(' AND ')
					requireRowid(row.table)
					const located = rowidRows.parse(exec(`SELECT rowid AS id FROM ${quoted(row.table)} WHERE ${where}`, ...[...row.match.values()].map(binding)))
					for (const { id } of located) add(row.table, id)
				}
				while (level.size > 0) {
					const current = level
					level = new Map()
					for (const [table, rowids] of current) {
						for (const key of referrers.get(table) ?? []) {
							requireRowid(key.table)
							const on = key.columns.map((column, position) => `r.${quoted(column)} = t.${quoted(key.refs[position] ?? '')}`).join(' AND ')
							const referring = rowidRows.parse(
								exec(
									`SELECT r.rowid AS id FROM ${quoted(key.table)} r JOIN ${quoted(table)} t ON ${on} WHERE t.rowid IN (SELECT value FROM json_each(?))`,
									JSON.stringify(rowids),
								),
							)
							for (const referrer of referring) add(key.table, referrer.id)
						}
					}
				}
				for (const [table, rowids] of found) {
					exec(`DELETE FROM ${quoted(table)} WHERE rowid IN (SELECT value FROM json_each(?))`, JSON.stringify([...rowids]))
				}
			})
		},
	}
	const database = openSqlite(storage)
	return {
		...testSeeding(backend),
		database,
		schema: 'main',
		async close() {
			await database.close()
			sqlite.close()
		},
	}
}

/**
 * The untyped handle over one table of the data layer `scoped(tables)` created; it reaches the database once `boot`
 * has bound that layer. Every runtime check of a store applies: kind, dimension, action and the request's authority.
 */
export function tableProbe(layer: unknown, table: string): TableProbe {
	return probeTable(MODULE, layer, table)
}
