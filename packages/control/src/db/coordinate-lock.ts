// The durable lock of one `<app>@<env>` (ADR-0050): its `app_env_protection` row, which is never deleted. Every write
// that creates, changes, deletes, protects or publishes the environment first ensures that row and locks it, and only
// then reads the tombstone or the environment, so on Postgres those reads see every write that committed before.
// SQLite and D1 run one batch at a time; there the statements change nothing.
//
// Lock order: a run's `deploy_locks` lease row, then the `apps` row, then protection rows, then `app_envs` rows.

import type { SqlDatabase, SqlStatement } from '@fabrika/platform'

/** A new environment is protected by default only as `prod`. */
export const defaultProtected = (env: string): number => (env === 'prod' ? 1 : 0)

export function coordinateLockStatements(d1: SqlDatabase, appId: string, env: string): SqlStatement[] {
	return [
		d1.prepare(`INSERT INTO app_env_protection (app_id, env, protected, generation, protection_revision)
			VALUES (?, ?, ?, 0, 0) ON CONFLICT (app_id, env) DO NOTHING`).bind(appId, env, defaultProtected(env)),
		d1.prepare('UPDATE app_env_protection SET generation = generation WHERE app_id = ? AND env = ?').bind(appId, env),
	]
}

/** The coordinate lock of the environment a run deploys. */
export function runCoordinateLockStatements(d1: SqlDatabase, runId: string): SqlStatement[] {
	return [
		d1.prepare(`INSERT INTO app_env_protection (app_id, env, protected, generation, protection_revision)
			SELECT app_id, env, CASE WHEN env = 'prod' THEN 1 ELSE 0 END, 0, 0 FROM runs WHERE id = ?
			ON CONFLICT (app_id, env) DO NOTHING`).bind(runId),
		d1.prepare(`UPDATE app_env_protection SET generation = generation
			WHERE EXISTS (SELECT 1 FROM runs WHERE runs.id = ? AND runs.app_id = app_env_protection.app_id AND runs.env = app_env_protection.env)`)
			.bind(runId),
	]
}

/**
 * Every protection row of an app, for its deletion, after the `apps` row lock that keeps new environments out. Only an
 * app deletion locks more than one protection row, and the `apps` row serializes those, so their order cannot deadlock.
 */
export function appCoordinateLockStatements(d1: SqlDatabase, appId: string): SqlStatement[] {
	return [
		appRowLockStatement(d1, appId),
		d1.prepare(`INSERT INTO app_env_protection (app_id, env, protected, generation, protection_revision)
			SELECT app_id, env, protected, generation, protection_revision FROM app_envs WHERE app_id = ?
			ON CONFLICT (app_id, env) DO NOTHING`).bind(appId),
		d1.prepare('UPDATE app_env_protection SET generation = generation WHERE app_id = ?').bind(appId),
	]
}

/** Taken by every write that may create an environment, so an app deletion and a creation never interleave. */
export function appRowLockStatement(d1: SqlDatabase, appId: string): SqlStatement {
	return d1.prepare('UPDATE apps SET default_branch = default_branch WHERE id = ?').bind(appId)
}
