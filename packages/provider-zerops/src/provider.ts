// The Zerops provider owns its plan and every effect needed to execute it.
//
// A Zerops deploy is HTTP and nothing else (ADR-0003) — no container, no shell, no filesystem — so this
// driver's whole side-effect surface is one REST client plus the portable schema reconciler
// (`./collaborators.ts`). It never spawns a process and has no `runCommand` to be handed.
//
// The interesting step is `await-version`: fabrika does not RUN the build, it WATCHES one the platform
// runs. Recovery never resumes a deploy (ADR-0044): a version reserved but never triggered is deleted, and
// one whose build may have been requested is settled only by polling it.

import {
	type DeployStepResult,
	followLeaseLoss,
	isLeaseLoss,
	type JsonValue,
	ProviderInvocationAbort,
	type ProviderManagedEnvironment,
	type ProviderRunEvents,
	runSteps,
} from '@fabrika/provider-contract'
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
import { defaultZeropsCollaborators, type ZeropsCollaboratorFactory, type ZeropsCollaborators } from './collaborators'
import { assertZeropsInvariants, renderYaml } from './compile'
import {
	assertAuthoredManagedDocument,
	assertAuthoredManagedInputs,
	type ManagedValues,
	overlayRelease,
	parseManagedValues,
	SERVICE_MANAGED_KEYS,
} from './managed-env'
import { type FabrikaImportDocument, type FabrikaManifest, manifestServiceHostnames, verifyZeropsArtifactSourceDescriptor } from './manifest'
import { buildZeropsPlan, resolveDeployHostname, type ZeropsStep } from './plan'
import { allowedReferenceHosts, foreignReferenceHost } from './service-references'
import { isZeropsUploadDestination } from './source'
import type { ZeropsRunState, ZeropsRuntimeSource, ZeropsRuntimeTarget } from './types'
import { deleteVersion } from './version-attempt'

export const CANCELLED = 'deploy cancelled'

export interface ZeropsDeployRun {
	readonly appId: string
	readonly env: string
	/** Every origin IAM may hand this app a session at; app-wide, because IAM's registry is keyed by app id. */
	readonly returnOrigins?: readonly string[]
	readonly secrets: Readonly<Record<string, string>>
	readonly vars: Readonly<Record<string, string>>
	/** Platform-owned runtime configuration, separate from operator-managed application vars. */
	readonly managedEnvironment: ProviderManagedEnvironment
	readonly target: ZeropsRuntimeTarget
	readonly artifact: FabrikaManifest
	readonly dryRun: boolean
	readonly signal: AbortSignal
	readonly events: ProviderRunEvents
}

export interface ZeropsDeployResult {
	readonly appId: string
	readonly env: string
	readonly status: 'succeeded' | 'failed'
	readonly steps: readonly DeployStepResult[]
}

/** How often `await-version` asks Zerops for the version's status. */
const POLL_INTERVAL_MS = 3000

/** A run stops waiting for its version this long after it started. Zerops' own pipeline limit is 1 hour. */
export const ZEROPS_VERSION_DEADLINE_MS = 75 * 60 * 1000

const RELEASE_KEY = 'FABRIKA_RELEASE'

/** Abandon the step if the run was cancelled. Checked before every real mutation and each poll iteration. */
const assertRunning = (signal: AbortSignal): void => {
	if (signal.aborted) {
		if (signal.reason instanceof ProviderInvocationAbort) throw signal.reason
		throw new Error(CANCELLED)
	}
}

const PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]*)\}/g

/** Fields that decide WHAT a service is: a placeholder there would let a value redefine the service. */
const STRUCTURAL_FIELDS: readonly string[] = ['hostname', 'type', 'envIsolation', 'override']

/** Rebuild the tree with every string leaf resolved — arrays and nested objects included. */
const substituteLeaves = (value: JsonValue, resolve: (text: string) => string): JsonValue => {
	if (typeof value === 'string') {
		return resolve(value)
	}
	if (Array.isArray(value)) {
		return value.map((item) => substituteLeaves(item, resolve))
	}
	if (value !== null && typeof value === 'object') {
		return substituteRecord(value, resolve)
	}
	return value
}

