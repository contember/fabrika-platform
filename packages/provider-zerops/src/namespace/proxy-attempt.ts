import { ProviderInvocationAbort, ProviderNamespaceError } from '@fabrika/provider-contract'
import { encodeProxyManifestJson, FABRIKA_PROXY_MANIFEST_JSON, parseProxyManifestJson } from '@fabrika/proxy-contract'
import { ZEROPS_ACTIVE, ZEROPS_TERMINAL, type ZeropsApi, ZeropsApiError, type ZeropsAppVersion } from '../api'
import { defaultSleep, type Sleeper } from '../collaborators'
import { prepareZeropsDescriptor } from '../descriptor'
import type { ZeropsSourceClient } from '../source'
import { ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE, ZEROPS_NAMESPACE_IAM_KEY_VARIABLE } from './constants'
import { equalProxySources, verifyZeropsNamespaceProxySource } from './proxy-source'
import type { NamespaceProxyIamInput, ZeropsNamespaceTarget } from './types'

export type ZeropsProxyAttemptApi = Pick<
	ZeropsApi,
	'listServiceEnv' | 'putServiceEnv' | 'createAppVersion' | 'deleteAppVersion' | 'buildAndDeployAppVersion' | 'getAppVersion' | 'cancelBuild'
>

export interface ZeropsProxyAttemptInput {
	readonly target: ZeropsNamespaceTarget
	readonly manifest: string
	readonly source?: ZeropsSourceClient
	readonly api: ZeropsProxyAttemptApi
	readonly iamUrl: string
	readonly iamKey: string
	readonly signal: AbortSignal
	readonly ownershipSignal?: AbortSignal
	/** Explicit syncs activate IAM configuration even when source and routing are unchanged. */
	readonly refresh?: boolean
	readonly checkpoint: (target: ZeropsNamespaceTarget) => Promise<void>
	readonly wait?: 'started' | 'active'
	readonly sleep?: Sleeper
}

const unresolved = (id: string): ProviderNamespaceError =>
	new ProviderNamespaceError(
		`Proxy version ${id} remains unresolved; reconcile this namespace before another build`,
		'proxyAttemptUnresolved',
		true,
	)
const digest = async (text: string): Promise<string> =>
	Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join(
		'',
	)

export const ensureNamespaceProxyIam = async (input: NamespaceProxyIamInput): Promise<void> => {
	const variables = await input.api.listServiceEnv({ serviceId: input.proxyServiceId, signal: input.signal })
	const issuer = variables.find(variable => variable.key === ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE)
	if (issuer?.content !== input.iamUrl) {
		await input.api.putServiceEnv({
			serviceId: input.proxyServiceId,
			key: ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE,
			value: input.iamUrl,
			signal: input.signal,
		})
	}
	// Secret read-back is not trustworthy, so overwrite it without inspecting its value.
	await input.api.putServiceEnv({ serviceId: input.proxyServiceId, key: ZEROPS_NAMESPACE_IAM_KEY_VARIABLE, value: input.iamKey, signal: input.signal })
}

