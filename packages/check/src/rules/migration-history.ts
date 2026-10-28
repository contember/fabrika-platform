// A migration that a shared branch already holds, edited, renamed or deleted in the tree being checked. Every runner
// keeps the SHA-256 of each applied file and refuses a deploy whose file changed after it ran (ADR-0017), and Control
// and the deploy see one commit, not its history: the checker is where the edit can be named before the push.

import type { Finding } from '../finding'
import { MIGRATIONS_DIR } from '../layout'

/** The migrations of `db/migrations` at the commit the tree is compared with, by path relative to the root. */
export interface MigrationBase {
	/** How the commit is named to the author, such as `origin/main`. */
	readonly ref: string
	readonly files: ReadonlyMap<string, string>
}

const ALLOWED = 'the file as it is there, and the change as a new migration (bunx fabrika db new <slug>)'

const isMigration = (path: string): boolean => {
	const name = path.slice(MIGRATIONS_DIR.length)
	return path.startsWith(MIGRATIONS_DIR) && name.endsWith('.sql') && !name.includes('/')
}

/** Lines without a trailing carriage return: a Windows checkout's line ends are not an edit of the committed file. */
const linesOf = (sql: string): string[] => sql.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))

/** The first line where `current` leaves `base`, or its last line when it only lost lines at the end. */
const firstChangedLine = (base: readonly string[], current: readonly string[]): number | null => {
	const length = Math.max(base.length, current.length)
	for (let index = 0; index < length; index++) {
		if (base[index] !== current[index]) return Math.min(index, current.length - 1) + 1
	}
	return null
}

/**
 * Each migration of `base` that the tree changed (at its first changed line) or no longer holds. A file renamed is one
 * removed and one new, and the new one would run again where the old one ran, so the removal is what is reported.
 */
export const checkMigrationHistory = (files: ReadonlyMap<string, string>, base: MigrationBase): Finding[] => {
	const findings: Finding[] = []
	for (const [path, committed] of base.files) {
		if (!isMigration(path)) continue
		const name = path.slice(MIGRATIONS_DIR.length)
		const current = files.get(path)
		if (current === undefined) {
			findings.push({
				file: path,
				line: 1,
				column: 1,
				severity: 'refusal',
				rule: 'migration-edited',
				message:
					`'${name}' is in ${base.ref} and was deleted or renamed: an environment that applied it keeps its changes, and a renamed file runs again there`,
				allowed: ALLOWED,
			})
			continue
		}
		const line = firstChangedLine(linesOf(committed), linesOf(current))
		if (line === null) continue
		findings.push({
			file: path,
			line,
			column: 1,
			severity: 'refusal',
			rule: 'migration-edited',
			message: `'${name}' differs from ${base.ref}: a deploy refuses a migration that changed after it was applied, even in a comment`,
			allowed: ALLOWED,
		})
	}
	return findings
}