const substituteRecord = (
	record: { readonly [key: string]: JsonValue },
	resolve: (text: string) => string,
): { [key: string]: JsonValue } => {
	const substituted: { [key: string]: JsonValue } = {}
	for (const [key, entry] of Object.entries(record)) {
		const planted = key.match(PLACEHOLDER)
		if (planted !== null) {
			throw new Error(`zerops: placeholder \`${String(planted[0])}\` stands in an import document key; a variable may only fill a value`)
		}
		// Defined rather than assigned: a literal `__proto__` key would otherwise set the prototype.
		Object.defineProperty(substituted, key, {
			value: substituteLeaves(entry, resolve),
			enumerable: true,
			writable: true,
			configurable: true,
		})
	}
	return substituted
}

/** A structural field that moved means a placeholder sat where only the compiler may write. */
const assertStructureUnchanged = (before: FabrikaImportDocument, after: FabrikaImportDocument): void => {
	if (JSON.stringify(before.project) !== JSON.stringify(after.project)) {
		throw new Error('zerops: variable substitution changed the project entry; a variable may not stand in the project fabrika creates')
	}
	for (const [index, service] of after.services.entries()) {
		const original = before.services[index]
		for (const field of STRUCTURAL_FIELDS) {
			if (original?.[field] !== service[field]) {
				throw new Error(`zerops: variable substitution changed service field \`${field}\`; a variable may not stand in a service's identity`)
			}
		}
	}
}

/** Substitution is a single pass, so a placeholder left in the document came out of a variable's VALUE. */
const assertNoPlaceholderLeft = (document: FabrikaImportDocument): void => {
	const refuse = (text: string): void => {
		const left = text.match(PLACEHOLDER)
		if (left !== null) {
			throw new Error(`zerops: placeholder \`${String(left[0])}\` survived substitution; a variable value may not carry one`)
		}
	}
	const visitRecord = (record: { readonly [key: string]: JsonValue }): void => {
		for (const [key, entry] of Object.entries(record)) {
			refuse(key)
			visit(entry)
		}
	}
	const visit = (value: JsonValue): void => {
		if (typeof value === 'string') {
			refuse(value)
			return
		}
		if (Array.isArray(value)) {
			for (const item of value) visit(item)
			return
		}
		if (value !== null && typeof value === 'object') {
			visitRecord(value)
		}
	}
	if (document.project !== undefined) {
		visitRecord(document.project)
	}
	for (const service of document.services) {
		visitRecord(service)
	}
}

/**
 * Resolve the manifest's declared variables INTO THE DOCUMENT — never into the rendered YAML, where a
 * value carrying a quote or a newline would be read as structure and could add a service or turn
 * `envIsolation` off. Only variables the manifest declares resolve; every other placeholder fails the
 * deploy, and so does a value that names a service outside the app (Zerops resolves `${host_KEY}`
 * regardless of isolation). The document is re-checked here because this is the last point it is an object.
 */
