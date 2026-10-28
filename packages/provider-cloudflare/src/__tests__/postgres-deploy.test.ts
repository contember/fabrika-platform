import { type ContractArtifact, contractDigest, FABRIKA_APPLICATION_OBJECT, OPS_PREFIX, parseManagedEnvironment } from '@fabrika/auth-core'
import { parseProxyManifestJson } from '@fabrika/proxy-core/manifest'
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type GeneratedConfig, Worker } from 'oblaka-iac'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import type { CloudflareAppConfig, CloudflareCollaborators, CommandResult, CommandSpec } from '..'
import { composeLocalApplication, createCloudflareDeployer, defineApp, generateWranglerConfigs, stageLocalAssets } from '..'
import { type HyperdriveUpsert, localDatabaseConnection, migrationDatabaseConnection, PENDING_HYPERDRIVE_ID, runtimeOrigin } from '../database'
import { PROXY_MANIFEST_DEFINE } from '../proxy'

const PROVISIONING = 'postgres://owner:pr%40vision-secret@db.example.com:5432/notes_db'
const PROVISIONING_PASSWORD = 'pr@vision-secret'
const HYPERDRIVE = 'c'.repeat(32)
const SINCE = '0.9.0-dev.9'
const ENTRY = 'fabrika/entry.generated.ts'

/** The checkout on disk the runner installed: the application's CLI and the built SPA mounts of `notesArtifact`. */
const REPO = await mkdtemp(join(tmpdir(), 'fabrika-postgres-'))
const APP_DIR = join(REPO, 'app')
const CLI = join(APP_DIR, 'node_modules', '.bin', 'fabrika')
await mkdir(dirname(CLI), { recursive: true })
await writeFile(CLI, '')
for (const mount of ['dist/app', 'dist/share']) {
	await mkdir(join(APP_DIR, mount), { recursive: true })
	await writeFile(join(APP_DIR, mount, 'index.html'), '<!doctype html>')
}

afterAll(async () => {
	await rm(REPO, { recursive: true, force: true })
})

interface Recorded {
	commands: CommandSpec[]
	upserts: HyperdriveUpsert[]
	provisioned: GeneratedConfig[][]
	logs: string[]
}

let rec: Recorded
beforeEach(() => {
	rec = { commands: [], upserts: [], provisioned: [], logs: [] }
})

const postgres = { kind: 'postgres', provisioningSecret: 'DATABASE_URL' } as const

const appConfig = (
	overrides: Partial<Pick<CloudflareAppConfig, 'pipeline' | 'resources'>> & { readonly database?: unknown } = {},
): CloudflareAppConfig => {
	const { database, ...rest } = overrides
	const config = defineApp({ id: 'notes', database: postgres, ...rest })
	// A checkout's config is plain JavaScript: whatever it carries reaches the deployer.
	return database === undefined ? config : { ...config, database: database === null ? undefined : postgresShape(database) }
}

/** Narrows a test's `database` override to the config's type; the deployer re-validates whatever it receives. */
const postgresShape = (value: unknown): CloudflareAppConfig['database'] => {
	if (typeof value !== 'object' || value === null) return undefined
	return { kind: 'postgres', provisioningSecret: String(Reflect.get(value, 'provisioningSecret')) }
}

const appWorker = (raw: Record<string, unknown> = {}): Worker => {
	const worker = new Worker({ dir: '.', workers_dev: false, preview_urls: false, name: 'notes', compatibility_flags: [], bindings: {}, main: ENTRY })
	Object.assign(worker.options, raw)
	return worker
}

const succeeded = (spec: CommandSpec): CommandResult => ({
	exitCode: 0,
	stdout: spec.args[0] === 'secret' && spec.args[1] === 'list' ? '[]' : '',
	stderr: '',
})

const collaborators = (
	config: CloudflareAppConfig,
	runCommand: (spec: CommandSpec) => CommandResult = succeeded,
): CloudflareCollaborators => ({
	loadConfig: async () => ({ config, cwd: APP_DIR }),
	// Read only by a local deploy, which carries no approved access.
	readContract: async () => notesArtifact,
	runCommand: async (spec) => {
		rec.commands.push(spec)
		return runCommand(spec)
	},
	provision: async (input) => {
		if (input.definition === undefined) throw new Error('nothing to provision')
		const { configs } = await generateWranglerConfigs(input.definition, input.env)
		rec.provisioned.push([...configs])
		return { wranglerConfigs: [...configs], wranglerConfig: configs[0]?.config ?? {} }
	},
	writeOutcome: async () => {},
	hyperdrive: {
		upsert: async (input) => {
			rec.upserts.push(input)
			return { id: HYPERDRIVE }
		},
	},
})

