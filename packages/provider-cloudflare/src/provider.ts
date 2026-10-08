import {
	type AppEnvironment,
	appEnvironmentId,
	type ContractArtifact,
	contractDigest,
	FABRIKA_CONTRACT_DIGEST,
	FABRIKA_IAM_ISSUER,
} from '@fabrika/auth-core'
import { type DeployStepResult, type ProviderManagedEnvironment, runSteps } from '@fabrika/provider-contract'
import { contractProxyTable } from '@fabrika/proxy-core/manifest'
import { dirname, resolve } from 'node:path'
import { type GeneratedConfig, Worker } from 'oblaka-iac'
import { assertLiteralAssets } from './assets'
import type { CloudflareAppConfig } from './authoring'
import { type CloudflareCollaborators, defaultCloudflareCollaborators } from './collaborators'
import {
	type ApplicationNames,
	applicationNames,
	assertApplicationServices,
	assertAuthoredGraph,
	buildPlan,
	type CloudflareStep,
	findMigratableDatabases,
} from './plan'
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
const assertContractSchema = (config: CloudflareAppConfig, contract: ContractArtifact | null): void => {
	const declared = config.schema?.contract === true
	if (contract === null && declared) {
		throw new Error('cloudflare: the IAM schema says `contract: true`, but the checkout has no `fabrika.contract.ts`')
	}
	if (contract !== null && !declared) {
		throw new Error('cloudflare: this deployment serves a contract, so its IAM schema is `schemaFromContract(artifact)` (`contract: true`)')
	}
}

/**
 * A contract application's proxy Worker is the platform's (ADR-0048): built here from the contract's endpoint table,
 * around the application Worker the config returns. A config that returns a proxy of its own is refused.
 */
const contractProxyWorker = (authored: Worker, contract: ContractArtifact, run: CloudflareDeployRun): Worker => {
	if (authored.options.bindings?.['APP'] instanceof Worker) {
		throw new Error(
			`cloudflare: \`resources\` returns the proxy Worker \`${authored.options.name}\`; a contract application returns its application Worker, and the platform builds the proxy Worker from the contract`,
		)
	}
	const name = `${run.appId}-proxy`
	if (authored.options.name === name) {
		throw new Error(`cloudflare: application Worker \`${name}\` takes the name of the proxy Worker the platform builds; rename it`)
	}
	return createCloudflareProxyWorker({
		name,
		app: authored,
		appId: appEnvironmentId(run.appId, run.env),
		appHost: run.domain ?? 'localhost',
		...(run.domain === undefined ? {} : { domain: run.domain }),
		endpoints: contractProxyTable(contract),
		iamUrl: run.managedEnvironment[FABRIKA_IAM_ISSUER] ?? '',
	})
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
	readonly run: CloudflareDeployRun
	readonly credentials: CloudflareCredentials
	readonly worker: Worker
	readonly dir: string
	readonly cf: CloudflareCollaborators
	readonly platformResources: 'refuse' | 'allow'
	readonly names: ApplicationNames
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
			// The checkout's own build step has run by now, so this is the last moment the tree is still ours to check.
			const assertAssets = async (configDir: string): Promise<void> => {
				if (env.platformResources === 'refuse') await assertLiteralAssets(worker, dir, configDir)
			}
			if (configs.length === 0) {
				await assertAssets(dir)
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
				await assertAssets(generatedDir)
				// The config oblaka wrote, not the graph checked before the run: a stateful binding can emit differently twice.
				if (env.platformResources === 'refuse') {
					assertApplicationServices(generated.config.name ?? generated.path, generated.config.services, env.names)
				}
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
			if (config.schema === undefined) return
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
			await cf.writeOutcome({ iamReconcile: { app: config.id, schemaJson: JSON.stringify(config.schema) } })
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
	 * The contract this deployment serves, once Control sends the run's approved snapshot (ADR-0050). Without it the
	 * deployer reads `fabrika.contract.ts` from the checkout, statically, as Control does at the commit.
	 */
	readonly contract?: ContractArtifact
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

export const createCloudflareDeployer = (options: CloudflareDeployerOptions) => async (run: CloudflareDeployRun): Promise<CloudflareDeployResult> => {
	const cf = options.collaborators ?? defaultCloudflareCollaborators
	const loaded = await cf.loadConfig(run.cwd, run.configPath)
	if (loaded.config.id !== run.appId) {
		throw new Error(`Cloudflare config declares app "${loaded.config.id}", expected "${run.appId}"`)
	}
	const contract = run.contract ?? (await cf.readContract(loaded.cwd))
	assertContractSchema(loaded.config, contract)
	const authored = loaded.config.resources({ env: run.env, domain: run.domain })
	const worker = withManagedEnvironment(
		loaded.config,
		contract === null ? authored : contractProxyWorker(authored, contract, run),
		run,
		contractEnvironment(run.managedEnvironment, contract),
	)
	const platformResources = options.platformResources ?? 'refuse'
	const limits = {
		env: run.env,
		...(run.domain === undefined ? {} : { domain: run.domain }),
		stateNamespace: stateNamespace(loaded.config, run),
		platformResources,
		iamAppId: appEnvironmentId(run.appId, run.env),
		contract: contract !== null,
		installation: run.installationApps ?? [],
	}
	assertAuthoredGraph(worker, limits)
	const env: StepEnv = {
		config: loaded.config,
		run,
		credentials: { accountId: options.accountId, apiToken: options.apiToken },
		worker,
		dir: workerDir(loaded.config, loaded.cwd),
		cf,
		platformResources,
		names: applicationNames(limits),
		generatedConfigs: [],
	}
	const result = await runSteps(buildPlan(loaded.config, worker), run, (step) => runStep(step, env))
	return { appId: run.appId, env: run.env, ...result }
}
