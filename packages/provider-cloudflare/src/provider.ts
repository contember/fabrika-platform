import { createProvider, type ProviderDeploySession, type TypedProviderRun } from '@fabrika/provider-contract'
import { resolve } from 'node:path'
import { Worker } from 'oblaka-iac'
import type { CloudflareAppConfig } from './authoring'
import { type CloudflareArtifact, cloudflareArtifactCodec, type CloudflareTarget, cloudflareTargetCodec } from './codec'
import { type CloudflareCollaborators, defaultCloudflareCollaborators } from './collaborators'
import { buildPlan, type CloudflareJobSpec, findMigratableDatabases } from './plan'

const CANCELLED = 'deploy cancelled'

const workerDir = (config: CloudflareAppConfig, cwd: string): string => resolve(cwd, config.pipeline?.workerDir ?? '.')

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
	for (const [name, value] of Object.entries(managed)) {
		if (declared.has(name) || authored.options.vars?.[name] !== undefined || run.vars[name] !== undefined) {
			throw new Error(`cloudflare: application variable \`${name}\` is managed by Fabrika`)
		}
		if (value !== null) present[name] = value
	}
	if (Object.keys(present).length === 0) return authored
	return new Worker({
		...authored.options,
		vars: {
			...(authored.options.vars ?? {}),
			...present,
		},
	})
}

interface StepEnv {
	readonly config: CloudflareAppConfig
	readonly run: CloudflareRun
	readonly worker: Worker
	readonly dir: string
	readonly cf: CloudflareCollaborators
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
			const result = await cf.runCommand({ command: 'sh', args: ['-c', build], cwd: dir, signal })
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
				stateNamespace: target.stateNamespace ?? `${config.id}-state`,
				dryRun,
			})
			const names = result.wranglerConfigs.map((item) => item.config.name ?? '(unnamed)').join(', ')
			run.events.log(dryRun ? `  [dry-run] provisioned (plan-only): ${names}` : `  provisioned: ${names}`)
			return
		}
		case 'migrate': {
			const binding = spec.id.slice('migrate:'.length)
			const database = findMigratableDatabases(worker).find((item) => item.binding === binding)
			if (database === undefined) throw new Error(`migrate: no migratable D1 database for binding \`${binding}\``)
			if (dryRun) {
				run.events.log(`  [dry-run] would run: wrangler d1 migrations apply ${database.binding} --remote`)
				return
			}
			assertRunning(signal)
			const result = await cf.runCommand({
				command: 'wrangler',
				args: ['d1', 'migrations', 'apply', database.binding, '--remote'],
				cwd: dir,
				env: wranglerEnv(target),
				signal,
			})
			if (result.exitCode !== 0) throw commandError(`wrangler d1 migrations apply ${database.binding}`, result)
			return
		}
		case 'deploy-worker': {
			if (dryRun) {
				run.events.log(`  [dry-run] would run: wrangler deploy in ${dir}`)
				return
			}
			assertRunning(signal)
			const result = await cf.runCommand({ command: 'wrangler', args: ['deploy'], cwd: dir, env: wranglerEnv(target), signal })
			if (result.exitCode !== 0) throw commandError('wrangler deploy', result)
			return
		}
		case 'reconcile-schema': {
			if (config.schema === undefined || target.propustkaUrl === undefined) return
			if (dryRun) {
				run.events.log(`  [dry-run] would reconcile schema for \`${config.id}\` against ${target.propustkaUrl}`)
				return
			}
			assertRunning(signal)
			await cf.reconcileSchema({
				url: target.propustkaUrl,
				app: config.id,
				schema: config.schema,
				adminKey: target.adminKey,
			})
			return
		}
		case 'sync-secrets': {
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
					cwd: dir,
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

export const createCloudflareProvider = (cf: CloudflareCollaborators = defaultCloudflareCollaborators) =>
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
			const dir = workerDir(loaded.config, loaded.cwd)
			const plan = buildPlan(loaded.config, { appId: run.appId, env: run.env, propustkaUrl: run.target.propustkaUrl }, worker)
			const byId = new Map(plan.steps.map((step): [string, CloudflareJobSpec] => [step.id, step]))
			const env: StepEnv = { config: loaded.config, run, worker, dir, cf }
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