interface DeployOptions {
	readonly dryRun?: boolean
	readonly secrets?: Readonly<Record<string, string>>
	/** What Control approved: Postgres by default, `null` for no database. */
	readonly approvedDatabase?: 'postgres' | null
	/** The application's release Control names: `SINCE` by default. */
	readonly framework?: string
	/** `false`: a local deploy, with no approved access. */
	readonly approved?: false
	readonly runCommand?: (spec: CommandSpec) => CommandResult
	readonly contract?: ContractArtifact
	/** The application's declared variables the runner read; none by default. */
	readonly vars?: Readonly<Record<string, string>>
	/** What Control hands the job as its managed environment; none by default. */
	readonly managedEnvironment?: Readonly<Record<string, string>>
}

const deploy = (config: CloudflareAppConfig, options: DeployOptions = {}) => {
	const contract = options.contract ?? notesArtifact
	return createCloudflareDeployer({ accountId: 'acc-1', apiToken: 'tok-1', collaborators: collaborators(config, options.runCommand) })({
		// The runner takes the id from the checkout's config, as `deployCloudflareConfig` does.
		appId: config.id,
		env: 'stage',
		domain: 'stage.example.com',
		cwd: REPO,
		configPath: 'app/fabrika.config.ts',
		secrets: options.secrets ?? { DATABASE_URL: PROVISIONING },
		vars: options.vars ?? {},
		managedEnvironment: parseManagedEnvironment(options.managedEnvironment ?? {}),
		...(options.approved === false ? {} : {
			approved: {
				kind: 'contract' as const,
				contract,
				contractDigest: contractDigest(contract),
				framework: options.framework ?? SINCE,
				...(options.approvedDatabase === null ? {} : { database: options.approvedDatabase ?? 'postgres' }),
			},
		}),
		dryRun: options.dryRun ?? false,
		signal: new AbortController().signal,
		log: (line) => {
			rec.logs.push(line)
		},
	})
}

const failure = (result: Awaited<ReturnType<ReturnType<typeof createCloudflareDeployer>>>): string =>
	result.steps.flatMap((step) => step.error === undefined ? [] : [step.error]).join('\n')

const applicationConfig = (): GeneratedConfig['config'] | undefined =>
	rec.provisioned.at(-1)?.find((generated) => generated.config.name === 'stage-notes')?.config

const proxyConfig = (): GeneratedConfig['config'] | undefined =>
	rec.provisioned.at(-1)?.find((generated) => generated.config.name === 'stage-notes-proxy')?.config

/** The proxy's one manifest entry, from the `define` literal baked into its bundle. */
const manifestApp = () => {
	const literal = proxyConfig()?.define?.[PROXY_MANIFEST_DEFINE]
	const manifest: unknown = typeof literal === 'string' ? JSON.parse(literal) : null
	return parseProxyManifestJson(typeof manifest === 'string' ? manifest : '')?.apps[0]
}

const everything = (): string => JSON.stringify({ commands: rec.commands.map((command) => [command.command, ...command.args]), logs: rec.logs })

