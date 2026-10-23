import { followLeaseLoss, isLeaseLoss, ProviderNamespaceError } from '@fabrika/provider-contract'
import type { InstallationBrand } from '@fabrika/proxy-core/brand'
import { encodeProxyManifestJson, FABRIKA_PROXY_MANIFEST_JSON, type ProxyManifest } from '@fabrika/proxy-core/manifest'
import {
	readableContent,
	ZEROPS_ACTIVE,
	ZEROPS_TERMINAL,
	type ZeropsApi,
	ZeropsApiError,
	type ZeropsAppVersion,
	ZeropsServiceEnvValueTooLargeError,
} from '../api'
import type { Sleeper } from '../collaborators'
import { prepareZeropsDescriptor } from '../descriptor'
import {
	ZEROPS_PROXY_MANIFEST_PATH,
	zeropsProxyAcceptsBrand,
	type ZeropsProxyManifestCarrier,
	zeropsProxyManifestCarrier,
} from '../proxy-manifest-carrier'
import { isZeropsUploadDestination } from '../source'
import type { ZeropsSourcePort } from '../source/port'
import { deleteVersion } from '../version-attempt'
import { ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE, ZEROPS_NAMESPACE_IAM_KEY_VARIABLE } from './constants'
import { verifyZeropsNamespaceProxySource } from './proxy-source'
import type { ZeropsNamespaceProxyBuild, ZeropsNamespaceTarget } from './types'

export type ZeropsProxyApi = Pick<
	ZeropsApi,
	| 'listServiceEnv'
	| 'putServiceEnv'
	| 'deleteServiceEnv'
	| 'createAppVersion'
	| 'deleteAppVersion'
	| 'buildAndDeployAppVersion'
	| 'getAppVersion'
>

export interface ZeropsProxyRepublishInput {
	/** The namespace's id, named in the one refusal an operator acts on: re-pin it. */
	readonly namespaceId: string
	readonly target: ZeropsNamespaceTarget
	readonly manifest: ProxyManifest
	/** The installation's client logo (ADR-0066); added to the manifest only when the pinned proxy can parse it. */
	readonly brand?: InstallationBrand | null
	readonly source?: ZeropsSourcePort
	readonly api: ZeropsProxyApi
	readonly iamUrl: string
	readonly iamKey: string
	/** Proxy service variable → the secret of one contract application (`namespaceProxySecrets`); none without one. */
	readonly proxySecrets?: ReadonlyMap<string, string>
	/** Aborts with `lease_lost` when the namespace lease goes, and with `cancel_requested` when a deploy is cancelled. */
	readonly signal: AbortSignal
	readonly wait: 'started' | 'active'
	/** Persist the target; the caller fences the write on the namespace lease. */
	readonly checkpoint: (target: ZeropsNamespaceTarget) => Promise<void>
	readonly boundary: () => Promise<void>
	readonly sleep: Sleeper
}

const POLL_INTERVAL_MS = 3000
const POLL_DEADLINE_MS = 70 * 60 * 1000
const USER_DATA_SYNC_ATTEMPTS = 10
const SESSION_OWNER_VARIABLE = 'FABRIKA_PROXY_SESSION_OWNER_JSON'

const unresolved = (id: string): ProviderNamespaceError =>
	new ProviderNamespaceError(`Proxy version ${id} remains unresolved; reconcile this namespace before another build`, 'proxyAttemptUnresolved', true)

const digest = async (text: string): Promise<string> =>
	Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join(
		'',
	)

const writeProxyIam = async (input: ZeropsProxyRepublishInput, serviceId: string, carrier: ZeropsProxyManifestCarrier): Promise<void> => {
	const { api, signal } = input
	const variables = await api.listServiceEnv({ serviceId, signal })
	// The archive carries the manifest now; a copy left in the environment would describe nothing the proxy serves.
	const stale = variables.find(variable => variable.key === FABRIKA_PROXY_MANIFEST_JSON)
	if (carrier === 'archive' && stale !== undefined) {
		await api.deleteServiceEnv({ envId: stale.id, signal })
	}
	if (readableContent(variables.find(variable => variable.key === SESSION_OWNER_VARIABLE)) !== 'null') {
		await api.putServiceEnv({ serviceId, key: SESSION_OWNER_VARIABLE, value: 'null', sensitive: false, signal })
	}
	if (readableContent(variables.find(variable => variable.key === ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE)) !== input.iamUrl) {
		await api.putServiceEnv({ serviceId, key: ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE, value: input.iamUrl, sensitive: false, signal })
	}
	// A secret cannot be read back, so it is overwritten without inspecting its value.
	await api.putServiceEnv({ serviceId, key: ZEROPS_NAMESPACE_IAM_KEY_VARIABLE, value: input.iamKey, sensitive: true, signal })
	for (const [key, value] of input.proxySecrets ?? []) {
		await api.putServiceEnv({ serviceId, key, value, sensitive: true, signal })
	}
}

