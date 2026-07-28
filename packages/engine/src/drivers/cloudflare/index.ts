// The Cloudflare `DeployDriver`: it owns Cloudflare's plan (`./plan.ts`) AND the execution of every
// kind in it. Everything Cloudflare-specific that the orchestrator used to know — the oblaka resource
// graph, `pipeline.workerDir`, the `wrangler` cred env, the six step kinds — lives here.
//
// The driver is CONSTRUCTED with its collaborators (`./collaborators.ts`), which is its single
// side-effect seam: dry-run and every unit test work by substituting that bundle, and nothing else in
// this file spawns, provisions, or fetches (ADR-0009).

import type { AppConfig } from '@fabrika/config'
import { resolve } from 'node:path'
import type { Worker } from 'oblaka-iac'
import { CANCELLED, type DeployDriver, type DeploySession, type DriverRun } from '../../driver'
import type { CloudflareTarget, DeployContext } from '../../types'
import { type CloudflareCollaborators, defaultCloudflareCollaborators } from './collaborators'
import { buildPlan, type CloudflareJobSpec, findMigratableDatabases } from './plan'

/** This driver's own context shape: universal fields plus a target already narrowed to Cloudflare. */
type CloudflareContext = DeployContext<CloudflareTarget>

/** Resolve the absolute directory the Worker source lives in (`pipeline.workerDir` over `cwd`). */
const workerDir = (config: AppConfig, ctx: CloudflareContext): string => resolve(ctx.cwd, config.pipeline?.workerDir ?? '.')

/** The cred env every real `wrangler` child needs — oblaka uses the SDK, wrangler reads these. */
const wranglerEnv = (target: CloudflareTarget): Record<string, string> => ({
	CLOUDFLARE_API_TOKEN: target.apiToken,
	CLOUDFLARE_ACCOUNT_ID: target.accountId,
})

/** Throw a uniform error from a failed shell-out, folding stderr/stdout into the message. */
const commandError = (label: string, result: { exitCode: number; stdout: string; stderr: string }): Error => {
	const detail = (result.stderr.trim() || result.stdout.trim() || '(no output)').slice(0, 2000)
	return new Error(`${label} failed (exit ${result.exitCode}): ${detail}`)
}

/**
 * Abandon the step if the run was cancelled. Checked before every real mutation and between the
 * iterations of a multi-part step, so a cancelled run never starts work the orchestrator has already
 * stopped waiting for. Long-running children ALSO get the signal (see `CommandSpec.signal`).
 */
const assertRunning = (signal: AbortSignal): void => {
	if (signal.aborted) {
		throw new Error(CANCELLED)
	}
}

/**
 * Everything one step's executor needs: the config, the Cloudflare-narrowed context, the materialized
 * worker graph, its dir, the collaborators, the neutral run parts, and whether this is a dry-run.
 * Bundled so the per-kind handlers stay small.
 */
interface StepEnv {
	config: AppConfig
	ctx: CloudflareContext
	worker: Worker
	dir: string
	cf: CloudflareCollaborators
	log: (line: string) => void
	signal: AbortSignal
	dryRun: boolean
}

