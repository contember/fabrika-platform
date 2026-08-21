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
import {
	waitForProcess,
	ZEROPS_ACTIVE,
	ZEROPS_PROCESS_FINISHED,
	ZEROPS_PROCESS_TERMINAL,
	ZEROPS_TERMINAL,
	ZeropsApiError,
	type ZeropsAppVersion,
	type ZeropsLogAccess,
	type ZeropsProcess,
} from './api'
import { zeropsTargetCodec } from './codec'
import { defaultSleep, defaultZeropsCollaborators, type ZeropsCollaboratorFactory, type ZeropsCollaborators } from './collaborators'
import {
	type FabrikaManifest,
	manifestServiceHostnames,
	renderFabrikaImportYaml,
	verifyZeropsArtifactSourceDescriptor,
	zeropsArtifactCodec,
} from './manifest'
import { buildZeropsPlan, resolveDeployHostname, type ZeropsJobSpec, type ZeropsPlan } from './plan'
import type { ZeropsSourceUploadInputV2, ZeropsSourceUploadResult } from './source'
import type { ZeropsRunState, ZeropsRuntimeSource, ZeropsRuntimeTarget } from './types'

export const CANCELLED = 'deploy cancelled'

type ZeropsRun = TypedProviderRun<ZeropsRuntimeTarget, FabrikaManifest>

export interface ZeropsSourceTransportBinding {
	readonly connectionId: string
	readonly installationId: number
	readonly transportKind: 'keyed-v2'
}

export interface ZeropsSourceTransportRouting {
	bindingForRun(runId: string): ZeropsSourceTransportBinding | undefined
	uploadV2(input: ZeropsSourceUploadInputV2): Promise<ZeropsSourceUploadResult>
}

/** How often `await-deploy` asks Zerops for the version's status. */
const POLL_INTERVAL_MS = 3000

/** Give up after this long. Zerops' own pipeline limit is 1 hour; we allow a little slack past it. */
const POLL_TIMEOUT_MS = 70 * 60 * 1000

/** Delay before deciding whether an ambiguous build trigger remained pre-trigger. */
const BUILD_TRIGGER_CONSISTENCY_MS = 10_000

/** Source cancellation cannot hold Zerops cleanup hostage. */
const SOURCE_CANCEL_TIMEOUT_MS = 5000

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
	sourceTransport?: ZeropsSourceTransportRouting
	/** Set by `trigger-deploy`, read by `await-deploy` — the only state that crosses a step boundary. */
	state: { appVersionId?: string; processId?: string }
}

const runState = (
	appVersionId: string,
	phase: Exclude<ZeropsRunState['phase'], 'build_triggered'>,
): Exclude<ZeropsRunState, { phase: 'build_triggered' }> => ({ appVersionId, phase })

const buildTriggeredState = (
	appVersionId: string,
	processId?: string,
): Extract<ZeropsRunState, { phase: 'build_triggered' }> => ({
	appVersionId,
	phase: 'build_triggered',
	...(processId === undefined ? {} : { processId }),
})

const requireSource = (env: StepEnv): { runtime: ZeropsRuntimeSource; client: NonNullable<ZeropsCollaborators['source']> } => {
	const runtime = env.run.target.source
	const client = env.zerops.source
	if (runtime === undefined || client === undefined) {
		throw new Error('zerops: upload-backed deploy requires source coordinates and a source client')
	}
	return { runtime, client }
}

const cancelSourceBestEffort = async (env: StepEnv, source: ZeropsRuntimeSource, appVersionId: string): Promise<void> => {
	const client = env.zerops.source
	if (client === undefined) return
	const sourceController = new AbortController()
	const timeoutController = new AbortController()
	const cancel = Promise.resolve()
		.then(() => client.cancel({ runId: source.runId, appVersionId, signal: sourceController.signal }))
		.catch(() => {})
	const timeout = Promise.resolve()
		.then(() => (env.zerops.sourceCancelSleep ?? defaultSleep)(SOURCE_CANCEL_TIMEOUT_MS, timeoutController.signal))
		.then(() => sourceController.abort())
		.catch(() => {})
	await Promise.race([cancel, timeout])
	timeoutController.abort()
	sourceController.abort()
}

