import { CLOUDFLARE_APPLICATION_BINDING, CLOUDFLARE_APPLICATION_CLASS, CLOUDFLARE_FILES_BINDING, GENERATED_ENTRY_FILE } from '@fabrika/app/build'
import {
	type AppEnvironment,
	appEnvironmentId,
	type AppSchema,
	connectVariables,
	type ContractArtifact,
	contractDigest,
	FABRIKA_CONTRACT_DIGEST,
	FABRIKA_IAM_ISSUER,
	isFrameworkVariableName,
} from '@fabrika/auth-core'
import { type DeployStepResult, type ProviderManagedEnvironment, runSteps, type SchemaReconciler } from '@fabrika/provider-contract'
import { isPolicyOrigin } from '@fabrika/proxy-core/headers'
import { contractProxyTable } from '@fabrika/proxy-core/manifest'
import { basename, dirname, resolve } from 'node:path'
import { DurableObject, type GeneratedConfig, R2Bucket, ServiceReference, Worker } from 'oblaka-iac'
import { assertLiteralAssets } from './assets'
import type { CloudflareAppConfig } from './authoring'
import {
	type ApplicationRuntime,
	assertGeneratedConfigs,
	assertGeneration,
	assertStateNamespace,
	type DeploymentBounds,
	frameworkValues,
	generateWranglerConfigs,
} from './bounds'
import { runnerWorkerGraph } from './checkout'
import { type CloudflareCollaborators, defaultCloudflareCollaborators } from './collaborators'
import { configSchema } from './config-schema'
import { assertCloudflareContract, needsMinuteTick, pinsGeneratedEntry, runsInObject } from './contract-support'
import { parseSecretNames, splitManagedEnvironment, staleManagedSecrets, withSecretsFile } from './managed-secrets'
import { buildPlan, type CloudflareStep, findMigratableDatabases } from './plan'
import { createCloudflareProxyWorker, IamApplicationReference, PROXY_MANIFEST_DEFINE } from './proxy'
import type { RunnerApprovedAccess } from './runner-protocol'
import { defaultReconcileSchema } from './schema'

const CANCELLED = 'deploy cancelled'

/** Every credential the platform hands the executor. The checkout's own build step must inherit none of them. */
const PLATFORM_CREDENTIAL_NAMES: readonly string[] = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'FABRIKA_IAM_PROVISIONING_KEY']

const workerDir = (config: CloudflareAppConfig, cwd: string): string => resolve(cwd, config.pipeline?.workerDir ?? '.')

/** The KV namespace oblaka keeps deploy state in. One definition, so the check and the call cannot drift. */
// An empty CLOUDFLARE_STATE_NAMESPACE means unset, never an empty oblaka state namespace.
const stateNamespace = (config: CloudflareAppConfig, run: CloudflareDeployRun): string =>
	run.stateNamespace === undefined || run.stateNamespace === '' ? `${config.id}-state` : run.stateNamespace

const wranglerEnv = (credentials: CloudflareCredentials): Record<string, string> => ({
	CLOUDFLARE_API_TOKEN: credentials.apiToken,
	CLOUDFLARE_ACCOUNT_ID: credentials.accountId,
})

const commandError = (label: string, result: { exitCode: number; stdout: string; stderr: string }): Error => {
	const detail = (result.stderr.trim() || result.stdout.trim() || '(no output)').slice(0, 2000)
	return new Error(`${label} failed (exit ${result.exitCode}): ${detail}`)
}

const assertRunning = (signal: AbortSignal): void => {
	if (signal.aborted) {
		throw new Error(CANCELLED)
	}
}

/** The bindings the platform writes into a contract application's Worker (ADR-0065). */
const PLATFORM_BINDINGS: ReadonlySet<string> = new Set([CLOUDFLARE_APPLICATION_BINDING, CLOUDFLARE_FILES_BINDING])

