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

/** One statement of a migration file, split on `;` with `--` comments blanked: enough to find a file table's DDL. */
interface Statement {
	readonly path: string
	readonly line: number
	readonly text: string
}

const statementsOf = (path: string, sql: string): Statement[] => {
	const statements: Statement[] = []
	let line = 1
	for (const part of sql.replace(/--[^\n]*/g, '').split(';')) {
		const leading = part.length - part.trimStart().length
		statements.push({ path, line: line + (part.slice(0, leading).match(/\n/g)?.length ?? 0), text: part })
		line += part.match(/\n/g)?.length ?? 0
	}
	return statements
}

/**
 * A `scan: true` collection whose table an earlier `fileTableSql` created admits only `pending` and `live`, so every
 * upload would fail at its `quarantined` row. It needs the migration `fileScanSql` writes. A collection whose table no
 * migration creates is not this rule's.
 */
export const checkScanMigrations = (files: ReadonlyMap<string, string>, scanning: readonly string[]): Finding[] => {
	const statements = [...files.entries()]
		.filter(([path]) => path.startsWith(MIGRATIONS_DIR) && path.endsWith('.sql'))
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.flatMap(([path, sql]) => statementsOf(path, sql))
	const findings: Finding[] = []
	for (const name of scanning) {
		const table = `fabrika_files_${name}`
		const names = new RegExp(`\\b${table}\\b`, 'i')
		const creates = new RegExp(`^\\s*create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${table}\\b`, 'i')
		const created = statements.find((statement) => creates.test(statement.text))
		const widened = statements.some((statement) => names.test(statement.text) && statement.text.includes("'quarantined'"))
		if (created === undefined || widened) continue
		findings.push({
			file: created.path,
			line: created.line,
			column: 1,
			severity: 'refusal',
			rule: 'file-scan-migration',
			message: `files '${name}' sets scan: true, and no migration lets ${table} hold a quarantined file`,
			allowed:
				`a new migration holding fileScanSql('${name}') of @fabrika/db: ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS …, ADD CONSTRAINT ${table}_status CHECK (status IN ('pending', 'live', 'quarantined', 'rejected'))`,
		})
	}
	return findings
}