/** One line per secret, sorted, so the attempt's identity changes when any secret does and never carries one. */
const proxySecretsDigest = async (secrets: ReadonlyMap<string, string>): Promise<string> =>
	digest([...secrets].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, value]) => `${key}=${value}`).join('\n'))

/**
 * Rebuild the namespace proxy with `manifest` (ADR-0044). The attempt is recorded as `proxyBuild` and never
 * resumed: an inherited attempt not yet `triggered` is deleted, a triggered one is polled to a terminal state.
 * A lost lease deletes nothing; a cancelled deploy leaves a triggered attempt recorded for reconciliation.
 */
export async function republishProxy(input: ZeropsProxyRepublishInput): Promise<ZeropsNamespaceTarget> {
	const pin = input.target.proxySource
	const serviceId = input.target.proxyServiceId
	if (serviceId === undefined) throw new Error('Zerops namespace has no proxy service id')
	await verifyZeropsNamespaceProxySource(pin)
	// The pinned descriptor decides: a namespace kept on an older proxy revision still lifts the variable (ADR-0045).
	const carrier = zeropsProxyManifestCarrier(pin.descriptor.contents)
	// So does it for the logo: an older parser refuses the key, and the namespace keeps the mark until it is re-pinned.
	const brand = input.brand ?? null
	const manifest = encodeProxyManifestJson(
		brand !== null && zeropsProxyAcceptsBrand(pin.descriptor.contents) ? { ...input.manifest, brand } : input.manifest,
	)
	// The attempt's identity covers the IAM configuration and the proxy secrets too, so rotating any forces a rebuild.
	const proxySecrets = input.proxySecrets ?? new Map<string, string>()
	const secrets = proxySecrets.size === 0 ? '' : `\n${await proxySecretsDigest(proxySecrets)}`
	const manifestSha256 = await digest(`${manifest}\n${input.iamUrl}\n${await digest(input.iamKey)}${secrets}`)
	let target = input.target

	const save = async (next: ZeropsNamespaceTarget): Promise<void> => {
		await input.checkpoint(next)
		target = next
	}

	/** Observe one version until terminal; with `started`, a running build of this manifest is answer enough. */
	const settle = async (build: ZeropsNamespaceProxyBuild): Promise<'settled' | 'running'> => {
		const deadline = Date.now() + POLL_DEADLINE_MS
		for (;;) {
			await input.boundary()
			input.signal.throwIfAborted()
			let version: ZeropsAppVersion
			try {
				version = await input.api.getAppVersion({ appVersionId: build.appVersionId, signal: input.signal })
			} catch {
				input.signal.throwIfAborted()
				throw unresolved(build.appVersionId)
			}
			if (
				version.id !== build.appVersionId || (version.serviceStackId !== undefined && version.serviceStackId !== serviceId)
				|| (version.projectId !== undefined && target.projectId !== undefined && version.projectId !== target.projectId)
			) throw unresolved(build.appVersionId)
			if (version.status !== undefined && ZEROPS_TERMINAL.has(version.status)) {
				const active = version.status === ZEROPS_ACTIVE
				await save({
					...target,
					proxyBuild: undefined,
					...(active
						? {
							proxyDeployment: {
								appVersionId: version.id,
								repository: pin.repository,
								commitSha: pin.commitSha,
								descriptorSha256: pin.descriptor.sha256,
								...(build.manifestSha256 === undefined ? {} : { manifestSha256: build.manifestSha256 }),
							},
						}
						: { ready: false }),
				})
				if (!active) throw new ProviderNamespaceError(`Proxy version ${version.id} finished as ${version.status}`, 'proxyDeployFailed', false)
				return 'settled'
			}
			if (input.wait === 'started') {
				if (build.manifestSha256 === manifestSha256 && version.status !== 'UPLOADING') return 'running'
				throw unresolved(build.appVersionId)
			}
			if (Date.now() >= deadline) throw unresolved(build.appVersionId)
			await input.sleep(POLL_INTERVAL_MS, input.signal)
		}
	}

	const inherited = target.proxyBuild
	if (inherited !== undefined && !inherited.triggered) {
		input.signal.throwIfAborted()
		try {
			await deleteVersion(input.api, inherited.appVersionId, input.signal)
		} catch {
			input.signal.throwIfAborted()
			throw unresolved(inherited.appVersionId)
		}
		await save({ ...target, proxyBuild: undefined })
	} else if (inherited !== undefined) {
		if (await settle(inherited) === 'running') return target
		if (inherited.manifestSha256 === manifestSha256) return target
	}

	if (input.source === undefined) throw new Error('Zerops namespace source client is required')
	const runId = crypto.randomUUID()
	const resolved = await input.source.resolve({
		repository: pin.repository,
		requestedRef: pin.commitSha,
		expectedCommitSha: pin.commitSha,
		descriptorSha256: pin.descriptor.sha256,
		signal: input.signal,
	})
	if (resolved.commitSha !== pin.commitSha || resolved.descriptorSha256 !== pin.descriptor.sha256) {
		throw new Error('Proxy source resolution identity mismatch')
	}
	await input.boundary()
	if (carrier === 'environment') {
		try {
			await input.api.putServiceEnv({ serviceId, key: FABRIKA_PROXY_MANIFEST_JSON, value: manifest, sensitive: false, signal: input.signal })
		} catch (cause) {
			if (!(cause instanceof ZeropsServiceEnvValueTooLargeError)) throw cause
			throw new ProviderNamespaceError(
				`${cause.message}. The namespace's proxy source predates the manifest file in the build archive; re-pin it with `
					+ `\`fabrika control namespaces update --namespace=${input.namespaceId} --proxy-source=current\``,
				cause.code,
				false,
			)
		}
	}
	await writeProxyIam(input, serviceId, carrier)
	input.signal.throwIfAborted()
	const reserved = await input.api.createAppVersion({ serviceId, name: runId, signal: input.signal })
	let build: ZeropsNamespaceProxyBuild = { appVersionId: reserved.id, triggered: false, manifestSha256 }
	let accepted = false
	try {
		await save({ ...target, proxyBuild: build })
		input.signal.throwIfAborted()
		if (!isZeropsUploadDestination(reserved.uploadUrl)) throw new Error(`Proxy version ${reserved.id} has an unexpected upload destination`)
		const uploaded = await input.source.upload({
			repository: pin.repository,
			commitSha: pin.commitSha,
			descriptorSha256: pin.descriptor.sha256,
			archive: carrier === 'archive'
				? { kind: 'platform', dataFile: { path: ZEROPS_PROXY_MANIFEST_PATH, contents: manifest } }
				: { kind: 'platform' },
			uploadUrl: reserved.uploadUrl,
			signal: input.signal,
		})
		const expectedDataFile = carrier === 'archive' ? await digest(manifest) : undefined
		if (
			uploaded.commitSha !== pin.commitSha || uploaded.descriptorSha256 !== pin.descriptor.sha256
			|| uploaded.dataFileSha256 !== expectedDataFile
		) {
			throw new Error('Proxy source upload identity mismatch')
		}
		const descriptor = prepareZeropsDescriptor(pin.descriptor.contents, 'proxy')
		// Once triggered, only a lost lease stops the build request; a cancelled deploy leaves it to reconcile.
		const buildSignal = followLeaseLoss(input.signal)
		for (let attempt = 1;; attempt++) {
			await input.boundary()
			build = { ...build, triggered: true }
			await save({ ...target, proxyBuild: build })
			buildSignal.throwIfAborted()
			try {
				const process = await input.api.buildAndDeployAppVersion({
					appVersionId: reserved.id,
					zeropsYaml: descriptor.contents,
					zeropsYamlSetup: 'proxy',
					signal: buildSignal,
				})
				if (process.appVersionId !== undefined && process.appVersionId !== reserved.id) throw unresolved(reserved.id)
				accepted = true
				break
			} catch (cause) {
				buildSignal.throwIfAborted()
				if (!(cause instanceof ZeropsApiError && cause.status === 400 && cause.code === 'userDataSyncRunning')) break
				// A definitive refusal: the version is inert again, so a failure from here deletes it.
				build = { ...build, triggered: false }
				await save({ ...target, proxyBuild: build })
				if (attempt >= USER_DATA_SYNC_ATTEMPTS) {
					throw new ProviderNamespaceError(`Proxy version ${reserved.id}: service variables are still synchronizing`, 'userDataSyncRunning', true)
				}
				await input.sleep(POLL_INTERVAL_MS, input.signal)
			}
		}
	} catch (cause) {
		if (!build.triggered && !isLeaseLoss(input.signal.reason) && !isLeaseLoss(cause)) {
			const cleanup = AbortSignal.any([followLeaseLoss(input.signal), AbortSignal.timeout(30_000)])
			try {
				await deleteVersion(input.api, reserved.id, cleanup)
				await save({ ...target, proxyBuild: undefined })
			} catch {
				// The recorded attempt is deleted by the next owner.
			}
		}
		throw cause
	}
	if (input.wait === 'started' && accepted) return target
	await settle(build)
	return target
}
