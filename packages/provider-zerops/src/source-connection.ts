import type { ZeropsApi, ZeropsService, ZeropsServiceEnv } from './api'
import {
	buildZeropsSourceCredentialBundle,
	decodeZeropsSourceCredentialBundle,
	serializeZeropsSourceCredentialBundle,
	sha256ZeropsSourceCredentialBundle,
	type ZeropsSourceCredentialActivateResponseV1,
	type ZeropsSourceCredentialManager,
	type ZeropsSourceCredentialStatusResponseV1,
	type ZeropsSourceGitHubAppIdentityV1,
	type ZeropsSourceInstallationsVerifyInput,
	type ZeropsSourceInstallationsVerifyResponseV1,
	type ZeropsSourceWebhookConfigureInput,
	type ZeropsSourceWebhookConfigureResponseV1,
} from './source'

export const ZEROPS_SOURCE_CREDENTIAL_ENV = 'GITHUB_APP_CREDENTIALS'
export const ZEROPS_SOURCE_LEGACY_APP_ID_ENV = 'GITHUB_APP_ID'
export const ZEROPS_SOURCE_LEGACY_PRIVATE_KEY_ENV = 'GITHUB_APP_PRIVATE_KEY'

const SOURCE_HOSTNAME = 'source'
const MAX_ENV_ENTRIES = 256
const PROJECT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const DEFAULT_REREAD_ATTEMPTS = 5
const DEFAULT_REREAD_DELAY_MS = 250
const ADOPTION_CONNECTION_DOMAIN = 'fabrika:zerops-source-connection:v1'

export type SourceConnectionInspection =
	| { readonly state: 'unavailable' }
	| { readonly state: 'anonymous' }
	| { readonly state: 'legacy-complete' }
	| { readonly state: 'legacy-partial' }
	| { readonly state: 'durable'; readonly credentialSha256: string }

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

export interface SourceConnectionAdoptExistingInput {
	readonly signal: AbortSignal
}

/** Provider-neutral lifecycle consumed by the future authenticated control connection flow. */
export interface SourceConnectionAdmin {
	inspect(signal: AbortSignal): Promise<SourceConnectionInspection>
	adoptExisting(input: SourceConnectionAdoptExistingInput): Promise<ZeropsSourceCredentialActivateResponseV1>
	activate(input: SourceConnectionActivateInput): Promise<ZeropsSourceCredentialActivateResponseV1>
	status(input: SourceConnectionStatusInput): Promise<SourceConnectionStatus>
	configureWebhook(input: ZeropsSourceWebhookConfigureInput): Promise<ZeropsSourceWebhookConfigureResponseV1>
	verifyInstallations(input: ZeropsSourceInstallationsVerifyInput): Promise<ZeropsSourceInstallationsVerifyResponseV1>
}

export type SourceConnectionZeropsApi = Pick<ZeropsApi, 'findService' | 'listServiceEnv' | 'createServiceEnv'>

export interface ZeropsSourceConnectionAdminOptions {
	readonly api: SourceConnectionZeropsApi
	readonly source: ZeropsSourceCredentialManager
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

interface DurableInspection {
	readonly public: SourceConnectionInspection
	readonly service: ZeropsService
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

	const inspectInternal = async (signal: AbortSignal): Promise<DurableInspection> => {
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
		return await withDigest(classify(service, environment))
	}