/** An application never names a variable only the platform writes, whether or not this deploy writes it. */
const assertNoFrameworkVariables = (config: CloudflareAppConfig, application: Worker, run: CloudflareDeployRun): void => {
	const authored = [
		...(config.pipeline?.vars ?? []),
		...(config.pipeline?.secrets ?? []),
		...Object.keys(application.options.vars ?? {}),
		...Object.keys(application.options.bindings ?? {}),
		...Object.keys(run.vars),
		...Object.keys(run.secrets),
	]
	const reserved = authored.find((name) => isFrameworkVariableName(name) || PLATFORM_BINDINGS.has(name))
	if (reserved !== undefined) {
		throw new Error(`cloudflare: application variable \`${reserved}\` is managed by Fabrika`)
	}
	if (application.options.triggers !== undefined) {
		throw new Error(`cloudflare: application Worker \`${application.options.name}\` sets \`triggers\`; the platform writes its cron triggers`)
	}
}

/**
 * Write the managed values into the application Worker: the public ones as vars, and the credentials as Worker secrets
 * the deploy uploads with the version (`withSecretsFile`), never as plain text in a generated config.
 */
const withManagedEnvironment = (
	config: CloudflareAppConfig,
	authored: Worker,
	run: CloudflareDeployRun,
	managed: ProviderManagedEnvironment,
): { readonly worker: Worker; readonly secrets: Readonly<Record<string, string>> } => {
	const declared = new Set([...(config.pipeline?.vars ?? []), ...(config.pipeline?.secrets ?? [])])
	const application = applicationWorker(authored)
	for (const name of Object.keys(managed)) {
		if (
			declared.has(name) || application.options.vars?.[name] !== undefined || run.vars[name] !== undefined || run.secrets[name] !== undefined
		) {
			throw new Error(`cloudflare: application variable \`${name}\` is managed by Fabrika`)
		}
	}
	const { vars, secrets } = splitManagedEnvironment(managed)
	if (Object.keys(vars).length === 0) return { worker: authored, secrets }
	const configured = new Worker({
		...application.options,
		vars: {
			...(application.options.vars ?? {}),
			...vars,
		},
	})
	return { worker: replaceApplicationWorker(authored, configured), secrets }
}

/** R2's bucket names: 3 to 63 lowercase letters, digits and hyphens, starting and ending with a letter or a digit. */
const R2_BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/

/** The environment's files bucket, before oblaka's environment prefix. */
const filesBucketName = (appId: string): string => `${appId}-files`

/** The remote name oblaka gives the files bucket; it prefixes a bucket with the environment, `local` included. */
const filesBucketRemote = (run: CloudflareDeployRun): string => {
	const remote = `${run.env}-${filesBucketName(run.appId)}`
	if (!R2_BUCKET_NAME.test(remote)) {
		throw new Error(
			`cloudflare: the files bucket \`${remote}\` of \`${run.appId}@${run.env}\` is not a valid R2 bucket name; shorten the app id or the environment`,
		)
	}
	return remote
}

const MINUTE_TICK = '* * * * *'

/** What the platform gives a contract application's Worker; the deployer writes exactly this and the bounds check it. */
const applicationRuntime = (run: CloudflareDeployRun, contract: ContractArtifact, entry: string | null): ApplicationRuntime => ({
	filesBucket: filesBucketRemote(run),
	crons: needsMinuteTick(contract) ? [MINUTE_TICK] : [],
	entry,
})

/** Where `fabrika app build` runs: the application directory, beside its config and contract, and the config it reads. */
interface EntryBuild {
	readonly cwd: string
	readonly config: string
}

/** The application's own CLI, installed by the checkout's `bun install`, as the Zerops build runs it. */
const APPLICATION_CLI = ['node_modules', '.bin', 'fabrika']

const ENTRY_BUILD_ARGS = ['app', 'build', '--provider=cloudflare']

/** Regenerate the entry and the inlined migrations from the checkout, with the application's own release of the CLI. */
const buildEntry = async ({ cwd, config }: EntryBuild, run: CloudflareDeployRun, cf: CloudflareCollaborators): Promise<void> => {
	const args = [...ENTRY_BUILD_ARGS, `--config=${config}`]
	if (run.dryRun) {
		run.log(`  [dry-run] would run: fabrika ${args.join(' ')} in ${cwd}`)
		return
	}
	assertRunning(run.signal)
	// The CLI is checkout code, so it runs without the platform's credentials, like `pipeline.build`.
	const result = await cf.runCommand({
		command: resolve(cwd, ...APPLICATION_CLI),
		args,
		cwd,
		omitEnv: PLATFORM_CREDENTIAL_NAMES,
		signal: run.signal,
	})
	if (result.exitCode !== 0) throw commandError('fabrika app build', result)
}