describe('an application on Postgres through Hyperdrive', () => {
	test('the plan migrates and writes the Hyperdrive config after the build and before oblaka provisions', async () => {
		const result = await deploy(appConfig({ pipeline: { build: 'bun run build' } }), { dryRun: true })
		expect(result.status).toBe('succeeded')
		expect(result.steps.map((step) => step.id)).toEqual(['build', 'provision-database', 'provision-resources', 'deploy-worker'])
		expect(rec.logs).toContain(`  [dry-run] would run: fabrika db migrate in ${APP_DIR} (the provisioning URL from \`DATABASE_URL\`)`)
		expect(rec.logs).toContain('  [dry-run] would write the Hyperdrive config stage-notes-database (caching disabled) over the runtime role')
		expect(rec.upserts).toEqual([])
		expect(everything()).not.toContain(PROVISIONING)
		// A dry run hands out no id, so the configs carry the pending one.
		expect(applicationConfig()?.hyperdrive).toEqual([{ binding: 'FABRIKA_DATABASE', id: PENDING_HYPERDRIVE_ID }])
	})

	test("the application's own CLI migrates with exactly its variables, and the URL is never on an argv or in a log", async () => {
		const result = await deploy(appConfig({ pipeline: { build: 'bun run build' } }))
		expect(failure(result)).toBe('')
		expect(result.status).toBe('succeeded')
		const migrate = rec.commands.find((command) => command.args.join(' ') === 'db migrate')
		expect(migrate?.command).toBe(CLI)
		expect(migrate?.cwd).toBe(APP_DIR)
		const expected: Record<string, string> = { FABRIKA_APP_ID: 'notes', FABRIKA_APP_DATABASE_URL: PROVISIONING }
		for (const name of ['PATH', 'HOME', 'TMPDIR']) {
			const value = process.env[name]
			if (value !== undefined) expected[name] = value
		}
		expect(migrate?.env).toEqual(expected)
		expect(migrate?.omitEnv).toEqual(Object.keys(process.env))
		// The checkout's own build runs without the provisioning URL, as without the account's credentials.
		const build = rec.commands.find((command) => command.command === 'sh')
		expect(build?.omitEnv).toContain('DATABASE_URL')
		expect(build?.env).toBeUndefined()
		// Every other command (the entry build, wrangler) gets no URL either.
		for (const command of rec.commands) {
			if (command !== migrate) expect(JSON.stringify(command.env ?? {})).not.toContain(PROVISIONING)
		}
		const origin = runtimeOrigin(PROVISIONING, 'notes')
		expect(everything()).not.toContain(PROVISIONING)
		expect(everything()).not.toContain(PROVISIONING_PASSWORD)
		expect(everything()).not.toContain(origin.password)
		expect(rec.logs).toContain(`  wrote the Hyperdrive config stage-notes-database (${HYPERDRIVE})`)
	})

	test("the entry build asks the application's own CLI for Postgres, which a deployer that composes no database never does", async () => {
		const result = await deploy(appConfig())
		expect(failure(result)).toBe('')
		const build = rec.commands.find((command) => command.args[0] === 'app' && command.args[1] === 'build')
		expect(build?.command).toBe(CLI)
		expect(build?.args).toEqual(['app', 'build', '--provider=cloudflare', '--config=fabrika.config.ts', '--database=postgres'])
		rec = { commands: [], upserts: [], provisioned: [], logs: [] }
		await deploy(appConfig(), { dryRun: true })
		expect(rec.logs).toContain(
			`  [dry-run] would run: fabrika app build --provider=cloudflare --config=fabrika.config.ts --database=postgres in ${APP_DIR}`,
		)
	})

	test('the Hyperdrive config connects as the runtime role, and the Worker binds exactly its id with Smart Placement', async () => {
		const result = await deploy(appConfig())
		expect(failure(result)).toBe('')
		expect(rec.upserts).toEqual([
			expect.objectContaining({ accountId: 'acc-1', apiToken: 'tok-1', name: 'stage-notes-database', origin: runtimeOrigin(PROVISIONING, 'notes') }),
		])
		expect(rec.upserts[0]?.origin.user).toBe('run_notes')
		const application = applicationConfig()
		expect(application?.hyperdrive).toEqual([{ binding: 'FABRIKA_DATABASE', id: HYPERDRIVE }])
		expect(application?.placement).toEqual({ mode: 'smart' })
		// Its jobs still run in the object, with the files bucket and the repair tick.
		expect(application?.durable_objects?.bindings).toEqual([{ name: 'FABRIKA_APPLICATION', class_name: 'FabrikaApplication' }])
		expect(application?.r2_buckets).toEqual([{ binding: 'FABRIKA_FILES', bucket_name: 'stage-notes-files' }])
		// The URL and the runtime password reach no Worker.
		expect(JSON.stringify(rec.provisioned)).not.toContain(PROVISIONING_PASSWORD)
		expect(JSON.stringify(rec.provisioned)).not.toContain(runtimeOrigin(PROVISIONING, 'notes').password)
		expect(proxyConfig()?.hyperdrive).toBeUndefined()
		expect(proxyConfig()?.placement).toBeUndefined()
	})

	test('an environment on Postgres gets no ops channel: no ops row, no object variables', async () => {
		const result = await deploy(appConfig())
		expect(failure(result)).toBe('')
		expect(applicationConfig()?.vars?.[FABRIKA_APPLICATION_OBJECT]).toBeUndefined()
		expect(applicationConfig()?.vars?.['FABRIKA_APPLICATION_OBJECTS']).toBeUndefined()
		const app = manifestApp()
		expect(app?.id).toBe('notes@stage')
		expect(JSON.stringify(app)).not.toContain(OPS_PREFIX)
		// The same contract on the object's SQLite, at the same release, gets the row and the variables.
		rec = { commands: [], upserts: [], provisioned: [], logs: [] }
		expect(failure(await deploy(appConfig({ database: null }), { approvedDatabase: null }))).toBe('')
		expect(JSON.stringify(manifestApp())).toContain(OPS_PREFIX)
		expect(applicationConfig()?.vars?.[FABRIKA_APPLICATION_OBJECT]).toBe('application')
	})

	test('a failed migration fails the run before any Hyperdrive config is written, with its output scrubbed', async () => {
		const derived = runtimeOrigin(PROVISIONING, 'notes').password
		// The migration role owns the schema; the CLI derives its URL from the provisioning one and connects with it.
		const migration = migrationDatabaseConnection(PROVISIONING, 'notes')
		const migrationPassword = new URL(migration).password
		expect(migrationPassword).not.toBe(derived)
		const result = await deploy(appConfig(), {
			runCommand: (spec) =>
				spec.args.join(' ') === 'db migrate'
					? {
						exitCode: 1,
						stdout: '',
						stderr: `connecting to ${migration}: refused ${PROVISIONING} (${PROVISIONING_PASSWORD}, ${derived}, ${migrationPassword})`,
					}
					: succeeded(spec),
		})
		expect(result.status).toBe('failed')
		const message = failure(result)
		expect(message).toContain('fabrika db migrate failed (exit 1): connecting to [redacted]: refused [redacted] ([redacted], [redacted], [redacted])')
		expect(message).not.toContain(migrationPassword)
		expect(rec.upserts).toEqual([])
		expect(rec.provisioned).toEqual([])
	})

	test('a local deploy takes the config, with no approved access', async () => {
		const result = await deploy(appConfig(), { approved: false })
		expect(failure(result)).toBe('')
		expect(result.steps.map((step) => step.id)).toEqual(['provision-database', 'provision-resources', 'deploy-worker'])
	})

	describe('is refused before anything runs', () => {
		const refused = async (config: CloudflareAppConfig, options: DeployOptions, message: string): Promise<void> => {
			await expect(deploy(config, options)).rejects.toThrow(message)
			expect(rec.commands).toEqual([])
			expect(rec.upserts).toEqual([])
		}

		test('without the provisioning secret', async () => {
			await refused(
				appConfig(),
				{ secrets: {} },
				'the application secret `DATABASE_URL` (`database.provisioningSecret`) is not set for environment `stage`',
			)
		})

		test('with the secret among the Worker’s secrets, variables or bindings', async () => {
			const message = "`DATABASE_URL` holds the database's provisioning URL, which never reaches the Worker"
			await refused(appConfig({ pipeline: { secrets: ['DATABASE_URL'] } }), {}, message)
			await refused(appConfig({ pipeline: { vars: ['DATABASE_URL'] } }), {}, message)
			await refused(appConfig({ resources: () => appWorker({ vars: { DATABASE_URL: 'x' } }) }), {}, message)
		})

		test('with a config that names another application than the one Control deploys', async () => {
			// The id names the Hyperdrive config the deploy overwrites and the roles it creates: another application's.
			const other = defineApp({ id: 'other', database: postgres })
			await refused(other, {}, 'the config declares app "other", and Control approved the contract of app "notes"')
			await refused(appConfig(), { managedEnvironment: { FABRIKA_IAM_APP_ID: 'other@stage' } }, 'and Control deploys `other@stage`')
			// The same on the object's SQLite: the id names its Workers too.
			await refused(defineApp({ id: 'other' }), { approvedDatabase: null }, 'Control approved the contract of app "notes"')
			// Control's own audience for this application is accepted.
			expect(failure(await deploy(appConfig(), { managedEnvironment: { FABRIKA_IAM_APP_ID: 'notes@stage' } }))).toBe('')
		})

		test('with the provisioning URL or its password under another name', async () => {
			const copied = (name: string) => `\`${name}\` holds the database's provisioning URL or its password (\`DATABASE_URL\`)`
			await refused(
				appConfig({ pipeline: { secrets: ['DB_URL'] } }),
				{ secrets: { DATABASE_URL: PROVISIONING, DB_URL: PROVISIONING } },
				copied('DB_URL'),
			)
			await refused(appConfig({ pipeline: { vars: ['DB_PASSWORD'] } }), { vars: { DB_PASSWORD: PROVISIONING_PASSWORD } }, copied('DB_PASSWORD'))
			await refused(appConfig({ resources: () => appWorker({ vars: { DB: PROVISIONING } }) }), {}, copied('DB'))
			// The password as the URL writes it, inside a longer value.
			await refused(appConfig({ resources: () => appWorker({ vars: { DSN: `user=owner password=pr%40vision-secret` } }) }), {}, copied('DSN'))
			// An ordinary value is no copy, and the error names the variable, never the value.
			const message = await deploy(appConfig({ resources: () => appWorker({ vars: { DB: PROVISIONING } }) })).then(
				() => '',
				(error: unknown) => String(error),
			)
			expect(message).toContain(copied('DB'))
			expect(message).not.toContain(PROVISIONING_PASSWORD)
			expect(failure(await deploy(appConfig({ resources: () => appWorker({ vars: { MODE: 'postgres', HOST: 'db.example.com' } }) })))).toBe('')
		})

		test('when the config and the approval disagree', async () => {
			await refused(appConfig(), { approvedDatabase: null }, 'Control approved no database: Control reads it statically from the `fabrika.config.ts`')
			await refused(appConfig({ database: null }), {}, 'Control approved Postgres for this application, read from the `fabrika.config.ts` at its root')
		})

		test('below the release that serves Postgres', async () => {
			await refused(appConfig(), { framework: '0.9.0-dev.8' }, 'which an application on framework 0.9.0-dev.8 cannot run on Cloudflare')
		})

		test('with a provisioning secret that is no application secret name', async () => {
			await refused(appConfig({ database: { provisioningSecret: 'FABRIKA_DATABASE_URL' } }), {}, 'is not an application secret name')
			await refused(appConfig({ database: { provisioningSecret: 'database_url' } }), {}, 'is not an application secret name')
		})

		test('with a Hyperdrive binding or placement the platform did not write', async () => {
			// An application on SQLite binds no Hyperdrive and sets no placement.
			const sqlite = (raw: Record<string, unknown>) => appConfig({ database: null, resources: () => appWorker(raw) })
			await refused(
				sqlite({ hyperdrive: [{ binding: 'DB', id: HYPERDRIVE }] }),
				{ approvedDatabase: null },
				'binds Hyperdrive; only the platform binds it',
			)
			await refused(sqlite({ placement: { mode: 'smart' } }), { approvedDatabase: null }, 'sets `placement`; only the platform sets it')
			// On Postgres, an authored entry beside the platform's, a local connection string, or another placement.
			const emitting = (extra: Record<string, unknown>) => ({
				configureBinding: ({ config }: { config: GeneratedConfig['config'] }) => ({ ...config, ...extra }),
			})
			await refused(
				appConfig({ resources: () => appWorker({ hyperdrive: [{ binding: 'OTHER', id: HYPERDRIVE }] }) }),
				{},
				'must bind `FABRIKA_DATABASE` once, to the Hyperdrive config `stage-notes-database` this deploy wrote',
			)
			const local = [{ binding: 'FABRIKA_DATABASE', id: PENDING_HYPERDRIVE_ID, localConnectionString: 'postgres://x' }]
			await refused(
				appConfig({ resources: () => appWorker({ bindings: { ZZZ: emitting({ hyperdrive: local }) } }) }),
				{},
				'must bind `FABRIKA_DATABASE` once',
			)
			await refused(
				appConfig({ resources: () => appWorker({ bindings: { ZZZ: emitting({ placement: { mode: 'off' } }) } }) }),
				{},
				"must run with `placement: { mode: 'smart' }`",
			)
		})

		test('with an authored binding under the platform’s name', async () => {
			const binding = { configureBinding: ({ config }: { config: GeneratedConfig['config'] }) => config }
			await refused(
				appConfig({ resources: () => appWorker({ bindings: { FABRIKA_DATABASE: binding } }) }),
				{},
				'`FABRIKA_DATABASE` is managed by Fabrika',
			)
		})
	})

	test('a binding that hands oblaka another id during provisioning fails the deploy before wrangler runs', async () => {
		let swapped = false
		const config = appConfig({
			resources: () =>
				appWorker({
					bindings: {
						ZZZ: {
							configureBinding: ({ config: generated }: { config: GeneratedConfig['config'] }) => {
								if (!swapped) return generated
								return { ...generated, hyperdrive: [{ binding: 'FABRIKA_DATABASE', id: 'd'.repeat(32) }] }
							},
						},
					},
				}),
		})
		const result = await createCloudflareDeployer({
			accountId: 'acc-1',
			apiToken: 'tok-1',
			collaborators: {
				...collaborators(config),
				hyperdrive: {
					upsert: async () => {
						swapped = true
						return { id: HYPERDRIVE }
					},
				},
			},
		})({
			appId: 'notes',
			env: 'stage',
			domain: 'stage.example.com',
			cwd: REPO,
			configPath: 'app/fabrika.config.ts',
			secrets: { DATABASE_URL: PROVISIONING },
			vars: {},
			managedEnvironment: parseManagedEnvironment({}),
			approved: { kind: 'contract', contract: notesArtifact, contractDigest: contractDigest(notesArtifact), framework: SINCE, database: 'postgres' },
			dryRun: false,
			signal: new AbortController().signal,
			log: () => {},
		})
		expect(result.status).toBe('failed')
		expect(failure(result)).toContain('must bind `FABRIKA_DATABASE` once')
		expect(rec.commands.filter((command) => command.command === 'wrangler')).toEqual([])
	})
})

