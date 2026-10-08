// The names and the DDL of a file collection's table (`fabrika_files_<collection>`). Pure: `@fabrika/db/framework`
// re-exports `fileTableName` for `boot`, which the Worker adapter imports, and an application's migration uses the DDL.

import { QueryRefusedError } from './errors'
import { isPlainIdentifier } from './identifier'

export const FILE_TABLE_PREFIX = 'fabrika_files_'

/** `<table>_removable`, the longest name the DDL derives, must stay within Postgres' 63 characters. */
const MAX_COLLECTION_LENGTH = 63 - FILE_TABLE_PREFIX.length - '_removable'.length

/** The owner key types whose values `Bun.SQL` decodes as strings, as a capability carries them. */
export type FileOwnerKeyType = 'text' | 'uuid'

export interface FileOwner {
	readonly table: string
	readonly key: string
	readonly keyType: FileOwnerKeyType
}

/** `fabrika_files_<collection>`, or `null` when the collection's name cannot name a table. */
export function fileTableName(collection: string): string | null {
	const table = `${FILE_TABLE_PREFIX}${collection}`
	return collection.length <= MAX_COLLECTION_LENGTH && isPlainIdentifier(collection) && isPlainIdentifier(table) ? table : null
}

export function tableOf(collection: string): string {
	const table = fileTableName(collection)
	if (table === null) {
		throw new QueryRefusedError(`the file collection '${collection}' needs a lowercase snake_case name of at most ${MAX_COLLECTION_LENGTH} characters`)
	}
	return table
}

/**
 * The migration that creates a collection's table. The owner foreign key is on the owner's key only: the framework
 * reads the owner's containers through the owner row on every request, so the file row stores none that could go
 * stale. Deleting the owner orphans its files (`owner_id` becomes null), and the sweep deletes their objects.
 */
export function fileTableSql(collection: string, owner: FileOwner): string {
	const table = tableOf(collection)
	if (!isPlainIdentifier(owner.table) || !isPlainIdentifier(owner.key)) {
		throw new QueryRefusedError('the owner table and key must match ^[a-z_][a-z0-9_]*$')
	}
	if (owner.keyType !== 'text' && owner.keyType !== 'uuid') {
		throw new QueryRefusedError("the owner key type must be 'text' or 'uuid'")
	}
	return `CREATE TABLE ${table} (
	id UUID PRIMARY KEY,
	owner_id ${owner.keyType.toUpperCase()} REFERENCES ${owner.table} (${owner.key}) ON DELETE SET NULL,
	object_key TEXT NOT NULL UNIQUE,
	size BIGINT NOT NULL,
	content_type TEXT NOT NULL,
	sha256 TEXT NOT NULL,
	original_name TEXT,
	created_by TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL,
	deleted_at TIMESTAMPTZ
);
CREATE INDEX ${table}_owner ON ${table} (owner_id) WHERE deleted_at IS NULL;
CREATE INDEX ${table}_removable ON ${table} (id) WHERE deleted_at IS NOT NULL OR owner_id IS NULL;
`
}