/**
 * Bind the application's Durable Object, which runs the application over its SQLite, the environment's files bucket,
 * and the minute tick (ADR-0065). The object is bound first, so oblaka numbers its migration `v0001` whatever else the
 * application binds, and the tag never moves.
 */
const withApplicationRuntime = (authored: Worker, run: CloudflareDeployRun, runtime: ApplicationRuntime): Worker => {
	const application = applicationWorker(authored)
	const configured = new Worker({
		...application.options,
		bindings: {
			[CLOUDFLARE_APPLICATION_BINDING]: new DurableObject({ name: `${run.appId}-application`, className: CLOUDFLARE_APPLICATION_CLASS }),
			...(application.options.bindings ?? {}),
			[CLOUDFLARE_FILES_BINDING]: new R2Bucket({ name: filesBucketName(run.appId) }),
		},
		// Always written: wrangler leaves a Worker's schedules alone when `triggers` is absent, and clears them on `[]`.
		triggers: { crons: [...runtime.crons] },
	})
	return replaceApplicationWorker(authored, configured)
}

/** The proxy Worker the platform builds for application `appId`, before oblaka's environment prefix. */
const proxyWorkerName = (appId: string): string => `${appId}-proxy`

/** The remote name oblaka gives a Worker named `name` in `env`. */
const remoteName = (env: string, name: string): string => (env === 'local' ? name : `${env}-${name}`)

/**
 * Each connector import's `FABRIKA_CONNECT_<IMPORT>` service binding, to the owner's proxy Worker in the same
 * environment, by binding name; the owner's proxy enforces the export (ADR-0022), so no binding reaches its application.
 */
const connectorBindings = (contract: ContractArtifact | null): Readonly<Record<string, string>> =>
	Object.fromEntries(
		Object.entries(contract?.imports ?? {}).map(([name, imported]) => [connectVariables(name).binding, proxyWorkerName(imported.app)]),
	)

/** The application Worker's `IAM` binding, written by the deployer so that it names this deployment (ADR-0067 §3). */
const withIamIdentity = (authored: Worker, iamAppId: string): Worker => {
	const application = applicationWorker(authored)
	const declared = application.options.bindings?.['IAM']
	// A resource under the name is no IAM binding; oblaka provisions it, and the bounds check whatever it emits.
	if (declared === undefined || 'getId' in declared) return authored
	const configured = new Worker({
		...application.options,
		bindings: { ...application.options.bindings, IAM: new IamApplicationReference(iamAppId, declared) },
	})
	return replaceApplicationWorker(authored, configured)
}

const withConnectorBindings = (authored: Worker, bindings: Readonly<Record<string, string>>): Worker => {
	if (Object.keys(bindings).length === 0) return authored
	const application = applicationWorker(authored)
	const configured = new Worker({
		...application.options,
		bindings: {
			...(application.options.bindings ?? {}),
			...Object.fromEntries(Object.entries(bindings).map(([binding, worker]) => [binding, new ServiceReference(worker)])),
		},
	})
	return replaceApplicationWorker(authored, configured)
}

/** The contract a deployment serves, and the digest the application's own framework release computes for it. */
interface ServedContract {
	readonly contract: ContractArtifact
	readonly digest: string
}

/** A contract application starts only as the contract it was deployed with (ADR-0022 rule 5), so the platform writes its digest. */
const contractEnvironment = (managed: ProviderManagedEnvironment, served: ServedContract | null): ProviderManagedEnvironment => {
	if (served === null) return managed
	const { digest } = served
	const sent = managed[FABRIKA_CONTRACT_DIGEST]
	if (sent !== undefined && sent !== null && sent !== digest) {
		throw new Error(`cloudflare: ${FABRIKA_CONTRACT_DIGEST} is \`${sent}\`, but the contract this deployment serves has digest \`${digest}\``)
	}
	return { ...managed, [FABRIKA_CONTRACT_DIGEST]: digest }
}

