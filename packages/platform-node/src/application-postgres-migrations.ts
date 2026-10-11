import type { SqlDatabase } from '@fabrika/platform'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { foreignSchemaReference } from './migration-sql'
import {
	applyPostgresMigrations,
	definePostgresMigrationPlan,
	type PostgresMigration,
	PostgresMigrationError,
	type PostgresMigrationPlan,
	readPostgresMigrationBundle,
} from './postgres-migrations'

/** IAM's application id alphabet; `-` maps to `_`, which the alphabet lacks, so two ids never share a schema. */
const APP_ID = /^[a-z0-9][a-z0-9-]*$/
/** Postgres truncates identifiers to 63 bytes; `app_` takes four of them. */
const MAX_APP_ID_LENGTH = 59
/** The file-name contract the checker enforces (`db/migrations/`, `@fabrika/check`); timestamps keep worktrees apart. */
const APPLICATION_MIGRATION_NAME = /^\d{14}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/

/** Migration identity of every application (ADR-0017): bundle `app`, ledger `app_<id>.fabrika_migrations`. */
export const APPLICATION_MIGRATION_BUNDLE = 'app'
export const APPLICATION_MIGRATION_LEDGER = 'fabrika_migrations'
/** Fails a migration that waits this long for a lock, so a blocked `ALTER` does not queue the live version's queries. */
export const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 5_000
/** Bounds a statement such as a backfill or a non-concurrent index build, which holds its lock while it runs. */
export const DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS = 60_000

export interface PostgresApplicationMigrationsConfig {
	readonly appId: string
	/** The application's `db/migrations/` directory. */
	readonly directory: string
	readonly lockTimeoutMs?: number
	readonly statementTimeoutMs?: number
	/**
	 * The framework's own tables (`fabrika_*`, `@fabrika/db/migrations`), applied as their own bundle before the
	 * application's, in the same ledger and under the same checksum rule.
	 */
	readonly framework?: { readonly bundle: string; readonly migrations: readonly PostgresMigration[] }
}

export interface PostgresApplicationMigrations {
	/** `app_<id>`: the application's schema, which the data layer sets as its `search_path`. */
	readonly schema: string
	read(): PostgresMigration[]
	plan(migrations?: readonly PostgresMigration[]): PostgresMigrationPlan
	apply(db: SqlDatabase, migrations?: readonly PostgresMigration[]): Promise<string[]>
}

function validateAppId(appId: string): void {
	if (!APP_ID.test(appId) || appId.length > MAX_APP_ID_LENGTH) {
		throw new PostgresMigrationError(`Invalid application id for a database schema: ${appId} (lowercase letters, digits and -, at most 59)`)
	}
}

export function applicationDatabaseSchema(appId: string): string {
	validateAppId(appId)
	return `app_${appId.replaceAll('-', '_')}`
}

/** The first 48 bits of SHA-256(`fabrika-db:<appId>`), plus one: applications sharing a database do not serialize each other. */
export function applicationMigrationLockKey(appId: string): number {
	validateAppId(appId)
	return createHash('sha256').update(`fabrika-db:${appId}`, 'utf8').digest().readUIntBE(0, 6) + 1
}

/** An application's migration wrapper: its schema, ledger, lock and timeouts are derived, never configured. */
export function definePostgresApplicationMigrations(config: PostgresApplicationMigrationsConfig): PostgresApplicationMigrations {
	const schema = applicationDatabaseSchema(config.appId)
	const lockKey = applicationMigrationLockKey(config.appId)
	const read = (): PostgresMigration[] => {
		if (!existsSync(config.directory)) {
			throw new PostgresMigrationError(`No migrations directory at ${config.directory}; create the first migration with fabrika db new <slug>`)
		}
		const { migrations } = readPostgresMigrationBundle({ name: APPLICATION_MIGRATION_BUNDLE, directory: config.directory })
		return [...migrations]
	}
	const plan = (migrations: readonly PostgresMigration[] = read()): PostgresMigrationPlan => {
		for (const migration of migrations) {
			if (!APPLICATION_MIGRATION_NAME.test(migration.name)) {
				throw new PostgresMigrationError(`Application migration ${migration.name} is not named YYYYMMDDHHMMSS_slug.sql`)
			}
			const foreign = foreignSchemaReference(migration.sql)
			if (foreign !== undefined) {
				throw new PostgresMigrationError(
					`Application migration ${migration.name} line ${foreign.line} names the schema ${foreign.schema}; an application migration names its own tables unqualified`,
				)
			}
		}
		return definePostgresMigrationPlan({
			ledgerTable: `${schema}.${APPLICATION_MIGRATION_LEDGER}`,
			lockKey,
			bundles: [
				...(config.framework === undefined ? [] : [{ name: config.framework.bundle, migrations: config.framework.migrations }]),
				{ name: APPLICATION_MIGRATION_BUNDLE, migrations },
			],
			application: {
				schema,
				lockTimeoutMs: config.lockTimeoutMs ?? DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
				statementTimeoutMs: config.statementTimeoutMs ?? DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS,
			},
		})
	}
	const apply = async (db: SqlDatabase, migrations: readonly PostgresMigration[] = read()): Promise<string[]> =>
		applyPostgresMigrations(db, plan(migrations))
	return { schema, read, plan, apply }
}