/**
 * Drop a version that was created and never handed to the platform.
 *
 * BEST EFFORT ON PURPOSE. Every caller runs this while already failing, so a cleanup that throws would
 * replace the reason the deploy failed with the reason the cleanup did — which is what happened live,
 * where a real `trigger-deploy` failure surfaced as `delete app-version failed (400)` and the cause was
 * gone. The leftover version is visible on the platform; the lost diagnosis was not.
 */
const cleanupPreTriggerVersion = async (env: StepEnv, source: ZeropsRuntimeSource, appVersionId: string): Promise<void> => {
	await cancelSourceBestEffort(env, source, appVersionId)
	try {
		await env.zerops.api.deleteAppVersion({ appVersionId, signal: AbortSignal.timeout(5000) })
	} catch (error) {
		env.log(`  [warn] app-version ${appVersionId} was left behind: ${error instanceof Error ? error.message : 'unknown error'}`)
	}
}

/**
 * Relay ONE app version's build log into the run's progress sink.
 *
 * Scoped to the version being deployed: the runtime service's log window mixes every version that ever ran
 * on it, so an unscoped read stamps a run's log with lines from earlier releases. `appVersionId` selects
 * the build lines and `since` — the version's pipeline start — cuts the runtime ones
 * (see `ZeropsApi.readBuildLog`). Before the platform reports a pipeline start there is nothing to cut
 * against, so no runtime line is relayed yet. The cut is by time, so the OUTGOING container's own lines
 * still arrive until it is replaced; what it removes is every earlier version's history.
 *
 * Deliberately FAILURE-TOLERANT: a log service must never be able to fail a deploy, so an error degrades
 * to "no lines relayed" and the run still succeeds or fails on the platform's process and app-version
 * statuses.
 *
 * Relay is pull-based (ADR-0003), so each poll re-reads a window that overlaps the last one; `seen` keeps
 * the run log from repeating itself. Two genuinely identical lines with no timestamp collapse into one —
 * an acceptable trade for not printing the same window every three seconds.
 */