/**
 * The lock-down follows the contract, not the config: a contract whose IAM schema does not say `contract: true`, or a
 * platform service's schema that does, would leave the proxy and IAM deciding under different rules.
 */
const assertContractSchema = (schema: AppSchema | null, contract: ContractArtifact | null): void => {
	const declared = schema?.contract === true
	if (contract === null && declared) {
		throw new Error('cloudflare: the IAM schema says `contract: true`, but the checkout has no `fabrika.contract.ts`')
	}
	if (contract !== null && !declared) {
		throw new Error('cloudflare: this deployment serves a contract, so its IAM schema is `schemaFromContract(artifact)` (`contract: true`)')
	}
}

/**
 * The proxy Worker is the platform's (ADR-0048): built here, from this package's own entrypoint, around the
 * application Worker the config returns, never taken from the checkout. A config that returns a proxy is refused.
 */
const platformProxied = (authored: Worker, served: ServedContract, run: CloudflareDeployRun): Worker => {
	if (authored.options.bindings?.['APP'] !== undefined) {
		throw new Error(
			`cloudflare: \`resources\` returns the Worker \`${authored.options.name}\` binding \`APP\`, a proxy of its own; return the application Worker, and the platform builds the proxy Worker from its contract`,
		)
	}
	const name = proxyWorkerName(run.appId)
	if (authored.options.name === name) {
		throw new Error(`cloudflare: application Worker \`${name}\` takes the name of the proxy Worker the platform builds; rename it`)
	}
	return createCloudflareProxyWorker({
		name,
		app: authored,
		appId: appEnvironmentId(run.appId, run.env),
		appHost: run.domain ?? 'localhost',
		...(run.domain === undefined ? {} : { domain: run.domain }),
		...(run.crossOrigins === undefined ? {} : { crossOrigins: run.crossOrigins }),
		endpoints: contractProxyTable(served.contract, served.digest),
		...operationsOrigin(run.managedEnvironment),
		iamUrl: run.managedEnvironment[FABRIKA_IAM_ISSUER] ?? '',
	})
}

/** The ingest origin of the application's Operations DSN: the proxy's `connect-src` admits it, as the framework's does. */
const operationsOrigin = (managed: ProviderManagedEnvironment): { readonly operationsOrigin?: string } => {
	const dsn = managed['FABRIKA_OPERATIONS_DSN']
	if (dsn === undefined || dsn === null) return {}
	let origin: string
	try {
		origin = new URL(dsn).origin
	} catch {
		origin = ''
	}
	// The DSN carries the ingest key, so the message names the variable and never its value.
	if (!isPolicyOrigin(origin, ['https:', 'http:'])) throw new Error('cloudflare: FABRIKA_OPERATIONS_DSN is not an http(s) URL with a literal host')
	return { operationsOrigin: origin }
}

const applicationWorker = (worker: Worker): Worker => {
	const child = worker.options.bindings?.['APP']
	return child instanceof Worker ? applicationWorker(child) : worker
}

const replaceApplicationWorker = (worker: Worker, replacement: Worker): Worker => {
	const child = worker.options.bindings?.['APP']
	if (!(child instanceof Worker)) return replacement
	return new Worker({
		...worker.options,
		bindings: {
			...(worker.options.bindings ?? {}),
			APP: replaceApplicationWorker(child, replacement),
		},
	})
}

const databaseOwnerDir = (worker: Worker, binding: string, rootDir: string): string => {
	const parts = binding.split('.')
	let current = worker
	for (let index = 0; index < parts.length - 1; index++) {
		const part = parts[index]
		if (part === undefined) return rootDir
		const child = current.options.bindings?.[part]
		if (!(child instanceof Worker)) return rootDir
		current = child
	}
	return resolve(rootDir, current.options.dir)
}

const migrationBinding = (binding: string): string => {
	const parts = binding.split('.')
	return parts[parts.length - 1] ?? binding
}

