import type { AppGates } from '@fabrika/auth'
import {
	type AppEnvironment,
	appEnvironmentId,
	type ArtifactAccess,
	artifactAccessDigest,
	connectVariables,
	type ContractArtifact,
	contractDigest,
	FABRIKA_CONTRACT_DIGEST,
	FABRIKA_IAM_ISSUER,
	isFrameworkVariableName,
} from '@fabrika/auth-core'
import { type DeployStepResult, type ProviderManagedEnvironment, runSteps } from '@fabrika/provider-contract'
import { isPolicyOrigin } from '@fabrika/proxy-core/headers'
import { contractProxyTable } from '@fabrika/proxy-core/manifest'
import { dirname, resolve } from 'node:path'
import { type GeneratedConfig, ServiceReference, Worker } from 'oblaka-iac'
import { configArtifactAccess } from './artifact-access'
import { assertLiteralAssets } from './assets'
import type { CloudflareAppConfig } from './authoring'
import {
	assertGeneratedConfigs,
	assertGeneration,
	assertStateNamespace,
	type DeploymentBounds,
	frameworkValues,
	generateWranglerConfigs,
} from './bounds'
import { runnerWorkerGraph } from './checkout'
import { type CloudflareCollaborators, defaultCloudflareCollaborators } from './collaborators'
import { buildPlan, type CloudflareStep, findMigratableDatabases } from './plan'
import { createCloudflareProxyWorker } from './proxy'

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

/** An application never names a variable only the platform writes, whether or not this deploy writes it. */
const assertNoFrameworkVariables = (config: CloudflareAppConfig, application: Worker, run: CloudflareDeployRun): void => {
	const authored = [
		...(config.pipeline?.vars ?? []),
		...Object.keys(application.options.vars ?? {}),
		...Object.keys(application.options.bindings ?? {}),
		...Object.keys(run.vars),
	]
	const reserved = authored.find(isFrameworkVariableName)
	if (reserved !== undefined) {
		throw new Error(`cloudflare: application variable \`${reserved}\` is managed by Fabrika`)
	}
}