/** Caller holds the renewable namespace lease and persists every checkpoint with a fenced CAS. */
export async function runZeropsProxyAttempt(input: ZeropsProxyAttemptInput): Promise<ZeropsNamespaceTarget> {
	let target = input.target
	let settledAttempt = false
	let inheritedAttempt = target.proxyBuild !== undefined
	const pin = target.proxySource
	const serviceId = target.proxyServiceId
	if (pin === undefined) throw new Error('Zerops namespace proxy source is unpinned; explicit migration is required')
	await verifyZeropsNamespaceProxySource(pin)
	if (serviceId === undefined) throw new Error('Zerops namespace has no proxy service id')
	if (target.proxyBuild !== undefined && !equalProxySources(pin, target.proxyBuild.source)) {
		throw new Error('Proxy build source conflicts with namespace pin')
	}
	input.signal.throwIfAborted()
	const parsedManifest = parseProxyManifestJson(input.manifest)
	if (parsedManifest === null) throw new Error('Invalid namespace proxy manifest')
	const manifest = encodeProxyManifestJson(parsedManifest)
	const manifestSha256 = await digest(manifest)
	const sleep = input.sleep ?? defaultSleep
	const leaseLost = (): boolean =>
		input.ownershipSignal?.aborted === true
		|| (input.signal.reason instanceof ProviderInvocationAbort && input.signal.reason.kind === 'lease_lost')
	const cleanupSignal = (ms: number): AbortSignal =>
		input.ownershipSignal === undefined
			? AbortSignal.timeout(ms)
			: AbortSignal.any([input.ownershipSignal, AbortSignal.timeout(ms)])
	const save = async (next: ZeropsNamespaceTarget, ownershipOnly = false): Promise<void> => {
		if (leaseLost()) throw new ProviderInvocationAbort('lease_lost')
		if (!ownershipOnly) input.signal.throwIfAborted()
		await input.checkpoint(next)
		target = next
		if (leaseLost()) throw new ProviderInvocationAbort('lease_lost')
		if (!ownershipOnly) input.signal.throwIfAborted()
	}
	const observe = async (id: string, wait: boolean) => {
		const deadline = Date.now() + 70 * 60 * 1000
		for (;;) {
			input.signal.throwIfAborted()
			let version: ZeropsAppVersion
			try {
				version = await input.api.getAppVersion({ appVersionId: id, signal: input.signal })
			} catch {
				input.signal.throwIfAborted()
				throw unresolved(id)
			}
			if (
				version.id !== id || (version.serviceStackId !== undefined && version.serviceStackId !== serviceId)
				|| (version.projectId !== undefined && target.projectId !== undefined && version.projectId !== target.projectId)
			) throw unresolved(id)
			if (version.status !== undefined && ZEROPS_TERMINAL.has(version.status)) return version
			if (!wait || Date.now() >= deadline) throw unresolved(id)
			await sleep(3000, input.signal)
		}
	}
	const settle = async (): Promise<void> => {
		const build = target.proxyBuild
		if (build === undefined) return
		const version = await observe(build.appVersionId, input.wait !== 'started')
		await save({
			...target,
			proxyBuild: undefined,
			ready: version.status === ZEROPS_ACTIVE ? target.ready : false,
			proxyDeployment: version.status === ZEROPS_ACTIVE
				? {
					appVersionId: version.id,
					repository: pin.repository,
					commitSha: pin.commitSha,
					descriptorSha256: pin.descriptor.sha256,
					...(build.manifestSha256 === undefined ? {} : { manifestSha256: build.manifestSha256 }),
				}
				: undefined,
		})
		if (version.status !== ZEROPS_ACTIVE) {
			throw new ProviderNamespaceError(`Proxy version ${version.id} finished as ${version.status}`, 'proxyDeployFailed', false)
		}
		settledAttempt = true
	}
	const discardInert = async (): Promise<void> => {
		const build = target.proxyBuild
		if (build === undefined) return
		// Source cancellation is best effort; only exact version absence settles an inert reservation.
		if (leaseLost()) throw new ProviderInvocationAbort('lease_lost')
		// Persist cleanup intent before deletion, so a crash cannot leave a deleted version marked as submitted.
		if (build.phase !== 'version_created') await save({ ...target, proxyBuild: { ...build, phase: 'version_created', processId: undefined } }, true)
		if (input.source === undefined) throw unresolved(build.appVersionId)
		const cancellation = new AbortController()
		const timeout = new AbortController()
		try {
			const source = input.source
			await Promise.race([
				Promise.resolve().then(() =>
					source.cancel({ runId: build.runId, appVersionId: build.appVersionId, signal: AbortSignal.any([cleanupSignal(5000), cancellation.signal]) })
				).catch(() => {}),
				sleep(5000, timeout.signal).catch(() => {}),
			])
		} finally {
			timeout.abort()
			cancellation.abort()
		}
		if (leaseLost()) throw new ProviderInvocationAbort('lease_lost')
		const signal = cleanupSignal(30_000)
		try {
			await input.api.deleteAppVersion({ appVersionId: build.appVersionId, signal })
		} catch (cause) {
			if (!(cause instanceof ZeropsApiError && cause.status === 400 && cause.code === 'appVersionNotFound')) throw unresolved(build.appVersionId)
		}
		if (leaseLost()) throw new ProviderInvocationAbort('lease_lost')
		let absent = false
		try {
			await input.api.getAppVersion({ appVersionId: build.appVersionId, signal })
		} catch (cause) {
			absent = cause instanceof ZeropsApiError && cause.status === 400 && cause.code === 'appVersionNotFound'
		}
		if (!absent) throw unresolved(build.appVersionId)
		await save({ ...target, proxyBuild: undefined }, true)
	}

	let ownsInert = false
	try {
		if (target.proxyBuild?.phase === 'version_created') await discardInert()
		if (target.proxyBuild?.phase === 'build_trigger_requested' || target.proxyBuild?.phase === 'build_triggered') await settle()
		// An older pre-trigger checkpoint has no frozen routing identity: discard rather than attribute new intent.
		if (target.proxyBuild?.phase === 'source_uploaded' && target.proxyBuild.manifestSha256 === undefined) await discardInert()
		const deployed = target.proxyDeployment
		if (target.proxyBuild === undefined && deployed !== undefined) {
			const version = await observe(deployed.appVersionId, false)
			if (
				input.refresh === false && settledAttempt && version.status === ZEROPS_ACTIVE && deployed.manifestSha256 === manifestSha256
				&& deployed.repository.owner === pin.repository.owner && deployed.repository.name === pin.repository.name
				&& deployed.commitSha === pin.commitSha && deployed.descriptorSha256 === pin.descriptor.sha256
			) {
				return target
			}
		}

		if (target.proxyBuild === undefined) {
			if (input.source === undefined) throw new Error('Zerops namespace source client is required')
			const runId = crypto.randomUUID()
			const resolved = await input.source.resolve({
				runId,
				repository: pin.repository,
				requestedRef: pin.commitSha,
				expectedCommitSha: pin.commitSha,
				descriptorSha256: pin.descriptor.sha256,
				signal: input.signal,
			})
			if (resolved.runId !== runId || resolved.commitSha !== pin.commitSha || resolved.descriptorSha256 !== pin.descriptor.sha256) {
				throw new Error('Proxy source resolution identity mismatch')
			}
			input.signal.throwIfAborted()
			await input.api.putServiceEnv({ serviceId, key: FABRIKA_PROXY_MANIFEST_JSON, value: manifest, signal: input.signal })
			await ensureNamespaceProxyIam({ api: input.api, proxyServiceId: serviceId, iamUrl: input.iamUrl, iamKey: input.iamKey, signal: input.signal })
			input.signal.throwIfAborted()
			const reserved = await input.api.createAppVersion({ serviceId, name: runId, signal: input.signal })
			if (reserved.id === '') throw new Error('Proxy reservation returned an empty id')
			// A completed reservation remains ours to record and clean after caller cancellation, never after lease loss.
			await save({ ...target, proxyBuild: { runId, appVersionId: reserved.id, source: pin, phase: 'version_created', manifestSha256 } }, true)
			ownsInert = true
			inheritedAttempt = false
			input.signal.throwIfAborted()
			const uploaded = await input.source.upload({
				runId,
				appVersionId: reserved.id,
				repository: pin.repository,
				commitSha: pin.commitSha,
				descriptor: { path: pin.descriptor.path, sha256: pin.descriptor.sha256 },
				uploadUrl: reserved.uploadUrl,
				archiveKind: 'platform',
				signal: input.signal,
			})
			if (
				uploaded.runId !== runId || uploaded.appVersionId !== reserved.id || uploaded.commitSha !== pin.commitSha
				|| uploaded.descriptorSha256 !== pin.descriptor.sha256
			) throw new Error('Proxy source upload identity mismatch')
			await save({ ...target, proxyBuild: { runId, appVersionId: reserved.id, source: pin, phase: 'source_uploaded', manifestSha256 } })
		}
		let build = target.proxyBuild
		if (build === undefined) throw new Error('Proxy attempt checkpoint is missing')
		if (build.phase === 'source_uploaded') {
			const descriptor = prepareZeropsDescriptor(pin.descriptor.contents, 'proxy')
			for (let attempt = 0;; attempt++) {
				ownsInert = true
				await save({ ...target, proxyBuild: { ...build, phase: 'build_trigger_requested' } })
				ownsInert = false
				try {
					const process = await input.api.buildAndDeployAppVersion({
						appVersionId: build.appVersionId,
						zeropsYaml: descriptor.contents,
						zeropsYamlSetup: 'proxy',
						signal: input.signal,
					})
					if (process.appVersionId !== undefined && process.appVersionId !== build.appVersionId) throw unresolved(build.appVersionId)
					build = { ...build, phase: 'build_triggered', processId: process.id }
					await save({ ...target, proxyBuild: build })
					break
				} catch (cause) {
					if (cause instanceof ZeropsApiError && cause.status === 400 && cause.code === 'userDataSyncRunning') {
						ownsInert = true
						await save({ ...target, proxyBuild: { ...build, phase: 'source_uploaded' } }, true)
						input.signal.throwIfAborted()
						ownsInert = false
						if (attempt >= 9) {
							throw new ProviderNamespaceError(
								`Proxy version ${build.appVersionId}: retry the uploaded version after service variables synchronize`,
								'userDataSyncRunning',
								true,
							)
						}
						await sleep(3000, input.signal)
						continue
					}
					input.signal.throwIfAborted()
					// A timeout is not rejection; observe only this exact version and never resubmit it.
					break
				}
			}
		}
		if (input.wait === 'started') {
			const freshConfigurationRequired = input.refresh !== false && inheritedAttempt
			if (!freshConfigurationRequired && target.proxyBuild?.phase === 'build_triggered' && build.manifestSha256 === manifestSha256) return target
			const version = await input.api.getAppVersion({ appVersionId: build.appVersionId, signal: input.signal }).catch(() => null)
			input.signal.throwIfAborted()
			if (version?.id !== build.appVersionId || version.status === undefined || version.status === 'UPLOADING') throw unresolved(build.appVersionId)
			if (
				(version.serviceStackId !== undefined && version.serviceStackId !== serviceId)
				|| (version.projectId !== undefined && target.projectId !== undefined && version.projectId !== target.projectId)
			) throw unresolved(build.appVersionId)
			if (!ZEROPS_TERMINAL.has(version.status)) {
				if (freshConfigurationRequired || build.manifestSha256 !== manifestSha256) throw unresolved(build.appVersionId)
				return target
			}
		}
		await settle()
		// A resumed upload belongs to its original manifest; settle it before publishing newer routing.
		if ((input.refresh !== false && inheritedAttempt) || target.proxyDeployment?.manifestSha256 !== manifestSha256) {
			return runZeropsProxyAttempt({ ...input, target })
		}
		return target
	} catch (cause) {
		if (ownsInert && !leaseLost()) await discardInert()
		if (input.signal.aborted && !leaseLost() && target.proxyBuild !== undefined && !ownsInert) {
			try {
				if (target.proxyBuild.phase === 'version_created' || target.proxyBuild.phase === 'source_uploaded') await discardInert()
				else await input.api.cancelBuild({ appVersionId: target.proxyBuild.appVersionId, signal: cleanupSignal(10_000) })
			} catch { /* Retain the attempt until its exact version is observed terminal. */ }
		}
		throw cause
	}
}
