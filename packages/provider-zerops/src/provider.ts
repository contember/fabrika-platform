// The Zerops provider owns its plan and every effect needed to execute it.
//
// A Zerops deploy is HTTP and nothing else (ADR-0003) — no container, no shell, no filesystem — so this
// driver's whole side-effect surface is one REST client plus the portable schema reconciler
// (`./collaborators.ts`). It never spawns a process and has no `runCommand` to be handed.
//
// The interesting step is `await-version`: fabrika does not RUN the build, it WATCHES one the platform
// runs. Recovery never resumes a deploy (ADR-0044): a version reserved but never triggered is deleted, and
// one whose build may have been requested is settled only by polling it.

import { appEnvironmentId, FABRIKA_SOURCE_MAP_UPLOAD_KEY } from '@fabrika/auth-core'
import { type OperationsSourceMapUploadState, readSourceMapUploadReport } from '@fabrika/operations-contract/releases'
import {
	type DeployStepResult,
	followLeaseLoss,
	isLeaseLoss,
	type JsonValue,
	type ProviderApprovedAccess,
	type ProviderDeployInput,
	ProviderInvocationAbort,
	type ProviderManagedEnvironment,
	type ProviderRunEvents,
	runSteps,
} from '@fabrika/provider-contract'
import {
	readableContent,
	waitForProcess,
	ZEROPS_ACTIVE,
	ZEROPS_PROCESS_FINISHED,
	ZEROPS_PROCESS_TERMINAL,
	ZEROPS_TERMINAL,
	ZeropsApiError,
	type ZeropsAppVersion,
	type ZeropsLogAccess,
	type ZeropsProcess,
	type ZeropsServiceAutoscaling,
} from './api'
import { defaultZeropsCollaborators, type ZeropsCollaboratorFactory, type ZeropsCollaborators } from './collaborators'
import { assertZeropsInvariants, renderYaml } from './compile'
import { FABRIKA_CHECK_VERSION, PLATFORM_TYPESCRIPT_VERSION, renderLockedExecutionDescriptor, zeropsStartMinRam } from './execution'
import {
	createdServices,
	type ExposureFinding,
	formatExposureFindings,
	formatStorageProvenance,
	isObjectStorageType,
	parseStorageProvenance,
	STORAGE_PROVENANCE_KEY,
	type StorageProvenanceMarker,
	unprovenBucketReason,
} from './exposure'
import {
	assertAuthoredManagedDocument,
	assertAuthoredManagedInputs,
	isFrameworkFamilyVariable,
	isSensitiveFamilyVariable,
	type ManagedValues,
	overlayRelease,
	parseManagedEnvironment,
	SENSITIVE_MANAGED_KEYS,
	SERVICE_MANAGED_KEYS,
} from './managed-env'
import {
	approvedSchemaOf,
	type FabrikaImportDocument,
	type FabrikaManifest,
	lockedExecutionFor,
	manifestServiceHostnames,
	verifyZeropsArtifactSourceDescriptor,
} from './manifest'
import { buildZeropsPlan, resolveDeployHostname, type ZeropsStep } from './plan'
import { allowedReferenceHosts, assertNoPlatformOnlyReference, foreignReferenceHost } from './service-references'
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
	/** Control's approved access for the environment (ADR-0050); the lock-down and the IAM schema come from it. */
	readonly access?: ProviderApprovedAccess
	/** The run-scoped source-map destination Control minted; the build uploads to it. */
	readonly artifactUpload?: ProviderDeployInput['artifactUpload']
	readonly dryRun: boolean
	readonly signal: AbortSignal
	readonly events: ProviderRunEvents
}

export interface ZeropsDeployResult {
	readonly appId: string
	readonly env: string
	readonly status: 'succeeded' | 'failed'
	readonly steps: readonly DeployStepResult[]
	/** Whether the build's source maps reached Operations; absent when the run had no upload to make. */
	readonly artifactState?: OperationsSourceMapUploadState
}

