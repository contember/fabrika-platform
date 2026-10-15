import {
	PROVIDER_NAMESPACE_IMMUTABLE,
	PROVIDER_NAMESPACE_UPDATE_UNCONFIRMED,
	type ProviderDeploymentNamespace,
	type ProviderEnvelope,
	type ProviderNamespaceUpdateInput,
	type ProviderNamespaceUpdatePlan,
	type ProviderNamespaceUpdates,
} from '@fabrika/provider-contract'
import { waitForProcess, ZeropsApiError, type ZeropsProcess } from '../api'
import { defaultSleep } from '../collaborators'
import { envelope, namespaceUpdatePayloadSchema, normalizeTarget, ZEROPS_PROXY_SOURCE_CURRENT, zeropsNamespaceTargetCodec } from './codec'
import { asNamespaceError, namespaceError, ZEROPS_NAMESPACE_CANCELLED } from './errors'
import { verifyZeropsNamespaceProxySource } from './proxy-source'
import type { NormalizedZeropsNamespaceTarget, ZeropsNamespaceOptions, ZeropsNamespacePostgres, ZeropsNamespaceTarget } from './types'
import { validateService } from './validation'

// Budget: ≤ 60 s on the autoscaling process plus ≤ 30 s of read-back — inside one request, and inside the lease TTL.
const PROCESS_POLL_INTERVAL_MS = 2_000
const PROCESS_POLL_ATTEMPTS = 30
const READBACK_INTERVAL_MS = 3_000
/** UNVERIFIED: how soon `autoscalingProfileId` reads the new profile after the PUT and its process finish. */
const READBACK_ATTEMPTS = 10

/** The plan field of a re-pin, which moves only the stored target; the reconcile core queues rebuilds the proxy. */
export const ZEROPS_PROXY_SOURCE_FIELD = 'proxySource'

type FixedField = Exclude<keyof ZeropsNamespaceTarget, 'postgres' | 'proxySource'>

/**
 * Every target field but the two an update may move: the PostgreSQL profile, and the proxy source pin, which only an
 * explicit re-pin to the installation's default moves (ADR-0045). A new field fails to compile until listed.
 */
const FIXED_FIELDS: { readonly [K in FixedField]: (target: ZeropsNamespaceTarget) => ZeropsNamespaceTarget[K] } = {
	proxyBuild: (target) => target.proxyBuild,
	proxyDeployment: (target) => target.proxyDeployment,
	projectName: (target) => target.projectName,
	corePackage: (target) => target.corePackage,
	publicAccess: (target) => target.publicAccess,
	managed: (target) => target.managed,
	projectId: (target) => target.projectId,
	proxyServiceId: (target) => target.proxyServiceId,
	postgresServiceId: (target) => target.postgresServiceId,
	proxyConfigured: (target) => target.proxyConfigured,
	proxyBaselineSequence: (target) => target.proxyBaselineSequence,
	proxyAppVersionId: (target) => target.proxyAppVersionId,
	proxyHosts: (target) => target.proxyHosts,
	ready: (target) => target.ready,
}

const immutable = (message: string) => namespaceError(PROVIDER_NAMESPACE_IMMUTABLE, message, false)

/** The stored target with the requested payload's top-level fields laid over it, validated by the one codec. */
const mergedTarget = (
	namespace: ProviderDeploymentNamespace,
	current: NormalizedZeropsNamespaceTarget,
	requested: ProviderEnvelope,
	options: ZeropsNamespaceOptions,
): NormalizedZeropsNamespaceTarget => {
	const payload = requested.payload
	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
		throw new Error('Zerops namespace update payload must be an object')
	}
	const checked = namespaceUpdatePayloadSchema.safeParse(payload)
	if (!checked.success) {
		const issue = checked.error.issues[0]
		const path = issue?.path.join('.') ?? ''
		if (issue?.code === 'unrecognized_keys') {
			const field = [path, issue.keys[0] ?? ''].filter((part) => part !== '').join('.')
			throw new Error(`Zerops namespace update field ${field} is not a namespace target field`)
		}
		throw new Error(`Zerops namespace update field ${path === '' ? 'payload' : path} is invalid`)
	}
	const stored = zeropsNamespaceTargetCodec.encode(current)
	if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
		throw new Error('Zerops namespace target did not encode to an object')
	}
	if (checked.data.proxySource !== ZEROPS_PROXY_SOURCE_CURRENT) {
		return normalizeTarget({ ...namespace, target: { ...requested, payload: { ...stored, ...payload } } }, options)
	}
	const fields = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'proxySource'))
	return {
		...normalizeTarget({ ...namespace, target: { ...requested, payload: { ...stored, ...fields } } }, options),
		proxySource: options.proxySource,
	}
}