export function interpolateManifest(
	document: FabrikaImportDocument,
	declared: readonly string[],
	values: Record<string, string>,
	ownHostnames: readonly string[],
): FabrikaImportDocument {
	assertAuthoredManagedDocument(document.services)
	assertAuthoredManagedInputs({ variableNames: [...declared, ...Object.keys(values)], secretNames: [] })
	const allowed = new Set(declared)
	const hosts = allowedReferenceHosts(ownHostnames)
	const resolve = (text: string): string => {
		const substituted = text.replace(PLACEHOLDER, (_placeholder, name: string) => {
			if (!allowed.has(name)) {
				throw new Error(`zerops: manifest uses undeclared variable \`${name}\``)
			}
			const value = values[name]
			if (value === undefined) {
				throw new Error(`zerops: manifest variable \`${name}\` has no deploy-time value`)
			}
			const foreign = foreignReferenceHost(value, hosts)
			if (foreign !== null) {
				throw new Error(`zerops: manifest variable \`${name}\` references service \`${foreign}\`, which this app does not own`)
			}
			return value
		})
		// Adjacent values can spell a reference neither of them carries alone.
		const foreign = substituted === text ? null : foreignReferenceHost(substituted, hosts)
		if (foreign !== null) {
			throw new Error(`zerops: a substituted value references service \`${foreign}\`, which this app does not own`)
		}
		return substituted
	}
	const services = document.services.map((service) => substituteRecord(service, resolve))
	const substituted: FabrikaImportDocument = document.project === undefined
		? { services }
		: { project: substituteRecord(document.project, resolve), services }
	assertZeropsInvariants(substituted)
	assertStructureUnchanged(document, substituted)
	assertNoPlaceholderLeft(substituted)
	assertAuthoredManagedDocument(substituted.services)
	return substituted
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

/**
 * The attempt this invocation is making. `appVersionId` is set once a version is reserved and `triggered`
 * just before the build request is sent; together they decide whether a failure may delete the version.
 */
interface Attempt {
	appVersionId?: string
	uploadUrl?: string
	processId?: string
	triggered: boolean
}

/** Everything one step's executor needs, bundled so the per-kind handlers stay small. */
interface StepEnv {
	run: ZeropsDeployRun
	zerops: ZeropsCollaborators
	/** The compiled import document + its YAML text, materialized once in `open()`. */
	compiled: { yaml: string; hostnames: string[] }
	log: (line: string) => void
	signal: AbortSignal
	dryRun: boolean
	attempt: Attempt
	managedValues: ManagedValues
	/** `await-version` gives up at this instant. */
	deadlineMs: number
}

const requireSource = (env: StepEnv): { runtime: ZeropsRuntimeSource; client: NonNullable<ZeropsCollaborators['source']> } => {
	const runtime = env.run.target.source
	const client = env.zerops.source
	if (runtime === undefined || client === undefined) {
		throw new Error('zerops: upload-backed deploy requires source coordinates and a source client')
	}
	return { runtime, client }
}

const requireVersion = (env: StepEnv, step: string): string => {
	const appVersionId = env.attempt.appVersionId
	if (appVersionId === undefined) throw new Error(`zerops: ${step} has no reserved app-version (reserve-version did not run)`)
	return appVersionId
}

/** Best-effort: the caller is already giving up, so a failed cancellation must not replace the reason. */
const cancelBuildQuietly = async (env: StepEnv, appVersionId: string): Promise<void> => {
	await env.zerops.api.cancelBuild({ appVersionId, signal: AbortSignal.timeout(5000) }).catch(() => {})
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
 * A cancelled run asks Zerops to cancel the BUILD too: the platform is running the work, so abandoning the
 * poll loop without telling it leaves a build container burning through the pipeline's hour. A lost lease
 * gives no such permission (ADR-0044), so it stops without touching the build.
 */
const awaitVersion = async (env: StepEnv, appVersionId: string, processId: string | undefined): Promise<void> => {
	const { zerops, signal, log } = env
	const access = await openLog(env)
	const seen = new Set<string>()
	let previous: string | undefined
	const timedOut = async (): Promise<never> => {
		await cancelBuildQuietly(env, appVersionId)
		throw new Error(`zerops: gave up waiting for app-version ${appVersionId} at the run deadline`)
	}

	for (;;) {
		// Only a boundary that still holds the lease may cancel the build; a lost lease rejects it as lease_lost.
		const crossed: unknown = await env.run.events.boundary().then(() => null, (error: unknown) => error)
		if (isLeaseLoss(crossed)) throw crossed
		if (signal.aborted) {
			if (isLeaseLoss(signal.reason)) throw signal.reason
			await cancelBuildQuietly(env, appVersionId)
			throw new ProviderInvocationAbort('cancel_requested')
		}
		let process: ZeropsProcess | undefined
		let version: ZeropsAppVersion
		try {
			process = processId === undefined ? undefined : await zerops.api.getProcess({ processId, signal })
			version = await zerops.api.getAppVersion({ appVersionId, signal })
		} catch {
			log(`  ${appVersionId}: status observation unavailable; retrying`)
			if (Date.now() > env.deadlineMs) await timedOut()
			await zerops.sleep(POLL_INTERVAL_MS, signal)
			continue
		}
		if (signal.aborted) continue
		if (
			version.id !== appVersionId || (version.serviceStackId !== undefined && version.serviceStackId !== env.run.target.serviceId)
			|| (processId !== undefined && process?.id !== processId)
			|| (process?.appVersionId !== undefined && process.appVersionId !== appVersionId)
		) {
			throw new Error('zerops: status observation has different coordinates')
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
		if (Date.now() > env.deadlineMs) await timedOut()
		await zerops.sleep(POLL_INTERVAL_MS, signal)
	}
}

/** Write the five service-level managed keys; `FABRIKA_RELEASE` is never a service variable (ADR-0044). */
const writeServiceEnv = async (env: StepEnv): Promise<void> => {
	const { zerops, log, signal, managedValues } = env
	const serviceId = env.run.target.serviceId
	if (env.dryRun) {
		const written = SERVICE_MANAGED_KEYS.filter((key) => managedValues[key] !== null)
		const removed = SERVICE_MANAGED_KEYS.filter((key) => managedValues[key] === null)
		log(`  [dry-run] would write service variables on ${serviceId}: ${written.join(', ') || '(none)'}`)
		log(`  [dry-run] would remove service variables on ${serviceId} if present: ${[...removed, RELEASE_KEY].join(', ')}`)
		return
	}
	assertRunning(signal)
	// One read: every write below waits for its own user-data sync, so the build request never meets `userDataSyncRunning`.
	const records = await zerops.api.listServiceEnv({ serviceId, signal })
	for (const key of SERVICE_MANAGED_KEYS) {
		const value = managedValues[key]
		const existing = records.find((record) => record.key === key)
		assertRunning(signal)
		if (value !== null && existing?.content !== value) {
			await zerops.api.putServiceEnv({ serviceId, key, value, signal })
			log(`  ${key}: updated`)
		} else if (value === null && existing !== undefined) {
			await zerops.api.deleteServiceEnv({ envId: existing.id, signal })
			log(`  ${key}: removed`)
		} else {
			log(`  ${key}: unchanged`)
		}
	}
	const strayRelease = records.find((record) => record.key === RELEASE_KEY)
	if (strayRelease !== undefined) {
		assertRunning(signal)
		await zerops.api.deleteServiceEnv({ envId: strayRelease.id, signal })
		log(`  ${RELEASE_KEY}: removed`)
	}
}

/** Run one step's effect. Resolves on success, throws on failure (caught + recorded by `runSteps`). */
const runStep = async (spec: ZeropsStep, env: StepEnv): Promise<void> => {
	const { run, zerops, compiled, log, signal, dryRun, attempt } = env
	const { target, artifact } = run
	await run.events.boundary()

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

		case 'write-service-env': {
			await writeServiceEnv(env)
			return
		}

		case 'reserve-version': {
			if (dryRun) {
				log(`  [dry-run] would reserve an app version on service ${target.serviceId}`)
				return
			}
			const source = requireSource(env)
			await verifyZeropsArtifactSourceDescriptor(artifact.target.sourceDescriptor)
			assertRunning(signal)
			const version = await zerops.api.createAppVersion({ serviceId: target.serviceId, name: source.runtime.runId, signal })
			attempt.appVersionId = version.id
			attempt.uploadUrl = version.uploadUrl
			const checkpoint: ZeropsRunState = { appVersionId: version.id, triggered: false }
			await run.events.externalId(version.id, { ...checkpoint })
			log(`  reserved app-version ${version.id}`)
			return
		}

		case 'upload-source': {
			if (dryRun) {
				log('  [dry-run] would upload the resolved repository snapshot to the reserved app version')
				return
			}
			const source = requireSource(env)
			const appVersionId = requireVersion(env, 'upload-source')
			const uploadUrl = attempt.uploadUrl
			if (uploadUrl === undefined) throw new Error('zerops: upload-source has no upload URL')
			// The upload URL carries its own credential; it is checked here and never put in an error.
			if (!isZeropsUploadDestination(uploadUrl)) throw new Error('zerops: the reserved app version has an unexpected upload destination')
			assertRunning(signal)
			const binding = source.runtime.privateBinding
			const uploaded = await source.client.upload({
				repository: source.runtime.repository,
				commitSha: source.runtime.commitSha,
				descriptorSha256: artifact.target.sourceDescriptor.sha256,
				archive: {
					kind: 'application',
					...(binding === undefined ? {} : { privateBinding: { connectionId: binding.connectionId, installationId: binding.installationId } }),
				},
				uploadUrl,
				signal,
			})
			if (
				uploaded.commitSha !== source.runtime.commitSha
				|| uploaded.descriptorSha256 !== artifact.target.sourceDescriptor.sha256
			) {
				throw new Error('zerops: source upload returned different coordinates')
			}
			log(`  uploaded ${source.runtime.commitSha} to ${appVersionId}`)
			return
		}

		case 'trigger-build': {
			if (dryRun) {
				log('  [dry-run] would trigger build+deploy with FABRIKA_RELEASE written into the execution descriptor')
				return
			}
			const appVersionId = requireVersion(env, 'trigger-build')
			await verifyZeropsArtifactSourceDescriptor(artifact.target.sourceDescriptor)
			const descriptor = overlayRelease(artifact.target.sourceDescriptor.contents, artifact.target.zeropsSetup, env.managedValues.FABRIKA_RELEASE)
			assertRunning(signal)
			// Recorded BEFORE the request: from here on the version is settled only by polling it (ADR-0044).
			const checkpoint: ZeropsRunState = { appVersionId, triggered: true }
			await run.events.checkpoint({ ...checkpoint })
			attempt.triggered = true
			// A cancel from here on still sends the build, so `cancel()` cancels a real build instead of
			// polling a version that would sit in UPLOADING until the deadline. Only a lost lease stops it.
			const buildSignal = followLeaseLoss(signal)
			buildSignal.throwIfAborted()
			let process: ZeropsProcess
			try {
				process = await zerops.api.buildAndDeployAppVersion({
					appVersionId,
					zeropsYaml: descriptor.contents,
					zeropsYamlSetup: descriptor.setup,
					signal: buildSignal,
				})
			} catch (error) {
				buildSignal.throwIfAborted()
				// A 408 says the request timed out, not that the platform refused it.
				if (error instanceof ZeropsApiError && error.status >= 400 && error.status < 500 && error.status !== 408) {
					throw new Error(`zerops: build refused (${error.code === '' ? error.status : error.code})`)
				}
				log('  build request outcome unknown; polling the version')
				return
			}
			attempt.processId = process.id
			log(`  triggered app-version ${appVersionId}`)
			return
		}

		case 'await-version': {
			if (dryRun) {
				log('  [dry-run] would poll the pipeline process when available and /app-version until it is ACTIVE, relaying the build log')
				return
			}
			const appVersionId = requireVersion(env, 'await-version')
			assertRunning(signal)
			await awaitVersion(env, appVersionId, attempt.processId)
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
 * Build a Zerops deployer over a specific collaborator FACTORY. Production passes the real one; tests pass
 * `() => fakes`, which is the whole testability property — one seam, all of this driver's effects.
 *
 * A factory rather than a bundle because the Zerops client is authenticated with a token that lives on the
 * run's target, so it cannot be constructed once at module load the way Cloudflare's bundle is.
 */
export const createZeropsDeployer = (
	collaborators: ZeropsCollaboratorFactory = defaultZeropsCollaborators,
) =>
async (run: ZeropsDeployRun): Promise<ZeropsDeployResult> => {
	if (run.artifact.app.id !== run.appId) {
		throw new Error(`zerops: artifact app drift: expected \`${run.appId}\`, got \`${run.artifact.app.id}\``)
	}
	if (run.artifact.app.env !== run.env) {
		throw new Error(`zerops: artifact environment drift: expected \`${run.env}\`, got \`${run.artifact.app.env}\``)
	}
	assertAuthoredManagedInputs({ variableNames: Object.keys(run.vars), secretNames: Object.keys(run.secrets) })
	const managedValues = parseManagedValues(run.managedEnvironment)
	const hostnames = manifestServiceHostnames(run.artifact)
	const document = interpolateManifest(run.artifact.target.importDocument, run.artifact.app.pipeline.vars, run.vars, hostnames)
	const compiled = { yaml: renderYaml(document), hostnames }
	resolveDeployHostname(run.artifact)
	const zerops = collaborators(run.target)
	const env: StepEnv = {
		run,
		zerops,
		compiled,
		log: run.events.log,
		signal: run.signal,
		dryRun: run.dryRun,
		attempt: { triggered: false },
		managedValues,
		deadlineMs: Date.now() + ZEROPS_VERSION_DEADLINE_MS,
	}
	const steps = buildZeropsPlan(run.artifact, run.target)
	const options = { appId: run.appId, env: run.env, dryRun: run.dryRun, signal: run.signal, log: run.events.log }
	const result = await runSteps(steps, options, (step) => runStep(step, env))
	const { appVersionId, triggered } = env.attempt
	// A cancelled run leaves the version to `cancel()`; a lost lease leaves it to the next owner.
	if (result.status === 'failed' && appVersionId !== undefined && !triggered && !run.signal.aborted) {
		try {
			await deleteVersion(zerops.api, appVersionId, run.signal)
			run.events.log(`  deleted app-version ${appVersionId}`)
		} catch {
			run.events.log(`  [warn] app-version ${appVersionId} could not be deleted; it was never built`)
		}
	}
	return { appId: run.appId, env: run.env, ...result }
}
