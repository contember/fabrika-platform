// The application's database role family (ADR-0017, backlog 110 shipped): a migration role that owns `app_<id>` and
// nothing else, and a runtime role with DML on its tables and no DDL. Run once with a superuser and once with a
// CREATEROLE role that only owns what a managed service's own user owns, as the provisioning credential. Skips cleanly
// without FABRIKA_TEST_POSTGRES_URL, which must be a superuser's; no URL is ever printed.

import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
	applicationDatabaseRoles,
	applicationMigrationLockKey,
	applicationRuntimeUrl,
	definePostgresApplicationMigrations,
	dropApplicationDatabase,
} from '../application-postgres-migrations.js'
import { postgresRoleUrl } from '../application-postgres-roles.js'
import type { PostgresMigration } from '../postgres-migrations.js'
import { changeCreateOnDatabase, createTestProvisioner } from '../postgres-test-provisioner.js'
import { PostgresDatabase } from '../sql-postgres.js'
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
				await changeCreate('grant', name)
			}),
		tearDown: async () => {
			await changeCreate('revoke', name)
			await as(superuserUrl, (sql) => sql.unsafe(`DROP ROLE ${name}`))
		},
	}
}

/** CREATE on the test database for `role`, through the lock every run that changes the database's row takes. */
async function changeCreate(change: 'grant' | 'revoke', role: string): Promise<void> {
	const admin = PostgresDatabase.connect(superuserUrl, { max: 1 })
	try {
		const database = await admin.prepare('SELECT current_database() AS name').first<{ name: string }>()
		if (database === null) throw new Error('the test database has no name')
		await changeCreateOnDatabase(admin, change, role, database.name)
	} finally {
		await admin.close()
	}
}

interface Application {
	readonly appId: string
	readonly migrations: ReturnType<typeof definePostgresApplicationMigrations>
}