/** Refuse every difference except the PostgreSQL profile and a re-pin of the proxy source, naming the fields. */
const planUpdate = (
	namespace: ProviderDeploymentNamespace,
	requested: ProviderEnvelope,
	options: ZeropsNamespaceOptions,
): ProviderNamespaceUpdatePlan => {
	const current = normalizeTarget(namespace, options)
	const merged = mergedTarget(namespace, current, requested, options)
	const changed = Object.entries(FIXED_FIELDS)
		.filter(([, read]) => JSON.stringify(read(current)) !== JSON.stringify(read(merged)))
		.map(([field]) => field)
	if (changed.length > 0) {
		throw immutable(
			`Zerops namespace ${namespace.id} cannot change ${changed.join(', ')} in place; only the PostgreSQL profile and the proxy source can`,
		)
	}
	if (JSON.stringify(current.proxySource) === JSON.stringify(merged.proxySource)) return planProfile(namespace, current, merged)
	if (JSON.stringify(merged.proxySource) !== JSON.stringify(options.proxySource)) {
		throw new Error(`Zerops namespace ${namespace.id} can re-pin its proxy source only to the installation's default: proxySource "current"`)
	}
	if (JSON.stringify(current.postgres) !== JSON.stringify(merged.postgres)) {
		throw new Error(`Zerops namespace ${namespace.id}: re-pin the proxy source and change the PostgreSQL profile in separate updates`)
	}
	// Rebuilding under a new pin settles an attempt first, and would record that attempt's version as the new pin's.
	if (current.proxyBuild !== undefined) {
		throw new Error(`Zerops namespace ${namespace.id} has a proxy build in flight; reconcile it before re-pinning the proxy source`)
	}
	return {
		namespace: { ...namespace, target: envelope(merged) },
		change: { field: ZEROPS_PROXY_SOURCE_FIELD, from: current.proxySource.commitSha, to: merged.proxySource.commitSha },
	}
}

const planProfile = (
	namespace: ProviderDeploymentNamespace,
	current: NormalizedZeropsNamespaceTarget,
	merged: NormalizedZeropsNamespaceTarget,
): ProviderNamespaceUpdatePlan => {
	const was = current.postgres
	const wanted = merged.postgres
	const unchanged: ProviderNamespaceUpdatePlan = { namespace: { ...namespace, target: envelope(current) }, change: null }
	// The merge starts from the stored target, so `wanted` is absent only when `was` is.
	if (wanted === undefined) return unchanged
	if (was === undefined) {
		throw immutable(`Zerops namespace ${namespace.id} has no PostgreSQL service, and one cannot be added in place`)
	}
	if (was.type !== wanted.type) {
		throw immutable(`Zerops namespace ${namespace.id} cannot change its PostgreSQL type from ${was.type} to ${wanted.type} in place`)
	}
	if (wanted.profile === was.profile) return unchanged
	if (wanted.profile === undefined) {
		throw immutable(`Zerops namespace ${namespace.id} cannot return its PostgreSQL service to the platform default profile in place`)
	}
	return {
		namespace: { ...namespace, target: envelope({ ...current, postgres: wanted }) },
		change: { field: 'postgres.profile', from: was.profile ?? null, to: wanted.profile },
	}
}

const unconfirmed = (serviceId: string, profile: string, cause: unknown) =>
	namespaceError(
		PROVIDER_NAMESPACE_UPDATE_UNCONFIRMED,
		`Zerops PostgreSQL service ${serviceId} was asked to move to profile ${profile}, and the change is not confirmed`,
		true,
		cause instanceof Error ? cause.message : undefined,
	)

/** A platform refusal answered before anything was accepted; everything else once the PUT is sent is ambiguous. */
const refusedOutright = (cause: unknown): boolean =>
	cause instanceof ZeropsApiError && cause.status >= 400 && cause.status < 500 && cause.status !== 429

