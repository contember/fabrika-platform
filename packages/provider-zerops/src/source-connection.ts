import type { ZeropsApi, ZeropsService, ZeropsServiceEnv } from './api'
import {
	decodeZeropsSourceCredentialBundleV2,
	sha256ZeropsSourceCredentialBundleV2,
	ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION_V2,
	ZEROPS_SOURCE_PROTOCOL_VERSION_V2,
	type ZeropsSourceCredentialActivateResponseV2,
	zeropsSourceCredentialEnvV2,
	type ZeropsSourceCredentialManager,
	type ZeropsSourceCredentialManagerV2,
	type ZeropsSourceCredentialStatusResponseV2,
	type ZeropsSourceGitHubAppIdentityV1,
	type ZeropsSourceInstallationsVerifyInput,
	type ZeropsSourceInstallationsVerifyResponseV1,
	type ZeropsSourceWebhookConfigureInput,
	type ZeropsSourceWebhookConfigureResponseV1,
} from './source'

const SOURCE_HOSTNAME = 'source'
const PROJECT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const DEFAULT_REREAD_ATTEMPTS = 5
const DEFAULT_REREAD_DELAY_MS = 250

export type SourceConnectionInspection =
	| { readonly state: 'unavailable' }
	| { readonly state: 'anonymous' }

export type SourceConnectionStatus =
	| SourceConnectionInspection
	| { readonly state: 'activation-required'; readonly credentialSha256: string }
	| {
		readonly state: 'active'
		readonly credentialSha256: string
		readonly githubApp: ZeropsSourceGitHubAppIdentityV1
	}

export interface SourceConnectionActivateInput {
	readonly connectionId: string
	readonly credentialBundle: string
	readonly credentialSha256: string
	readonly signal: AbortSignal
}

export interface SourceConnectionStatusInput {
	readonly connectionId: string
	readonly signal: AbortSignal
}

/** Provider-neutral lifecycle consumed by the authenticated control connection flow. */
export interface SourceConnectionAdmin {
	inspect(signal: AbortSignal): Promise<SourceConnectionInspection>
	activateV2(input: SourceConnectionActivateInput): Promise<ZeropsSourceCredentialActivateResponseV2>
	statusV2(input: SourceConnectionStatusInput): Promise<SourceConnectionStatus>
	configureWebhook(input: ZeropsSourceWebhookConfigureInput): Promise<ZeropsSourceWebhookConfigureResponseV1>
	verifyInstallations(input: ZeropsSourceInstallationsVerifyInput): Promise<ZeropsSourceInstallationsVerifyResponseV1>
}

export type SourceConnectionZeropsApi = Pick<ZeropsApi, 'findService' | 'listServiceEnv' | 'createServiceEnv'>

export interface ZeropsSourceConnectionAdminOptions {
	readonly api: SourceConnectionZeropsApi
	readonly source: ZeropsSourceCredentialManager & ZeropsSourceCredentialManagerV2
	readonly projectId: string
	readonly reread?: {
		readonly attempts?: number
		readonly delayMs?: number
		readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>
	}
}

export type SourceConnectionAdminErrorCode =
	| 'invalid_configuration'
	| 'source_not_found'
	| 'source_mismatch'
	| 'credential_conflict'
	| 'credential_persistence'
	| 'credential_activation'

/** Stable detail-free failure. It never carries a project id, service id, environment value, or upstream body. */
export class SourceConnectionAdminError extends Error {
	constructor(readonly code: SourceConnectionAdminErrorCode) {
		super(`source connection administration failed (${code})`)
		this.name = 'SourceConnectionAdminError'
	}
}

interface DurableInspectionV2 {
	readonly public:
		| { readonly state: 'anonymous' }
		| { readonly state: 'durable'; readonly credentialSha256: string }
	readonly service: ZeropsService
	readonly environmentKey: string
	readonly bundle?: string
}

