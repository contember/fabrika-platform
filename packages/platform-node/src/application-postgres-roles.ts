import type { SqlDatabase } from '@fabrika/platform'
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import { PostgresMigrationError } from './postgres-migrations'

/** An application's schema and the two roles that reach it (ADR-0017). */
export interface ApplicationDatabaseRoles {
	/** `app_<id>`. */
	readonly schema: string
	/** Owns the schema and every object in it, so it is the only role that runs DDL there. Named like the schema. */
	readonly migration: string
	/** `run_<id>`: DML on the schema's tables except the migration ledger, and nothing else. */
	readonly runtime: string
}

const ROLE_NAME = /^(?:app|run)_[a-z0-9_]{1,59}$/
const SCRAM_ITERATIONS = 4096

function validateRoles(roles: ApplicationDatabaseRoles): void {
	for (const name of [roles.schema, roles.migration, roles.runtime]) {
		if (!ROLE_NAME.test(name)) throw new PostgresMigrationError(`Invalid application database role or schema: ${name}`)
	}
}

function provisioningCredential(provisioningUrl: string): { readonly url: URL; readonly password: string } {
	let url: URL
	try {
		url = new URL(provisioningUrl)
	} catch {
		throw new PostgresMigrationError('the provisioning credential is not a connection URL')
	}
	const password = decodeURIComponent(url.password)
	if (password === '') {
		throw new PostgresMigrationError("the provisioning credential has no password; the application's database roles derive theirs from it")
	}
	return { url, password }
}

/** HMAC-SHA-256 of the role's name under the provisioning password: whoever holds that credential derives it, so nothing stores it. */
function derivedPassword(provisioningPassword: string, role: string): string {
	return createHmac('sha256', provisioningPassword).update(`fabrika-db-role:${role}`, 'utf8').digest('base64url')
}

/** Postgres' SCRAM-SHA-256 verifier (RFC 7677): the password itself never reaches the server, so no statement log holds it. */
function scramVerifier(password: string): string {
	const salt = randomBytes(16)
	const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, 'sha256')
	const storedKey = createHash('sha256').update(createHmac('sha256', salted).update('Client Key').digest()).digest()
	const serverKey = createHmac('sha256', salted).update('Server Key').digest()
	return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
}

/** The URL `role` connects with: the provisioning URL's host, database and options, the role's name and derived password. */
export function postgresRoleUrl(provisioningUrl: string, role: string): string {
	const { url, password } = provisioningCredential(provisioningUrl)
	url.username = role
	url.password = derivedPassword(password, role)
	return url.toString()
}

interface ProvisioningRole {
	readonly rolname: string
	readonly rolsuper: boolean
	readonly rolcreaterole: boolean
}

interface RoleReach {
	readonly rolname: string
	readonly attributes: string | null
	readonly memberships: string | null
	readonly creates_schemas: boolean
	readonly creates_in: string | null
}

/**
 * Creates the role family and the schema when absent, resets both roles' passwords to their derived values, and refuses
 * a family that holds more than it should. Runs over one connection of the provisioning credential, under the
 * application's migration lock, so two containers starting together do not race on the same catalog rows.
 */
