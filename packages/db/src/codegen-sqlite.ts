// @fabrika/db/codegen-sqlite — `fabrika db codegen` for an application on Cloudflare (ADR-0065): applies its bundles to
// an in-memory SQLite database, reads its tables back and renders `SCHEMA_FILE` with the Postgres codegen's renderer.
// Runs in the CLI, on Bun.

import { Database } from 'bun:sqlite'
import { z } from 'zod/v4'
import { CodegenError, type DescribedColumn, type ForeignKeyColumns, type NamedColumn, renderTables, type ScalarType } from './codegen'
import { execStatements } from './sqlite-bun'
import { migrateSqlite, type SqliteMigrationBundle, type SqliteMigrationTarget } from './sqlite-migrate'

const STRING: ScalarType = { select: 'string' }
const NUMBER: ScalarType = { select: 'number' }

/** A column's TypeScript types and list field by its declared type, without a length (`VARCHAR(80)` → `VARCHAR`). */
const DECLARED_TYPES: ReadonlyMap<string, { readonly scalar: ScalarType; readonly list: DescribedColumn['list'] }> = new Map([
	['TEXT', { scalar: STRING, list: undefined }],
	['VARCHAR', { scalar: STRING, list: undefined }],
	['CHAR', { scalar: STRING, list: undefined }],
	['UUID', { scalar: STRING, list: undefined }],
	['INTEGER', { scalar: NUMBER, list: undefined }],
	['INT', { scalar: NUMBER, list: undefined }],
	['BIGINT', { scalar: NUMBER, list: undefined }],
	['SMALLINT', { scalar: NUMBER, list: undefined }],
	['REAL', { scalar: NUMBER, list: undefined }],
	['DOUBLE', { scalar: NUMBER, list: undefined }],
	['FLOAT', { scalar: NUMBER, list: undefined }],
	['BOOLEAN', { scalar: { select: 'boolean' }, list: 'booleans' }],
	['TIMESTAMP', { scalar: { select: 'Date', write: 'Date | string' }, list: 'timestamps' }],
	['TIMESTAMPTZ', { scalar: { select: 'Date', write: 'Date | string' }, list: 'timestamps' }],
	['DATETIME', { scalar: { select: 'Date', write: 'Date | string' }, list: 'timestamps' }],
	['DATE', { scalar: STRING, list: 'dates' }],
	['BLOB', { scalar: { select: 'Uint8Array' }, list: undefined }],
])

interface SqliteColumn extends NamedColumn {
	readonly declared: string
	readonly nullable: boolean
	readonly generated: DescribedColumn['generated']
}

const tableSchema = z.object({ name: z.string(), type: z.string(), wr: z.number() })

const columnSchema = z.object({
	name: z.string(),
	type: z.string(),
	notnull: z.number(),
	dflt_value: z.string().nullable(),
	pk: z.number(),
	/** 0 an ordinary column, 2 or 3 a generated one. */
	hidden: z.number(),
})

const foreignKeySchema = z.object({ id: z.number(), seq: z.number(), table: z.string(), from: z.string(), to: z.string().nullable() })

/** Runs multi-statement text the way a Durable Object's `sql.exec` does; `prepare` alone compiles only its first statement. */
function bunTarget(db: Database): SqliteMigrationTarget {
	return {
		exec(query, ...bindings) {
			const rows = execStatements(db, query, bindings)
			return { toArray: () => rows }
		},
		transactionSync: (fn) => db.transaction(fn)(),
	}
}

function describeSqlite(column: SqliteColumn): DescribedColumn {
	const base = column.declared.trim().toUpperCase().replace(/\s*\(.*\)$/s, '')
	const mapped = DECLARED_TYPES.get(base)
	if (mapped === undefined) {
		throw new CodegenError(
			`${column.table_name}.${column.column_name} has declared type '${column.declared}', which the data layer does not read or bind on SQLite (supported: ${
				[...DECLARED_TYPES.keys()].join(', ')
			})`,
		)
	}
	return { scalar: mapped.scalar, nullable: column.nullable, generated: column.generated, list: mapped.list }
}