/** How often `await-version` asks Zerops for the version's status. */
const POLL_INTERVAL_MS = 3000

/** A run stops waiting for its version this long after it started. Zerops' own pipeline limit is 1 hour. */
export const ZEROPS_VERSION_DEADLINE_MS = 75 * 60 * 1000

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
			assertNoPlatformOnlyReference(value)
			return value
		})
		if (substituted === text) return substituted
		// Adjacent values can spell a reference neither of them carries alone.
		const foreign = foreignReferenceHost(substituted, hosts)
		if (foreign !== null) {
			throw new Error(`zerops: a substituted value references service \`${foreign}\`, which this app does not own`)
		}
		assertNoPlatformOnlyReference(substituted)
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
	/** Hostname → id of every service this run's import created. */
	created?: ReadonlyMap<string, string>
	/** The provenance marker `write-service-env` writes, or null to remove a marker no bucket needs any more. */
	storageProvenance?: string | null
	appVersionId?: string
	uploadUrl?: string
	processId?: string
	triggered: boolean
	/** What the build's source-map upload reported in its log, once a relayed line said so. */
	sourceMaps?: OperationsSourceMapUploadState
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
	/** The key of each job and webhook of the approved contract, by its variable (ADR-0022 "Principal kinds"). */
	familyVariables: Readonly<Record<string, string>>
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
			const reported = readSourceMapUploadReport(line.message)
			if (reported !== null) env.attempt.sourceMaps = reported
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

const declaredBuckets = (artifact: FabrikaManifest): string[] =>
	artifact.target.importDocument.services.filter((service) => isObjectStorageType(service.type)).map((service) => service.hostname)

interface CreatedBucket {
	readonly hostname: string
	readonly id: string
}

/** The declared buckets this import reports creating. */
const createdBucketsOf = (artifact: FabrikaManifest, created: ReadonlyMap<string, string>): CreatedBucket[] =>
	declaredBuckets(artifact).flatMap((hostname) => {
		const id = created.get(hostname)
		return id === undefined ? [] : [{ hostname, id }]
	})

/**
 * Record this import's buckets in the provenance marker before any other step can fail: the import's answer is the only
 * evidence of creation, since a re-apply reports nothing for a service that exists. Merged here, never narrowed;
 * `write-service-env` sets the verified set. A sensitive marker of an earlier release cannot be merged and is replaced.
 */
const recordCreatedBuckets = async (env: StepEnv, buckets: readonly CreatedBucket[], signal: AbortSignal): Promise<void> => {
	const { zerops, log, run } = env
	const serviceId = run.target.serviceId
	try {
		const records = await zerops.api.listServiceEnv({ serviceId, signal })
		const recorded = parseStorageProvenance(readableContent(records.find((record) => record.key === STORAGE_PROVENANCE_KEY)))
		if (buckets.every((bucket) => recorded.has(bucket.id))) return
		const value = formatStorageProvenance([...recorded, ...buckets.map((bucket) => bucket.id)])
		await zerops.api.putServiceEnv({ serviceId, key: STORAGE_PROVENANCE_KEY, value, sensitive: false, signal })
		log(`  ${STORAGE_PROVENANCE_KEY}: recorded the bucket(s) this import created`)
	} catch (error) {
		// The run log is then the one record of the evidence; the refusal a later run raises names the remedy.
		const named = buckets.map((bucket) => `\`${bucket.hostname}\` (${bucket.id})`).join(', ')
		log(`  [warn] this import created bucket(s) ${named}, but ${STORAGE_PROVENANCE_KEY} on ${serviceId} could not record them`)
		throw error
	}
}

/**
 * The exposure read-back (ADR-0043): before a version can activate, every declared service must read
 * `subdomainAccess: false`, and every object-storage service must be one this import created or the provenance
 * marker names. A refusal raises an Operations alert, best-effort, and fails the run before any version exists.
 */