const withManagedEnvironment = (
	config: CloudflareAppConfig,
	authored: Worker,
	run: CloudflareDeployRun,
	managed: ProviderManagedEnvironment,
): Worker => {
	const present: Record<string, string> = {}
	const declared = new Set(config.pipeline?.vars ?? [])
	const application = applicationWorker(authored)
	for (const [name, value] of Object.entries(managed)) {
		if (declared.has(name) || application.options.vars?.[name] !== undefined || run.vars[name] !== undefined) {
			throw new Error(`cloudflare: application variable \`${name}\` is managed by Fabrika`)
		}
		if (value !== null) present[name] = value
	}
	if (Object.keys(present).length === 0) return authored
	const configured = new Worker({
		...application.options,
		vars: {
			...(application.options.vars ?? {}),
			...present,
		},
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

/** A contract application starts only as the contract it was deployed with (ADR-0022 rule 5), so the platform writes its digest. */
const contractEnvironment = (managed: ProviderManagedEnvironment, contract: ContractArtifact | null): ProviderManagedEnvironment => {
	if (contract === null) return managed
	const digest = contractDigest(contract)
	const sent = managed[FABRIKA_CONTRACT_DIGEST]
	if (sent !== undefined && sent !== null && sent !== digest) {
		throw new Error(`cloudflare: ${FABRIKA_CONTRACT_DIGEST} is \`${sent}\`, but the contract this deployment serves has digest \`${digest}\``)
	}
	return { ...managed, [FABRIKA_CONTRACT_DIGEST]: digest }
}

/**
 * The lock-down follows the contract, not the config: `contract: true` in the IAM schema without a contract, or a
 * contract whose schema does not say so, would leave the proxy and IAM deciding under different rules.
 */
const assertContractSchema = (access: ArtifactAccess, contract: ContractArtifact | null): void => {
	const declared = access.schema?.contract === true
	if (contract === null && declared) {
		throw new Error('cloudflare: the IAM schema says `contract: true`, but the checkout has no `fabrika.contract.ts`')
	}
	if (contract !== null && !declared) {
		throw new Error('cloudflare: this deployment serves a contract, so its IAM schema is `schemaFromContract(artifact)` (`contract: true`)')
	}
	if (contract !== null && access.gates !== null) {
		throw new Error('cloudflare: a contract application is protected by its endpoint table; remove `gates` from the config')
	}
}

/** What the platform-built proxy enforces: the contract's endpoint table, or the gates of the captured access. */
const proxyProtection = (
	access: ArtifactAccess,
	contract: ContractArtifact | null,
): { readonly endpoints: ReturnType<typeof contractProxyTable> } | { readonly gates: AppGates } | null => {
	if (contract !== null) return { endpoints: contractProxyTable(contract) }
	return access.gates === null ? null : { gates: access.gates }
}

/**
 * The proxy Worker is the platform's (ADR-0048): built here, from this package's own entrypoint, around the
 * application Worker the config returns, never taken from the checkout. A config that returns a proxy is refused.
 */
const platformProxied = (authored: Worker, access: ArtifactAccess, contract: ContractArtifact | null, run: CloudflareDeployRun): Worker => {
	if (authored.options.bindings?.['APP'] !== undefined) {
		throw new Error(
			`cloudflare: \`resources\` returns the Worker \`${authored.options.name}\` binding \`APP\`, a proxy of its own; return the application Worker and declare \`gates\` (or a contract), and the platform builds the proxy Worker`,
		)
	}
	const protection = proxyProtection(access, contract)
	if (protection === null) return authored
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
		...protection,
		...('endpoints' in protection ? operationsOrigin(run.managedEnvironment) : {}),
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
	/** The gates and IAM schema read before the checkout's `resources()` ran (`configArtifactAccess`). */
	readonly access: ArtifactAccess
	readonly run: CloudflareDeployRun
	readonly credentials: CloudflareCredentials
	readonly worker: Worker
	readonly dir: string
	readonly cf: CloudflareCollaborators
	readonly platformResources: 'refuse' | 'allow'
	readonly bounds: DeploymentBounds
	generatedConfigs: readonly GeneratedConfig[]
}

const runStep = async (spec: CloudflareStep, env: StepEnv): Promise<void> => {
	const { config, run, credentials, worker, dir, cf } = env
	const { signal, dryRun } = run

	switch (spec.kind) {
		case 'build': {
			const build = config.pipeline?.build
			if (build === undefined) return
			if (dryRun) {
				run.log(`  [dry-run] would run build: \`${build}\` in ${dir}`)
				return
			}
			assertRunning(signal)
			const result = await cf.runCommand({ command: 'sh', args: ['-c', build], cwd: dir, omitEnv: PLATFORM_CREDENTIAL_NAMES, signal })
			if (result.exitCode !== 0) throw commandError(`build (\`${build}\`)`, result)
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
				if (dryRun) {
					run.log(`  [dry-run] would run: wrangler deploy in ${dir}`)
					return
				}
				assertRunning(signal)
				const result = await cf.runCommand({ command: 'wrangler', args: ['deploy'], cwd: dir, env: wranglerEnv(credentials), signal })
				if (result.exitCode !== 0) throw commandError('wrangler deploy', result)
				return
			}
			for (const generated of configs) {
				const generatedDir = dirname(resolve(dir, generated.path))
				// The checkout's own build step has run by now, so this is the last moment the tree is still ours to check.
				if (env.platformResources === 'refuse') await assertLiteralAssets(generated, generatedDir)
				if (dryRun) {
					run.log(`  [dry-run] would run: wrangler deploy in ${generatedDir}`)
					continue
				}
				assertRunning(signal)
				const result = await cf.runCommand({ command: 'wrangler', args: ['deploy'], cwd: generatedDir, env: wranglerEnv(credentials), signal })
				if (result.exitCode !== 0) throw commandError('wrangler deploy', result)
			}
			return
		}
		case 'reconcile-schema': {
			const schema = env.access.schema
			if (schema === null) return
			const returnOrigins = run.returnOrigins !== undefined && run.returnOrigins.length > 0 ? run.returnOrigins : undefined
			if (dryRun) {
				run.log(`  [dry-run] would report the authz schema for \`${config.id}\` to the control plane`)
				if (returnOrigins !== undefined) {
					run.log(`  [dry-run] would register return origins for \`${config.id}\`: ${returnOrigins.join(', ')}`)
				}
				return
			}
			assertRunning(signal)
			// The reconcile itself happens in the CONTROL plane, which holds IAM's admin key; this
			// container runs the checkout's own code and never sees it (ADR-0022).
			if (run.artifactApproval === undefined) await cf.writeOutcome({ iamReconcile: { app: config.id, schemaJson: JSON.stringify(schema) } })
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
}

export interface CloudflareDeployRun {
	readonly appId: string
	readonly env: string
	readonly domain?: string
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
	 * The contract Control approved for this run (ADR-0050), or null when Control read none at the commit. Absent
	 * outside Control (a local deploy), the deployer reads `fabrika.contract.ts` from the checkout, as Control does.
	 */
	readonly contract?: ContractArtifact | null
	/**
	 * Without a contract, the artifact access Control approved (ADR-0050). On a protected environment a config whose gates
	 * and IAM schema hash to anything else stops before provisioning and reports them (`pending`); otherwise the deploy
	 * reports what it applied (`deployed`). Absent outside Control.
	 */
	readonly artifactApproval?: { readonly digest: string | null; readonly protected: boolean }
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
	approved: ContractArtifact | null | undefined,
): Promise<ContractArtifact | null> => {
	if (approved === undefined) return cf.readContract(cwd)
	if (approved === null && (await cf.readContract(cwd)) !== null) {
		throw new Error('cloudflare: the checkout has a `fabrika.contract.ts`, but the commit Control read has none')
	}
	return approved
}

export const createCloudflareDeployer = (options: CloudflareDeployerOptions) => async (run: CloudflareDeployRun): Promise<CloudflareDeployResult> => {
	const cf = options.collaborators ?? defaultCloudflareCollaborators
	const loaded = await cf.loadConfig(run.cwd, run.configPath)
	if (loaded.config.id !== run.appId) {
		throw new Error(`Cloudflare config declares app "${loaded.config.id}", expected "${run.appId}"`)
	}
	const platformResources = options.platformResources ?? 'refuse'
	const contract = await servedContract(cf, loaded.cwd, run.contract)
	// Read once, before `resources()` runs the checkout's code again: nothing below reads the config's gates or schema.
	const access = configArtifactAccess(loaded.config)
	assertContractSchema(access, contract)
	const approval = contract === null ? run.artifactApproval : undefined
	if (approval?.protected === true && !run.dryRun && artifactAccessDigest(access) !== approval.digest) {
		await cf.writeOutcome({ artifactAccess: { state: 'pending', accessJson: JSON.stringify(access) } })
		throw new Error("cloudflare: the config's gates and IAM schema are not the access Control approved; the run waits for a human with access.approve")
	}
	const authored = runnerWorkerGraph(loaded.config.resources({ env: run.env, domain: run.domain }))
	// Fabrika's own components compose their own proxies; every application gets the platform's.
	const served = platformResources === 'refuse' ? platformProxied(authored, access, contract, run) : authored
	if (platformResources === 'refuse') assertNoFrameworkVariables(loaded.config, applicationWorker(served), run)
	const connectors = platformResources === 'refuse' ? connectorBindings(contract) : {}
	const worker = withConnectorBindings(
		withManagedEnvironment(loaded.config, served, run, contractEnvironment(run.managedEnvironment, contract)),
		connectors,
	)
	const dir = workerDir(loaded.config, loaded.cwd)
	const bounds: DeploymentBounds = {
		env: run.env,
		...(run.domain === undefined ? {} : { domain: run.domain }),
		cwd: dir,
		platformResources,
		iamAppId: appEnvironmentId(run.appId, run.env),
		installation: run.installationApps ?? [],
		proxy: served === authored ? null : `${run.env}-${run.appId}-proxy`,
		connectors: Object.fromEntries(Object.entries(connectors).map(([binding, owner]) => [binding, remoteName(run.env, owner)])),
		frameworkVariables: {
			application: frameworkValues(applicationWorker(worker).options.vars),
			proxy: served === authored ? null : frameworkValues(worker.options.vars),
		},
	}
	assertStateNamespace(stateNamespace(loaded.config, run), platformResources)
	assertGeneration(await generateWranglerConfigs(worker, run.env), bounds)
	const env: StepEnv = {
		config: loaded.config,
		access,
		run,
		credentials: { accountId: options.accountId, apiToken: options.apiToken },
		worker,
		dir,
		cf,
		platformResources,
		bounds,
		generatedConfigs: [],
	}
	const result = await runSteps(buildPlan(loaded.config, worker), run, (step) => runStep(step, env))
	// Control applies this access's IAM schema and records it; the reconcile-schema step reports nothing for it.
	if (approval !== undefined && !run.dryRun && result.status === 'succeeded') {
		await cf.writeOutcome({ artifactAccess: { state: 'deployed', accessJson: JSON.stringify(access) } })
	}
	return { appId: run.appId, env: run.env, ...result }
}
