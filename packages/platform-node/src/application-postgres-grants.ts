import type { SqlDatabase } from '@fabrika/platform'
import { PostgresMigrationError } from './postgres-migration-error'

/** Postgres' `lock_not_available`, which `lock_timeout` raises. */
const LOCK_NOT_AVAILABLE = '55P03'

const sqlState = (error: unknown): unknown => typeof error === 'object' && error !== null ? Reflect.get(error, 'errno') : undefined

/**
 * Takes the migration's session-level advisory lock. Any role may take any advisory lock, the application's own
 * runtime included, so an application's wait is bounded by `timeoutMs`; a service plan waits as long as it takes.
 */
export async function acquireMigrationLock(db: SqlDatabase, lockKey: number, timeoutMs: number | undefined, label: string): Promise<void> {
	const lock = db.prepare(`SELECT pg_catalog.pg_advisory_lock(${lockKey})`)
	if (timeoutMs === undefined) {
		await lock.run()
		return
	}
	await db.prepare(`SET lock_timeout = ${timeoutMs}`).run()
	try {
		await lock.run()
	} catch (error) {
		if (sqlState(error) === LOCK_NOT_AVAILABLE) {
			throw new PostgresMigrationError(
				`the migration lock of ${label} was not free within ${timeoutMs} ms: another migration of the application, or a session that holds its advisory lock, still runs`,
			)
		}
		throw error
	} finally {
		await db.prepare('RESET lock_timeout').run()
	}
}

/**
 * Clears PUBLIC from the default privileges of the session's role (the migration role), globally and in its schema,
 * before the plan creates anything. A default the provisioning credential or a superuser set would otherwise hand
 * every table a later migration creates to the runtime role through PUBLIC.
 */
export async function normalizeDefaultPrivileges(db: SqlDatabase, schema: string): Promise<void> {
	const kinds = ['TABLES', 'SEQUENCES', 'FUNCTIONS', 'TYPES']
	await db.batch([
		...kinds.map((kind) => db.prepare(`ALTER DEFAULT PRIVILEGES REVOKE ALL ON ${kind} FROM PUBLIC`)),
		...kinds.map((kind) => db.prepare(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE ALL ON ${kind} FROM PUBLIC`)),
	])
}

/**
 * Resets the schema's privileges to what the runtime role needs: PUBLIC and the runtime role lose everything on the
 * schema and its objects, then the runtime role gets USAGE, DML on every table but the ledger, EXECUTE on the schema's
 * routines and USAGE on its types. One transaction, so a live runtime never sees a gap. Then the effective privileges
 * are verified, PUBLIC included, and anything beyond that stops the deploy.
 */
export async function grantRuntimeRole(db: SqlDatabase, schema: string, ledgerTable: string, role: string): Promise<void> {
	try {
		await db.batch([
			db.prepare('SET LOCAL search_path TO pg_catalog, pg_temp'),
			db.prepare(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC, ${role}`),
			db.prepare(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC, ${role}`),
			db.prepare(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM PUBLIC, ${role}`),
			db.prepare(`REVOKE ALL ON ALL ROUTINES IN SCHEMA ${schema} FROM PUBLIC, ${role}`),
			db.prepare(`DO $types$
				DECLARE t pg_catalog.regtype;
				BEGIN
					FOR t IN SELECT y.oid::pg_catalog.regtype FROM pg_catalog.pg_type y LEFT JOIN pg_catalog.pg_class c ON c.oid = y.typrelid
						WHERE y.typnamespace = '${schema}'::pg_catalog.regnamespace AND (y.typtype IN ('e', 'd', 'r') OR c.relkind = 'c')
					LOOP
						EXECUTE pg_catalog.format('REVOKE ALL ON TYPE %s FROM PUBLIC, ${role}', t);
						EXECUTE pg_catalog.format('GRANT USAGE ON TYPE %s TO ${role}', t);
					END LOOP;
				END $types$`),
			db.prepare(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`),
			db.prepare(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`),
			db.prepare(`REVOKE ALL ON TABLE ${ledgerTable} FROM ${role}`),
			db.prepare(`GRANT EXECUTE ON ALL ROUTINES IN SCHEMA ${schema} TO ${role}`),
		])
	} catch (error) {
		throw new PostgresMigrationError(`granting the runtime role ${role} its privileges in ${schema} failed`, { cause: error })
	}
	await verifyRuntimeRole(db, schema, ledgerTable, role)
}

interface Problem {
	readonly problem: string
}

/** The runtime role's effective privileges in its schema, PUBLIC's included, and the migration role's default privileges. */
async function verifyRuntimeRole(db: SqlDatabase, schema: string, ledgerTable: string, role: string): Promise<void> {
	const { results } = await db.prepare(`
		WITH runtime AS (SELECT oid, rolname FROM pg_catalog.pg_roles WHERE rolname OPERATOR(pg_catalog.=) ?::pg_catalog.name),
			ledger AS (SELECT pg_catalog.to_regclass(?::pg_catalog.text) AS oid),
			table_privileges AS (
				SELECT pg_catalog.unnest(CASE WHEN pg_catalog.current_setting('server_version_num')::pg_catalog.int4 OPERATOR(pg_catalog.>=) 170000
					THEN ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] ELSE ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER'] END) AS privilege)
		SELECT pg_catalog.format('%s may create objects in schema %s', runtime.rolname, ?::pg_catalog.text) AS problem FROM runtime
			WHERE pg_catalog.has_schema_privilege(runtime.oid, ?::pg_catalog.text, 'CREATE')
		UNION ALL
		SELECT pg_catalog.format('%s holds %s on %s', runtime.rolname, p.privilege, c.oid::pg_catalog.regclass) FROM runtime, table_privileges p, pg_catalog.pg_class c
			WHERE c.relnamespace OPERATOR(pg_catalog.=) ?::pg_catalog.regnamespace AND c.relkind OPERATOR(pg_catalog.=) ANY (ARRAY['r', 'p', 'v', 'm', 'f']::"char"[])
				AND pg_catalog.has_table_privilege(runtime.oid, c.oid, p.privilege)
		UNION ALL
		SELECT pg_catalog.format('%s may %s the migration ledger', runtime.rolname, p.privilege) FROM runtime, ledger, pg_catalog.unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p(privilege)
			WHERE pg_catalog.has_table_privilege(runtime.oid, ledger.oid, p.privilege)
				OR (p.privilege OPERATOR(pg_catalog.<>) 'DELETE' AND pg_catalog.has_any_column_privilege(runtime.oid, ledger.oid, p.privilege))
		UNION ALL
		SELECT pg_catalog.format('a default privilege of %s grants %s on every new object of kind %s to %s', pg_catalog.pg_get_userbyid(d.defaclrole),
				a.privilege_type, d.defaclobjtype, CASE WHEN a.grantee OPERATOR(pg_catalog.=) 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END)
			FROM pg_catalog.pg_default_acl d, pg_catalog.aclexplode(d.defaclacl) a
			WHERE d.defaclrole OPERATOR(pg_catalog.=) (SELECT oid FROM pg_catalog.pg_roles WHERE rolname OPERATOR(pg_catalog.=) current_user)
				AND a.grantee OPERATOR(pg_catalog.<>) d.defaclrole`).bind(role, ledgerTable, schema, schema, schema).all<Problem>()
	if (results.length > 0) {
		throw new PostgresMigrationError(
			`${
				results.map((row) => row.problem).join('; ')
			}; the deploy stops, because the runtime role ${role} has DML on its tables and nothing else (ADR-0017)`,
		)
	}
}