export async function provisionPostgresRoles(
	admin: SqlDatabase,
	provisioningUrl: string,
	roles: ApplicationDatabaseRoles,
	lockKey: number,
): Promise<void> {
	validateRoles(roles)
	const { password } = provisioningCredential(provisioningUrl)
	// A dedicated session: nothing an application created can shadow a catalog function here.
	await admin.prepare('SET search_path TO pg_catalog, pg_temp').run()
	await admin.prepare(`SELECT pg_advisory_lock(${lockKey})`).run()
	try {
		const self = await admin.prepare('SELECT rolname, rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user').first<ProvisioningRole>()
		if (self === null || (!self.rolsuper && !self.rolcreaterole)) {
			throw new PostgresMigrationError(
				`the provisioning credential connects as ${
					self?.rolname ?? 'an unknown role'
				}, which is neither a superuser nor holds CREATEROLE, so it cannot create the application's database roles ${roles.migration} and ${roles.runtime}; nothing runs as the provisioning credential instead`,
			)
		}
		for (const role of [roles.migration, roles.runtime]) {
			const verifier = scramVerifier(derivedPassword(password, role))
			const exists = await admin.prepare('SELECT true AS present FROM pg_roles WHERE rolname = ?').bind(role).first()
			// Defaults are NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; `verifyRoles` holds an existing role to them.
			if (exists === null) {
				await admin.prepare(`CREATE ROLE ${role} LOGIN NOINHERIT PASSWORD '${verifier}'`).run()
				continue
			}
			await admin.prepare(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${verifier}'`).run()
			// A role may set its own session defaults (`ALTER ROLE CURRENT_USER SET …`); each deploy starts it clean.
			await admin.prepare(`ALTER ROLE ${role} RESET ALL`).run()
		}
		// A CREATEROLE role holds only ADMIN on a role it created; creating a schema for it needs SET (Postgres 16).
		if (!self.rolsuper) await admin.prepare(`GRANT ${roles.migration} TO CURRENT_USER`).run()
		const schema = await admin.prepare('SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = ?').bind(roles.schema).first<{
			owner: string
		}>()
		if (schema === null) {
			await admin.prepare(`CREATE SCHEMA ${roles.schema} AUTHORIZATION ${roles.migration}`).run()
		} else if (schema.owner !== roles.migration) {
			throw new PostgresMigrationError(
				`schema ${roles.schema} is owned by ${schema.owner}, not by its migration role ${roles.migration}: it predates the application's database roles and is not adopted; drop it to start over, or make ${roles.migration} the owner of the schema and of every object in it`,
			)
		}
		await verifyRoles(admin, roles)
	} finally {
		await admin.prepare(`SELECT pg_advisory_unlock(${lockKey})`).run()
	}
}

/** Fails closed on any reach beyond the family's: a widened attribute, a membership, or CREATE outside the migration role's schema. */
async function verifyRoles(admin: SqlDatabase, roles: ApplicationDatabaseRoles): Promise<void> {
	const { results } = await admin.prepare(`SELECT r.rolname,
			concat_ws(', ',
				CASE WHEN r.rolsuper THEN 'SUPERUSER' END, CASE WHEN r.rolcreaterole THEN 'CREATEROLE' END,
				CASE WHEN r.rolcreatedb THEN 'CREATEDB' END, CASE WHEN r.rolreplication THEN 'REPLICATION' END,
				CASE WHEN r.rolbypassrls THEN 'BYPASSRLS' END) AS attributes,
			(SELECT string_agg(pg_get_userbyid(m.roleid), ', ' ORDER BY pg_get_userbyid(m.roleid)) FROM pg_auth_members m WHERE m.member = r.oid) AS memberships,
			has_database_privilege(r.oid, current_database(), 'CREATE') AS creates_schemas,
			(SELECT string_agg(n.nspname, ', ' ORDER BY n.nspname) FROM pg_namespace n WHERE has_schema_privilege(r.oid, n.oid, 'CREATE')) AS creates_in
		FROM pg_roles r WHERE r.rolname IN (?, ?)`).bind(roles.migration, roles.runtime).all<RoleReach>()
	const problems: string[] = []
	for (const role of results) {
		const subject = `the database role ${role.rolname}`
		if (role.attributes !== null && role.attributes !== '') problems.push(`${subject} holds ${role.attributes}`)
		if (role.memberships !== null) problems.push(`${subject} is a member of ${role.memberships}`)
		if (role.creates_schemas) problems.push(`${subject} may create schemas in the database`)
		const allowed = role.rolname === roles.migration ? roles.schema : null
		if (role.creates_in !== allowed) {
			problems.push(`${subject} may create objects in ${role.creates_in ?? 'no schema'} (allowed: ${allowed ?? 'none'})`)
		}
	}
	if (results.length !== 2) problems.push(`the database roles ${roles.migration} and ${roles.runtime} do not both exist`)
	if (problems.length > 0) {
		throw new PostgresMigrationError(
			`${problems.join('; ')}; the deploy stops until it is undone, because these roles bound what the application's SQL may do (ADR-0017)`,
		)
	}
}

const quotedIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`

/**
 * Drops the schema and both roles: for throwaway test databases only. The schema is dropped as its owner, which a
 * CREATEROLE provisioning credential may become (`provisionPostgresRoles` granted it the migration role).
 */
export async function dropPostgresRoles(admin: SqlDatabase, roles: ApplicationDatabaseRoles): Promise<void> {
	validateRoles(roles)
	const schema = await admin.prepare('SELECT pg_catalog.pg_get_userbyid(nspowner) AS owner FROM pg_catalog.pg_namespace WHERE nspname = ?').bind(
		roles.schema,
	).first<{ owner: string }>()
	if (schema !== null) {
		await admin.batch([admin.prepare(`SET LOCAL ROLE ${quotedIdentifier(schema.owner)}`), admin.prepare(`DROP SCHEMA ${roles.schema} CASCADE`)])
	}
	await admin.prepare(`DROP ROLE IF EXISTS ${roles.runtime}, ${roles.migration}`).run()
}