export function createZeropsSourceConnectionAdmin(options: ZeropsSourceConnectionAdminOptions): SourceConnectionAdmin {
	if (!PROJECT_ID_PATTERN.test(options.projectId)) throw new SourceConnectionAdminError('invalid_configuration')
	const attempts = options.reread?.attempts ?? DEFAULT_REREAD_ATTEMPTS
	const delayMs = options.reread?.delayMs ?? DEFAULT_REREAD_DELAY_MS
	if (!Number.isSafeInteger(attempts) || attempts <= 0 || attempts > 20 || !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 5_000) {
		throw new SourceConnectionAdminError('invalid_configuration')
	}
	const sleep = options.reread?.sleep ?? defaultSleep

	const readEnvironment = async (signal: AbortSignal): Promise<{ service: ZeropsService; environment: ZeropsServiceEnv[] }> => {
		throwIfAborted(signal)
		const service = await exactSourceService(options.api, options.projectId, signal)
		let environment: ZeropsServiceEnv[]
		try {
			environment = await options.api.listServiceEnv({ serviceId: service.id, signal })
		} catch (error) {
			if (isAbort(error, signal)) throw error
			throw new SourceConnectionAdminError('credential_persistence')
		}
		throwIfAborted(signal)
		return { service, environment }
	}

	const inspectV2Internal = async (connectionId: string, signal: AbortSignal): Promise<DurableInspectionV2> => {
		let environmentKey: string
		try {
			environmentKey = await zeropsSourceCredentialEnvV2(connectionId)
		} catch {
			throw new SourceConnectionAdminError('credential_conflict')
		}
		const current = await readEnvironment(signal)
		return await classifyV2(current.service, current.environment, environmentKey, connectionId)
	}

	const admin: SourceConnectionAdmin = {
		// Proves the exact `source` service AND that this token can read its environment. A setup that
		// cannot do both fails later anyway; the console shows this probe before it starts one.
		inspect: async (signal) => {
			await readEnvironment(signal)
			return { state: 'anonymous' }
		},

		activateV2: async (input) => {
			let digest: string
			try {
				const bundle = decodeZeropsSourceCredentialBundleV2(input.credentialBundle)
				if (bundle.connectionId !== input.connectionId) throw new Error('connection mismatch')
				digest = await sha256ZeropsSourceCredentialBundleV2(input.credentialBundle)
			} catch {
				throw new SourceConnectionAdminError('credential_conflict')
			}
			if (digest !== input.credentialSha256) throw new SourceConnectionAdminError('credential_conflict')
			const initial = await inspectV2Internal(input.connectionId, input.signal)
			if (initial.public.state === 'durable') {
				if (initial.bundle !== input.credentialBundle || initial.public.credentialSha256 !== digest) {
					throw new SourceConnectionAdminError('credential_conflict')
				}
			} else {
				try {
					await options.api.createServiceEnv({
						serviceId: initial.service.id,
						key: initial.environmentKey,
						value: input.credentialBundle,
						signal: input.signal,
					})
				} catch (error) {
					if (isAbort(error, input.signal)) throw error
				}
				await proveDurableV2(input, digest, attempts, delayMs, sleep, inspectV2Internal)
			}
			let activated: ZeropsSourceCredentialActivateResponseV2
			try {
				activated = await options.source.activateV2(input)
			} catch (error) {
				if (isAbort(error, input.signal)) throw error
				let status: ZeropsSourceCredentialStatusResponseV2
				try {
					status = await options.source.statusV2({ connectionId: input.connectionId, signal: input.signal })
				} catch (statusError) {
					if (isAbort(statusError, input.signal)) throw statusError
					throw new SourceConnectionAdminError('credential_activation')
				}
				if (
					status.state !== 'active' || status.connectionId !== input.connectionId || status.credentialSha256 !== digest
				) throw new SourceConnectionAdminError('credential_activation')
				activated = {
					protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION_V2,
					connectionId: input.connectionId,
					credentialVersion: ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION_V2,
					credentialSha256: status.credentialSha256,
					githubApp: status.githubApp,
				}
			}
			if (activated.connectionId !== input.connectionId || activated.credentialSha256 !== digest) {
				throw new SourceConnectionAdminError('credential_activation')
			}
			return activated
		},

		statusV2: async (input) => {
			const durable = await inspectV2Internal(input.connectionId, input.signal)
			if (durable.public.state !== 'durable') return durable.public
			let runtime: ZeropsSourceCredentialStatusResponseV2
			try {
				runtime = await options.source.statusV2(input)
			} catch (error) {
				if (isAbort(error, input.signal)) throw error
				throw new SourceConnectionAdminError('credential_activation')
			}
			if (runtime.connectionId !== input.connectionId || runtime.state === 'anonymous') {
				return { state: 'activation-required', credentialSha256: durable.public.credentialSha256 }
			}
			if (runtime.credentialSha256 !== durable.public.credentialSha256) {
				throw new SourceConnectionAdminError('credential_conflict')
			}
			return { state: 'active', credentialSha256: runtime.credentialSha256, githubApp: runtime.githubApp }
		},

		configureWebhook: async (input) => {
			await requireDurableDigest(input.connectionId, input.credentialSha256, input.signal, inspectV2Internal)
			try {
				const response = await options.source.configureWebhook(input)
				if (
					response.connectionId !== input.connectionId || response.credentialSha256 !== input.credentialSha256
					|| response.webhook.url !== input.url || response.webhook.contentType !== 'json' || response.webhook.insecureSsl !== '0'
				) throw new SourceConnectionAdminError('credential_activation')
				return response
			} catch (error) {
				if (isAbort(error, input.signal)) throw error
				if (error instanceof SourceConnectionAdminError) throw error
				throw new SourceConnectionAdminError('credential_activation')
			}
		},

		verifyInstallations: async (input) => {
			await requireDurableDigest(input.connectionId, input.credentialSha256, input.signal, inspectV2Internal)
			try {
				const response = await options.source.verifyInstallations(input)
				if (response.connectionId !== input.connectionId || response.credentialSha256 !== input.credentialSha256) {
					throw new SourceConnectionAdminError('credential_activation')
				}
				return response
			} catch (error) {
				if (isAbort(error, input.signal)) throw error
				if (error instanceof SourceConnectionAdminError) throw error
				throw new SourceConnectionAdminError('credential_activation')
			}
		},
	}
	return admin
}