function primaryKeyOf(db: Database, table: string): string[] {
	const columns = z.array(columnSchema).parse(db.query('SELECT * FROM pragma_table_xinfo(?) WHERE pk > 0 ORDER BY pk').all(table))
	return columns.map((column) => column.name)
}

/** Every column of the application's ordinary tables, and their foreign keys in declaration order. */
function introspect(db: Database): { columns: SqliteColumn[]; foreignKeys: ForeignKeyColumns[] } {
	const tables = z.array(tableSchema).parse(
		db.query(`SELECT name, type, wr FROM pragma_table_list WHERE schema = 'main' AND type IN ('table', 'virtual') ORDER BY name`).all(),
	).filter((table) => !table.name.startsWith('sqlite_') && !table.name.startsWith('fabrika_'))
	const columns: SqliteColumn[] = []
	const foreignKeys: ForeignKeyColumns[] = []
	for (const table of tables) {
		if (table.type === 'virtual') throw new CodegenError(`table ${table.name} is a virtual table, which the data layer does not read`)
		const declared = z.array(columnSchema).parse(db.query('SELECT * FROM pragma_table_xinfo(?) ORDER BY cid').all(table.name))
		const keyColumns = declared.filter((column) => column.pk > 0)
		for (const column of declared) {
			// An INTEGER PRIMARY KEY of a rowid table is the rowid: never null, assigned when an insert omits it.
			const rowid = table.wr === 0 && keyColumns.length === 1 && column.pk === 1 && column.type.trim().toUpperCase() === 'INTEGER'
			columns.push({
				table_name: table.name,
				column_name: column.name,
				declared: column.type,
				nullable: !rowid && column.notnull === 0,
				generated: column.hidden === 2 || column.hidden === 3 ? 'always' : rowid || column.dflt_value !== null ? 'default' : 'no',
			})
		}
		const references = z.array(foreignKeySchema).parse(db.query('SELECT * FROM pragma_foreign_key_list(?) ORDER BY id DESC, seq').all(table.name))
		for (const id of new Set(references.map((reference) => reference.id))) {
			const parts = references.filter((reference) => reference.id === id)
			const referenced = parts[0]?.table
			if (referenced === undefined) continue
			// `REFERENCES parent` without columns names the parent's primary key.
			const implicit = parts.some((part) => part.to === null) ? primaryKeyOf(db, referenced) : []
			const referencedColumns: string[] = []
			for (const [index, part] of parts.entries()) {
				const name = part.to ?? implicit[index]
				if (name === undefined) {
					throw new CodegenError(`${table.name}: a foreign key to ${referenced} names no columns, and ${referenced} has no primary key of that width`)
				}
				referencedColumns.push(name)
			}
			foreignKeys.push({
				table_name: table.name,
				columns: parts.map((part) => part.from),
				referenced_table: referenced,
				referenced_columns: referencedColumns,
			})
		}
	}
	return { columns, foreignKeys }
}

/**
 * Applies `bundles` (the framework's `fabrika`, then the application's `app`) to a fresh in-memory database and renders
 * the module for `SCHEMA_FILE` from its application tables. Deterministic for given migrations.
 */
export function generateSqliteSchema(bundles: readonly SqliteMigrationBundle[]): Promise<string> {
	return withMigratedSqlite(bundles, (db) => {
		const { columns, foreignKeys } = introspect(db)
		return renderTables(columns, foreignKeys, describeSqlite)
	})
}

/**
 * `read` of a fresh in-memory database with foreign keys enforced and `bundles` applied, as the Durable Object applies
 * them; the database is closed after. `fabrika-check` plans the backup of an application's schema with it.
 */
export async function withMigratedSqlite<T>(bundles: readonly SqliteMigrationBundle[], read: (db: Database) => T): Promise<T> {
	const db = new Database(':memory:')
	try {
		db.run('PRAGMA foreign_keys = ON')
		await migrateSqlite(bunTarget(db), bundles)
		return read(db)
	} finally {
		db.close()
	}
}
