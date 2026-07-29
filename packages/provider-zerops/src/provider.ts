// The Zerops provider owns its plan and every effect needed to execute it.
//
// A Zerops deploy is HTTP and nothing else (ADR-0003) — no container, no shell, no filesystem — so this
// driver's whole side-effect surface is one REST client plus the portable schema reconciler
// (`./collaborators.ts`). It never spawns a process and has no `runCommand` to be handed.
//
// The interesting step is `await-deploy`: fabrika does not RUN the build, it WATCHES one the platform
// runs. That is the case the run's `AbortSignal` was added for (ADR-0009), and it is honoured three ways —
// the poll loop rechecks it, the sleep between polls is interruptible, and a cancelled run asks Zerops to
// cancel the build it started rather than leaving it running.

import { createProvider, type ProviderDeploySession, type ProviderModule, type TypedProviderRun } from '@fabrika/provider-contract'
import { ZEROPS_ACTIVE, ZEROPS_TERMINAL, type ZeropsAppVersion, type ZeropsLogAccess } from './api'
import { zeropsTargetCodec } from './codec'
import { defaultZeropsCollaborators, type ZeropsCollaboratorFactory, type ZeropsCollaborators } from './collaborators'
import { type FabrikaManifestV1, zeropsArtifactCodec } from './manifest'
import { buildZeropsPlan, resolveDeployHostname, type ZeropsJobSpec, type ZeropsPlan } from './plan'
import type { ZeropsRuntimeTarget } from './types'

export const CANCELLED = 'deploy cancelled'

type ZeropsRun = TypedProviderRun<ZeropsRuntimeTarget, FabrikaManifestV1>

/** How often `await-deploy` asks Zerops for the version's status. */
const POLL_INTERVAL_MS = 3000

/** Give up after this long. Zerops' own pipeline limit is 1 hour; we allow a little slack past it. */
const POLL_TIMEOUT_MS = 70 * 60 * 1000

/** Abandon the step if the run was cancelled. Checked before every real mutation and each poll iteration. */
const assertRunning = (signal: AbortSignal): void => {
	if (signal.aborted) {
		throw new Error(CANCELLED)
	}
}

const PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]*)\}/g

/** Resolve only variables declared by the manifest. Unknown or missing placeholders fail the deploy. */
export function interpolateManifest(source: string, declared: string[], values: Record<string, string>): string {
	const allowed = new Set(declared)
	return source.replace(PLACEHOLDER, (_placeholder, name: string) => {
		if (!allowed.has(name)) {
			throw new Error(`zerops: manifest uses undeclared variable \`${name}\``)
		}
		const value = values[name]
		if (value === undefined) {
			throw new Error(`zerops: manifest variable \`${name}\` has no deploy-time value`)
		}
		return value
	})
}

/** Human-readable failure for a version that finished in a non-`ACTIVE` state. */
const terminalFailure = (version: ZeropsAppVersion): string => {
	if (version.status === 'BACKUP') {
		return `app-version ${version.id} was superseded by a newer version before it went live`
	}
	if (version.status === 'CANCELLED') {
		return `app-version ${version.id} was cancelled`
	}
	return `Zerops pipeline failed: app-version ${version.id} is ${version.status ?? 'in an unknown state'}`
}

/** Everything one step's executor needs, bundled so the per-kind handlers stay small. */
interface StepEnv {
	run: ZeropsRun
	zerops: ZeropsCollaborators
	/** The compiled import document + its YAML text, materialized once in `open()`. */
	compiled: { yaml: string; hostnames: string[] }
	/** Hostname of the service the app's code deploys to. */
	deployHostname: string
	log: (line: string) => void
	signal: AbortSignal
	dryRun: boolean
	/** Set by `trigger-deploy`, read by `await-deploy` — the only state that crosses a step boundary. */
	state: { appVersionId?: string }
}

/**
 * Relay whatever build log Zerops will give us into the run's progress sink.
 *
 * Deliberately FAILURE-TOLERANT: the log service's protocol is the one shape in this driver nobody could
 * verify against a document (see `ZeropsApi.readBuildLog`). An unverified endpoint must never be able to
 * fail a deploy, so a broken guess degrades to "no lines relayed" and the run still succeeds or fails on
 * `/app-version` status alone.
 *
 * Relay is pull-based (ADR-0003), so each poll re-reads a window that overlaps the last one; `seen` keeps
 * the run log from repeating itself. Two genuinely identical lines with no timestamp collapse into one —
 * an acceptable trade for not printing the same window every three seconds.
 */
