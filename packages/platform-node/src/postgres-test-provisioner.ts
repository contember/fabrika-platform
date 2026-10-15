import type { SqlDatabase } from '@fabrika/platform'
import { createHash, randomBytes } from 'node:crypto'
import { provisioningCredential, quotedIdentifier, scramVerifier } from './application-postgres-roles'
import { PostgresMigrationError } from './postgres-migration-error'
import { PostgresDatabase } from './sql-postgres'

/** A provisioning credential that exists for one test run only, and what it created. */
export interface TestProvisioner {
	/**
	 * Connects as `fabrika_tests_<hex>`: CREATEROLE and CREATE on the database, nothing of any application, and a login
	 * for `TEST_PROVISIONER_LIFETIME_MINUTES` only.
	 */
	readonly url: string
	/** The provisioners of earlier runs that creating this one dropped. Role names, never a credential. */
	readonly swept: readonly string[]
	/** Drops every role the provisioner created, with everything those roles own, then the provisioner itself. */
	drop(): Promise<void>
}

/**
 * Every grant or revoke on a database changes its one `pg_database` row, and two concurrent changes of that row fail with
 * `tuple concurrently updated`, so each change waits for this transaction-level lock first.
 */
export const DATABASE_GRANT_LOCK_KEY: number = createHash('sha256').update('fabrika-db:database-grants', 'utf8').digest().readUIntBE(0, 6) + 1

/**
 * Grants (or revokes) CREATE on `database` to `role`, serialized with every other run that does so on the same server.
 * Verified afterwards: a grantor that neither owns the database, is a superuser nor holds CREATE WITH GRANT OPTION only
 * gets a WARNING, and the statement changes nothing.
 */
export async function changeCreateOnDatabase(admin: SqlDatabase, change: 'grant' | 'revoke', role: string, database: string): Promise<void> {
	const statement = change === 'grant'
		? `GRANT CREATE ON DATABASE ${quotedIdentifier(database)} TO ${quotedIdentifier(role)}`
		: `REVOKE CREATE ON DATABASE ${quotedIdentifier(database)} FROM ${quotedIdentifier(role)}`
	await admin.batch([admin.prepare(`SELECT pg_catalog.pg_advisory_xact_lock(${DATABASE_GRANT_LOCK_KEY})`), admin.prepare(statement)])
	const held = await admin.prepare("SELECT pg_catalog.has_database_privilege(?, ?, 'CREATE') AS creates").bind(role, database).first<{
		creates: boolean
	}>()
	if ((held?.creates ?? false) !== (change === 'grant')) {
		throw new PostgresMigrationError(
			`the provisioning credential could not ${change} CREATE on the database ${database} ${
				change === 'grant' ? 'to' : 'from'
			} ${role}: it must own the database, be a superuser, or hold CREATE on it WITH GRANT OPTION`,
		)
	}
}

/** Before Postgres 16, CREATEROLE may grant membership in any role that is not a superuser, `pg_execute_server_program` included. */
const MINIMUM_SERVER_VERSION = 160000

/** A provisioner's name. The sweep selects by it, so a role of another kind never matches. */
const TEST_PROVISIONER_NAME = /^fabrika_tests_[0-9a-f]{16}$/

/**
 * How long a provisioner can log in (`VALID UNTIL`). A run that a kill stopped before `drop()` leaves its provisioner
 * behind, and nobody knows its password; after this time it also cannot log in, and the next run's sweep drops it. A
 * run makes new connections until it ends, so this is far beyond the longest run.
 */
export const TEST_PROVISIONER_LIFETIME_MINUTES = 15

/**
 * The session-level lock one sweep holds. A run that does not get it skips its sweep: the run that holds it is sweeping
 * the same leftovers, and any role may take any advisory lock, so a run never waits for it.
 */
const SWEEP_LOCK_KEY: number = createHash('sha256').update('fabrika-db:test-provisioner-sweep', 'utf8').digest().readUIntBE(0, 6) + 1

/**
 * Creates a throwaway provisioning credential for code the platform runs but did not write, such as an application's
 * generated tests: it can create the test kit's role families and schemas, and reaches no application's data, because
 * a CREATEROLE role administers only the roles it created. The provisioning credential itself never leaves this process.
 * First it drops the provisioners earlier runs left behind (`sweepTestProvisioners`).
 */
