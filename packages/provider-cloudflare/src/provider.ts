import { createProvider, type ProviderDeploySession, type TypedProviderRun } from '@fabrika/provider-contract'
import { dirname, resolve } from 'node:path'
import { type GeneratedConfig, Worker } from 'oblaka-iac'
import { assertLiteralAssets } from './assets'
import type { CloudflareAppConfig } from './authoring'
import { type CloudflareArtifact, cloudflareArtifactCodec, type CloudflareTarget, cloudflareTargetCodec } from './codec'
import { type CloudflareCollaborators, defaultCloudflareCollaborators } from './collaborators'
import { assertAuthoredGraph, buildPlan, type CloudflareJobSpec, findMigratableDatabases } from './plan'

const CANCELLED = 'deploy cancelled'

/** Every credential the platform hands the executor. The checkout's own build step must inherit none of them. */
const PLATFORM_CREDENTIAL_NAMES: readonly string[] = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'FABRIKA_IAM_PROVISIONING_KEY']

const workerDir = (config: CloudflareAppConfig, cwd: string): string => resolve(cwd, config.pipeline?.workerDir ?? '.')

/** The KV namespace oblaka keeps deploy state in. One definition, so the check and the call cannot drift. */
const stateNamespace = (config: CloudflareAppConfig, target: CloudflareTarget): string => target.stateNamespace ?? `${config.id}-state`

