// What the platform refuses of an application's migrations, found before the push instead of in a deploy's run log:
// the classifier Control runs on every snapshot, and on Cloudflare the backup's plan of the migrated schema, which every
// migration deploy takes first.

import { describeOpsDumpSchema, planOpsDump } from '@fabrika/auth-core'
import { withMigratedSqlite } from '@fabrika/db/codegen-sqlite'
import { FRAMEWORK_MIGRATION_BUNDLE } from '@fabrika/db/migrations'
import { SQLITE_FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations-sqlite'
import { applicationDatabaseSchema, classifyMigrations } from '@fabrika/platform-node/sql'
import type { Finding } from '../finding'
import { MIGRATIONS_DIR } from '../layout'

interface MigrationText {
	readonly path: string
	readonly name: string
	readonly sql: string
}

/** The files of `db/migrations` itself, by name: the order the runner and Control read them in. */
const migrationTexts = (files: ReadonlyMap<string, string>): MigrationText[] =>
	[...files].flatMap(([path, sql]) => {
		const name = path.slice(MIGRATIONS_DIR.length)
		return path.startsWith(MIGRATIONS_DIR) && name.endsWith('.sql') && !name.includes('/') ? [{ path, name, sql }] : []
	}).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))

/**
 * Every statement Control's classifier refuses, at its file and line. Control refuses a deploy whose new migration holds
 * one (`migrations-refused`), and its run log names neither, so this is where the author finds it. Every file is
 * checked, applied or not: the checker does not know which an environment holds.
 */
export const checkMigrationClassification = (files: ReadonlyMap<string, string>, appId: string): Finding[] => {
	const texts = migrationTexts(files)
	if (texts.length === 0) return []
	const paths = new Map(texts.map((text) => [text.name, text.path]))
	return classifyMigrations(texts.map(({ name, sql }) => ({ name, sql })), applicationDatabaseSchema(appId)).files.flatMap((file) =>
		file.refused.map((refusal): Finding => ({
			file: paths.get(refusal.file) ?? `${MIGRATIONS_DIR}${refusal.file}`,
			line: refusal.line,
			column: 1,
			severity: 'refusal',
			rule: 'migration-refused',
			message: `${refusal.reason} is not allowed: Control refuses the deploy that brings this migration`,
			allowed: 'the statements, functions and objects the migration classifier admits (application-runtime reference, "Migrations")',
		}))
	)
}

/**
 * On Cloudflare, the backup's refusal of the migrated schema (`planOpsDump`), at the newest migration that names the
 * table. Every migration deploy backs the environment up first, so a schema the backup refuses blocks every migration
 * after the one that made it. A migration set that does not apply is codegen's to report, so it finds nothing here.
 */
export const checkBackupPlan = async (files: ReadonlyMap<string, string>): Promise<Finding[]> => {
	const texts = migrationTexts(files)
	if (texts.length === 0) return []
	let refused: { readonly table: string | null } | null
	try {
		refused = await withMigratedSqlite([
			{ bundle: FRAMEWORK_MIGRATION_BUNDLE, migrations: SQLITE_FRAMEWORK_MIGRATIONS },
			{ bundle: 'app', migrations: texts.map(({ name, sql }) => ({ name, sql })) },
		], (db) => {
			const plan = planOpsDump(describeOpsDumpSchema((query, ...bindings) => db.query<Record<string, unknown>, string[]>(query).all(...bindings)))
			return 'refused' in plan ? plan : null
		})
	} catch {
		return []
	}
	if (refused === null) return []
	const at = refused.table === null ? undefined : newestNaming(texts, refused.table)
	const last = texts[texts.length - 1]
	return [{
		file: at?.path ?? last?.path ?? MIGRATIONS_DIR,
		line: at?.line ?? 1,
		column: 1,
		severity: 'refusal',
		rule: 'backup-schema',
		message: refused.table === null
			? 'the migrated schema cannot be backed up (a table name the data layer does not admit, or two tables of one name)'
			: `table ${refused.table} cannot be backed up, and every migration deploy takes a backup first`,
		allowed:
			"a foreign key inside its table's cycle that is nullable, outside the primary key, referenced by no other key and named by no CHECK (ADR-0070 section 2); or no such key",
	}]
}

/** The newest migration that names `table`, and the first line there that does. */
const newestNaming = (texts: readonly MigrationText[], table: string): { path: string; line: number } | undefined => {
	const word = new RegExp(`(^|[^A-Za-z0-9_$])["\`[]?${table.replace(/[$]/g, '\\$&')}["\`\\]]?($|[^A-Za-z0-9_$])`, 'i')
	for (const text of [...texts].reverse()) {
		const index = text.sql.split('\n').findIndex((line) => word.test(line))
		if (index >= 0) return { path: text.path, line: index + 1 }
	}
	return undefined
}