describe('defineApp with a database', () => {
	test('keeps a valid Postgres database and refuses any other shape', () => {
		expect(defineApp({ id: 'notes', database: postgres }).database).toEqual(postgres)
		expect(defineApp({ id: 'notes' }).database).toBeUndefined()
		const invalid: unknown[] = [
			{ kind: 'mysql', provisioningSecret: 'DATABASE_URL' },
			{ kind: 'postgres' },
			{ kind: 'postgres', provisioningSecret: 'DATABASE_URL', url: 'postgres://x' },
			{ kind: 'postgres', provisioningSecret: 'FABRIKA_DB' },
			{ kind: 'postgres', provisioningSecret: 'lower' },
			'postgres',
		]
		for (const database of invalid) {
			expect(() => defineApp(JSON.parse(JSON.stringify({ id: 'notes', database })))).toThrow('cloudflare: `database')
		}
	})
})

describe('the local composition on Postgres', () => {
	const LOCAL_IAM = 'http://127.0.0.1:8787'

	test('binds FABRIKA_DATABASE to the runtime role directly, with the deploy’s object, bucket and placement', async () => {
		const assets = await stageLocalAssets(notesArtifact, APP_DIR)
		const connectionString = localDatabaseConnection('postgres://owner:pw@127.0.0.1:55433/postgres', 'notes')
		const local = composeLocalApplication({
			config: defineApp({ id: 'notes', database: postgres }),
			contract: notesArtifact,
			assets,
			iamOrigin: LOCAL_IAM,
			env: 'local',
			database: { connectionString },
		})
		const configs = (await generateWranglerConfigs(local, 'local')).configs.map((item) => item.config)
		const application = configs.find((config) => config.name?.endsWith('-proxy') === false)
		expect(application?.hyperdrive).toEqual([{ binding: 'FABRIKA_DATABASE', id: 'local', localConnectionString: connectionString }])
		expect(application?.placement).toEqual({ mode: 'smart' })
		expect(application?.durable_objects?.bindings).toEqual([{ name: 'FABRIKA_APPLICATION', class_name: 'FabrikaApplication' }])
		expect(new URL(connectionString).username).toBe('run_notes')
	})

	test('requires the connection for a config on Postgres, and refuses it for one on SQLite', async () => {
		const assets = await stageLocalAssets(notesArtifact, APP_DIR)
		const base = { contract: notesArtifact, assets, iamOrigin: LOCAL_IAM, env: 'local' }
		expect(() => composeLocalApplication({ ...base, config: defineApp({ id: 'notes', database: postgres }) })).toThrow(
			'the config runs on Postgres; pass `database',
		)
		expect(() => composeLocalApplication({ ...base, config: defineApp({ id: 'notes' }), database: { connectionString: 'postgres://x' } })).toThrow(
			"the config runs on its object's SQLite; drop `database`",
		)
	})
})
