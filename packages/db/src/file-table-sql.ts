// The names and the DDL of a file collection's table (`fabrika_files_<collection>`). Pure: `@fabrika/db/framework`
// re-exports `fileTableName` for `boot`, which the Worker adapter imports, and an application's migration uses the DDL.

import { QueryRefusedError } from './errors'
import { isPlainIdentifier } from './identifier'

export const FILE_TABLE_PREFIX = 'fabrika_files_'

/** `<table>_removable`, the longest name the DDL derives, must stay within Postgres' 63 characters. */
const MAX_COLLECTION_LENGTH = 63 - FILE_TABLE_PREFIX.length - '_removable'.length

/** The columns every file row has; an owner's containment column may not take one of these names. */
export const FILE_COLUMNS: readonly string[] = [
	'id',
	'owner_id',
	'status',
	'object_key',
	'size',
	'content_type',
	'sha256',
	'original_name',
	'created_by',
	'created_at',
	'deleted_at',
]

/** The column types whose values `Bun.SQL` decodes as strings, as a capability carries them. */
export type FileColumnType = 'text' | 'uuid'

export interface FileColumn {
	readonly column: string
	readonly type: FileColumnType
}

export interface FileOwner {
	readonly table: string
	readonly key: FileColumn
	/** The owner's containment columns, as its table policy declares them, nearest container first. */
	readonly chain: readonly FileColumn[]
}

/** `fabrika_files_<collection>`, or `null` when the collection's name cannot name a table. */
export function fileTableName(collection: string): string | null {
	const table = `${FILE_TABLE_PREFIX}${collection}`
	return collection.length <= MAX_COLLECTION_LENGTH && isPlainIdentifier(collection) && isPlainIdentifier(table) ? table : null
}

export function tableOf(collection: string): string {
	const table = fileTableName(collection)
	if (table === null) {
		throw new QueryRefusedError(
			'invalid_name',
			`the file collection '${collection}' needs a lowercase snake_case name of at most ${MAX_COLLECTION_LENGTH} characters`,
		)
	}
	return table
}

function sqlType(column: FileColumn): string {
	if (!isPlainIdentifier(column.column)) {
		throw new QueryRefusedError('invalid_name', 'an owner column must match ^[a-z_][a-z0-9_]*$')
	}
	if (column.type !== 'text' && column.type !== 'uuid') {
		throw new QueryRefusedError('invalid_name', "an owner column's type must be 'text' or 'uuid'")
	}
	return column.type.toUpperCase()
}

/**
 * The migration that creates a collection's table. A row carries its owner's key and the owner's whole containment
 * chain under the owner's column names, with a composite foreign key: a move of the owner cascades into its files,
 * so a capability minted before the move matches none of them, and deleting the owner orphans them (every owner
 * column becomes null) for the sweep. The owner table needs `UNIQUE (<key>, <chain columns>)`, as a child table's
 * parent does. A row is `pending` from before its object is written until the write completed.
 */
export function fileTableSql(collection: string, owner: FileOwner): string {
	const table = tableOf(collection)
	if (!isPlainIdentifier(owner.table)) {
		throw new QueryRefusedError('invalid_name', 'the owner table must match ^[a-z_][a-z0-9_]*$')
	}
	const keyType = sqlType(owner.key)
	const chain = owner.chain.map((link) => ({ column: link.column, type: sqlType(link) }))
	const taken = chain.find((link) => FILE_COLUMNS.includes(link.column))
	if (taken !== undefined) {
		throw new QueryRefusedError('invalid_name', `the owner column ${taken.column} has the name of a file column (${FILE_COLUMNS.join(', ')})`)
	}
	const fileColumns = ['owner_id', ...chain.map((link) => link.column)].join(', ')
	const ownerColumns = [owner.key.column, ...chain.map((link) => link.column)].join(', ')
	return `CREATE TABLE ${table} (
	id UUID PRIMARY KEY,
	owner_id ${keyType},
${chain.map((link) => `\t${link.column} ${link.type},\n`).join('')}	status TEXT NOT NULL CHECK (status IN ('pending', 'live')),
	object_key TEXT NOT NULL UNIQUE,
	size BIGINT,
	content_type TEXT NOT NULL,
	sha256 TEXT,
	original_name TEXT,
	created_by TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL,
	deleted_at TIMESTAMPTZ,
	FOREIGN KEY (${fileColumns}) REFERENCES ${owner.table} (${ownerColumns}) ON UPDATE CASCADE ON DELETE SET NULL
);
CREATE INDEX ${table}_owner ON ${table} (owner_id) WHERE deleted_at IS NULL;
CREATE INDEX ${table}_removable ON ${table} (created_at) WHERE deleted_at IS NOT NULL OR owner_id IS NULL OR status = 'pending';
`
}