interface StepEnv {
	readonly config: CloudflareAppConfig
	/** The IAM schema read before the checkout's `resources()` ran (`configSchema`). */
	readonly schema: AppSchema | null
	readonly run: CloudflareDeployRun
	readonly credentials: CloudflareCredentials
	readonly worker: Worker
	readonly dir: string
	readonly cf: CloudflareCollaborators
	readonly platformResources: 'refuse' | 'allow'
	readonly platformIam: PlatformIamTarget | undefined
	readonly reconcileSchema: SchemaReconciler
	readonly bounds: DeploymentBounds
	/** The managed credentials the application Worker's version is uploaded with, as Worker secrets. */
	readonly managedSecrets: Readonly<Record<string, string>>
	/** Where the build step regenerates the entry, after `pipeline.build`; null for a release that keeps its authored `main`. */
	readonly entryBuild: EntryBuild | null
	generatedConfigs: readonly GeneratedConfig[]
}

/**
 * `wrangler deploy`, with the managed secrets uploaded in the same version when there are any, so the version never
 * serves without them, and a plain var of the same name an older release wrote goes with the old version.
 */
const wranglerDeploy = async (env: StepEnv, cwd: string, secrets: Readonly<Record<string, string>>): Promise<void> => {
	const { run, credentials, cf } = env
	const names = Object.keys(secrets)
	if (run.dryRun) {
		run.log(`  [dry-run] would run: wrangler deploy${names.length === 0 ? '' : ` with the secrets ${names.join(', ')}`} in ${cwd}`)
		return
	}
	assertRunning(run.signal)
	await withSecretsFile(secrets, async (path) => {
		const args = path === null ? ['deploy'] : ['deploy', '--secrets-file', path]
		const result = await cf.runCommand({ command: 'wrangler', args, cwd, env: wranglerEnv(credentials), signal: run.signal })
		if (result.exitCode !== 0) throw commandError('wrangler deploy', result)
	})
}

/** Delete the framework secrets the application Worker holds that this deploy no longer writes, as Zerops removes them. */
const deleteStaleSecrets = async (env: StepEnv, cwd: string): Promise<void> => {
	const { run, credentials, cf } = env
	if (run.dryRun) {
		run.log(`  [dry-run] would delete the managed secrets this deploy no longer writes in ${cwd}`)
		return
	}
	assertRunning(run.signal)
	const listed = await cf.runCommand({
		command: 'wrangler',
		args: ['secret', 'list', '--format', 'json'],
		cwd,
		env: wranglerEnv(credentials),
		signal: run.signal,
	})
	if (listed.exitCode !== 0) throw commandError('wrangler secret list', listed)
	for (const name of staleManagedSecrets(parseSecretNames(listed.stdout), env.managedSecrets)) {
		assertRunning(run.signal)
		// A piped stdin keeps wrangler non-interactive, so its confirmation takes its fallback answer.
		const result = await cf.runCommand({
			command: 'wrangler',
			args: ['secret', 'delete', name],
			cwd,
			env: wranglerEnv(credentials),
			stdin: '',
			signal: run.signal,
		})
		if (result.exitCode !== 0) throw commandError(`wrangler secret delete ${name}`, result)
		run.log(`  deleted the managed secret ${name}, which this deploy no longer writes`)
	}
}