	const admin: SourceConnectionAdmin = {
		inspect: async (signal) => (await inspectInternal(signal)).public,

		adoptExisting: async (input) => {
			const existing = await inspectInternal(input.signal)
			if (
				(existing.public.state !== 'legacy-complete' && existing.public.state !== 'durable')
				|| existing.bundle === undefined
			) throw new SourceConnectionAdminError('credential_conflict')
			let credentialSha256: string
			try {
				credentialSha256 = existing.public.state === 'durable'
					? existing.public.credentialSha256
					: await sha256ZeropsSourceCredentialBundle(existing.bundle)
			} catch {
				throw new SourceConnectionAdminError('credential_conflict')
			}
			return await admin.activate({
				connectionId: await adoptionConnectionId(options.projectId, credentialSha256),
				credentialBundle: existing.bundle,
				credentialSha256,
				signal: input.signal,
			})
		},

		activate: async (input) => {
			let digest: string
			try {
				decodeZeropsSourceCredentialBundle(input.credentialBundle)
				digest = await sha256ZeropsSourceCredentialBundle(input.credentialBundle)
			} catch {
				throw new SourceConnectionAdminError('credential_conflict')
			}
			if (digest !== input.credentialSha256) throw new SourceConnectionAdminError('credential_conflict')
			const initial = await inspectInternal(input.signal)
			if (initial.public.state === 'legacy-partial' || initial.public.state === 'unavailable') {
				throw new SourceConnectionAdminError('credential_conflict')
			}
			if (initial.public.state === 'durable') {
				if (initial.bundle !== input.credentialBundle || initial.public.credentialSha256 !== digest) {
					throw new SourceConnectionAdminError('credential_conflict')
				}
			} else {
				if (initial.public.state === 'legacy-complete' && initial.bundle !== input.credentialBundle) {
					throw new SourceConnectionAdminError('credential_conflict')
				}
				try {
					await options.api.createServiceEnv({
						serviceId: initial.service.id,
						key: ZEROPS_SOURCE_CREDENTIAL_ENV,
						value: input.credentialBundle,
						signal: input.signal,
					})
				} catch (error) {
					if (isAbort(error, input.signal)) throw error
				}
				await proveDurable(input.credentialBundle, digest, input.signal, attempts, delayMs, sleep, inspectInternal)
			}
			let activated: ZeropsSourceCredentialActivateResponseV1
			try {
				activated = await options.source.activate(input)
			} catch (error) {
				if (isAbort(error, input.signal)) throw error
				let status: ZeropsSourceCredentialStatusResponseV1
				try {
					status = await options.source.status({ connectionId: input.connectionId, signal: input.signal })
				} catch (statusError) {
					if (isAbort(statusError, input.signal)) throw statusError
					throw new SourceConnectionAdminError('credential_activation')
				}
				if (
					status.state !== 'active' || status.connectionId !== input.connectionId || status.credentialSha256 !== digest
				) throw new SourceConnectionAdminError('credential_activation')
				activated = {
					protocolVersion: 1,
					connectionId: input.connectionId,
					credentialVersion: status.credentialVersion,
					credentialSha256: status.credentialSha256,
					githubApp: status.githubApp,
				}
			}
			if (activated.connectionId !== input.connectionId || activated.credentialSha256 !== digest) {
				throw new SourceConnectionAdminError('credential_activation')
			}
			return activated
		},

		status: async (input) => {
			const durable = await inspectInternal(input.signal)
			if (durable.public.state !== 'durable') return durable.public
			let runtime: ZeropsSourceCredentialStatusResponseV1
			try {
				runtime = await options.source.status(input)
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
			await requireDurableDigest(input.credentialSha256, input.signal, inspectInternal)
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
			await requireDurableDigest(input.credentialSha256, input.signal, inspectInternal)
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

async function adoptionConnectionId(projectId: string, credentialSha256: string): Promise<string> {
	const material = `${ADOPTION_CONNECTION_DOMAIN}\0${projectId}\0${credentialSha256}`
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material)))
	return `zsrc-${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

async function requireDurableDigest(
	digest: string,
	signal: AbortSignal,
	inspect: (signal: AbortSignal) => Promise<DurableInspection>,
): Promise<void> {
	const durable = await inspect(signal)
	if (durable.public.state !== 'durable' || durable.public.credentialSha256 !== digest) {
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

function classify(service: ZeropsService, environment: readonly ZeropsServiceEnv[]): DurableInspection {
	if (environment.length > MAX_ENV_ENTRIES) throw new SourceConnectionAdminError('source_mismatch')
	const bundleEntries = environment.filter((entry) => entry.key === ZEROPS_SOURCE_CREDENTIAL_ENV)
	const legacyIdEntries = environment.filter((entry) => entry.key === ZEROPS_SOURCE_LEGACY_APP_ID_ENV)
	const legacyKeyEntries = environment.filter((entry) => entry.key === ZEROPS_SOURCE_LEGACY_PRIVATE_KEY_ENV)
	if (bundleEntries.length > 1 || legacyIdEntries.length > 1 || legacyKeyEntries.length > 1) {
		throw new SourceConnectionAdminError('credential_conflict')
	}
	const legacyCount = legacyIdEntries.length + legacyKeyEntries.length
	let legacyBundle: string | undefined
	if (legacyIdEntries.length === 1 && legacyKeyEntries.length === 1) {
		const legacyAppId = legacyIdEntries[0]?.content
		const legacyPrivateKeyPem = legacyKeyEntries[0]?.content
		if (legacyAppId === undefined || legacyPrivateKeyPem === undefined) throw new SourceConnectionAdminError('credential_conflict')
		try {
			legacyBundle = serializeZeropsSourceCredentialBundle(buildZeropsSourceCredentialBundle({
				githubAppId: legacyAppId,
				privateKeyPem: legacyPrivateKeyPem,
			}))
		} catch {
			throw new SourceConnectionAdminError('credential_conflict')
		}
	}
	if (bundleEntries.length === 1) {
		if (legacyCount !== 0 && legacyBundle === undefined) throw new SourceConnectionAdminError('credential_conflict')
		const bundle = bundleEntries[0]?.content
		if (bundle === undefined) throw new SourceConnectionAdminError('credential_conflict')
		try {
			decodeZeropsSourceCredentialBundle(bundle)
		} catch {
			throw new SourceConnectionAdminError('credential_conflict')
		}
		if (legacyBundle !== undefined && legacyBundle !== bundle) throw new SourceConnectionAdminError('credential_conflict')
		return { public: { state: 'durable', credentialSha256: '' }, service, bundle }
	}
	if (legacyCount === 0) return { public: { state: 'anonymous' }, service }
	if (legacyBundle !== undefined) return { public: { state: 'legacy-complete' }, service, bundle: legacyBundle }
	return { public: { state: 'legacy-partial' }, service }
}

async function withDigest(inspection: DurableInspection): Promise<DurableInspection> {
	if (inspection.public.state !== 'durable' || inspection.bundle === undefined) return inspection
	return {
		...inspection,
		public: { state: 'durable', credentialSha256: await sha256ZeropsSourceCredentialBundle(inspection.bundle) },
	}
}

async function proveDurable(
	bundle: string,
	digest: string,
	signal: AbortSignal,
	attempts: number,
	delayMs: number,
	sleep: (delayMs: number, signal: AbortSignal) => Promise<void>,
	inspect: (signal: AbortSignal) => Promise<DurableInspection>,
): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		const durable = await withDigest(await inspect(signal))
		if (durable.public.state === 'durable') {
			if (durable.bundle === bundle && durable.public.credentialSha256 === digest) return
			throw new SourceConnectionAdminError('credential_conflict')
		}
		if (durable.public.state !== 'anonymous') throw new SourceConnectionAdminError('credential_conflict')
		if (attempt + 1 < attempts) await sleep(delayMs, signal)
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
