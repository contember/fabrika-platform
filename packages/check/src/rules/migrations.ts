import { fileTableScanReady } from '@fabrika/platform-node/sql'
import type { Finding } from '../finding'
import { MIGRATIONS_DIR } from '../layout'

const MIGRATION_NAME = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/
const ALLOWED = 'db/migrations/YYYYMMDDHHMMSS_slug.sql with a lowercase snake_case slug, as fabrika db new <slug> writes it'

const isValidTimestamp = (parts: readonly string[]): boolean => {
	const [year, month, day, hour, minute, second] = parts.map(Number)
	if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined || second === undefined) {
		return false
	}
	const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && hour < 24 && minute < 60 && second < 60
}

/** Migration file names sort by creation time, so parallel worktrees never claim the same name. */
export const checkMigrationNames = (paths: readonly string[]): Finding[] => {
	const findings: Finding[] = []
	for (const path of paths) {
		if (!path.startsWith(MIGRATIONS_DIR)) continue
		const name = path.slice(MIGRATIONS_DIR.length)
		const match = MIGRATION_NAME.exec(name)
		if (match !== null && isValidTimestamp(match.slice(1, 7))) continue
		const message = name.includes('/')
			? `'${name}' is in a subdirectory of db/migrations`
			: match === null
			? `'${name}' is not a migration file name`
			: `'${name}' does not start with a real UTC timestamp`
		findings.push({ file: path, line: 1, column: 1, severity: 'refusal', rule: 'migration-name', message, allowed: ALLOWED })
	}
	return findings
}

/**
 * A `scan: true` collection whose table no migration lets hold the scan states — the earlier `fileTableSql` DDL, which
 * admits only `pending` and `live`, without `fileScanSql` after it — would fail every upload at its `quarantined`
 * row. Only the named check of every state with the scan columns, or the exact `fileScanSql` statement, counts
 * (`fileTableScanReady`). A collection whose table no migration creates is not this rule's.
 */
export const checkScanMigrations = (
	files: ReadonlyMap<string, string>,
	scanning: readonly string[],
): Finding[] => {
	const migrations = [...files.entries()]
		.filter(
			([path]) => path.startsWith(MIGRATIONS_DIR) && path.endsWith('.sql'),
		)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
	const findings: Finding[] = []
	for (const name of scanning) {
		const table = `fabrika_files_${name}`
		if (
			fileTableScanReady(
				migrations.map(([, sql]) => sql),
				table,
			) !== false
		) {
			continue
		}
		const creating = migrations.find(
			([, sql]) => fileTableScanReady([sql], table) !== undefined,
		)
		const path = creating?.[0] ?? MIGRATIONS_DIR
		const line = creating === undefined ? 1 : lineOf(creating[1], table)
		findings.push({
			file: path,
			line,
			column: 1,
			severity: 'refusal',
			rule: 'file-scan-migration',
			message: `files '${name}' sets scan: true, and no migration lets ${table} hold a quarantined file`,
			allowed:
				`a new migration holding fileScanSql('${name}') of @fabrika/db, exactly as it writes it: ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS …, ADD CONSTRAINT ${table}_status CHECK (…), ADD COLUMN object_version TEXT, …`,
		})
	}
	return findings
}

/** The line of the `CREATE TABLE` of `table` in `sql`. */
function lineOf(sql: string, table: string): number {
	const match = new RegExp(
		`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${table}\\b`,
		'i',
	).exec(sql)
	return match === null ? 1 : sql.slice(0, match.index).split('\n').length
}