const runStep = async (spec: CloudflareStep, env: StepEnv): Promise<void> => {
	const { config, run, credentials, worker, dir, cf } = env
	const { signal, dryRun } = run

	switch (spec.kind) {
		case 'build': {
			const build = config.pipeline?.build
			if (build !== undefined && dryRun) {
				run.log(`  [dry-run] would run build: \`${build}\` in ${dir}`)
			} else if (build !== undefined) {
				assertRunning(signal)
				const result = await cf.runCommand({ command: 'sh', args: ['-c', build], cwd: dir, omitEnv: PLATFORM_CREDENTIAL_NAMES, signal })
				if (result.exitCode !== 0) throw commandError(`build (\`${build}\`)`, result)
			}
			if (env.entryBuild !== null) await buildEntry(env.entryBuild, run, cf)
			return
		}
		case 'provision-resources': {
			assertRunning(signal)
			const result = await cf.provision({
				definition: worker,
				accountId: credentials.accountId,
				apiToken: credentials.apiToken,
				env: run.env,
				cwd: dir,
				stateNamespace: stateNamespace(config, run),
				dryRun,
			})
			env.generatedConfigs = result.wranglerConfigs
			const names = result.wranglerConfigs.map((item) => item.config.name ?? '(unnamed)').join(', ')
			run.log(dryRun ? `  [dry-run] provisioned (plan-only): ${names}` : `  provisioned: ${names}`)
			return
		}
		case 'migrate': {
			const binding = spec.id.slice('migrate:'.length)
			const database = findMigratableDatabases(worker).find((item) => item.binding === binding)
			if (database === undefined) throw new Error(`migrate: no migratable D1 database for binding \`${binding}\``)
			const commandBinding = migrationBinding(database.binding)
			const migrationDir = databaseOwnerDir(worker, database.binding, dir)
			if (dryRun) {
				run.log(`  [dry-run] would run: wrangler d1 migrations apply ${commandBinding} --remote in ${migrationDir}`)
				return
			}
			assertRunning(signal)
			const result = await cf.runCommand({
				command: 'wrangler',
				args: ['d1', 'migrations', 'apply', commandBinding, '--remote'],
				cwd: migrationDir,
				env: wranglerEnv(credentials),
				signal,
			})
			if (result.exitCode !== 0) throw commandError(`wrangler d1 migrations apply ${commandBinding}`, result)
			return
		}
		case 'deploy-worker': {
			const configs = env.generatedConfigs
			// The configs oblaka wrote, not the generation checked before the run: a stateful binding can emit differently twice.
			assertGeneratedConfigs(configs, env.bounds)
			if (configs.length === 0) {
				await wranglerDeploy(env, dir, env.managedSecrets)
				return
			}
			const application = `${run.env}-${applicationWorker(worker).options.name}`
			for (const generated of configs) {
				const generatedDir = dirname(resolve(dir, generated.path))
				// The checkout's own build step has run by now, so this is the last moment the tree is still ours to check.
				if (env.platformResources === 'refuse') await assertLiteralAssets(generated, generatedDir)
				const isApplication = generated.config.name === application
				await wranglerDeploy(env, generatedDir, isApplication ? env.managedSecrets : {})
				// A platform component's own secrets carry framework names (IAM's mail transport), so only an application's are swept.
				if (isApplication && env.platformResources === 'refuse') await deleteStaleSecrets(env, generatedDir)
			}
			return
		}
		case 'reconcile-schema': {
			const schema = env.schema
			if (schema === null) return
			const returnOrigins = run.returnOrigins !== undefined && run.returnOrigins.length > 0 ? run.returnOrigins : undefined
			if (dryRun) {
				run.log(
					env.platformResources === 'allow'
						? `  [dry-run] would reconcile the authz schema for \`${config.id}\` with IAM`
						: `  [dry-run] would report the authz schema for \`${config.id}\` to the control plane`,
				)
				if (returnOrigins !== undefined) {
					run.log(`  [dry-run] would register return origins for \`${config.id}\`: ${returnOrigins.join(', ')}`)
				}
				return
			}
			assertRunning(signal)
			// The installation deploying its own component holds IAM's provisioning key and registers the schema itself.
			if (env.platformResources === 'allow') {
				if (env.platformIam === undefined) {
					throw new Error('reconcile-schema: a platform deploy registers its schema with IAM; set FABRIKA_IAM_ISSUER and FABRIKA_IAM_PROVISIONING_KEY')
				}
				await env.reconcileSchema({
					url: env.platformIam.url,
					app: config.id,
					schema,
					...(returnOrigins === undefined ? {} : { returnOrigins }),
					adminKey: env.platformIam.adminKey,
					signal,
				})
				return
			}
			// The reconcile itself happens in the CONTROL plane, which holds IAM's admin key; this
			// container runs the checkout's own code and never sees it (ADR-0022).
			await cf.writeOutcome({ iamReconcile: { app: config.id, schemaJson: JSON.stringify(schema) } })
			return
		}
		case 'sync-secrets': {
			const secretsDir = resolve(dir, applicationWorker(worker).options.dir)
			for (const name of config.pipeline?.secrets ?? []) {
				const value = run.secrets[name]
				if (value === undefined) throw new Error(`sync-secrets: missing value for secret \`${name}\` (not in run.secrets)`)
				if (dryRun) {
					run.log(`  [dry-run] would run: wrangler secret put ${name} (value piped from run.secrets)`)
					continue
				}
				assertRunning(signal)
				const result = await cf.runCommand({
					command: 'wrangler',
					args: ['secret', 'put', name],
					cwd: secretsDir,
					env: wranglerEnv(credentials),
					stdin: value,
					signal,
				})
				if (result.exitCode !== 0) throw commandError(`wrangler secret put ${name}`, result)
			}
			return
		}
	}
}

