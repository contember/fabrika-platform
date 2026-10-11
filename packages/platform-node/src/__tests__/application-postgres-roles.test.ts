// The application's database role family (ADR-0017, backlog 110 shipped): a migration role that owns `app_<id>` and
// nothing else, and a runtime role with DML on its tables and no DDL. Run once with a superuser and once with a
// CREATEROLE role that only owns what a managed service's own user owns, as the provisioning credential. Skips cleanly
// without FABRIKA_TEST_POSTGRES_URL, which must be a superuser's; no URL is ever printed.

import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
	applicationDatabaseRoles,
	applicationRuntimeUrl,
	definePostgresApplicationMigrations,
	dropApplicationDatabase,
} from '../application-postgres-migrations.js'
import { postgresRoleUrl } from '../application-postgres-roles.js'
import type { PostgresMigration } from '../postgres-migrations.js'
import { hasPostgres, postgresUrl, skipReason } from './helpers/postgres.js'

if (!hasPostgres) console.warn(`application-postgres-roles.test.ts ${skipReason}`)

const superuserUrl = postgresUrl ?? ''
const hex = (): string => crypto.randomUUID().replaceAll('-', '').slice(0, 12)

const NOTES: readonly PostgresMigration[] = [
	{ name: '20261011120000_init.sql', sql: 'CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, n INTEGER GENERATED ALWAYS AS IDENTITY)' },
]

const withCredential = (url: string, user: string, password: string): string => {
	const parsed = new URL(url)
	parsed.username = user
	parsed.password = password
	return parsed.toString()
}

/** Runs `work` on one connection of `url`, then closes it. */
async function as<T>(url: string, work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1, prepare: false })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

/** The server's message when `statement` fails as `url`; the test fails when it succeeds. */
async function refusal(url: string, statement: string): Promise<string> {
	try {
		await as(url, (sql) => sql.unsafe(statement))
	} catch (error) {
		return error instanceof Error ? error.message : String(error)
	}
	throw new Error(`${statement} succeeded`)
}

interface Provisioner {
	readonly label: string
	url(): string
	setUp(): Promise<void>
	tearDown(): Promise<void>
}

/** The test URL's own superuser. */
const superuser: Provisioner = {
	label: 'a superuser',
	url: () => superuserUrl,
	setUp: () => Promise.resolve(),
	tearDown: () => Promise.resolve(),
}

/** A role with CREATEROLE and CREATE on the database, as a managed service's own user holds: not a superuser. */
function createRoleOnly(): Provisioner {
	const name = `fabrika_provisioner_${hex()}`
	const password = `pw${hex()}`
	return {
		label: 'a CREATEROLE role that is not a superuser',
		url: () => withCredential(superuserUrl, name, password),
		setUp: () =>
			as(superuserUrl, async (sql) => {
				await sql.unsafe(`CREATE ROLE ${name} LOGIN CREATEROLE PASSWORD '${password}'`)
				await sql.unsafe(`GRANT CREATE ON DATABASE ${await currentDatabase(sql)} TO ${name}`)
			}),
		tearDown: () =>
			as(superuserUrl, async (sql) => {
				await sql.unsafe(`REVOKE CREATE ON DATABASE ${await currentDatabase(sql)} FROM ${name}`)
				await sql.unsafe(`DROP ROLE ${name}`)
			}),
	}
}

async function currentDatabase(sql: SQL): Promise<string> {
	const [row] = await sql.unsafe('SELECT current_database() AS name')
	return String(row?.name)
}

interface Application {
	readonly appId: string
	readonly migrations: ReturnType<typeof definePostgresApplicationMigrations>
}