/** Run one step's effect. Resolves on success, throws on failure (caught + recorded by the engine). */
const runStep = async (spec: CloudflareJobSpec, env: StepEnv): Promise<void> => {
	const { config, ctx, worker, dir, cf, log, signal, dryRun } = env
	const target = ctx.target

	switch (spec.kind) {
		case 'build': {
			const build = config.pipeline?.build
			if (build === undefined) {
				return
			}
			if (dryRun) {
				log(`  [dry-run] would run build: \`${build}\` in ${dir}`)
				return
			}
			assertRunning(signal)
			const result = await cf.runCommand({ command: 'sh', args: ['-c', build], cwd: dir, signal })
			if (result.exitCode !== 0) {
				throw commandError(`build (\`${build}\`)`, result)
			}
			return
		}

		case 'provision-resources': {
			// Per-app state namespace (`<app id>-state` by default) so apps sharing one account don't
			// collide on oblaka's env-keyed state, and a migrated app continues its existing state.
			const stateNamespace = target.stateNamespace ?? `${config.id}-state`
			// oblaka always runs — in dry-run it provisions in plan-only mode (no remote, no writes),
			// which still materializes the resource graph + wrangler config so the path is exercised.
			// oblaka's programmatic deploy() takes no signal, so cancellation is checked at the boundary.
			assertRunning(signal)
			const result = await cf.provision({
				definition: worker,
				accountId: target.accountId,
				apiToken: target.apiToken,
				env: ctx.env,
				cwd: dir,
				stateNamespace,
				dryRun,
			})
			const names = result.wranglerConfigs.map((c) => c.config.name ?? '(unnamed)').join(', ')
			log(dryRun ? `  [dry-run] provisioned (plan-only): ${names}` : `  provisioned: ${names}`)
			return
		}

		case 'migrate': {
			// `migrate:<binding>` — apply by the D1 BINDING (env-stable), not the oblaka resource name (env-prefixed in wrangler.jsonc).
			const binding = spec.id.slice('migrate:'.length)
			const database = findMigratableDatabases(worker).find((d) => d.binding === binding)
			if (database === undefined) {
				throw new Error(`migrate: no migratable D1 database for binding \`${binding}\``)
			}
			if (dryRun) {
				log(`  [dry-run] would run: wrangler d1 migrations apply ${database.binding} --remote`)
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
			if (result.exitCode !== 0) {
				throw commandError(`wrangler d1 migrations apply ${database.binding}`, result)
			}
			return
		}

		case 'deploy-worker': {
			if (dryRun) {
				log(`  [dry-run] would run: wrangler deploy in ${dir}`)
				return
			}
			assertRunning(signal)
			const result = await cf.runCommand({ command: 'wrangler', args: ['deploy'], cwd: dir, env: wranglerEnv(target), signal })
			if (result.exitCode !== 0) {
				throw commandError('wrangler deploy', result)
			}
			return
		}

		case 'reconcile-schema': {
			const schema = config.schema
			const propustkaUrl = ctx.propustkaUrl
			if (schema === undefined || propustkaUrl === undefined) {
				return
			}
			if (dryRun) {
				log(`  [dry-run] would reconcile schema for \`${config.id}\` against ${propustkaUrl}`)
				return
			}
			assertRunning(signal)
			// propustka is fully native: `PUT /admin/apps/:app/schema` SELF-REGISTERS a new app (no
			// ACCESS_APPS gate, so no 404 "unknown app"). Any error is a real failure and propagates.
			await cf.reconcileSchema({ url: propustkaUrl, app: config.id, schema, adminKey: ctx.adminKey })
			return
		}

		case 'sync-secrets': {
			const secrets = config.pipeline?.secrets ?? []
			for (const name of secrets) {
				const value = ctx.secrets[name]
				if (value === undefined) {
					throw new Error(`sync-secrets: missing value for secret \`${name}\` (not in ctx.secrets)`)
				}
				if (dryRun) {
					log(`  [dry-run] would run: wrangler secret put ${name} (value piped from ctx.secrets)`)
					continue
				}
				// One `wrangler secret put` per secret — a cancel between two of them stops here.
				assertRunning(signal)
				const result = await cf.runCommand({
					command: 'wrangler',
					args: ['secret', 'put', name],
					cwd: dir,
					env: wranglerEnv(target),
					stdin: value,
					signal,
				})
				if (result.exitCode !== 0) {
					throw commandError(`wrangler secret put ${name}`, result)
				}
			}
			return
		}
	}
}

/**
 * Build a Cloudflare driver over a specific collaborator bundle. Production uses the real one;
 * tests pass fakes, which is the whole testability property — ONE seam, all of this driver's effects.
 */
export const createCloudflareDriver = (cf: CloudflareCollaborators = defaultCloudflareCollaborators): DeployDriver<'cloudflare'> => ({
	id: 'cloudflare',
	/**
	 * Open one Cloudflare run: materialize the app's resource graph ONCE (the plan inspects it for D1
	 * migrations and `provision-resources` hands it to oblaka), resolve the worker dir, then derive the
	 * plan purely from those. Nothing is executed here.
	 */
	open: (run: DriverRun<'cloudflare'>): Promise<DeploySession> => {
		const { config, ctx, log, signal, dryRun } = run
		const worker = config.resources({ env: ctx.env, domain: ctx.domain })
		const dir = workerDir(config, ctx)
		const plan = buildPlan(config, ctx, worker)
		const env: StepEnv = { config, ctx, worker, dir, cf, log, signal, dryRun }
		const byId = new Map(plan.steps.map((step): [string, CloudflareJobSpec] => [step.id, step]))

		return Promise.resolve({
			plan,
			execute: async (stepId: string): Promise<void> => {
				const spec = byId.get(stepId)
				if (spec === undefined) {
					throw new Error(`cloudflare: no step \`${stepId}\` in this plan`)
				}
				await runStep(spec, env)
			},
		})
	},
})

/** The Cloudflare deploy driver wired to the real collaborators — the default target's entry in the registry. */
export const cloudflareDriver: DeployDriver<'cloudflare'> = createCloudflareDriver()