type CloudflareCredentials = Pick<CloudflareDeployerOptions, 'accountId' | 'apiToken'>

export interface CloudflareDeployerOptions {
	readonly accountId: string
	readonly apiToken: string
	readonly collaborators?: CloudflareCollaborators
	/**
	 * `refuse` (the default) rejects a config that names one of fabrika's own resources. Only the
	 * operator deploying fabrika itself passes `allow`; a checkout is never trusted with it.
	 */
	readonly platformResources?: 'refuse' | 'allow'
	/** Where a platform deploy (`allow`) registers a component's schema. Never set for an application deploy. */
	readonly platformIam?: PlatformIamTarget
	/** Replaces the HTTP reconcile with IAM (tests). */
	readonly reconcileSchema?: SchemaReconciler
}

/** IAM's origin and the installation's provisioning key, as the installation's own deploy holds them. */
export interface PlatformIamTarget {
	readonly url: string
	readonly adminKey: string
}

export interface CloudflareDeployRun {
	readonly appId: string
	readonly env: string
	readonly domain?: string
	/** The environment's cross-origin list from Control's registry (ADR-0022); the proxy Worker's manifest entry lists it. */
	readonly crossOrigins?: readonly string[]
	/** Every origin IAM may hand this environment a session at, registered under `<app>@<env>`. */
	readonly returnOrigins?: readonly string[]
	readonly cwd: string
	readonly configPath: string
	readonly stateNamespace?: string
	readonly secrets: Readonly<Record<string, string>>
	readonly vars: Readonly<Record<string, string>>
	/** Platform-owned runtime configuration, separate from operator-managed application vars. */
	readonly managedEnvironment: ProviderManagedEnvironment
	/**
	 * The contract Control approved for this run (ADR-0050), with the digest the application's release computes. Absent
	 * outside Control (a local deploy), the deployer reads `fabrika.contract.ts` from the checkout, as Control does.
	 */
	readonly approved?: RunnerApprovedAccess
	/** Every Cloudflare deployment of the installation in Control's registry; a name of another application is refused. */
	readonly installationApps?: readonly AppEnvironment[]
	readonly dryRun: boolean
	readonly signal: AbortSignal
	readonly log: (line: string) => void
}

export interface CloudflareDeployResult {
	readonly appId: string
	readonly env: string
	readonly status: 'succeeded' | 'failed'
	readonly steps: readonly DeployStepResult[]
}

const servedContract = async (
	cf: CloudflareCollaborators,
	cwd: string,
	approved: RunnerApprovedAccess | undefined,
): Promise<ServedContract | null> => {
	if (approved !== undefined) return { contract: approved.contract, digest: approved.contractDigest }
	const read = await cf.readContract(cwd)
	return read === null ? null : { contract: read, digest: contractDigest(read) }
}