async function requireDurableDigest(
	connectionId: string,
	digest: string,
	signal: AbortSignal,
	inspectV2: (connectionId: string, signal: AbortSignal) => Promise<DurableInspectionV2>,
): Promise<void> {
	const keyed = await inspectV2(connectionId, signal)
	if (keyed.public.state !== 'durable' || keyed.public.credentialSha256 !== digest) {
		throw new SourceConnectionAdminError('credential_conflict')
	}
}

async function exactSourceService(api: SourceConnectionZeropsApi, projectId: string, signal: AbortSignal): Promise<ZeropsService> {
	let service: ZeropsService | null
	try {
		service = await api.findService({ projectId, hostname: SOURCE_HOSTNAME, signal })
	} catch (error) {
		if (isAbort(error, signal)) throw error
		throw new SourceConnectionAdminError('source_not_found')
	}
	if (service === null) throw new SourceConnectionAdminError('source_not_found')
	if (service.id === '' || service.name !== SOURCE_HOSTNAME || service.projectId !== projectId) {
		throw new SourceConnectionAdminError('source_mismatch')
	}
	return service
}

async function classifyV2(
	service: ZeropsService,
	environment: readonly ZeropsServiceEnv[],
	environmentKey: string,
	connectionId: string,
): Promise<DurableInspectionV2> {
	const entries = environment.filter((entry) => entry.key === environmentKey)
	if (entries.length > 1) throw new SourceConnectionAdminError('credential_conflict')
	if (entries.length === 0) return { public: { state: 'anonymous' }, service, environmentKey }
	const bundle = entries[0]?.content
	if (bundle === undefined) throw new SourceConnectionAdminError('credential_conflict')
	try {
		const decoded = decodeZeropsSourceCredentialBundleV2(bundle)
		if (decoded.connectionId !== connectionId) throw new Error('connection mismatch')
		return {
			public: { state: 'durable', credentialSha256: await sha256ZeropsSourceCredentialBundleV2(bundle) },
			service,
			environmentKey,
			bundle,
		}
	} catch {
		throw new SourceConnectionAdminError('credential_conflict')
	}
}

async function proveDurableV2(
	input: SourceConnectionActivateInput,
	digest: string,
	attempts: number,
	delayMs: number,
	sleep: (delayMs: number, signal: AbortSignal) => Promise<void>,
	inspect: (connectionId: string, signal: AbortSignal) => Promise<DurableInspectionV2>,
): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		const durable = await inspect(input.connectionId, input.signal)
		if (durable.public.state === 'durable') {
			if (durable.bundle === input.credentialBundle && durable.public.credentialSha256 === digest) return
			throw new SourceConnectionAdminError('credential_conflict')
		}
		if (attempt + 1 < attempts) await sleep(delayMs, input.signal)
	}
	throw new SourceConnectionAdminError('credential_persistence')
}

const defaultSleep = (delayMs: number, signal: AbortSignal): Promise<void> => {
	throwIfAborted(signal)
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup()
			resolve()
		}, delayMs)
		const abort = (): void => {
			cleanup()
			reject(abortError())
		}
		const cleanup = (): void => {
			clearTimeout(timer)
			signal.removeEventListener('abort', abort)
		}
		signal.addEventListener('abort', abort, { once: true })
	})
}

const throwIfAborted = (signal: AbortSignal): void => {
	if (signal.aborted) throw abortError()
}

const isAbort = (error: unknown, signal: AbortSignal): boolean => signal.aborted || (error instanceof Error && error.name === 'AbortError')

const abortError = (): DOMException => new DOMException('Source connection administration was aborted', 'AbortError')