const relayLog = async (
	env: StepEnv,
	access: ZeropsLogAccess | null,
	seen: Set<string>,
	appVersionId: string,
	since: string | undefined,
): Promise<void> => {
	if (access === null) {
		return
	}
	try {
		const lines = await env.zerops.api.readBuildLog({
			access,
			serviceId: env.run.target.serviceId,
			appVersionId,
			...(since === undefined ? {} : { since }),
			signal: env.signal,
		})
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
 * Poll the trigger process and `/app-version` until the version reaches a terminal state, relaying the
 * build log as it goes. The process is optional because the trigger response may omit its id.
 *
 * A run cancelled here asks Zerops to cancel the BUILD too. That is not tidiness: the platform is running
 * the work, so abandoning the poll loop without telling it leaves a build container burning through the
 * pipeline's hour.
 */
const awaitVersion = async (env: StepEnv, appVersionId: string, processId: string | undefined): Promise<void> => {
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
		let process: ZeropsProcess | undefined
		let version: ZeropsAppVersion
		try {
			process = processId === undefined ? undefined : await zerops.api.getProcess({ processId, signal })
			version = await zerops.api.getAppVersion({ appVersionId, signal })
		} catch {
			log(`  ${appVersionId}: status observation unavailable; retrying`)
			if (Date.now() > deadline) {
				throw new Error(`zerops: timed out after ${Math.round(POLL_TIMEOUT_MS / 60000)}m waiting for app-version ${appVersionId}`)
			}
			await zerops.sleep(POLL_INTERVAL_MS, signal)
			continue
		}
		if (version.status !== previous) {
			log(`  ${appVersionId}: ${version.status ?? 'unknown'}`)
			previous = version.status
		}
		await relayLog(env, access, seen, appVersionId, version.build?.pipelineStart)

		if (process?.status !== undefined && ZEROPS_PROCESS_TERMINAL.has(process.status) && process.status !== ZEROPS_PROCESS_FINISHED) {
			throw new Error(
				`zerops: pipeline process ${process.id} is ${process.status} while app-version ${appVersionId} is ${version.status ?? 'in an unknown state'}`,
			)
		}
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
			// An import ANSWERS before its services exist. Triggering a pipeline on a service Zerops is
			// still creating answers 400 `projectImportInvalidParameter`, which is what the first deploy
			// into a fresh namespace hit; a re-apply onto services that already exist reports none.
			const pending = result.services.flatMap((service) => service.processes.map((process) => ({ service: service.name, id: process.id })))
			for (const process of pending) {
				assertRunning(signal)
				await waitForProcess({ api: zerops.api, processId: process.id, sleep: zerops.sleep, signal, label: `the ${process.service} import` })
			}
			if (pending.length > 0) {
				log(`  awaited ${pending.length} import process(es)`)
			}
			return
		}

		case 'trigger-deploy': {
			if (dryRun) {
				log(`  [dry-run] would create an app version, upload the resolved repository snapshot, and trigger build+deploy for service ${target.serviceId}`)
				return
			}
			assertRunning(signal)
			const source = requireSource(env)
			await verifyZeropsArtifactSourceDescriptor(artifact.target.sourceDescriptor)
			const version = await zerops.api.createAppVersion({ serviceId: target.serviceId, name: source.runtime.runId, signal })
			state.appVersionId = version.id
			let buildTriggerRequested = false
			try {
				await run.events.externalId(version.id, runState(version.id, 'version_created'))
				const uploadInput = {
					runId: source.runtime.runId,
					appVersionId: version.id,
					repository: source.runtime.repository,
					commitSha: source.runtime.commitSha,
					...(source.runtime.githubInstallationId === undefined
						? {}
						: { githubInstallationId: source.runtime.githubInstallationId }),
					uploadUrl: version.uploadUrl,
					descriptor: {
						path: artifact.target.sourceDescriptor.path,
						sha256: artifact.target.sourceDescriptor.sha256,
					},
					signal,
				}
				const sourceTransport = env.sourceTransport
				const binding = sourceTransport?.bindingForRun(source.runtime.runId)
				if (binding !== undefined && source.runtime.githubInstallationId !== binding.installationId) {
					throw new Error('zerops: source transport binding has different installation coordinates')
				}
				let uploaded: ZeropsSourceUploadResult
				if (binding === undefined) {
					uploaded = await source.client.upload(uploadInput)
				} else {
					if (sourceTransport === undefined) throw new Error('zerops: keyed source transport is unavailable')
					uploaded = await sourceTransport.uploadV2({
						...uploadInput,
						privateBinding: { connectionId: binding.connectionId, installationId: binding.installationId },
					})
				}
				if (
					uploaded.runId !== source.runtime.runId
					|| uploaded.appVersionId !== version.id
					|| uploaded.commitSha !== source.runtime.commitSha
					|| uploaded.descriptorSha256 !== artifact.target.sourceDescriptor.sha256
				) {
					throw new Error('zerops: source upload returned different coordinates')
				}
				await run.events.checkpoint(runState(version.id, 'source_uploaded'))
				await verifyZeropsArtifactSourceDescriptor(artifact.target.sourceDescriptor)
				await run.events.checkpoint(runState(version.id, 'build_trigger_requested'))
				buildTriggerRequested = true
				let process: ZeropsProcess
				try {
					process = await zerops.api.buildAndDeployAppVersion({
						appVersionId: version.id,
						zeropsYaml: artifact.target.sourceDescriptor.contents,
						...(artifact.target.zeropsSetup === undefined ? {} : { zeropsYamlSetup: artifact.target.zeropsSetup }),
						signal,
					})
				} catch (error) {
					if (error instanceof ZeropsApiError && error.status >= 400 && error.status < 500) {
						await cleanupPreTriggerVersion(env, source.runtime, version.id)
						throw error
					}
					let observed: ZeropsAppVersion | undefined
					try {
						await zerops.sleep(BUILD_TRIGGER_CONSISTENCY_MS, signal)
						observed = await zerops.api.getAppVersion({ appVersionId: version.id, signal })
					} catch {
						log(`  ${version.id}: build-trigger observation unavailable; continuing to poll`)
						return
					}
					if (observed.id === version.id && observed.status === 'UPLOADING') {
						await cleanupPreTriggerVersion(env, source.runtime, version.id)
						throw error
					}
					if (observed.id === version.id && observed.status !== undefined) {
						await run.events.checkpoint(buildTriggeredState(version.id)).catch(() => {})
						log(`  recovered accepted build trigger for app-version ${version.id}`)
					} else {
						log(`  ${version.id}: build-trigger state is not known yet; continuing to poll`)
					}
					return
				}
				state.processId = process.id
				await run.events.checkpoint(buildTriggeredState(version.id, process.id)).catch(() => {})
				log(`  triggered: app-version ${version.id} (build+deploy is ONE platform-side operation)`)
			} catch (error) {
				if (!buildTriggerRequested) {
					await cleanupPreTriggerVersion(env, source.runtime, version.id)
				}
				throw error
			}
			return
		}

		case 'await-deploy': {
			if (dryRun) {
				log('  [dry-run] would poll the pipeline process when available and /app-version until it is ACTIVE, relaying the build log')
				return
			}
			const appVersionId = state.appVersionId
			if (appVersionId === undefined) {
				throw new Error('zerops: await-deploy has no app-version to watch (trigger-deploy did not run)')
			}
			assertRunning(signal)
			await awaitVersion(env, appVersionId, state.processId)
			return
		}

		case 'reconcile-schema': {
			const schema = artifact.app.schema
			const propustkaUrl = target.propustkaUrl
			if (schema === undefined || propustkaUrl === undefined) {
				return
			}
			// Return origins ride this step because `apps.setReturnOrigins` 404s for an app IAM has never
			// heard of, and the schema reconcile is what registers it. Separate call, same moment.
			const returnOrigins = run.returnOrigins !== undefined && run.returnOrigins.length > 0 ? run.returnOrigins : undefined
			if (dryRun) {
				log(`  [dry-run] would reconcile schema for \`${artifact.app.id}\` against ${propustkaUrl}`)
				if (returnOrigins !== undefined) {
					log(`  [dry-run] would register return origins for \`${artifact.app.id}\`: ${returnOrigins.join(', ')}`)
				}
				return
			}
			assertRunning(signal)
			await zerops.reconcileSchema({
				url: propustkaUrl,
				app: artifact.app.id,
				schema,
				...(returnOrigins === undefined ? {} : { returnOrigins }),
				adminKey: target.adminKey,
				signal,
			})
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
export type ZeropsProvider = ProviderModule<'zerops', ZeropsRuntimeTarget, FabrikaManifest>

/** Construct an independently testable Zerops provider against one collaborator factory. */
export const createZeropsProvider = (
	collaborators: ZeropsCollaboratorFactory = defaultZeropsCollaborators,
	sourceTransport?: ZeropsSourceTransportRouting,
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
			const hostnames = manifestServiceHostnames(run.artifact)
			const compiled = {
				yaml: interpolateManifest(renderFabrikaImportYaml(run.artifact), run.artifact.app.pipeline.vars, run.vars),
				hostnames,
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
				...(sourceTransport === undefined ? {} : { sourceTransport }),
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