export const createCloudflareDeployer = (options: CloudflareDeployerOptions) => async (run: CloudflareDeployRun): Promise<CloudflareDeployResult> => {
	const cf = options.collaborators ?? defaultCloudflareCollaborators
	const loaded = await cf.loadConfig(run.cwd, run.configPath)
	if (loaded.config.id !== run.appId) {
		throw new Error(`Cloudflare config declares app "${loaded.config.id}", expected "${run.appId}"`)
	}
	const platformResources = options.platformResources ?? 'refuse'
	const served = await servedContract(cf, loaded.cwd, run.approved)
	const contract = served?.contract ?? null
	// Fabrika's own components (`allow`) are its trusted installation path; an application needs a contract.
	if (platformResources === 'refuse' && served === null) {
		throw new Error('cloudflare: the checkout has no `fabrika.contract.ts`; Fabrika deploys an application only with a contract')
	}
	if (platformResources === 'refuse' && contract !== null) assertCloudflareContract(contract)
	// Read once, before `resources()` runs the checkout's code again: nothing below reads the config's schema.
	const schema = configSchema(loaded.config)
	assertContractSchema(schema, contract)
	const authored = runnerWorkerGraph(loaded.config.resources({ env: run.env, domain: run.domain }))
	// Fabrika's own components compose their own proxies; every application gets the platform's.
	const proxied = platformResources === 'refuse' && served !== null ? platformProxied(authored, served, run) : authored
	if (platformResources === 'refuse') assertNoFrameworkVariables(loaded.config, applicationWorker(proxied), run)
	const connectors = platformResources === 'refuse' ? connectorBindings(contract) : {}
	// An older release's entry exports no object, and a Control older than the runner names no release (ADR-0062).
	const objectRuntime = run.approved === undefined || (run.approved.framework !== undefined && runsInObject(run.approved.framework))
	// Only a release Control named pins the entry; a local deploy names none and keeps its authored `main`.
	const release = run.approved?.framework
	const entry = release !== undefined && pinsGeneratedEntry(release) ? resolve(loaded.cwd, GENERATED_ENTRY_FILE) : null
	const runtime = platformResources === 'refuse' && contract !== null && objectRuntime ? applicationRuntime(run, contract, entry) : null
	const managed = withManagedEnvironment(loaded.config, proxied, run, contractEnvironment(run.managedEnvironment, served))
	const identified = platformResources === 'refuse' ? withIamIdentity(managed.worker, appEnvironmentId(run.appId, run.env)) : managed.worker
	const connected = withConnectorBindings(identified, connectors)
	const worker = runtime === null ? connected : withApplicationRuntime(connected, run, runtime)
	const dir = workerDir(loaded.config, loaded.cwd)
	const bounds: DeploymentBounds = {
		env: run.env,
		...(run.domain === undefined ? {} : { domain: run.domain }),
		cwd: dir,
		platformResources,
		iamAppId: appEnvironmentId(run.appId, run.env),
		installation: run.installationApps ?? [],
		proxy: proxied === authored ? null : `${run.env}-${run.appId}-proxy`,
		connectors: Object.fromEntries(Object.entries(connectors).map(([binding, owner]) => [binding, remoteName(run.env, owner)])),
		frameworkVariables: {
			application: frameworkValues(applicationWorker(worker).options.vars),
			proxy: proxied === authored ? null : frameworkValues(worker.options.vars),
		},
		proxyManifest: proxied === authored ? null : (worker.options.define?.[PROXY_MANIFEST_DEFINE] ?? null),
		application: runtime,
	}
	assertStateNamespace(stateNamespace(loaded.config, run), platformResources)
	assertGeneration(await generateWranglerConfigs(worker, run.env), bounds)
	const env: StepEnv = {
		config: loaded.config,
		schema,
		run,
		credentials: { accountId: options.accountId, apiToken: options.apiToken },
		worker,
		dir,
		cf,
		platformResources,
		platformIam: options.platformIam,
		reconcileSchema: options.reconcileSchema ?? defaultReconcileSchema,
		bounds,
		managedSecrets: managed.secrets,
		entryBuild: runtime !== null && runtime.entry !== null ? { cwd: loaded.cwd, config: basename(resolve(run.cwd, run.configPath)) } : null,
		generatedConfigs: [],
	}
	const result = await runSteps(buildPlan(loaded.config, worker, env.entryBuild !== null), run, (step) => runStep(step, env))
	return { appId: run.appId, env: run.env, ...result }
}