const readBack = async (serviceId: string, profile: string, options: ZeropsNamespaceOptions, signal: AbortSignal): Promise<void> => {
	const sleep = options.sleep ?? defaultSleep
	for (let attempt = 0;; attempt += 1) {
		if (signal.aborted) {
			throw namespaceError(ZEROPS_NAMESPACE_CANCELLED, 'Zerops namespace update was cancelled', true)
		}
		const live = (await options.api.getService({ serviceId, signal })).autoscalingProfileId
		if (live === profile) return
		if (attempt >= READBACK_ATTEMPTS) {
			throw new Error(`the service still reads ${live ?? 'no profile'}`)
		}
		await sleep(READBACK_INTERVAL_MS, signal)
	}
}

const applyProfile = async (
	current: NormalizedZeropsNamespaceTarget,
	wanted: ZeropsNamespacePostgres,
	profile: string,
	unconfirmedProfile: string | undefined,
	options: ZeropsNamespaceOptions,
	signal: AbortSignal,
): Promise<void> => {
	const projectId = current.projectId
	const serviceId = current.postgresServiceId
	if (projectId === undefined || serviceId === undefined) {
		throw new Error('Zerops namespace has no PostgreSQL service id')
	}
	const service = await options.api.getService({ serviceId, signal })
	validateService(service, projectId, wanted.type, false, undefined, {
		...(current.postgres?.profile === undefined ? {} : { declared: current.postgres.profile }),
		changingTo: profile,
		...(unconfirmedProfile === undefined ? {} : { unconfirmed: unconfirmedProfile }),
	})
	if (service.autoscalingProfileId !== profile) {
		let process: ZeropsProcess | null
		try {
			process = await options.api.configureAutoscaling({ serviceId, autoscalingProfileId: profile, signal })
		} catch (cause) {
			if (refusedOutright(cause)) throw cause
			throw unconfirmed(serviceId, profile, cause)
		}
		try {
			if (process !== null && process.id !== '') {
				await waitForProcess({
					api: options.api,
					processId: process.id,
					sleep: options.sleep ?? defaultSleep,
					signal,
					label: 'the PostgreSQL autoscaling change',
					intervalMs: PROCESS_POLL_INTERVAL_MS,
					attempts: PROCESS_POLL_ATTEMPTS,
				})
			}
		} catch (cause) {
			throw unconfirmed(serviceId, profile, cause)
		}
	}
	try {
		await readBack(serviceId, profile, options, signal)
	} catch (cause) {
		throw unconfirmed(serviceId, profile, cause)
	}
}

const applyUpdate = async (input: ProviderNamespaceUpdateInput, options: ZeropsNamespaceOptions): Promise<ProviderDeploymentNamespace> => {
	const current = normalizeTarget(input.namespace, options)
	const plan = planUpdate(input.namespace, input.next.target, options)
	// A re-pin touches no platform resource: it stores the pin, and the reconcile core queues builds from it.
	if (plan.change?.field === ZEROPS_PROXY_SOURCE_FIELD) {
		await verifyZeropsNamespaceProxySource(normalizeTarget(plan.namespace, options).proxySource)
		return plan.namespace
	}
	if (!current.ready) {
		throw new Error(`Zerops namespace ${input.namespace.id} is not ready`)
	}
	const wanted = normalizeTarget(plan.namespace, options).postgres
	// Checked even with no planned change: after an unconfirmed update, confirming the live service is
	// what lets core return the namespace to ready.
	if (wanted?.profile === undefined) return plan.namespace
	const unconfirmedProfile = input.unconfirmed === undefined ? undefined : normalizeTarget(input.unconfirmed, options).postgres?.profile
	await applyProfile(current, wanted, wanted.profile, unconfirmedProfile, options, input.signal)
	return plan.namespace
}

/** Move a ready namespace's PostgreSQL service to another profile — the one field Zerops changes in place. */
export const createZeropsNamespaceUpdates = (options: ZeropsNamespaceOptions): ProviderNamespaceUpdates => ({
	plan: (namespace, requested) => planUpdate(namespace, requested, options),
	apply: async (input) => {
		try {
			return await applyUpdate(input, options)
		} catch (cause) {
			throw asNamespaceError(cause, 'update')
		}
	},
})
