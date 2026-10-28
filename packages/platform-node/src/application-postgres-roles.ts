import type { SqlDatabase } from '@fabrika/platform'
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import { acquireMigrationLock } from './application-postgres-grants'
import { PostgresMigrationError } from './postgres-migration-error'

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

export function provisioningCredential(provisioningUrl: string): { readonly url: URL; readonly password: string } {
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
export function scramVerifier(password: string): string {
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
	lock: { readonly key: number; readonly timeoutMs: number },
): Promise<void> {
	validateRoles(roles)
	const { password } = provisioningCredential(provisioningUrl)
	// A dedicated session: nothing an application created can shadow a catalog function here.
	await admin.prepare('SET search_path TO pg_catalog, pg_temp').run()
	await acquireMigrationLock(admin, lock.key, lock.timeoutMs, roles.schema)
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
			} else {
				await admin.prepare(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${verifier}'`).run()
			}
			// A role may set its own session defaults (`ALTER ROLE CURRENT_USER SET …`); each deploy starts it clean. The
			// runtime role's one default is its schema: a pooler that forbids startup parameters (Hyperdrive) leaves the
			// role's default as the only search_path, and the data layer names its tables unqualified. Reset and set run in
			// one transaction, so no session starts in between without it.
			const reset = admin.prepare(`ALTER ROLE ${role} RESET ALL`)
			if (role === roles.runtime) {
				await admin.batch([reset, admin.prepare(`ALTER ROLE ${role} SET search_path TO ${roles.schema}`)])
			} else {
				await reset.run()
			}
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
		await verifyForeignReach(admin, roles)
	} finally {
		await admin.prepare(`SELECT pg_advisory_unlock(${lock.key})`).run()
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

interface ForeignGrant {
	readonly role: string
	readonly object: string
	readonly privileges: string
}

/**
 * Fails closed on any reach of the family into the rest of the database: a privilege either role was granted, or
 * ownership it holds, on a schema, relation, column, routine, type, the database, a large object or a parameter outside
 * its schema; and a SECURITY DEFINER routine either may call, which would run as its owner. PUBLIC's own defaults
 * (CONNECT, TEMP, EXECUTE on built-ins) are not grants to the roles; a large object a role created itself is its own.
 */
async function verifyForeignReach(admin: SqlDatabase, roles: ApplicationDatabaseRoles): Promise<void> {
	const { results } = await admin.prepare(`
		WITH family AS (SELECT oid, rolname FROM pg_roles WHERE rolname IN (?, ?)),
			own AS (SELECT oid FROM pg_namespace WHERE nspname = ?),
			objects (rank, object, owner, acl) AS (
				SELECT 1, 'schema ' || quote_ident(nspname), nspowner, nspacl FROM pg_namespace WHERE oid NOT IN (SELECT oid FROM own)
				UNION ALL SELECT 2, CASE relkind WHEN 'S' THEN 'sequence ' WHEN 'v' THEN 'view ' WHEN 'm' THEN 'materialized view ' ELSE 'table ' END
					|| relnamespace::regnamespace || '.' || quote_ident(relname), relowner, relacl
					FROM pg_class WHERE relnamespace NOT IN (SELECT oid FROM own) AND relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
				UNION ALL SELECT 3, 'column ' || c.relnamespace::regnamespace || '.' || quote_ident(c.relname) || '.' || quote_ident(a.attname), c.relowner, a.attacl
					FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE a.attacl IS NOT NULL AND c.relnamespace NOT IN (SELECT oid FROM own)
				UNION ALL SELECT 4, 'function ' || oid::regprocedure, proowner, proacl FROM pg_proc WHERE pronamespace NOT IN (SELECT oid FROM own)
				UNION ALL SELECT 5, 'type ' || oid::regtype, typowner, typacl FROM pg_type WHERE typnamespace NOT IN (SELECT oid FROM own)
				UNION ALL SELECT 6, 'database ' || quote_ident(datname), datdba, datacl FROM pg_database WHERE datname = current_database()
				UNION ALL SELECT 7, 'large object ' || oid, lomowner, lomacl FROM pg_largeobject_metadata
				UNION ALL SELECT 8, 'parameter ' || parname, NULL, paracl FROM pg_parameter_acl
			)
		SELECT f.rolname AS role, o.object, string_agg(DISTINCT a.privilege_type, ', ') AS privileges
			FROM objects o CROSS JOIN LATERAL aclexplode(o.acl) a JOIN family f ON f.oid = a.grantee
			WHERE o.owner IS DISTINCT FROM a.grantee
			GROUP BY f.rolname, o.rank, o.object
		UNION ALL
		SELECT f.rolname, o.object, 'OWNER' FROM objects o JOIN family f ON f.oid = o.owner WHERE o.rank NOT IN (6, 7)
		ORDER BY 1, 2`).bind(roles.migration, roles.runtime, roles.schema).all<ForeignGrant>()
	const problems: string[] = []
	for (const role of [roles.migration, roles.runtime]) {
		const held = results.filter((grant) => grant.role === role).map((grant) => `${grant.object} (${grant.privileges})`)
		if (held.length > 0) problems.push(`the database role ${role} holds privileges outside its schema: ${held.join(', ')}`)
	}
	const { results: definers } = await admin.prepare(`
		SELECT p.oid::regprocedure::text AS routine, pg_get_userbyid(p.proowner) AS owner FROM pg_proc p
			WHERE p.prosecdef AND p.pronamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
				AND p.proowner NOT IN (SELECT oid FROM pg_roles WHERE rolname IN (?, ?))
				AND EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN (?, ?)
					AND has_schema_privilege(r.oid, p.pronamespace, 'USAGE') AND has_function_privilege(r.oid, p.oid, 'EXECUTE'))
			ORDER BY 1`).bind(roles.migration, roles.runtime, roles.migration, roles.runtime).all<{ routine: string; owner: string }>()
	for (const definer of definers) {
		problems.push(
			`the SECURITY DEFINER function ${definer.routine} runs as ${definer.owner} and the application's roles may call it; revoke EXECUTE on it from PUBLIC or drop it`,
		)
	}
	if (problems.length > 0) {
		throw new PostgresMigrationError(`${problems.join('; ')}; the deploy stops, because these roles bound what the application's SQL may do (ADR-0017)`)
	}
}

export const quotedIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`

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
	// The migration role's default privileges (`normalizeDefaultPrivileges`) are objects of its own that block DROP ROLE.
	const migration = await admin.prepare('SELECT true AS present FROM pg_catalog.pg_roles WHERE rolname = ?').bind(roles.migration).first()
	if (migration !== null) {
		await admin.batch([admin.prepare(`SET LOCAL ROLE ${roles.migration}`), admin.prepare(`DROP OWNED BY ${roles.migration}`)])
	}
	await admin.prepare(`DROP ROLE IF EXISTS ${roles.runtime}, ${roles.migration}`).run()
}