describe.skipIf(!hasPostgres)('the application role family', () => {
	for (const provisioner of [superuser, createRoleOnly()]) {
		describe(`provisioned by ${provisioner.label}`, () => {
			const created: string[] = []
			const application = (options: { readonly advisoryLockTimeoutMs?: number } = {}): Application => {
				const appId = `roles-${hex()}`
				created.push(appId)
				return { appId, migrations: definePostgresApplicationMigrations({ appId, directory: '/unused', ...options }) }
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
				expect([...await as(runtimeUrl(notes), (sql) => sql.unsafe('SHOW statement_timeout'))]).toEqual([{ statement_timeout: '0' }])
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

			test('PUBLIC defaults and grants do not reach the runtime role: the next migrate revokes them', async () => {
				const app = application()
				await app.migrations.migrate(provisioner.url(), NOTES)
				const { schema, migration } = applicationDatabaseRoles(app.appId)
				await as(superuserUrl, async (sql) => {
					await sql.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} GRANT ALL ON TABLES TO PUBLIC`)
					await sql.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA ${schema} GRANT ALL ON TABLES TO PUBLIC`)
					await sql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA ${schema} TO PUBLIC`)
					await sql.unsafe(`GRANT UPDATE (checksum) ON ${schema}.fabrika_migrations TO PUBLIC`)
				})
				const later = [...NOTES, { name: '20261011130000_tags.sql', sql: 'CREATE TABLE tags (id TEXT PRIMARY KEY)' }]
				await app.migrations.migrate(provisioner.url(), later)
				const runtime = applicationRuntimeUrl(provisioner.url(), app.appId)
				expect(await refusal(runtime, `UPDATE ${schema}.fabrika_migrations SET checksum = checksum`)).toContain(
					'permission denied for table fabrika_migrations',
				)
				for (const table of ['notes', 'tags']) {
					expect(await refusal(runtime, `TRUNCATE ${schema}.${table}`)).toContain(`permission denied for table ${table}`)
					expect(
						await refusal(
							runtime,
							`CREATE TRIGGER later BEFORE UPDATE ON ${schema}.${table} FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()`,
						),
					)
						.toContain(`permission denied for table ${table}`)
				}
				expect(await refusal(runtime, `CREATE TABLE ${schema}.extra (id TEXT)`)).toContain(`permission denied for schema ${schema}`)
				const defaults = await as(superuserUrl, (sql) =>
					sql.unsafe(
						`SELECT count(*)::int AS public FROM pg_default_acl, aclexplode(defaclacl) WHERE defaclrole = to_regrole($1) AND grantee = 0`,
						[migration],
					))
				expect([...defaults]).toEqual([{ public: 0 }])
				// CREATE on the schema for PUBLIC reaches the runtime role before any migration could run: refused, not repaired.
				await as(superuserUrl, (sql) => sql.unsafe(`GRANT CREATE ON SCHEMA ${schema} TO PUBLIC`))
				await expect(app.migrations.migrate(provisioner.url(), later)).rejects.toThrow(
					`the database role ${applicationDatabaseRoles(app.appId).runtime} may create objects in ${schema} (allowed: none)`,
				)
				await as(superuserUrl, (sql) => sql.unsafe(`REVOKE CREATE ON SCHEMA ${schema} FROM PUBLIC`))
			})

			test("a grant on another application's objects is refused at the next migrate, naming the object", async () => {
				const app = application()
				await app.migrations.migrate(provisioner.url(), NOTES)
				const { runtime } = applicationDatabaseRoles(app.appId)
				const foreign = other.migrations.schema
				const widen = [`GRANT USAGE ON SCHEMA ${foreign} TO ${runtime}`, `GRANT SELECT, UPDATE ON ${foreign}.notes TO ${runtime}`]
				await as(superuserUrl, async (sql) => {
					for (const statement of widen) await sql.unsafe(statement)
				})
				await expect(app.migrations.migrate(provisioner.url(), NOTES)).rejects.toThrow(
					`the database role ${runtime} holds privileges outside its schema: schema ${foreign} (USAGE), table ${foreign}.notes (SELECT, UPDATE)`,
				)
				await as(superuserUrl, async (sql) => {
					await sql.unsafe(`REVOKE ALL ON ${foreign}.notes FROM ${runtime}`)
					await sql.unsafe(`GRANT UPDATE (title) ON ${foreign}.notes TO ${runtime}`)
				})
				await expect(app.migrations.migrate(provisioner.url(), NOTES)).rejects.toThrow(`column ${foreign}.notes.title (UPDATE)`)
				await as(superuserUrl, async (sql) => {
					await sql.unsafe(`REVOKE ALL ON ${foreign}.notes FROM ${runtime}`)
					await sql.unsafe(`REVOKE ALL ON SCHEMA ${foreign} FROM ${runtime}`)
				})
				expect(await app.migrations.migrate(provisioner.url(), NOTES)).toEqual([])
			})

			test('a SECURITY DEFINER function the roles may call is refused at the next migrate, naming it', async () => {
				const app = application()
				await app.migrations.migrate(provisioner.url(), NOTES)
				const name = `escalate_${hex()}`
				await as(superuserUrl, (sql) => sql.unsafe(`CREATE FUNCTION public.${name}() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`))
				try {
					await expect(app.migrations.migrate(provisioner.url(), NOTES)).rejects.toThrow(`SECURITY DEFINER function public.${name}()`)
					await as(superuserUrl, (sql) => sql.unsafe(`REVOKE EXECUTE ON FUNCTION public.${name}() FROM PUBLIC`))
					expect(await app.migrations.migrate(provisioner.url(), NOTES)).toEqual([])
				} finally {
					await as(superuserUrl, (sql) => sql.unsafe(`DROP FUNCTION public.${name}()`))
				}
			})

			test('a runtime that holds the migration lock fails the next migrate within its lock timeout', async () => {
				const app = application({ advisoryLockTimeoutMs: 500 })
				await app.migrations.migrate(provisioner.url(), NOTES)
				const holder = new SQL({ url: applicationRuntimeUrl(provisioner.url(), app.appId), adapter: 'postgres', max: 1, prepare: false })
				try {
					await holder.unsafe(`SELECT pg_advisory_lock(${applicationMigrationLockKey(app.appId)})`)
					const started = Date.now()
					await expect(app.migrations.migrate(provisioner.url(), NOTES)).rejects.toThrow(
						`the migration lock of ${app.migrations.schema} was not free within 500 ms`,
					)
					expect(Date.now() - started).toBeLessThan(5_000)
				} finally {
					await holder.close()
				}
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

	// A Zerops service whose `db` user was once granted CREATEROLE by hand, now provisioned by the service's superuser.
	test('a family a CREATEROLE role created is taken over by a superuser: the passwords follow the new credential', async () => {
		const previous = createRoleOnly()
		await previous.setUp()
		const appId = `roles-${hex()}`
		const migrations = definePostgresApplicationMigrations({ appId, directory: '/unused' })
		try {
			await migrations.migrate(previous.url(), NOTES)
			const before = applicationRuntimeUrl(previous.url(), appId)
			await as(before, (sql) => sql.unsafe(`INSERT INTO ${migrations.schema}.notes (id, title) VALUES ('n1', 'Kept')`))
			expect(await migrations.migrate(superuserUrl, NOTES)).toEqual([])
			expect(await migrations.migrate(superuserUrl, NOTES)).toEqual([])
			const runtime = applicationRuntimeUrl(superuserUrl, appId)
			expect([...await as(runtime, (sql) => sql.unsafe(`SELECT id, title FROM ${migrations.schema}.notes`))]).toEqual([{ id: 'n1', title: 'Kept' }])
			expect(await refusal(before, 'SELECT 1')).toContain('password authentication failed')
		} finally {
			await dropApplicationDatabase(superuserUrl, appId)
			await previous.tearDown()
		}
	})

	test('a provisioning credential that cannot create roles is refused, and nothing runs as it', async () => {
		const name = `fabrika_plain_${hex()}`
		const password = `pw${hex()}`
		await as(superuserUrl, async (sql) => {
			await sql.unsafe(`CREATE ROLE ${name} LOGIN PASSWORD '${password}'`)
		})
		await changeCreate('grant', name)
		const appId = `roles-${hex()}`
		const migrations = definePostgresApplicationMigrations({ appId, directory: '/unused' })
		try {
			await expect(migrations.migrate(withCredential(superuserUrl, name, password), NOTES)).rejects.toThrow(
				`the provisioning credential connects as ${name}, which is neither a superuser nor holds CREATEROLE`,
			)
			const schemas = await as(superuserUrl, (sql) => sql.unsafe('SELECT nspname FROM pg_namespace WHERE nspname = $1', [migrations.schema]))
			expect([...schemas]).toEqual([])
		} finally {
			await changeCreate('revoke', name)
			await as(superuserUrl, (sql) => sql.unsafe(`DROP ROLE ${name}`))
		}
	})

	test('a throwaway test provisioner creates role families, reaches no application, and drops what it left behind', async () => {
		const liveId = `roles-${hex()}`
		const live = definePostgresApplicationMigrations({ appId: liveId, directory: '/unused' })
		await live.migrate(superuserUrl, NOTES)
		const provisioner = await createTestProvisioner(superuserUrl)
		const abandoned = definePostgresApplicationMigrations({ appId: `test-${hex()}`, directory: '/unused' })
		try {
			expect(new URL(provisioner.url).username).toMatch(/^fabrika_tests_[0-9a-f]{16}$/)
			await abandoned.migrate(provisioner.url, NOTES)
			expect(await refusal(provisioner.url, `SELECT * FROM ${live.schema}.notes`)).toContain(`permission denied for schema ${live.schema}`)
			expect(await refusal(provisioner.url, `ALTER ROLE ${live.roles.runtime} PASSWORD 'x'`)).toContain('permission denied to alter role')
			expect(await refusal(provisioner.url, `GRANT pg_execute_server_program TO ${abandoned.roles.runtime}`)).toContain(
				'permission denied to grant role',
			)
		} finally {
			await provisioner.drop()
			await dropApplicationDatabase(superuserUrl, liveId)
		}
		const left = await as(
			superuserUrl,
			(sql) =>
				sql.unsafe('SELECT rolname FROM pg_roles WHERE rolname IN ($1, $2, $3) UNION ALL SELECT nspname FROM pg_namespace WHERE nspname = $4', [
					new URL(provisioner.url).username,
					abandoned.roles.migration,
					abandoned.roles.runtime,
					abandoned.schema,
				]),
		)
		expect([...left]).toEqual([])
	})

	test('concurrent grants and revokes on the one database row all succeed: each waits for the shared lock', async () => {
		const names = Array.from({ length: 8 }, () => `fabrika_grant_${hex()}`)
		await as(superuserUrl, async (sql) => {
			for (const name of names) await sql.unsafe(`CREATE ROLE ${name}`)
		})
		try {
			const outcomes = await Promise.allSettled(names.map(async (name) => {
				for (let round = 0; round < 5; round++) {
					await changeCreate('grant', name)
					await changeCreate('revoke', name)
				}
			}))
			expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toEqual([])
		} finally {
			for (const name of names) {
				await changeCreate('revoke', name)
				await as(superuserUrl, (sql) => sql.unsafe(`DROP ROLE ${name}`))
			}
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
