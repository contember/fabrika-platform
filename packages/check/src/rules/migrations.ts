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
		findings.push({ file: path, line: 1, column: 1, rule: 'migration-name', message, allowed: ALLOWED })
	}
	return findings
}
