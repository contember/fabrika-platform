import { SQL } from 'bun'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	applicationDatabaseSchema,
	applicationMigrationLockKey,
	DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
	DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS,
	definePostgresApplicationMigrations,
} from '../application-postgres-migrations.js'
import {
	applyPostgresMigrations,
	definePostgresMigrationPlan,
	migrationChecksum,
	type PostgresMigration,
	PostgresMigrationError,
} from '../postgres-migrations.js'
import { PostgresDatabase } from '../sql-postgres.js'
import { hasPostgres, postgresUrl, skipReason } from './helpers/postgres.js'

const migration = (name: string, sql: string): PostgresMigration => ({ name, sql })

describe('application migration identity', () => {
	test('derives the schema from the application id', () => {
		expect(applicationDatabaseSchema('notes')).toBe('app_notes')
		expect(applicationDatabaseSchema('my-app')).toBe('app_my_app')
		for (const appId of ['', 'Notes', 'my_app', '-notes', 'notes;drop', 'a'.repeat(60)]) {
			expect(() => applicationDatabaseSchema(appId)).toThrow(PostgresMigrationError)
		}
		expect(applicationDatabaseSchema('a'.repeat(59))).toHaveLength(63)
	})

	test('derives a stable lock key per application from fabrika-db:<appId>', () => {
		// Migration identity: changing the derivation lets an old and a new container migrate at once.
		expect(applicationMigrationLockKey('notes')).toBe(79_287_579_160_455)
		expect(applicationMigrationLockKey('notes')).not.toBe(applicationMigrationLockKey('tasks'))
		for (const appId of ['notes', 'tasks', 'my-app']) {
			const key = applicationMigrationLockKey(appId)
			expect(Number.isSafeInteger(key) && key >= 1).toBe(true)
		}
	})

	test('every plan refuses a migration that reaches another schema, so migrate and the test kit refuse it', () => {
		const migrations = definePostgresApplicationMigrations({ appId: 'notes', directory: '/unused' })
		const reaching = migration('20261008120000_init.sql', "CREATE TABLE notes (id TEXT);\nUPDATE public.accounts SET plan = 'free';")
		expect(() => migrations.plan([reaching])).toThrow(
			'Application migration 20261008120000_init.sql line 2 names the schema public; an application migration names its own tables unqualified',
		)
	})

	test('every plan refuses a statement outside the allowlist, naming the file and the line', () => {
		const migrations = definePostgresApplicationMigrations({ appId: 'notes', directory: '/unused' })
		// A guarded single-row write to deals would fire this and change the rows of every tenant (backlog 108).
		const trigger = migration(
			'20261008120000_init.sql',
			[
				'CREATE TABLE deals (id TEXT PRIMARY KEY, stage TEXT NOT NULL);',
				'CREATE FUNCTION spread() RETURNS trigger LANGUAGE plpgsql AS $body$',
				'BEGIN UPDATE deals SET stage = NEW.stage WHERE id <> NEW.id; RETURN NEW; END',
				'$body$;',
				'CREATE TRIGGER spread AFTER UPDATE ON deals FOR EACH ROW EXECUTE FUNCTION spread();',
			].join('\n'),
		)
		expect(() => migrations.plan([trigger])).toThrow(
			'Application migration 20261008120000_init.sql line 2: CREATE FUNCTION is not allowed; an application migration holds only CREATE TABLE, ALTER TABLE, CREATE [UNIQUE] INDEX, CREATE TYPE … AS ENUM, ALTER TYPE … ADD/RENAME VALUE, DROP, COMMENT ON, INSERT, UPDATE and DELETE',
		)
		const framework = definePostgresApplicationMigrations({
			appId: 'notes',
			directory: '/unused',
			framework: { bundle: 'fabrika', migrations: [migration('0001_framework.sql', 'DO $$ BEGIN PERFORM 1; END $$')] },
		})
		expect(() => framework.plan([migration('20261008120000_init.sql', 'CREATE TABLE notes (id TEXT)')])).toThrow(
			'Application migration 0001_framework.sql line 1: DO is not allowed',
		)
	})

	test("the example application's migrations are accepted", () => {
		const directory = join(import.meta.dir, '..', '..', '..', '..', 'examples', 'zerops-app', 'db', 'migrations')
		const migrations = definePostgresApplicationMigrations({ appId: 'notes', directory })
		expect(migrations.plan().bundles.map((bundle) => bundle.migrations.length)).toEqual([1])
	})

	test('composes one app bundle, a ledger in the application schema and the default timeouts', () => {
		const migrations = definePostgresApplicationMigrations({ appId: 'notes', directory: '/unused' })
		const plan = migrations.plan([migration('20261008120000_init.sql', 'CREATE TABLE notes (id TEXT)')])
		expect(migrations.schema).toBe('app_notes')
		expect(plan).toEqual({
			ledgerTable: 'app_notes.fabrika_migrations',
			lockKey: applicationMigrationLockKey('notes'),
			bundles: [{ name: 'app', migrations: [migration('20261008120000_init.sql', 'CREATE TABLE notes (id TEXT)')] }],
			application: {
				schema: 'app_notes',
				lockTimeoutMs: DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
				statementTimeoutMs: DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS,
			},
		})
	})

	test('refuses a file the checker would refuse and a missing directory', () => {
		const migrations = definePostgresApplicationMigrations({ appId: 'notes', directory: '/nonexistent/db/migrations' })
		for (const name of ['0001_init.sql', '20261008120000_Init.sql', '20261008120000-init.sql', '20261008120000_.sql']) {
			expect(() => migrations.plan([migration(name, 'CREATE TABLE notes (id TEXT)')])).toThrow('is not named YYYYMMDDHHMMSS_slug.sql')
		}
		expect(() => migrations.read()).toThrow('No migrations directory at /nonexistent/db/migrations')
	})

	test('a qualified ledger exists only for an application, and only in its own schema', () => {
		const bundles = [{ name: 'app', migrations: [migration('20261008120000_init.sql', 'CREATE TABLE notes (id TEXT)')] }]
		const application = { schema: 'app_notes', lockTimeoutMs: 1, statementTimeoutMs: 1 }
		expect(() => definePostgresMigrationPlan({ ledgerTable: 'app_notes.fabrika_migrations', lockKey: 1, bundles })).toThrow(
			'Invalid migration ledger table',
		)
		expect(() => definePostgresMigrationPlan({ ledgerTable: 'app_tasks.fabrika_migrations', lockKey: 1, bundles, application })).toThrow(
			'is not in app_notes',
		)
		expect(() =>
			definePostgresMigrationPlan({
				ledgerTable: 'app_notes.fabrika_migrations',
				lockKey: 1,
				bundles,
				application: { ...application, lockTimeoutMs: 0 },
			})
		).toThrow('lock timeout must be a positive number')
		expect(() =>
			definePostgresMigrationPlan({
				ledgerTable: 'app_notes.fabrika_migrations',
				lockKey: 1,
				bundles,
				application: { ...application, statementTimeoutMs: 1.5 },
			})
		).toThrow('statement timeout must be a positive number')
	})

	test('reads the migrations directory in file-name order', () => {
		const directory = mkdtempSync(join(tmpdir(), 'fabrika-app-migrations-'))
		try {
			writeFileSync(join(directory, '20261009120000_second.sql'), 'SELECT 2')
			writeFileSync(join(directory, '20261008120000_first.sql'), 'CREATE TABLE notes (id TEXT)')
			const migrations = definePostgresApplicationMigrations({ appId: 'notes', directory })
			expect(migrations.read().map((item) => item.name)).toEqual(['20261008120000_first.sql', '20261009120000_second.sql'])
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})
})

if (!hasPostgres) console.warn(`application-postgres-migrations.test.ts ${skipReason}`)

const openDatabases: PostgresDatabase[] = []
const schemas: string[] = []

afterAll(async () => {
	for (const db of openDatabases) await db.close()
	if (postgresUrl === null) return
	const cleanup = PostgresDatabase.connect(postgresUrl)
	for (const schema of schemas) await cleanup.prepare(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).run()
	await cleanup.close()
})

function requireUrl(): string {
	if (postgresUrl === null) throw new Error('FABRIKA_TEST_POSTGRES_URL is not set')
	return postgresUrl
}

/** A fresh application id per test, so every test gets its own schema, ledger and lock. */
function application(options: { lockTimeoutMs?: number; statementTimeoutMs?: number } = {}) {
	const appId = `t${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
	const migrations = definePostgresApplicationMigrations({ appId, directory: '/unused', ...options })
	schemas.push(migrations.schema)
	const db = PostgresDatabase.connect(requireUrl(), { max: 1 })
	openDatabases.push(db)
	return { appId, migrations, db }
}

async function failureOf(work: Promise<unknown>): Promise<PostgresMigrationError> {
	try {
		await work
	} catch (error) {
		if (error instanceof PostgresMigrationError) return error
		throw error
	}
	throw new Error('the migration run did not fail')
}

const sqlStateOf = (error: PostgresMigrationError): string | undefined => error.cause instanceof SQL.PostgresError ? error.cause.errno : undefined

describe.skipIf(!hasPostgres)('application migrations on real Postgres', () => {
	test('applies into the application schema and records a checksum per file', async () => {
		const { migrations, db } = application()
		const files = [
			migration('20261008120000_init.sql', 'CREATE TABLE notes (id TEXT PRIMARY KEY)'),
			migration('20261009120000_title.sql', 'ALTER TABLE notes ADD COLUMN title TEXT'),
		]
		expect(await migrations.apply(db, files)).toEqual(['app/20261008120000_init.sql', 'app/20261009120000_title.sql'])
		expect(await migrations.apply(db, files)).toEqual([])

		const relation = await db.prepare(`SELECT to_regclass('${migrations.schema}.notes') AS relation`).first<{ relation: string | null }>()
		expect(relation?.relation).toBe(`${migrations.schema}.notes`)
		const { results } = await db
			.prepare(`SELECT bundle, name, checksum FROM ${migrations.schema}.fabrika_migrations ORDER BY name`)
			.all<{ bundle: string; name: string; checksum: string }>()
		expect(results).toEqual(files.map((file) => ({ bundle: 'app', name: file.name, checksum: migrationChecksum(file.sql) })))
	})

	test('applies the framework bundle before the application bundle, in the same ledger and under the same checksums', async () => {
		const appId = `t${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
		const framework = { bundle: 'fabrika', migrations: [migration('0001_framework.sql', 'CREATE TABLE fabrika_things (id TEXT PRIMARY KEY)')] }
		const migrations = definePostgresApplicationMigrations({ appId, directory: '/unused', framework })
		schemas.push(migrations.schema)
		const db = PostgresDatabase.connect(requireUrl(), { max: 1 })
		openDatabases.push(db)
		// The application's first migration may reference a framework table: the framework bundle runs first.
		const files = [migration('20261008120000_init.sql', 'CREATE TABLE notes (thing TEXT REFERENCES fabrika_things (id))')]
		expect(await migrations.apply(db, files)).toEqual(['fabrika/0001_framework.sql', 'app/20261008120000_init.sql'])
		const changed = definePostgresApplicationMigrations({
			appId,
			directory: '/unused',
			framework: { bundle: 'fabrika', migrations: [migration('0001_framework.sql', 'CREATE TABLE fabrika_things (id TEXT)')] },
		})
		expect((await failureOf(changed.apply(db, files))).message).toContain('fabrika/0001_framework.sql')
	})

	test('a changed applied migration fails the run before anything else is applied', async () => {
		const { migrations, db } = application()
		await migrations.apply(db, [migration('20261008120000_init.sql', 'CREATE TABLE notes (id TEXT PRIMARY KEY)')])

		const failure = await failureOf(
			migrations.apply(db, [
				migration('20261008120000_init.sql', 'CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT)'),
				migration('20261009120000_tags.sql', 'CREATE TABLE tags (id TEXT PRIMARY KEY)'),
			]),
		)
		expect(failure.message).toBe(
			'Postgres migration app/20261008120000_init.sql changed after it was applied; an applied migration is immutable, so write the change as a new migration',
		)
		const tags = await db.prepare(`SELECT to_regclass('${migrations.schema}.tags') AS relation`).first<{ relation: string | null }>()
		expect(tags?.relation).toBeNull()
	})

	test('tolerates a database ahead of the code after a rollback', async () => {
		const { migrations, db } = application()
		await migrations.apply(db, [
			migration('20261008120000_init.sql', 'CREATE TABLE notes (id TEXT PRIMARY KEY)'),
			migration('20261009120000_tags.sql', 'CREATE TABLE tags (id TEXT PRIMARY KEY)'),
		])
		expect(await migrations.apply(db, [migration('20261008120000_init.sql', 'CREATE TABLE notes (id TEXT PRIMARY KEY)')])).toEqual([])
	})

	test('a blocked ALTER fails within the lock timeout and leaves no trace', async () => {
		const { migrations, db } = application({ lockTimeoutMs: 200 })
		await migrations.apply(db, [migration('20261008120000_init.sql', 'CREATE TABLE notes (id TEXT PRIMARY KEY)')])

		const live = new SQL({ url: requireUrl(), max: 1 })
		let release = (): void => {}
		const released = new Promise<void>((resolve) => {
			release = resolve
		})
		let locked = (): void => {}
		const holding = new Promise<void>((resolve) => {
			locked = resolve
		})
		// The live version's open transaction holds ACCESS SHARE, which the ALTER's ACCESS EXCLUSIVE waits behind.
		const reader = live.begin(async (tx) => {
			await tx.unsafe(`SELECT * FROM ${migrations.schema}.notes`)
			locked()
			await released
		})
		try {
			await holding
			const started = performance.now()
			const failure = await failureOf(
				migrations.apply(db, [
					migration('20261008120000_init.sql', 'CREATE TABLE notes (id TEXT PRIMARY KEY)'),
					migration('20261009120000_title.sql', 'ALTER TABLE notes ADD COLUMN title TEXT'),
				]),
			)
			expect(performance.now() - started).toBeLessThan(3_000)
			expect(failure.message).toBe('Postgres migration app/20261009120000_title.sql failed')
			expect(sqlStateOf(failure)).toBe('55P03')
		} finally {
			release()
			await reader
			await live.close()
		}
		const { results } = await db.prepare(`SELECT name FROM ${migrations.schema}.fabrika_migrations`).all<{ name: string }>()
		expect(results).toEqual([{ name: '20261008120000_init.sql' }])
	})

	test('a long statement fails within the statement timeout', async () => {
		const { migrations, db } = application({ statementTimeoutMs: 200 })
		const started = performance.now()
		const slow = migration('20261008120000_slow.sql', "CREATE TABLE marker (id text); INSERT INTO marker SELECT 'x' FROM pg_sleep(10)")
		const failure = await failureOf(migrations.apply(db, [slow]))
		expect(performance.now() - started).toBeLessThan(3_000)
		expect(sqlStateOf(failure)).toBe('57014')
	})

	test('applications in one database do not serialize each other', async () => {
		const first = application()
		const second = application()
		const holder = new SQL({ url: requireUrl(), max: 1 })
		try {
			await holder.unsafe(`SELECT pg_advisory_lock(${applicationMigrationLockKey(first.appId)})`)
			expect(await second.migrations.apply(second.db, [migration('20261008120000_init.sql', 'CREATE TABLE notes (id TEXT PRIMARY KEY)')]))
				.toEqual(['app/20261008120000_init.sql'])
			await holder.unsafe(`SELECT pg_advisory_unlock(${applicationMigrationLockKey(first.appId)})`)
		} finally {
			await holder.close()
		}
	})

	test('a file that would end the transaction or change its settings is refused before any SQL runs', async () => {
		const { migrations, db } = application()
		for (
			const [sql, refusal] of [
				['CREATE TABLE marker (id text); ROLLBACK', 'line 1: ROLLBACK is not allowed'],
				['CREATE TABLE marker (id text);\nCOMMIT;\nSELECT * FROM missing_table', 'line 2: COMMIT is not allowed'],
				['SET LOCAL statement_timeout = 0; SELECT pg_sleep(0.2)', 'line 1: SET is not allowed'],
			] as const
		) {
			const failure = await failureOf(migrations.apply(db, [migration('20261008120000_init.sql', sql)]))
			expect(failure.message).toContain(`Postgres migration app/20261008120000_init.sql ${refusal}`)
		}
		const schema = await db.prepare(`SELECT to_regnamespace('${migrations.schema}') AS schema`).first<{ schema: string | null }>()
		expect(schema?.schema).toBeNull()
	})

	test('a runner-owned setting changed through set_config fails the migration and rolls it back', async () => {
		for (
			const sql of [
				"insert into marker select set_config('statement_timeout', '0', true)",
				"insert into marker select set_config('lock_timeout', '0', true)",
				"insert into marker select set_config('search_path', 'public', true)",
				"insert into marker select set_config('fabrika.migration_xact', '0', true)",
			]
		) {
			const { migrations, db } = application()
			const failure = await failureOf(
				migrations.apply(db, [migration('20261008120000_init.sql', `CREATE TABLE marker (id text); ${sql}`)]),
			)
			expect(failure.message).toBe(
				"Postgres migration app/20261008120000_init.sql ended the runner's transaction or changed its lock_timeout, statement_timeout or search_path",
			)
			const marker = await db.prepare(`SELECT to_regclass('${migrations.schema}.marker') AS relation`).first<{ relation: string | null }>()
			expect(marker?.relation).toBeNull()
			const { results } = await db.prepare(`SELECT name FROM ${migrations.schema}.fabrika_migrations`).all()
			expect(results).toEqual([])
		}
	})

	test('keywords inside strings, comments and dollar-quoted bodies are applied', async () => {
		const { migrations, db } = application()
		const sql = [
			'-- COMMIT; ROLLBACK;',
			'/* SET statement_timeout = 0; /* nested */ */',
			'CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT);',
			"INSERT INTO notes VALUES ('n1', 'COMMIT; SET search_path TO public');",
			"INSERT INTO notes VALUES ('n2', $body$ CREATE TRIGGER t; DO $$ COMMIT $$; GRANT ALL $body$);",
		].join('\n')
		expect(await migrations.apply(db, [migration('20261008120000_init.sql', sql)])).toEqual(['app/20261008120000_init.sql'])
		const { results } = await db.prepare(`SELECT body FROM ${migrations.schema}.notes ORDER BY id`).all<{ body: string }>()
		expect(results.map((row) => row.body)).toEqual(['COMMIT; SET search_path TO public', ' CREATE TRIGGER t; DO $$ COMMIT $$; GRANT ALL '])
	})

	test('a statement outside the allowlist is refused before any SQL runs, however the file hides it', async () => {
		const tag = `$${'t'.repeat(70)}$`
		for (
			const [sql, refusal] of [
				['CREATE TABLE marker (id text);\nCREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$', 'line 2: CREATE FUNCTION'],
				// Postgres ends a `--` comment at a lone carriage return.
				['CREATE TABLE marker (id text); -- a note\rCREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$', 'line 1: CREATE FUNCTION'],
				// A dollar tag has no length limit, and a parenthesis inside its body is text.
				[
					`CREATE TABLE marker (id text);\nCOMMENT ON TABLE marker IS ${tag} ( ${tag};\nCREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$`,
					'line 3: CREATE FUNCTION',
				],
				// COPY … PROGRAM runs outside the migration's transaction, so no rollback could undo it.
				["CREATE TABLE marker (id text);\nCOPY marker FROM PROGRAM 'true'", 'line 2: COPY'],
				['CREATE TABLE deals (id text);\nCREATE TABLE copied (LIKE deals INCLUDING ALL)', 'line 2: CREATE TABLE … LIKE … INCLUDING'],
			] as const
		) {
			const { migrations, db } = application()
			const failure = await failureOf(migrations.apply(db, [migration('20261008120000_init.sql', sql)]))
			expect(failure.message).toContain(`Application migration 20261008120000_init.sql ${refusal} is not allowed`)
			const schema = await db.prepare(`SELECT to_regnamespace('${migrations.schema}') AS schema`).first<{ schema: string | null }>()
			expect(schema?.schema).toBeNull()
		}
	})

	test("a COMMIT inside a service migration's DO block is refused by Postgres inside the runner transaction", async () => {
		const schema = `service_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
		schemas.push(schema)
		const admin = PostgresDatabase.connect(requireUrl(), { max: 1 })
		await admin.prepare(`CREATE SCHEMA ${schema}`).run()
		await admin.close()
		const db = PostgresDatabase.connect(requireUrl(), { connection: { search_path: schema }, max: 1 })
		openDatabases.push(db)
		const plan = definePostgresMigrationPlan({
			ledgerTable: 'service_schema_migrations',
			lockKey: 8_301_101,
			bundles: [{ name: 'service', migrations: [migration('0001_init.sql', 'CREATE TABLE marker (id text); DO $$ BEGIN COMMIT; END $$')] }],
		})
		const failure = await failureOf(applyPostgresMigrations(db, plan))
		expect(failure.message).toBe('Postgres migration service/0001_init.sql failed')
		expect(sqlStateOf(failure)).toBe('2D000')
		const marker = await db.prepare(`SELECT to_regclass('${schema}.marker') AS relation`).first<{ relation: string | null }>()
		expect(marker?.relation).toBeNull()
	})

	test('a service ledger keeps its shape and records no checksum', async () => {
		const schema = `service_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
		schemas.push(schema)
		const admin = PostgresDatabase.connect(requireUrl(), { max: 1 })
		await admin.prepare(`CREATE SCHEMA ${schema}`).run()
		await admin.close()
		const db = PostgresDatabase.connect(requireUrl(), { connection: { search_path: schema }, max: 1 })
		openDatabases.push(db)
		await applyPostgresMigrations(
			db,
			definePostgresMigrationPlan({
				ledgerTable: 'service_schema_migrations',
				lockKey: 8_301_100,
				bundles: [{ name: 'service', migrations: [migration('0001_init.sql', 'SELECT 1')] }],
			}),
		)
		const { results } = await db
			.prepare(
				`SELECT column_name FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'service_schema_migrations' ORDER BY ordinal_position`,
			)
			.all<{ column_name: string }>()
		expect(results.map((row) => row.column_name)).toEqual(['bundle', 'name', 'applied_at'])
	})
})

