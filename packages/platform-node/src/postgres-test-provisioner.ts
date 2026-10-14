import type { SqlDatabase } from '@fabrika/platform'
import { createHash, randomBytes } from 'node:crypto'
import { provisioningCredential, quotedIdentifier, scramVerifier } from './application-postgres-roles'
import { PostgresMigrationError } from './postgres-migration-error'
import { PostgresDatabase } from './sql-postgres'

/** A provisioning credential that exists for one test run only, and what it created. */
export interface TestProvisioner {
	/** Connects as `fabrika_tests_<hex>`: CREATEROLE and CREATE on the database, nothing of any application. */
	readonly url: string
	/** Drops every role the provisioner created, with everything those roles own, then the provisioner itself. */
	drop(): Promise<void>
}

/**
 * Every grant or revoke on a database changes its one `pg_database` row, and two concurrent changes of that row fail with
 * `tuple concurrently updated`, so each change waits for this transaction-level lock first.
 */
export const DATABASE_GRANT_LOCK_KEY: number = createHash('sha256').update('fabrika-db:database-grants', 'utf8').digest().readUIntBE(0, 6) + 1

/** Grants (or revokes) CREATE on `database` to `role`, serialized with every other run that does so on the same server. */
export async function changeCreateOnDatabase(admin: SqlDatabase, change: 'grant' | 'revoke', role: string, database: string): Promise<void> {
	const statement = change === 'grant'
		? `GRANT CREATE ON DATABASE ${quotedIdentifier(database)} TO ${quotedIdentifier(role)}`
		: `REVOKE CREATE ON DATABASE ${quotedIdentifier(database)} FROM ${quotedIdentifier(role)}`
	await admin.batch([admin.prepare(`SELECT pg_catalog.pg_advisory_xact_lock(${DATABASE_GRANT_LOCK_KEY})`), admin.prepare(statement)])
}

/** Before Postgres 16, CREATEROLE may grant membership in any role that is not a superuser, `pg_execute_server_program` included. */
const MINIMUM_SERVER_VERSION = 160000

/**
 * Creates a throwaway provisioning credential for code the platform runs but did not write, such as an application's
 * generated tests: it can create the test kit's role families and schemas, and reaches no application's data, because
 * a CREATEROLE role administers only the roles it created. The provisioning credential itself never leaves this process.
 */
export async function createTestProvisioner(provisioningUrl: string): Promise<TestProvisioner> {
	const { url } = provisioningCredential(provisioningUrl)
	const name = `fabrika_tests_${randomBytes(8).toString('hex')}`
	const password = randomBytes(32).toString('base64url')
	const admin = PostgresDatabase.connect(provisioningUrl, { max: 1 })
	try {
		const self = await admin.prepare(`SELECT rolsuper, rolcreaterole, pg_catalog.current_setting('server_version_num')::int AS version,
			pg_catalog.current_database() AS database FROM pg_catalog.pg_roles WHERE rolname = current_user`).first<{
			rolsuper: boolean
			rolcreaterole: boolean
			version: number
			database: string
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
		await admin.prepare(`CREATE ROLE ${name} LOGIN CREATEROLE NOINHERIT PASSWORD '${scramVerifier(password)}'`).run()
		await changeCreateOnDatabase(admin, 'grant', name, self.database)
		const database = self.database
		url.username = name
		url.password = password
		return { url: url.toString(), drop: () => dropTestProvisioner(provisioningUrl, name, database) }
	} finally {
		await admin.close()
	}
}

async function dropTestProvisioner(provisioningUrl: string, name: string, database: string): Promise<void> {
	const admin = PostgresDatabase.connect(provisioningUrl, { max: 1 })
	try {
		await admin.prepare(`GRANT ${name} TO CURRENT_USER`).run()
		await dropCreatedRoles(admin, name)
		await changeCreateOnDatabase(admin, 'revoke', name, database)
		await admin.prepare(`DROP ROLE ${name}`).run()
	} finally {
		await admin.close()
	}
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