const wranglerEnv = (target: CloudflareTarget): Record<string, string> => ({
	CLOUDFLARE_API_TOKEN: target.apiToken,
	CLOUDFLARE_ACCOUNT_ID: target.accountId,
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

type CloudflareRun = TypedProviderRun<CloudflareTarget, CloudflareArtifact>

const withManagedEnvironment = (config: CloudflareAppConfig, authored: Worker, run: CloudflareRun): Worker => {
	const managed = run.managedEnvironment
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
	readonly run: CloudflareRun
	readonly worker: Worker
	readonly dir: string
	readonly cf: CloudflareCollaborators
	readonly platformResources: 'refuse' | 'allow'
	generatedConfigs: readonly GeneratedConfig[]
}

const runStep = async (spec: CloudflareJobSpec, env: StepEnv): Promise<void> => {
	const { config, run, worker, dir, cf } = env
	const { target, signal, dryRun } = run

	switch (spec.kind) {
		case 'build': {
			const build = config.pipeline?.build
			if (build === undefined) return
			if (dryRun) {
				run.events.log(`  [dry-run] would run build: \`${build}\` in ${dir}`)
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
				accountId: target.accountId,
				apiToken: target.apiToken,
				env: run.env,
				cwd: dir,
				stateNamespace: stateNamespace(config, target),
				dryRun,
			})
			env.generatedConfigs = result.wranglerConfigs
			const names = result.wranglerConfigs.map((item) => item.config.name ?? '(unnamed)').join(', ')
			run.events.log(dryRun ? `  [dry-run] provisioned (plan-only): ${names}` : `  provisioned: ${names}`)
			return
		}
		case 'migrate': {
			const binding = spec.id.slice('migrate:'.length)
			const database = findMigratableDatabases(worker).find((item) => item.binding === binding)
			if (database === undefined) throw new Error(`migrate: no migratable D1 database for binding \`${binding}\``)
			const commandBinding = migrationBinding(database.binding)
			const migrationDir = databaseOwnerDir(worker, database.binding, dir)
			if (dryRun) {
				run.events.log(`  [dry-run] would run: wrangler d1 migrations apply ${commandBinding} --remote in ${migrationDir}`)
				return
			}
			assertRunning(signal)
			const result = await cf.runCommand({
				command: 'wrangler',
				args: ['d1', 'migrations', 'apply', commandBinding, '--remote'],
				cwd: migrationDir,
				env: wranglerEnv(target),
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
					run.events.log(`  [dry-run] would run: wrangler deploy in ${dir}`)
					return
				}
				assertRunning(signal)
				const result = await cf.runCommand({ command: 'wrangler', args: ['deploy'], cwd: dir, env: wranglerEnv(target), signal })
				if (result.exitCode !== 0) throw commandError('wrangler deploy', result)
				return
			}
			for (const generated of configs) {
				const generatedDir = dirname(resolve(dir, generated.path))
				await assertAssets(generatedDir)
				if (dryRun) {
					run.events.log(`  [dry-run] would run: wrangler deploy in ${generatedDir}`)
					continue
				}
				assertRunning(signal)
				const result = await cf.runCommand({ command: 'wrangler', args: ['deploy'], cwd: generatedDir, env: wranglerEnv(target), signal })
				if (result.exitCode !== 0) throw commandError('wrangler deploy', result)
			}
			return
		}
		case 'reconcile-schema': {
			if (config.schema === undefined) return
			const returnOrigins = run.returnOrigins !== undefined && run.returnOrigins.length > 0 ? run.returnOrigins : undefined
			if (dryRun) {
				run.events.log(`  [dry-run] would report the authz schema for \`${config.id}\` to the control plane`)
				if (returnOrigins !== undefined) {
					run.events.log(`  [dry-run] would register return origins for \`${config.id}\`: ${returnOrigins.join(', ')}`)
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
					run.events.log(`  [dry-run] would run: wrangler secret put ${name} (value piped from run.secrets)`)
					continue
				}
				assertRunning(signal)
				const result = await cf.runCommand({
					command: 'wrangler',
					args: ['secret', 'put', name],
					cwd: secretsDir,
					env: wranglerEnv(target),
					stdin: value,
					signal,
				})
				if (result.exitCode !== 0) throw commandError(`wrangler secret put ${name}`, result)
			}
			return
		}
	}
}

export interface CloudflareProviderOptions {
	/**
	 * `refuse` (the default) rejects a config that names one of fabrika's own resources. Only the
	 * operator deploying fabrika itself passes `allow`; a checkout is never trusted with it.
	 */
	readonly platformResources?: 'refuse' | 'allow'
}

export const createCloudflareProvider = (
	cf: CloudflareCollaborators = defaultCloudflareCollaborators,
	options: CloudflareProviderOptions = {},
) =>
	createProvider({
		id: 'cloudflare',
		target: cloudflareTargetCodec,
		artifact: cloudflareArtifactCodec,
		open: async (run): Promise<ProviderDeploySession> => {
			const loaded = await cf.loadConfig(run.cwd, run.artifact.configPath)
			if (loaded.config.id !== run.appId) {
				throw new Error(`Cloudflare config declares app "${loaded.config.id}", expected "${run.appId}"`)
			}
			const worker = withManagedEnvironment(
				loaded.config,
				loaded.config.resources({ env: run.env, domain: run.domain }),
				run,
			)
			const platformResources = options.platformResources ?? 'refuse'
			assertAuthoredGraph(worker, {
				env: run.env,
				...(run.domain === undefined ? {} : { domain: run.domain }),
				stateNamespace: stateNamespace(loaded.config, run.target),
				platformResources,
			})
			const dir = workerDir(loaded.config, loaded.cwd)
			const plan = buildPlan(loaded.config, { appId: run.appId, env: run.env }, worker)
			const byId = new Map(plan.steps.map((step): [string, CloudflareJobSpec] => [step.id, step]))
			const env: StepEnv = { config: loaded.config, run, worker, dir, cf, platformResources, generatedConfigs: [] }
			return {
				plan,
				execute: async (stepId): Promise<void> => {
					const spec = byId.get(stepId)
					if (spec === undefined) throw new Error(`cloudflare: no step \`${stepId}\` in this plan`)
					await runStep(spec, env)
				},
			}
		},
	})

export const cloudflareProvider = createCloudflareProvider()