const relayLog = async (env: StepEnv, access: ZeropsLogAccess | null, seen: Set<string>): Promise<void> => {
	if (access === null) {
		return
	}
	try {
		const lines = await env.zerops.api.readBuildLog({ access, serviceId: env.run.target.serviceId, signal: env.signal })
		for (const line of lines) {
			const key = `${line.timestamp ?? ''}\u0000${line.message}`
			if (seen.has(key)) {
				continue
			}
			seen.add(key)
			env.log(`  │ ${line.message}`)
		}
	} catch (error) {
		env.log(`  [warn] build-log relay unavailable: ${error instanceof Error ? error.message : 'unknown error'}`)
	}
}

/** Ask Zerops for a log grant, tolerating its absence for the same reason `relayLog` tolerates a failure. */
const openLog = async (env: StepEnv): Promise<ZeropsLogAccess | null> => {
	try {
		return await env.zerops.api.getLogAccess({ projectId: env.run.target.projectId, signal: env.signal })
	} catch (error) {
		env.log(`  [warn] build-log relay unavailable: ${error instanceof Error ? error.message : 'unknown error'}`)
		return null
	}
}

/**
 * Poll `/app-version` until the version reaches a terminal state, relaying the build log as it goes.
 *
 * A run cancelled here asks Zerops to cancel the BUILD too. That is not tidiness: the platform is running
 * the work, so abandoning the poll loop without telling it leaves a build container burning through the
 * pipeline's hour.
 */
const awaitVersion = async (env: StepEnv, appVersionId: string): Promise<void> => {
	const { zerops, signal, log } = env
	const access = await openLog(env)
	const seen = new Set<string>()
	const deadline = Date.now() + POLL_TIMEOUT_MS
	let previous: string | undefined

	for (;;) {
		if (signal.aborted) {
			// Best-effort: the run is already abandoned, so a failure to cancel must not mask the reason.
			await zerops.api.cancelBuild({ appVersionId, signal: AbortSignal.timeout(5000) }).catch(() => {})
			throw new Error(CANCELLED)
		}
		const version = await zerops.api.getAppVersion({ appVersionId, signal })
		if (version.status !== previous) {
			log(`  ${appVersionId}: ${version.status ?? 'unknown'}`)
			previous = version.status
		}
		await relayLog(env, access, seen)

		if (version.status !== undefined && ZEROPS_TERMINAL.has(version.status)) {
			if (version.status === ZEROPS_ACTIVE) {
				return
			}
			throw new Error(terminalFailure(version))
		}
		if (Date.now() > deadline) {
			throw new Error(`zerops: timed out after ${Math.round(POLL_TIMEOUT_MS / 60000)}m waiting for app-version ${appVersionId}`)
		}
		await zerops.sleep(POLL_INTERVAL_MS, signal)
	}
}