const verifyExposure = async (env: StepEnv): Promise<void> => {
	const { zerops, log, signal, run } = env
	const { artifact, target } = run
	if (env.dryRun) {
		log('  [dry-run] would read back subdomain access and bucket provenance of every declared service')
		return
	}
	const created = env.attempt.created ?? new Map<string, string>()
	const buckets = declaredBuckets(artifact)
	const records = buckets.length === 0 ? [] : await zerops.api.listServiceEnv({ serviceId: target.serviceId, signal })
	const marker = records.find((record) => record.key === STORAGE_PROVENANCE_KEY)
	const markerState: StorageProvenanceMarker = marker === undefined ? 'absent' : marker.sensitive ? 'sensitive' : 'readable'
	if (markerState === 'sensitive') {
		log(`  [warn] ${STORAGE_PROVENANCE_KEY} was written sensitive by an earlier release; it names no bucket until it is rewritten readable`)
	}
	const known = new Set([...parseStorageProvenance(readableContent(marker)), ...(target.createdBuckets ?? [])])
	const findings: ExposureFinding[] = []
	const bucketIds: string[] = []
	for (const hostname of manifestServiceHostnames(artifact)) {
		assertRunning(signal)
		const service = await zerops.api.findService({ projectId: target.projectId, hostname, signal })
		if (service === null) {
			findings.push({ hostname, reason: 'is absent after the import, so its exposure cannot be read back' })
			continue
		}
		if (service.subdomainAccess !== false) {
			findings.push({
				hostname,
				reason: service.subdomainAccess === true
					? 'has a `.zerops.app` subdomain, which reaches it past the namespace proxy; disable it in Zerops'
					: 'did not report its subdomain access',
			})
		}
		if (!buckets.includes(hostname)) continue
		if (created.get(hostname) === service.id || known.has(service.id)) {
			bucketIds.push(service.id)
		} else {
			findings.push({
				hostname,
				reason: unprovenBucketReason({ bucketId: service.id, deployService: artifact.target.deployService, marker: markerState }),
			})
		}
	}
	if (findings.length > 0) {
		const dsn = env.managedValues.FABRIKA_OPERATIONS_DSN
		if (dsn !== null) {
			const alert = { appId: run.appId, env: run.env, release: env.managedValues.FABRIKA_RELEASE, findings }
			await zerops.alertExposure({ dsn, alert, signal }).then(
				() => log('  raised an Operations alert'),
				() => log('  [warn] the Operations alert could not be sent'),
			)
		}
		throw new Error(formatExposureFindings(findings))
	}
	env.attempt.storageProvenance = bucketIds.length > 0 ? formatStorageProvenance(bucketIds) : null
	log(
		`  ${manifestServiceHostnames(artifact).length} service(s) without subdomain access${
			bucketIds.length === 0 ? '' : `; ${bucketIds.length} bucket(s) of platform provenance`
		}`,
	)
}