describe.skipIf(!hasPostgres)('the application role family', () => {
	for (const provisioner of [superuser, createRoleOnly()]) {
		describe(`provisioned by ${provisioner.label}`, () => {
			const created: string[] = []
			const application = (): Application => {
				const appId = `roles-${hex()}`
				created.push(appId)
				return { appId, migrations: definePostgresApplicationMigrations({ appId, directory: '/unused' }) }
			}
			let notes: Application
			let other: Application

			beforeAll(async () => {
				await provisioner.setUp()
				notes = application()
				other = application()
				await notes.migrations.migrate(provisioner.url(), NOTES)
				await other.migrations.migrate(provisioner.url(), NOTES)
			})

			afterAll(async () => {
				for (const appId of created) await dropApplicationDatabase(provisioner.url(), appId)
				await provisioner.tearDown()
				const leftover = await as(superuserUrl, (sql) =>
					sql.unsafe(`SELECT rolname FROM pg_roles WHERE rolname = ANY(string_to_array($1, ','))`, [
						created.flatMap((appId) => [applicationDatabaseRoles(appId).migration, applicationDatabaseRoles(appId).runtime]).join(','),
					]))
				expect([...leftover]).toEqual([])
			})

			const migrationUrl = (app: Application): string => postgresRoleUrl(provisioner.url(), applicationDatabaseRoles(app.appId).migration)
			const runtimeUrl = (app: Application): string => applicationRuntimeUrl(provisioner.url(), app.appId)

			test('the migration role owns the schema and every object the migrations created; neither role holds more', async () => {
				const roles = applicationDatabaseRoles(notes.appId)
				expect(roles).toEqual({ schema: notes.migrations.schema, migration: notes.migrations.schema, runtime: `run_${notes.migrations.schema.slice(4)}` })
				const owners = await as(superuserUrl, (sql) =>
					sql.unsafe(
						`SELECT (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = $1) AS schema,
							(SELECT array_agg(DISTINCT pg_get_userbyid(relowner)) FROM pg_class WHERE relnamespace = to_regnamespace($1)) AS objects`,
						[roles.schema],
					))
				expect([...owners]).toEqual([{ schema: roles.migration, objects: [roles.migration] }])
				const attributes = await as(superuserUrl, (sql) =>
					sql.unsafe(
						`SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolcanlogin,
							(SELECT count(*)::int FROM pg_auth_members WHERE member = r.oid) AS memberships
						FROM pg_roles r WHERE rolname IN ($1, $2) ORDER BY rolname`,
						[roles.migration, roles.runtime],
					))
				const least = {
					rolsuper: false,
					rolcreaterole: false,
					rolcreatedb: false,
					rolreplication: false,
					rolbypassrls: false,
					rolcanlogin: true,
					memberships: 0,
				}
				expect([...attributes]).toEqual([{ rolname: roles.migration, ...least }, { rolname: roles.runtime, ...least }])
			})

			test('the runtime role reads and writes the tables, and cannot touch the ledger or run DDL', async () => {
				await as(runtimeUrl(notes), async (sql) => {
					await sql.unsafe(`SET search_path TO ${notes.migrations.schema}`)
					await sql.unsafe("INSERT INTO notes (id, title) VALUES ('n1', 'First')")
					await sql.unsafe("UPDATE notes SET title = 'Renamed' WHERE id = 'n1'")
					expect([...await sql.unsafe('SELECT id, title FROM notes')]).toEqual([{ id: 'n1', title: 'Renamed' }])
					await sql.unsafe("DELETE FROM notes WHERE id = 'n1'")
				})
				const schema = notes.migrations.schema
				const runtime = runtimeUrl(notes)
				expect(await refusal(runtime, `UPDATE ${schema}.fabrika_migrations SET checksum = checksum`)).toContain(
					'permission denied for table fabrika_migrations',
				)
				expect(await refusal(runtime, `DELETE FROM ${schema}.fabrika_migrations`)).toContain('permission denied for table fabrika_migrations')
				expect(await refusal(runtime, `SELECT * FROM ${schema}.fabrika_migrations`)).toContain('permission denied for table fabrika_migrations')
				expect(
					await refusal(
						runtime,
						`CREATE TRIGGER later BEFORE UPDATE ON ${schema}.notes FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()`,
					),
				)
					.toContain('permission denied for table notes')
				expect(await refusal(runtime, `CREATE TABLE ${schema}.extra (id TEXT)`)).toContain(`permission denied for schema ${schema}`)
				expect(await refusal(runtime, `CREATE FUNCTION ${schema}.f() RETURNS int LANGUAGE sql AS 'SELECT 1'`)).toContain(
					`permission denied for schema ${schema}`,
				)
				expect(await refusal(runtime, `ALTER TABLE ${schema}.notes ADD COLUMN body TEXT`)).toContain('must be owner of table notes')
				expect(await refusal(runtime, `TRUNCATE ${schema}.notes`)).toContain('permission denied for table notes')
			})

			test('neither role can write the catalog, unlink a large object it does not own, create outside its schema or run a program', async () => {
				const object = await as(superuserUrl, async (sql) => {
					const [row] = await sql.unsafe('SELECT lo_create(0) AS oid')
					return String(row?.oid)
				})
				try {
					for (const url of [migrationUrl(notes), runtimeUrl(notes)]) {
						expect(await refusal(url, "UPDATE pg_catalog.pg_class SET relname = relname WHERE relname = 'notes'")).toContain(
							'permission denied for table pg_class',
						)
						expect(await refusal(url, `SELECT lo_unlink(${object})`)).toContain('must be owner of large object')
						expect(await refusal(url, "CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS 'SELECT 1'")).toContain('permission denied for schema public')
						expect(await refusal(url, 'CREATE SCHEMA elsewhere')).toContain('permission denied for database')
						expect(await refusal(url, "COPY (SELECT 1) TO PROGRAM 'true'")).toContain('permission denied to COPY to or from an external program')
						expect(await refusal(url, "SELECT pg_read_file('/etc/hostname')")).toContain('permission denied for function pg_read_file')
						expect(await refusal(url, `SELECT * FROM ${other.migrations.schema}.notes`)).toContain(
							`permission denied for schema ${other.migrations.schema}`,
						)
					}
				} finally {
					await as(superuserUrl, (sql) => sql.unsafe(`SELECT lo_unlink(${object})`))
				}
			})

			test('a later migrate applies new files as the migration role, grants the runtime role their tables and resets its settings', async () => {
				await as(runtimeUrl(notes), (sql) => sql.unsafe('ALTER ROLE CURRENT_USER SET statement_timeout = 1'))
				const later = [...NOTES, { name: '20261011130000_tags.sql', sql: 'CREATE TABLE tags (id TEXT PRIMARY KEY)' }]
				expect(await notes.migrations.migrate(provisioner.url(), later)).toEqual(['app/20261011130000_tags.sql'])
				// A session default the runtime role set on itself does not survive the next deploy.
				expect(await as(runtimeUrl(notes), (sql) => sql.unsafe('SHOW statement_timeout'))).toEqual([{ statement_timeout: '0' }])
				expect(await notes.migrations.migrate(provisioner.url(), later)).toEqual([])
				await as(runtimeUrl(notes), (sql) => sql.unsafe(`INSERT INTO ${notes.migrations.schema}.tags (id) VALUES ('t1')`))
			})

			test('a role widened outside the platform is refused at the next migrate, before any migration runs', async () => {
				const app = application()
				await app.migrations.migrate(provisioner.url(), NOTES)
				const { runtime } = applicationDatabaseRoles(app.appId)
				await as(superuserUrl, (sql) => sql.unsafe(`GRANT pg_read_server_files TO ${runtime}`))
				await expect(app.migrations.migrate(provisioner.url(), [...NOTES, { name: '20261011130000_tags.sql', sql: 'CREATE TABLE tags (id TEXT)' }]))
					.rejects.toThrow(`the database role ${runtime} is a member of pg_read_server_files`)
				await as(superuserUrl, async (sql) => {
					await sql.unsafe(`REVOKE pg_read_server_files FROM ${runtime}`)
					expect([...await sql.unsafe('SELECT to_regclass($1) AS tags', [`${app.migrations.schema}.tags`])]).toEqual([{ tags: null }])
				})
			})

			test('a schema that predates the role family is refused, not adopted', async () => {
				const app = application()
				await as(provisioner.url(), (sql) => sql.unsafe(`CREATE SCHEMA ${app.migrations.schema}`))
				await expect(app.migrations.migrate(provisioner.url(), NOTES)).rejects.toThrow(
					`schema ${app.migrations.schema} is owned by ${new URL(provisioner.url()).username}, not by its migration role ${app.migrations.schema}`,
				)
				await as(superuserUrl, (sql) => sql.unsafe(`DROP SCHEMA ${app.migrations.schema}`))
			})
		})
	}

	test('a provisioning credential that cannot create roles is refused, and nothing runs as it', async () => {
		const name = `fabrika_plain_${hex()}`
		const password = `pw${hex()}`
		await as(superuserUrl, async (sql) => {
			await sql.unsafe(`CREATE ROLE ${name} LOGIN PASSWORD '${password}'`)
			await sql.unsafe(`GRANT CREATE ON DATABASE ${await currentDatabase(sql)} TO ${name}`)
		})
		const appId = `roles-${hex()}`
		const migrations = definePostgresApplicationMigrations({ appId, directory: '/unused' })
		try {
			await expect(migrations.migrate(withCredential(superuserUrl, name, password), NOTES)).rejects.toThrow(
				`the provisioning credential connects as ${name}, which is neither a superuser nor holds CREATEROLE`,
			)
			const schemas = await as(superuserUrl, (sql) => sql.unsafe('SELECT nspname FROM pg_namespace WHERE nspname = $1', [migrations.schema]))
			expect([...schemas]).toEqual([])
		} finally {
			await as(superuserUrl, async (sql) => {
				await sql.unsafe(`REVOKE CREATE ON DATABASE ${await currentDatabase(sql)} FROM ${name}`)
				await sql.unsafe(`DROP ROLE ${name}`)
			})
		}
	})

	test('a provisioning credential without a password is refused before it connects', async () => {
		const migrations = definePostgresApplicationMigrations({ appId: `roles-${hex()}`, directory: '/unused' })
		await expect(migrations.migrate('postgres://postgres@127.0.0.1:1/postgres', NOTES)).rejects.toThrow(
			"the provisioning credential has no password; the application's database roles derive theirs from it",
		)
	})
})