/** Run one step's effect. Resolves on success, throws on failure (caught + recorded by the engine). */
const runStep = async (spec: ZeropsJobSpec, env: StepEnv): Promise<void> => {
	const { run, zerops, compiled, log, signal, dryRun, state } = env
	const { target, artifact } = run

	switch (spec.kind) {
		case 'apply-import': {
			if (dryRun) {
				log(`  [dry-run] would POST the import for ${compiled.hostnames.length} service(s) to project ${target.projectId}:`)
				for (const line of compiled.yaml.trimEnd().split('\n')) {
					log(`  │ ${line}`)
				}
				return
			}
			assertRunning(signal)
			// `override: true` on every service (written by the compiler) is what makes re-applying safe.
			const result = await zerops.api.importServices({ projectId: target.projectId, yaml: compiled.yaml, signal })
			log(`  imported: ${result.services.map((service) => `${service.name} (${service.id})`).join(', ') || '(none reported)'}`)
			return
		}

		case 'trigger-deploy': {
			const source = target.buildFromGit === undefined ? "the service's configured Git integration" : target.buildFromGit
			if (dryRun) {
				log(`  [dry-run] would trigger the Zerops pipeline for service ${target.serviceId} (${env.deployHostname}) from ${source}`)
				return
			}
			assertRunning(signal)
			const zeropsSetup = artifact.target.zeropsSetup
			const process = await zerops.api.triggerPipeline({
				serviceId: target.serviceId,
				buildFromGit: target.buildFromGit,
				zeropsSetup,
				signal,
			})
			// The trigger response's app-version id is optional on the wire, so resolve the version we just
			// created rather than depending on it — and fail loudly if there is none, since awaiting a
			// version we cannot name would silently watch someone else's deploy.
			const version = process?.appVersionId !== undefined
				? { id: process.appVersionId }
				: await zerops.api.latestAppVersion({ serviceId: target.serviceId, signal })
			if (version === null || version.id === '') {
				throw new Error(`zerops: pipeline triggered for service ${target.serviceId} but no app-version could be resolved`)
			}
			state.appVersionId = version.id
			await run.events.externalId(version.id)
			log(`  triggered: app-version ${version.id} (build+deploy is ONE platform-side operation)`)
			return
		}

		case 'await-deploy': {
			if (dryRun) {
				log('  [dry-run] would poll /app-version until it is ACTIVE and relay the build log')
				return
			}
			const appVersionId = state.appVersionId
			if (appVersionId === undefined) {
				throw new Error('zerops: await-deploy has no app-version to watch (trigger-deploy did not run)')
			}
			assertRunning(signal)
			await awaitVersion(env, appVersionId)
			return
		}

		case 'reconcile-schema': {
			const schema = artifact.app.schema
			const propustkaUrl = target.propustkaUrl
			if (schema === undefined || propustkaUrl === undefined) {
				return
			}
			if (dryRun) {
				log(`  [dry-run] would reconcile schema for \`${artifact.app.id}\` against ${propustkaUrl}`)
				return
			}
			assertRunning(signal)
			await zerops.reconcileSchema({ url: propustkaUrl, app: artifact.app.id, schema, adminKey: target.adminKey })
			return
		}
	}
}

/**
 * Build a Zerops driver over a specific collaborator FACTORY. Production passes the real one; tests pass
 * `() => fakes`, which is the whole testability property — one seam, all of this driver's effects.
 *
 * A factory rather than a bundle because the Zerops client is authenticated with a token that lives on the
 * run's target, so it cannot be constructed once at module load the way Cloudflare's bundle is.
 */
export type ZeropsProvider = ProviderModule<'zerops', ZeropsRuntimeTarget, FabrikaManifestV1>

/** Construct an independently testable Zerops provider against one collaborator factory. */
export const createZeropsProvider = (
	collaborators: ZeropsCollaboratorFactory = defaultZeropsCollaborators,
): ZeropsProvider =>
	createProvider({
		id: 'zerops',
		target: zeropsTargetCodec,
		artifact: zeropsArtifactCodec,
		open: (run): Promise<ProviderDeploySession> => {
			if (run.artifact.app.id !== run.appId) {
				throw new Error(`zerops: artifact app drift: expected \`${run.appId}\`, got \`${run.artifact.app.id}\``)
			}
			if (run.artifact.app.env !== run.env) {
				throw new Error(`zerops: artifact environment drift: expected \`${run.env}\`, got \`${run.artifact.app.env}\``)
			}
			const compiled = {
				yaml: interpolateManifest(run.artifact.target.importYaml, run.artifact.app.pipeline.vars, run.vars),
				hostnames: run.artifact.target.serviceHostnames,
			}
			const deployHostname = resolveDeployHostname(run.artifact)
			const plan: ZeropsPlan = buildZeropsPlan(run.artifact, run.target, run.env)
			const env: StepEnv = {
				run,
				zerops: collaborators(run.target),
				compiled,
				deployHostname,
				log: run.events.log,
				signal: run.signal,
				dryRun: run.dryRun,
				state: {},
			}
			const byId = new Map(plan.steps.map((step): [string, ZeropsJobSpec] => [step.id, step]))

			return Promise.resolve({
				plan,
				execute: async (stepId: string): Promise<void> => {
					const spec = byId.get(stepId)
					if (spec === undefined) {
						throw new Error(`zerops: no step \`${stepId}\` in this plan`)
					}
					await runStep(spec, env)
				},
			})
		},
	})

export const zeropsProvider: ZeropsProvider = createZeropsProvider()