/** Write the nine service-level managed keys; `FABRIKA_RELEASE` is never a service variable (ADR-0044). */
const writeServiceEnv = async (env: StepEnv): Promise<void> => {
	const { zerops, log, signal, managedValues, familyVariables } = env
	const serviceId = env.run.target.serviceId
	if (env.dryRun) {
		const upload = env.run.artifactUpload !== undefined
		const written = [
			...SERVICE_MANAGED_KEYS.filter((key) => managedValues[key] !== null),
			...Object.keys(familyVariables),
			...(upload ? [FABRIKA_SOURCE_MAP_UPLOAD_KEY] : []),
		]
		const removed = [...SERVICE_MANAGED_KEYS.filter((key) => managedValues[key] === null), ...(upload ? [] : [FABRIKA_SOURCE_MAP_UPLOAD_KEY])]
		log(`  [dry-run] would write service variables on ${serviceId}: ${written.join(', ') || '(none)'}`)
		log(`  [dry-run] would remove service variables on ${serviceId} if present: ${removed.join(', ') || '(none)'}`)
		if (Object.keys(familyVariables).length > 0) {
			log(`  [dry-run] would remove every other job, webhook and connector variable on ${serviceId}`)
		}
		return
	}
	assertRunning(signal)
	// One read: every write below waits for its own user-data sync, so the build request never meets `userDataSyncRunning`.
	const records = await zerops.api.listServiceEnv({ serviceId, signal })
	for (const key of SERVICE_MANAGED_KEYS) {
		const value = managedValues[key]
		const existing = records.find((record) => record.key === key)
		const sensitive = SENSITIVE_MANAGED_KEYS.has(key)
		assertRunning(signal)
		if (value !== null && (sensitive || readableContent(existing) !== value)) {
			await zerops.api.putServiceEnv({ serviceId, key, value, sensitive, signal })
			log(`  ${key}: updated`)
		} else if (value === null && existing !== undefined) {
			await zerops.api.deleteServiceEnv({ envId: existing.id, signal })
			log(`  ${key}: removed`)
		} else {
			log(`  ${key}: unchanged`)
		}
	}
	const provenance = env.attempt.storageProvenance
	const marker = records.find((record) => record.key === STORAGE_PROVENANCE_KEY)
	if (typeof provenance === 'string' && readableContent(marker) !== provenance) {
		assertRunning(signal)
		// Not a credential, and the exposure read-back above reads it: it must stay readable.
		await zerops.api.putServiceEnv({ serviceId, key: STORAGE_PROVENANCE_KEY, value: provenance, sensitive: false, signal })
		log(`  ${STORAGE_PROVENANCE_KEY}: updated`)
	} else if (provenance === null && marker !== undefined) {
		assertRunning(signal)
		await zerops.api.deleteServiceEnv({ envId: marker.id, signal })
		log(`  ${STORAGE_PROVENANCE_KEY}: removed`)
	}
	// A workload key is written like a managed key; one whose workload is gone is removed, so no stale key stays readable.
	for (const [key, value] of Object.entries(familyVariables)) {
		const existing = records.find((record) => record.key === key)
		const sensitive = isSensitiveFamilyVariable(key)
		assertRunning(signal)
		if (sensitive || readableContent(existing) !== value) {
			await zerops.api.putServiceEnv({ serviceId, key, value, sensitive, signal })
			log(`  ${key}: updated`)
		} else {
			log(`  ${key}: unchanged`)
		}
	}
	for (const record of records) {
		if (isFrameworkFamilyVariable(record.key) && !Object.hasOwn(familyVariables, record.key)) {
			assertRunning(signal)
			await zerops.api.deleteServiceEnv({ envId: record.id, signal })
			log(`  ${record.key}: removed`)
		}
	}
	// The build lifts the upload's bearer from here (`${RUNTIME_…}`), so the descriptor never holds it.
	const bearer = env.run.artifactUpload?.bearer ?? null
	const uploadKey = records.find((record) => record.key === FABRIKA_SOURCE_MAP_UPLOAD_KEY)
	if (bearer !== null) {
		assertRunning(signal)
		await zerops.api.putServiceEnv({ serviceId, key: FABRIKA_SOURCE_MAP_UPLOAD_KEY, value: bearer, sensitive: true, signal })
		log(`  ${FABRIKA_SOURCE_MAP_UPLOAD_KEY}: updated`)
	} else if (uploadKey !== undefined) {
		assertRunning(signal)
		await zerops.api.deleteServiceEnv({ envId: uploadKey.id, signal })
		log(`  ${FABRIKA_SOURCE_MAP_UPLOAD_KEY}: removed`)
	}
}

/** The custom autoscaling with its minimum RAM raised to `minRam`; every other field is sent back as it was read. */
const withMinRam = (custom: ZeropsServiceAutoscaling, minRam: number): ZeropsServiceAutoscaling => ({
	...custom,
	vertical: { ...custom.vertical, minResource: { ...custom.vertical.minResource, memoryGBytes: minRam } },
})