describe('the role family names', () => {
	test('the migration role is named like the schema, the runtime role run_<id>, both within 63 bytes', () => {
		expect(applicationDatabaseRoles('my-app')).toEqual({ schema: 'app_my_app', migration: 'app_my_app', runtime: 'run_my_app' })
		expect(applicationDatabaseRoles('a'.repeat(59)).runtime).toHaveLength(63)
	})

	test('a role URL keeps the host, the database and the options, with the role and its derived password', () => {
		const provisioning = 'postgresql://db:s3cret@db:6432/db?sslmode=require'
		const runtime = new URL(applicationRuntimeUrl(provisioning, 'notes'))
		expect({ user: runtime.username, host: runtime.host, path: runtime.pathname, search: runtime.search }).toEqual({
			user: 'run_notes',
			host: 'db:6432',
			path: '/db',
			search: '?sslmode=require',
		})
		expect(runtime.password).not.toContain('s3cret')
		expect(applicationRuntimeUrl(provisioning, 'notes')).toBe(runtime.toString())
		expect(new URL(applicationRuntimeUrl('postgresql://db:other@db:6432/db', 'notes')).password).not.toBe(runtime.password)
		expect(new URL(postgresRoleUrl(provisioning, 'app_notes')).password).not.toBe(runtime.password)
	})
})