describe.skipIf(!hasPostgres)('database code in an application schema, checked before the commit', () => {
	/** A schema outside the application's, as another installation or an extension leaves one: a wrapper and a domain. */
	async function outsideSchema(): Promise<string> {
		const outside = `ext_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
		schemas.push(outside)
		const admin = new SQL({ url: requireUrl(), max: 1 })
		try {
			await admin.unsafe(`CREATE SCHEMA ${outside};
				CREATE FUNCTION ${outside}.spread(text) RETURNS text IMMUTABLE LANGUAGE sql AS $$ SELECT $1 $$;
				CREATE SEQUENCE ${outside}.s;
				CREATE DOMAIN ${outside}.sneaky AS int CHECK (nextval('${outside}.s') > 0);`)
		} finally {
			await admin.close()
		}
		return outside
	}

	/** Applies `sql` and expects the check to roll it back: no table of it and no ledger row survive. */
	async function rolledBack(sql: string, table: string): Promise<string> {
		const { migrations, db } = application()
		const failure = await failureOf(migrations.apply(db, [migration('20261008120000_init.sql', sql)]))
		expect(failure.message).toStartWith(
			'Postgres migration app/20261008120000_init.sql was rolled back: the schema would hold database code the data layer cannot see: ',
		)
		const relation = await db.prepare(`SELECT to_regclass('${migrations.schema}.${table}') AS relation`).first<{ relation: string | null }>()
		expect(relation?.relation).toBeNull()
		const { results } = await db.prepare(`SELECT name FROM ${migrations.schema}.fabrika_migrations`).all()
		expect(results).toEqual([])
		return failure.message
	}

	test('applies the defaults, checks, generated columns and indexes an application needs', async () => {
		const { migrations, db } = application()
		const sql = `
			CREATE TYPE stage AS ENUM ('open', 'won');
			CREATE TABLE workspaces (id text PRIMARY KEY);
			CREATE TABLE deals (
				id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
				workspace_id text NOT NULL REFERENCES workspaces (id) ON UPDATE CASCADE ON DELETE CASCADE,
				counter bigint GENERATED ALWAYS AS IDENTITY,
				title varchar(80) NOT NULL DEFAULT 'untitled' CHECK (length(btrim(title)) > 0),
				status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'live')),
				stage stage NOT NULL DEFAULT 'open',
				amount numeric(10, 2) DEFAULT 0,
				big bigint NOT NULL DEFAULT 0,
				done boolean NOT NULL DEFAULT false,
				created_at timestamptz NOT NULL DEFAULT now(),
				seen timestamptz DEFAULT CURRENT_TIMESTAMP,
				title_length int GENERATED ALWAYS AS (char_length(title) * 2) STORED,
				CHECK (big >= 0 AND amount IS DISTINCT FROM -1)
			);
			CREATE UNIQUE INDEX deals_title ON deals (workspace_id, lower(title)) WHERE status <> 'pending';
			ALTER TABLE deals ADD COLUMN note text DEFAULT '' CHECK (note NOT LIKE '%<script%');
			INSERT INTO workspaces VALUES ('w1');
		`
		expect(await migrations.apply(db, [migration('20261008120000_init.sql', sql)])).toEqual(['app/20261008120000_init.sql'])
	})

	test('a generated column or an index that calls a function outside pg_catalog is rolled back', async () => {
		const outside = await outsideSchema()
		expect(await rolledBack(`CREATE TABLE deals (stage text, spread text GENERATED ALWAYS AS (${outside}.spread(stage)) STORED)`, 'deals'))
			.toContain(`default deals.spread calls ${outside}.spread`)
		expect(await rolledBack(`CREATE TABLE deals (stage text); CREATE INDEX deals_spread ON deals (${outside}.spread(stage))`, 'deals'))
			.toContain(`index deals_spread calls ${outside}.spread`)
	})

	test('a CHECK that calls a built-in outside the reviewed list is rolled back', async () => {
		expect(await rolledBack('CREATE TABLE files (id oid CHECK (pg_catalog.lo_unlink(id) = 1))', 'files')).toContain(
			'constraint files_id_check calls pg_catalog.lo_unlink',
		)
	})

	test("a default that casts through another schema's domain is rolled back", async () => {
		const outside = await outsideSchema()
		const message = await rolledBack(`CREATE TABLE deals (n int DEFAULT 1::${outside}.sneaky::int)`, 'deals')
		expect(message).toContain('default deals.n holds COERCETODOMAIN')
		expect(message).toContain(`the type ${outside}.sneaky`)
	})

	test('a default that calls a built-in behind a cast is rolled back', async () => {
		expect(await rolledBack('CREATE TABLE deals (locked boolean DEFAULT (false::boolean OR pg_catalog.pg_try_advisory_xact_lock(1, 2)))', 'deals'))
			.toContain('default deals.locked calls pg_catalog.pg_try_advisory_xact_lock')
	})

	test('a serial column is rolled back: its sequence and its nextval default', async () => {
		const message = await rolledBack('CREATE TABLE deals (n serial PRIMARY KEY)', 'deals')
		expect(message).toContain('default deals.n calls pg_catalog.nextval')
		expect(message).toContain('sequence deals_n_seq (a serial column; use GENERATED ALWAYS AS IDENTITY)')
	})

	test('the check covers the whole schema, so a later migration that keeps a leftover trigger fails until it drops it', async () => {
		const { migrations, db } = application()
		const first = migration('20261008120000_init.sql', 'CREATE TABLE deals (id text PRIMARY KEY)')
		await migrations.apply(db, [first])
		await db
			.prepare(
				`CREATE TRIGGER noop BEFORE UPDATE ON ${migrations.schema}.deals FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()`,
			)
			.run()
		const keeping = migration('20261009120000_note.sql', 'ALTER TABLE deals ADD COLUMN note text')
		expect((await failureOf(migrations.apply(db, [first, keeping]))).message).toContain('trigger deals.noop')
		const dropping = migration('20261009120000_note.sql', 'DROP TRIGGER noop ON deals; ALTER TABLE deals ADD COLUMN note text')
		expect(await migrations.apply(db, [first, dropping])).toEqual(['app/20261009120000_note.sql'])
	})
})