/**
 * Raises the deploy service's minimum RAM to what the generated start script needs (`zeropsStartMinRam`), before the
 * version's containers start. An import cannot: Zerops ignores a changed `verticalAutoscaling` of an existing service,
 * so an existing service converges here, on every deploy. It only raises, and decides by reading the service back.
 */
const raiseStartMemory = async (env: StepEnv): Promise<void> => {
	const { run, zerops, log, signal, dryRun } = env
	const locked = lockedExecutionFor(run.artifact, run, dryRun)
	const minRam = locked === null ? null : zeropsStartMinRam(locked)
	const hostname = run.artifact.target.deployService
	if (minRam === null) {
		log(`  ${hostname} needs no more than the platform's minimum RAM`)
		return
	}
	if (dryRun) {
		log(`  [dry-run] would raise the minimum RAM of ${hostname} to ${minRam} GB where it is lower`)
		return
	}
	const serviceId = run.target.serviceId
	assertRunning(signal)
	const service = await zerops.api.getService({ serviceId, signal })
	const custom = service.customAutoscaling
	const current = service.currentAutoscaling
	if (custom === undefined || current === undefined) {
		throw new Error(`zerops: ${hostname} did not report its autoscaling whole, so its minimum RAM cannot be raised to ${minRam} GB`)
	}
	const before = current.vertical.minResource.memoryGBytes
	if (before !== null && before >= minRam) {
		log(`  minimum RAM of ${hostname}: ${before} GB, unchanged (its start needs ${minRam} GB)`)
		return
	}
	const maxRam = current.vertical.maxResource.memoryGBytes
	if (maxRam !== null && maxRam < minRam) {
		throw new Error(`zerops: ${hostname} may use at most ${maxRam} GB of RAM and its start needs ${minRam} GB; raise verticalAutoscaling.maxRam`)
	}
	assertRunning(signal)
	let process: ZeropsProcess | null
	try {
		process = await zerops.api.configureCustomAutoscaling({ serviceId, autoscaling: withMinRam(custom, minRam), signal })
	} catch (error) {
		if (error instanceof ZeropsApiError && error.status >= 400 && error.status < 500 && error.status !== 408) {
			throw new Error(`zerops: raising the minimum RAM of ${hostname} to ${minRam} GB was refused (${error.code === '' ? error.status : error.code})`)
		}
		throw error
	}
	if (process !== null) {
		await waitForProcess({ api: zerops.api, processId: process.id, sleep: zerops.sleep, signal, label: `the autoscaling change of ${hostname}` })
	}
	const after = (await zerops.api.getService({ serviceId, signal })).currentAutoscaling?.vertical.minResource.memoryGBytes ?? null
	if (after === null || after < minRam) {
		throw new Error(`zerops: ${hostname} reads back a minimum RAM of ${after ?? 'nothing'} GB after it was raised to ${minRam} GB`)
	}
	log(`  minimum RAM of ${hostname}: ${before ?? 'the platform default'} → ${after} GB`)
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
			attempt.created = createdServices(result)
			const createdBuckets = createdBucketsOf(artifact, attempt.created)
			// A cancel may not separate a created bucket from its evidence; only a lost lease stops the step then.
			const settling = createdBuckets.length === 0 ? signal : followLeaseLoss(signal)
			// An import ANSWERS before its services exist. Triggering a pipeline on a service Zerops is
			// still creating answers 400 `projectImportInvalidParameter`, which is what the first deploy
			// into a fresh namespace hit; a re-apply onto services that already exist reports none.
			const pending = result.services.flatMap((service) => service.processes.map((process) => ({ service: service.name, id: process.id })))
			for (const process of pending) {
				assertRunning(settling)
				await waitForProcess({
					api: zerops.api,
					processId: process.id,
					sleep: zerops.sleep,
					signal: settling,
					label: `the ${process.service} import`,
				})
			}
			if (pending.length > 0) {
				log(`  awaited ${pending.length} import process(es)`)
			}
			if (createdBuckets.length > 0) await recordCreatedBuckets(env, createdBuckets, settling)
			return
		}

		case 'verify-exposure': {
			await verifyExposure(env)
			return
		}

		case 'write-service-env': {
			await writeServiceEnv(env)
			return
		}

		case 'raise-start-memory': {
			await raiseStartMemory(env)
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
			const locked = lockedExecutionFor(artifact, run, dryRun, run.artifactUpload)
			if (dryRun) {
				log(
					locked === null
						? '  [dry-run] would trigger build+deploy with FABRIKA_RELEASE written into the execution descriptor'
						: '  [dry-run] would trigger build+deploy with the generated run section and build checks',
				)
				return
			}
			const appVersionId = requireVersion(env, 'trigger-build')
			await verifyZeropsArtifactSourceDescriptor(artifact.target.sourceDescriptor)
			const { contents } = artifact.target.sourceDescriptor
			const release = env.managedValues.FABRIKA_RELEASE
			const descriptor = locked === null
				? overlayRelease(contents, artifact.target.zeropsSetup, release)
				: renderLockedExecutionDescriptor(contents, artifact.target.zeropsSetup, release, locked)
			if (locked !== null) {
				log(`  generated run section; build checks @fabrika/check@${FABRIKA_CHECK_VERSION}, typescript@${PLATFORM_TYPESCRIPT_VERSION}`)
				if (locked.sourceMaps !== null) log(`  the build uploads the source maps of ${locked.sourceMaps.assetRoots.length} asset root(s)`)
			}
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
			const schema = approvedSchemaOf(run)
			const propustkaUrl = target.propustkaUrl
			if (schema === undefined || propustkaUrl === undefined) {
				return
			}
			// Return origins ride this step because `apps.setReturnOrigins` 404s for an app IAM has never
			// heard of, and the schema reconcile is what registers it. Separate call, same moment.
			const returnOrigins = run.returnOrigins !== undefined && run.returnOrigins.length > 0 ? run.returnOrigins : undefined
			const iamApp = appEnvironmentId(artifact.app.id, artifact.app.env)
			if (dryRun) {
				log(`  [dry-run] would reconcile schema for \`${iamApp}\` against ${propustkaUrl}`)
				if (returnOrigins !== undefined) {
					log(`  [dry-run] would register return origins for \`${iamApp}\`: ${returnOrigins.join(', ')}`)
				}
				return
			}
			assertRunning(signal)
			await zerops.reconcileSchema({
				url: propustkaUrl,
				app: iamApp,
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
	// The proxy serves an endpoint table exactly when Control approved a contract, whatever the artifact says.
	const contractProxy = run.access !== undefined
	const { values: handed, familyVariables } = parseManagedEnvironment(run.managedEnvironment)
	// Only a contract application checks the secret; any other would merely hold a credential its own code can print.
	const managedValues: ManagedValues = contractProxy ? handed : { ...handed, FABRIKA_PROXY_SECRET: null }
	if (!run.dryRun && contractProxy && managedValues.FABRIKA_PROXY_SECRET === null) {
		// The application would refuse every request its proxy sends (ADR-0022 rule 5).
		throw new Error('zerops: a contract application needs its proxy secret, and Control supplied none')
	}
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
		familyVariables,
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
	return { appId: run.appId, env: run.env, ...result, ...artifactStateOf(run, result.status, env.attempt) }
}

/** A run that uploads reports `complete` only when its build log said so; a missing or unread report is `incomplete`. */
const artifactStateOf = (
	run: ZeropsDeployRun,
	status: ZeropsDeployResult['status'],
	attempt: Attempt,
): Pick<ZeropsDeployResult, 'artifactState'> => {
	if (run.artifactUpload === undefined || run.dryRun || status !== 'succeeded') return {}
	return { artifactState: attempt.sourceMaps === 'complete' ? 'complete' : 'incomplete' }
}