export async function createTestProvisioner(provisioningUrl: string): Promise<TestProvisioner> {
	const { url } = provisioningCredential(provisioningUrl)
	const name = `fabrika_tests_${randomBytes(8).toString('hex')}`
	const password = randomBytes(32).toString('base64url')
	const admin = PostgresDatabase.connect(provisioningUrl, { max: 1 })
	try {
		const self = await admin.prepare(`SELECT rolsuper, rolcreaterole, pg_catalog.current_setting('server_version_num')::int AS version,
			pg_catalog.current_database() AS database,
			pg_catalog.quote_literal((pg_catalog.now() + interval '${TEST_PROVISIONER_LIFETIME_MINUTES} minutes')::text) AS valid_until
			FROM pg_catalog.pg_roles WHERE rolname = current_user`).first<{
			rolsuper: boolean
			rolcreaterole: boolean
			version: number
			database: string
			valid_until: string
		}>()
		if (self === null || (!self.rolsuper && !self.rolcreaterole)) {
			throw new PostgresMigrationError(
				'the provisioning credential is neither a superuser nor holds CREATEROLE, so it cannot create the test run its own',
			)
		}
		if (self.version < MINIMUM_SERVER_VERSION) {
			throw new PostgresMigrationError(
				'the test run needs Postgres 16 or later: before 16, a CREATEROLE role may grant itself any role that is not a superuser',
			)
		}
		const swept = await sweepTestProvisioners(admin, self.database)
		await admin.prepare(`CREATE ROLE ${name} LOGIN CREATEROLE NOINHERIT PASSWORD '${scramVerifier(password)}' VALID UNTIL ${self.valid_until}`).run()
		try {
			await changeCreateOnDatabase(admin, 'grant', name, self.database)
		} catch (error) {
			await admin.prepare(`DROP ROLE ${name}`).run()
			throw error
		}
		const database = self.database
		url.username = name
		url.password = password
		return { url: url.toString(), swept, drop: () => dropTestProvisioner(provisioningUrl, name, database) }
	} finally {
		await admin.close()
	}
}

async function dropTestProvisioner(provisioningUrl: string, name: string, database: string): Promise<void> {
	const admin = PostgresDatabase.connect(provisioningUrl, { max: 1 })
	try {
		await dropProvisioner(admin, name, database)
	} finally {
		await admin.close()
	}
}

/**
 * As the provisioning credential: drops every provisioner an earlier run left behind (a run killed before `drop()`),
 * with everything it administers. A leftover is one past its `VALID UNTIL`, or without one (a release before it), that
 * the credential administers, that holds CREATE on no other database, and that has no session, neither as itself nor as
 * a role it created. A concurrent run's provisioner is still valid; a session keeps one that outlived its validity.
 */
async function sweepTestProvisioners(admin: SqlDatabase, database: string): Promise<readonly string[]> {
	const lock = await admin.prepare(`SELECT pg_catalog.pg_try_advisory_lock(${SWEEP_LOCK_KEY}) AS locked`).first<{ locked: boolean }>()
	if (lock?.locked !== true) return []
	try {
		const { results } = await admin.prepare(`SELECT r.rolname AS name FROM pg_catalog.pg_roles r
			WHERE r.rolname ~ ?
				AND (r.rolvaliduntil IS NULL OR r.rolvaliduntil < pg_catalog.now())
				AND pg_catalog.pg_has_role(r.oid, 'MEMBER WITH ADMIN OPTION')
				AND NOT EXISTS (SELECT FROM pg_catalog.pg_database d
					WHERE d.datname <> pg_catalog.current_database() AND pg_catalog.has_database_privilege(r.oid, d.oid, 'CREATE'))
				AND NOT EXISTS (SELECT FROM pg_catalog.pg_stat_activity a
					WHERE a.usesysid = r.oid
						OR a.usesysid IN (SELECT m.roleid FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid AND m.admin_option))
			ORDER BY 1`).bind(TEST_PROVISIONER_NAME.source).all<{ name: string }>()
		const swept: string[] = []
		for (const { name } of results) {
			if (!TEST_PROVISIONER_NAME.test(name)) continue
			await dropProvisioner(admin, name, database)
			swept.push(name)
		}
		return swept
	} finally {
		await admin.prepare(`SELECT pg_catalog.pg_advisory_unlock(${SWEEP_LOCK_KEY})`).run()
	}
}

/** As the provisioning credential: the provisioner's roles with what they own, its CREATE on `database`, then itself. */
async function dropProvisioner(admin: SqlDatabase, name: string, database: string): Promise<void> {
	await admin.prepare(`GRANT ${name} TO CURRENT_USER`).run()
	await dropCreatedRoles(admin, name)
	await changeCreateOnDatabase(admin, 'revoke', name, database)
	await admin.prepare(`DROP ROLE ${name}`).run()
}

/** As the provisioner: each role it administers, made its own for a moment so that its objects can be dropped, then dropped. */
async function dropCreatedRoles(admin: SqlDatabase, name: string): Promise<void> {
	const { results } = await admin.prepare(`SELECT pg_catalog.pg_get_userbyid(m.roleid) AS role FROM pg_catalog.pg_auth_members m
		WHERE m.member = pg_catalog.to_regrole(?) AND m.admin_option ORDER BY 1`).bind(name).all<{ role: string }>()
	for (const { role } of results) {
		const quoted = quotedIdentifier(role)
		await admin.batch([
			admin.prepare(`SET LOCAL ROLE ${name}`),
			admin.prepare(`GRANT ${quoted} TO ${name}`),
		])
		await admin.batch([admin.prepare(`SET LOCAL ROLE ${quoted}`), admin.prepare(`DROP OWNED BY ${quoted} CASCADE`)])
		await admin.batch([admin.prepare(`SET LOCAL ROLE ${name}`), admin.prepare(`DROP ROLE ${quoted}`)])
	}
}
