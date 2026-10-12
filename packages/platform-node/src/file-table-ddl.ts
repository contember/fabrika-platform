// The SQL of a file collection's table that three readers must agree on: `@fabrika/db`'s `fileTableSql` and
// `fileScanSql` write it, the migration classifier admits exactly the scan migration, and `@fabrika/check` recognizes
// a table that can hold the scan states. Pure: tokens in, answers out.

import { type SqlToken, sqlTokens, topLevelStatements, upperWord } from './migration-sql'
import { nameText } from './sql-names'

/**
 * A file row's states. `pending`: its object is still being written. `quarantined`: written to a scanning collection
 * and not yet given a clean verdict. `live`: served. `rejected`: refused by the scan and its object is gone.
 */
export const FILE_STATUSES = ['pending', 'live', 'quarantined', 'rejected'] as const

export const FILE_TABLE_PREFIX = 'fabrika_files_'

/** The columns the scan job keeps: the scanned object's version, and the retry count and time of a file without a verdict. */
export const FILE_SCAN_COLUMNS = ['object_version TEXT', 'scan_attempts INTEGER NOT NULL DEFAULT 0', 'scan_after TIMESTAMPTZ'] as const

const STATUS_CHECK = `CHECK (status IN (${FILE_STATUSES.map((status) => `'${status}'`).join(', ')}))`

/** The named status check of every state. */
export function fileStatusCheck(table: string): string {
	return `CONSTRAINT ${table}_status ${STATUS_CHECK}`
}

/** The index the scan job selects its batch by. */
export function fileScanIndex(table: string): string {
	return `CREATE INDEX ${table}_scan ON ${table} (scan_after) WHERE status = 'quarantined'`
}

/**
 * The name Postgres gave the unnamed status check of a table an earlier `fileTableSql` created:
 * `<table>_status_check`, the table's name cut to 50 characters first (`makeObjectName`).
 */
export function legacyStatusCheckName(table: string): string {
	return `${table.slice(0, 63 - '_status_check'.length)}_status_check`
}

/** The statement of `fileScanSql` that widens a table an earlier `fileTableSql` created: its check and its columns. */
export function fileScanAlter(table: string): string {
	const columns = FILE_SCAN_COLUMNS.map((column) => `ADD COLUMN ${column}`).join(', ')
	return `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${legacyStatusCheckName(table)}, ADD ${fileStatusCheck(table)}, ${columns}`
}

const tokenKey = (token: SqlToken): string =>
	token.kind === 'word'
		? `w:${token.text.toLowerCase()}`
		: token.kind === 'punct'
		? `p:${token.char}`
		: token.kind === 'string'
		? `s:${token.text ?? ''}`
		: `${token.kind}:`

const keys = (tokens: readonly SqlToken[]): string[] => tokens.map(tokenKey)

const equalKeys = (actual: readonly string[], expected: readonly string[]): boolean =>
	actual.length === expected.length && expected.every((key, index) => actual[index] === key)

/** Whether `needle`'s tokens appear in `haystack`, in a row. */
function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
	for (let start = 0; start + needle.length <= haystack.length; start++) {
		if (needle.every((key, offset) => haystack[start + offset] === key)) return true
	}
	return false
}

/** The file table a statement is exactly `fileScanAlter` of, or `undefined`. */
export function fileScanAlterTable(tokens: readonly SqlToken[]): string | undefined {
	const table = nameText(tokens[2])
	if (upperWord(tokens[0]) !== 'ALTER' || table?.startsWith(FILE_TABLE_PREFIX) !== true || tokens[2]?.kind !== 'word') return undefined
	return equalKeys(keys(tokens), keys(sqlTokens(fileScanAlter(table)))) ? table : undefined
}

/** Whether a `CREATE TABLE` of `table` declares the check of every state and the scan columns. */
function createsScanReady(tokens: readonly SqlToken[], table: string): boolean {
	const statement = keys(tokens)
	return containsRun(statement, keys(sqlTokens(fileStatusCheck(table))))
		&& FILE_SCAN_COLUMNS.every((column) => containsRun(statement, keys(sqlTokens(column))))
}

/**
 * Whether the migrations, in order, leave `table` able to hold the scan states: created with the check of every state
 * and the scan columns, or widened by `fileScanAlter`. `undefined` when none of them creates it.
 */
export function fileTableScanReady(migrations: readonly string[], table: string): boolean | undefined {
	let state: boolean | undefined
	for (const sql of migrations) {
		for (const { tokens } of topLevelStatements(sql)) {
			const create = upperWord(tokens[0]) === 'CREATE' && upperWord(tokens[1]) === 'TABLE'
			const named = upperWord(tokens[2]) === 'IF' ? tokens[5] : tokens[2]
			if (create && nameText(named) === table) state = createsScanReady(tokens, table)
			else if (state !== undefined && fileScanAlterTable(tokens) === table) state = true
		}
	}
	return state
}
