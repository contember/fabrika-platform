import { SQL } from 'bun'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	applicationMigrationLockKey,
	DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
	DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS,
	definePostgresApplicationMigrations,
} from '../application-postgres-migrations.js'
import { applicationDatabaseSchema } from '../application-schema.js'
import { databaseCodeQuery } from '../database-code.js'
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

	test('a plan reads schema qualifiers by role, as the runner does: an alias or the own schema is no other schema', () => {
		const migrations = definePostgresApplicationMigrations({ appId: 'notes', directory: '/unused' })
		const sql = 'CREATE TABLE app_notes.notes (id TEXT);\nUPDATE notes SET id = app_other.id FROM notes AS app_other WHERE app_other.id = notes.id;'
		expect(migrations.plan([migration('20261008120000_init.sql', sql)]).bundles[0]?.migrations).toHaveLength(1)
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
		// The framework's tables share the schema; an application migration may not name one.
		const reaching = [migration('20261008120000_init.sql', 'CREATE TABLE notes (thing TEXT REFERENCES fabrika_things (id))')]
		expect((await failureOf(migrations.apply(db, reaching))).message).toContain(
			"Application migration 20261008120000_init.sql line 1: a reference to the framework's fabrika_things is not allowed",
		)
		const files = [migration('20261008120000_init.sql', 'CREATE TABLE notes (thing TEXT)')]
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
		const slow = migration('20261008120000_slow.sql', "CREATE TABLE marker (id text); INSERT INTO marker SELECT 'x' WHERE pg_sleep(10) IS NULL")
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

	test('a runner-owned setting changed where the classifier cannot see it fails the migration and rolls it back', async () => {
		for (
			const [name, value] of [
				['statement_timeout', '0'],
				['lock_timeout', '0'],
				['search_path', 'public'],
				['fabrika.migration_xact', '0'],
			] as const
		) {
			const { migrations, db } = application()
			const init = migration('20261008120000_init.sql', 'CREATE TABLE marker (id text)')
			await migrations.apply(db, [init])
			// Installed outside any migration, so only the guard sees it fire during the next one.
			await db.prepare(`CREATE FUNCTION ${migrations.schema}.loosen() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN PERFORM pg_catalog.set_config(TG_ARGV[0], TG_ARGV[1], true); RETURN NEW; END $$`).run()
			await db
				.prepare(
					`CREATE TRIGGER loosen BEFORE INSERT ON ${migrations.schema}.marker FOR EACH ROW EXECUTE FUNCTION ${migrations.schema}.loosen('${name}', '${value}')`,
				)
				.run()
			const failure = await failureOf(migrations.apply(db, [init, migration('20261009120000_mark.sql', "INSERT INTO marker VALUES ('x')")]))
			expect(failure.message).toBe(
				"Postgres migration app/20261009120000_mark.sql ended the runner's transaction or changed its lock_timeout, statement_timeout or search_path",
			)
			const { results } = await db.prepare(`SELECT id FROM ${migrations.schema}.marker`).all()
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

	test('a refused statement is refused before any SQL runs, however the file hides it', async () => {
		const tag = `$${'t'.repeat(70)}$`
		for (
			const [sql, refusal] of [
				['CREATE TABLE marker (id text);\nGRANT ALL ON marker TO PUBLIC', 'line 2: GRANT is not allowed'],
				// Postgres ends a `--` comment at a lone carriage return.
				['CREATE TABLE marker (id text); -- a note\rGRANT ALL ON marker TO PUBLIC', 'line 1: GRANT is not allowed'],
				// A dollar tag has no length limit, and a parenthesis inside its body is text.
				[`CREATE TABLE marker (id text);\nCOMMENT ON TABLE marker IS ${tag} ( ${tag};\nGRANT ALL ON marker TO PUBLIC`, 'line 3: GRANT is not allowed'],
				// COPY … PROGRAM runs outside the migration's transaction, so no rollback could undo it.
				["CREATE TABLE marker (id text);\nCOPY marker FROM PROGRAM 'true'", 'line 2: COPY is not allowed'],
				['CREATE TABLE marker (id text);\nINSERT INTO app_other.t VALUES (1)', 'line 2: INSERT reaching the schema app_other is not allowed'],
				["CREATE TABLE marker (id text);\nUPDATE public.accounts SET plan = 'free'", 'line 2: UPDATE reaching the schema public is not allowed'],
				[
					"CREATE TABLE marker (id text);\nUPDATE fabrika_job_leases SET holder = 'me'",
					"line 2: a reference to the framework's fabrika_job_leases is not allowed",
				],
				['CREATE TABLE marker (id text);\nCREATE DOMAIN positive AS int', 'line 2: CREATE DOMAIN is not allowed'],
				['CREATE TABLE deals (id text);\nCREATE TABLE copied (LIKE deals INCLUDING ALL)', 'line 2: CREATE TABLE … LIKE … INCLUDING is not allowed'],
				// Postgres reads a no-break space as part of a name, so `\u00a0E'\'` is a name and the string `'\'`.
				["CREATE TABLE marker (c text DEFAULT \u00a0E'\\'); GRANT ALL ON marker TO PUBLIC; --')", 'line 1: GRANT is not allowed'],
				[
					"CREATE TABLE marker (id text);\nUPDATE pg_proc SET prosrc = 'select 1' WHERE proname = 'lower'",
					'line 2: UPDATE reaching the schema pg_catalog is not allowed',
				],
				[
					'CREATE TABLE marker (id text);\nALTER TABLE ALL IN TABLESPACE pg_default SET TABLESPACE pg_default',
					'line 2: ALTER TABLE ALL IN TABLESPACE is not allowed',
				],
				[
					"CREATE TABLE marker (id text);\nINSERT INTO marker SELECT set_config('statement_timeout', '0', true)",
					'line 2: a call of set_config is not allowed',
				],
				['CREATE TABLE files (id oid CHECK (lo_unlink(id) = 1))', 'line 1: a call of lo_unlink is not allowed'],
				[
					"CREATE TABLE marker (id text);\nINSERT INTO marker SELECT query_to_xml('select 1', true, true, '')",
					'line 2: a call of query_to_xml is not allowed',
				],
				[
					'CREATE TABLE deals (id text);\nCREATE FUNCTION f() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$',
					'line 2: SECURITY DEFINER is not allowed',
				],
				[
					"CREATE TABLE deals (id text);\nCREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'DROP TABLE deals'; END $$",
					'line 2: a dynamic EXECUTE in a body is not allowed',
				],
			] as const
		) {
			const { migrations, db } = application()
			const failure = await failureOf(migrations.apply(db, [migration('20261008120000_init.sql', sql)]))
			expect(failure.message).toContain(`Application migration 20261008120000_init.sql ${refusal}`)
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
			ALTER TABLE deals ADD COLUMN data jsonb NOT NULL DEFAULT '{}', ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
			ALTER TABLE deals ADD COLUMN search tsvector GENERATED ALWAYS AS (to_tsvector('english', title)) STORED;
			ALTER TABLE deals ADD CHECK (data ?| ARRAY['kind'] OR NOT (data @> '{"locked": true}')), ADD CHECK (cardinality(tags) <= 10);
			ALTER TABLE deals ADD CHECK (abs(round(amount)) < 1000000 AND (big, counter) > (-1, -1));
			CREATE INDEX deals_kind ON deals ((data ->> 'kind'), (data -> 'owner'), date_trunc('day', created_at AT TIME ZONE 'UTC'));
			CREATE INDEX deals_search ON deals USING gin (search) WHERE tags && ARRAY['open'];
			ALTER TABLE deals ADD COLUMN note text DEFAULT '' CHECK (note NOT LIKE '%<script%');
			CREATE INDEX deals_month ON deals ((date_part('month', created_at AT TIME ZONE 'UTC')), (floor(big / 2)), (COALESCE(note, '')));
			ALTER TABLE deals ADD CHECK (greatest(big, 0) >= least(big, 0) AND NULLIF(note, 'x') IS DISTINCT FROM 'y');
			INSERT INTO workspaces VALUES ('w1');
		`
		expect(await migrations.apply(db, [migration('20261008120000_init.sql', sql)])).toEqual(['app/20261008120000_init.sql'])
	})

	test('a function, a type or a domain of another schema is refused before any SQL runs', async () => {
		const outside = await outsideSchema()
		for (
			const [sql, refusal] of [
				[`CREATE TABLE deals (stage text, spread text GENERATED ALWAYS AS (${outside}.spread(stage)) STORED)`, 'CREATE TABLE'],
				[`CREATE TABLE deals (stage text); CREATE INDEX deals_spread ON deals (${outside}.spread(stage))`, 'CREATE INDEX'],
				[`CREATE TABLE deals (n int DEFAULT 1::${outside}.sneaky::int)`, 'CREATE TABLE'],
			] as const
		) {
			const { migrations, db } = application()
			const failure = await failureOf(migrations.apply(db, [migration('20261008120000_init.sql', sql)]))
			expect(failure.message).toContain(`${refusal} naming the schema ${outside} is not allowed`)
			const schema = await db.prepare(`SELECT to_regnamespace('${migrations.schema}') AS schema`).first<{ schema: string | null }>()
			expect(schema?.schema).toBeNull()
		}
	})

	test('the catalog check finds the same objects when something else installed them', async () => {
		const outside = await outsideSchema()
		const { migrations, db } = application()
		await migrations.apply(db, [migration('20261008120000_init.sql', 'CREATE TABLE deals (stage text)')])
		await db.prepare(`ALTER TABLE ${migrations.schema}.deals ADD COLUMN spread text GENERATED ALWAYS AS (${outside}.spread(stage)) STORED`).run()
		await db.prepare(`CREATE INDEX deals_spread ON ${migrations.schema}.deals (${outside}.spread(stage))`).run()
		await db.prepare(`ALTER TABLE ${migrations.schema}.deals ADD COLUMN n int DEFAULT 1::${outside}.sneaky::int`).run()
		const { results } = await db.prepare(databaseCodeQuery(migrations.schema, [])).all<{ violation: string }>()
		expect(results.map((row) => row.violation)).toEqual([
			`default deals.n depends on the type ${outside}.sneaky`,
			`default deals.spread depends on the function ${outside}.spread`,
			`index deals_spread depends on the function ${outside}.spread`,
		])
	})

	test('database code a migration declares applies and passes the start check, its names matching the catalog', async () => {
		const { migrations, db } = application()
		const files = [
			migration(
				'20261008120000_init.sql',
				`
				CREATE TABLE deals (id text PRIMARY KEY, stage text NOT NULL, n int GENERATED ALWAYS AS IDENTITY, amount int);
				CREATE TABLE deal_log (deal_id text, stage text);
				CREATE FUNCTION spread() RETURNS trigger LANGUAGE plpgsql AS $body$
				BEGIN INSERT INTO deal_log VALUES (NEW.id, NEW.stage); RETURN NEW; END
				$body$;
				CREATE TRIGGER spread AFTER UPDATE ON deals FOR EACH ROW WHEN (OLD.stage IS DISTINCT FROM NEW.stage) EXECUTE FUNCTION spread();
				CREATE PROCEDURE tidy() LANGUAGE sql AS $$ DELETE FROM deal_log WHERE stage IS NULL $$;
				CREATE FUNCTION double_it(v int) RETURNS int LANGUAGE sql IMMUTABLE RETURN v * 2;
				CREATE VIEW open_deals AS SELECT d.id FROM deals d WHERE d.stage <> 'won';
				CREATE MATERIALIZED VIEW totals AS SELECT stage, count(*) FROM deals GROUP BY stage;
				CREATE RULE keep AS ON DELETE TO deal_log DO INSTEAD NOTHING;
				CREATE POLICY own ON deals USING (stage <> 'hidden');
				ALTER TABLE deals ADD COLUMN doubled int GENERATED ALWAYS AS (double_it(amount)) STORED;
				DO $$ BEGIN UPDATE deals SET stage = 'open' WHERE stage = ''; END $$;
				`,
			),
			migration(
				'20261009120000_rename.sql',
				`ALTER TABLE deals RENAME TO opportunities; DROP RULE keep ON deal_log;
				ALTER FUNCTION double_it(int) RENAME TO twice;
				CREATE OR REPLACE FUNCTION spread() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RETURN NEW; END $body$;
				ALTER TRIGGER spread ON opportunities RENAME TO spread_stage;`,
			),
		]
		expect(await migrations.apply(db, files)).toEqual(['app/20261008120000_init.sql', 'app/20261009120000_rename.sql'])
		const { results } = await db.prepare(databaseCodeQuery(migrations.schema, migrations.objects(files))).all<{ violation: string }>()
		expect(results).toEqual([])
	})

	test('the start check refuses an object no migration declares, and what escapes the schema', async () => {
		const { migrations, db } = application()
		const files = [migration('20261008120000_init.sql', 'CREATE TABLE deals (id text PRIMARY KEY)')]
		await migrations.apply(db, files)
		await db.prepare(
			`CREATE TRIGGER noop BEFORE UPDATE ON ${migrations.schema}.deals FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()`,
		).run()
		await db.prepare(
			`CREATE FUNCTION ${migrations.schema}.definer() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT 1 $$`,
		).run()
		const { results } = await db.prepare(databaseCodeQuery(migrations.schema, migrations.objects(files))).all<{ violation: string }>()
		expect(results.map((row) => row.violation)).toEqual([
			'function definer (no migration declares it)',
			'function definer has a SET clause',
			'function definer is SECURITY DEFINER',
			'trigger deals.noop (no migration declares it)',
		])
		const declared = migrations.objects([
			...files,
			migration(
				'20261009120000_noop.sql',
				'CREATE TRIGGER noop BEFORE UPDATE ON deals FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()',
			),
		])
		const { results: later } = await db.prepare(databaseCodeQuery(migrations.schema, declared)).all<{ violation: string }>()
		expect(later.map((row) => row.violation)).not.toContain('trigger deals.noop (no migration declares it)')
	})

	test('a routine has one signature and only an identity column has a sequence: the start check refuses the rest', async () => {
		const { migrations, db } = application()
		const files = [
			migration(
				'20261008120000_init.sql',
				`CREATE TABLE deals (id text, n int GENERATED ALWAYS AS IDENTITY);
				CREATE FUNCTION f(a text, b varchar(3) DEFAULT 'x', OUT c text) RETURNS text LANGUAGE sql AS $$ SELECT a $$;
				CREATE PROCEDURE p(IN a bigint, OUT b numeric) LANGUAGE plpgsql AS $$ BEGIN b := a; END $$;`,
			),
		]
		expect(await migrations.apply(db, files)).toEqual(['app/20261008120000_init.sql'])
		const check = async (): Promise<string[]> =>
			(await db.prepare(databaseCodeQuery(migrations.schema, migrations.objects(files))).all<{ violation: string }>()).results.map((row) =>
				row.violation
			)
		expect(await check()).toEqual([])
		await db.prepare(`CREATE FUNCTION ${migrations.schema}.f(a int) RETURNS int LANGUAGE sql RETURN a`).run()
		await db.prepare(`CREATE SEQUENCE ${migrations.schema}.stray OWNED BY ${migrations.schema}.deals.id`).run()
		await db.prepare(`ALTER TABLE ${migrations.schema}.deals ADD COLUMN m serial`).run()
		await db.prepare(`CREATE FUNCTION ${migrations.schema}.lower(a int) RETURNS int LANGUAGE sql RETURN a`).run()
		expect(await check()).toEqual([
			'function lower (no migration declares it)',
			'function lower shadows a pg_catalog function',
			'routine f has more than one signature',
			"sequence deals_m_seq (only an identity column's; use GENERATED ALWAYS AS IDENTITY)",
			"sequence stray (only an identity column's; use GENERATED ALWAYS AS IDENTITY)",
		])
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
	test('an applied file is checksum-locked, so a statement the allowlist refuses today does not block the next deploy', async () => {
		const { migrations, db } = application()
		const init = migration('20261008120000_init.sql', 'CREATE TABLE deals (id text PRIMARY KEY)')
		await migrations.apply(db, [init])
		const legacy = migration('20261007120000_legacy.sql', 'SELECT 1')
		await db
			.prepare(`INSERT INTO ${migrations.schema}.fabrika_migrations (bundle, name, checksum, applied_at) VALUES ('app', ?, ?, 0)`)
			.bind(legacy.name, migrationChecksum(legacy.sql))
			.run()
		const next = migration('20261009120000_note.sql', 'ALTER TABLE deals ADD COLUMN note text')
		expect(await migrations.apply(db, [legacy, init, next])).toEqual(['app/20261009120000_note.sql'])
	})

	test('an extension installed into the schema blocks every migration until one drops it', async () => {
		const { migrations, db } = application()
		const init = migration('20261008120000_init.sql', 'CREATE TABLE deals (id text PRIMARY KEY)')
		await migrations.apply(db, [init])
		await db.prepare(`CREATE EXTENSION citext SCHEMA ${migrations.schema}`).run()
		const keeping = migration('20261009120000_note.sql', 'ALTER TABLE deals ADD COLUMN note text')
		expect((await failureOf(migrations.apply(db, [init, keeping]))).message).toContain('function citext')
		const dropping = migration('20261009120000_note.sql', 'DROP EXTENSION citext; ALTER TABLE deals ADD COLUMN note text')
		expect(await migrations.apply(db, [init, dropping])).toEqual(['app/20261009120000_note.sql'])
	})

	test('the catalog query does not depend on the session: standard_conforming_strings off, the schema first on the path', async () => {
		const { migrations, db } = application()
		await migrations.apply(db, [migration('20261008120000_init.sql', 'CREATE TABLE deals (id text PRIMARY KEY)')])
		await db.prepare(`CREATE FUNCTION ${migrations.schema}."it's\\"(text) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$`).run()
		await db.prepare(`CREATE FUNCTION ${migrations.schema}.shadow() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$`).run()
		const hostile = PostgresDatabase.connect(requireUrl(), {
			connection: { standard_conforming_strings: 'off', search_path: `${migrations.schema}, pg_catalog` },
			max: 1,
		})
		openDatabases.push(hostile)
		const query = databaseCodeQuery(migrations.schema, [{ kind: 'function', name: "it's\\" }])
		expect(query).not.toContain('\\')
		const { results } = await hostile.prepare(query).all<{ violation: string }>()
		expect(results.map((row) => row.violation)).toEqual(['function shadow (no migration declares it)'])
	})
})
