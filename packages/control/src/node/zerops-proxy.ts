import type { DeployLocks, JobQueue } from '@fabrika/platform'
import type { ProviderCodec, ProviderEnvelope } from '@fabrika/provider-contract'
import {
	assertFabrikaManifestCoordinates,
	runZeropsProxyAttempt,
	verifyZeropsNamespaceProxySource,
	zeropsArtifactCodec,
	type ZeropsNamespaceProxySource,
	zeropsNamespaceTargetCodec,
	type ZeropsProxyAttemptApi,
	type ZeropsSourceClient,
} from '@fabrika/provider-zerops'
import { encodeProxyManifestJson, type ProxyManifest } from '@fabrika/proxy-contract'
import type { ControlRegistryRepository } from '../db'
import { NamespaceOwnership } from '../namespace-ownership'
import { type ControlJobMessage, parseProviderEnvelope } from '../run-lifecycle'

const decodeEnvelope = <T>(kind: string, envelope: ProviderEnvelope, codec: ProviderCodec<T>): T => {
	if (envelope.provider !== 'zerops' || envelope.version !== codec.version) {
		throw new Error(`Zerops ${kind} envelope is not supported`)
	}
	return codec.decode(envelope.payload)
}

/** Compile every public app assigned to one deployment namespace into its strict proxy manifest. */
export async function compileNamespaceProxyManifest(
	db: Pick<ControlRegistryRepository, 'listAppEnvsByNamespace'>,
	namespaceId: string,
): Promise<ProxyManifest> {
	const rows = await db.listAppEnvsByNamespace(namespaceId)
	const apps: ProxyManifest['apps'] = []
	const ids = new Set<string>()
	const hosts = new Set<string>()
	for (const row of rows) {
		if (row.provider !== 'zerops') {
			throw new Error(`deployment namespace ${namespaceId} contains an app owned by provider ${row.provider}`)
		}
		const manifest = decodeEnvelope(
			'artifact',
			parseProviderEnvelope(row.provider_artifact_json, `artifact for ${row.app_id}/${row.env}`),
			zeropsArtifactCodec,
		)
		assertFabrikaManifestCoordinates(manifest.app, { appId: row.app_id, env: row.env })
		const proxy = manifest.target.proxy
		if (proxy === undefined) {
			continue
		}
		if (row.domain === null || row.domain === '') {
			throw new Error(`Zerops proxy target ${row.app_id}/${row.env} requires a public domain`)
		}
		const host = row.domain.toLowerCase()
		if (ids.has(row.app_id)) {
			throw new Error(`duplicate proxy app id \`${row.app_id}\` in deployment namespace ${namespaceId}`)
		}
		if (hosts.has(host)) {
			throw new Error(`duplicate proxy host \`${host}\` in deployment namespace ${namespaceId}`)
		}
		ids.add(row.app_id)
		hosts.add(host)
		// A Zerops public domain is always served over the project's TLS-terminating L7 balancer, so the
		// browser speaks https even though the proxy itself is reached over plain HTTP (ADR-0022).
		apps.push({ id: row.app_id, hosts: [host], upstream: proxy.upstream, gates: proxy.gates, scheme: 'https' })
	}
	return { apps }
}

export interface SyncZeropsProxyInput {
	db: NamespaceProxyRegistry
	lock: DeployLocks
	queue?: JobQueue<ControlJobMessage>
	source: ZeropsSourceClient
	api: ZeropsProxyAttemptApi
	namespaceId: string
	proxySource?: ZeropsNamespaceProxySource
	/** The public IAM origin this installation's proxies verify against. */
	iamUrl: string
	iamKey: string
	/** `started` waits for the bounded upload and positive submission evidence; `active` also waits for activation. */
	wait?: 'active' | 'started'
	signal?: AbortSignal
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/** Registry and application callbacks share the namespace job's lease and durable attempt ledger. */
export async function syncZeropsProxy(input: SyncZeropsProxyInput): Promise<void> {
	if (input.wait === 'started' && input.queue === undefined) throw new Error('Namespace proxy background settlement queue is required')
	input.signal?.throwIfAborted()
	const owner = await NamespaceOwnership.acquire(input.db, input.lock, input.namespaceId)
	if (owner === null) throw new Error(`Namespace ${input.namespaceId} proxy is busy; retry or reconcile the namespace`)
	try {
		const row = owner.row
		if (row.provider !== 'zerops') throw new Error(`deployment namespace ${row.id} belongs to another provider`)
		const target = decodeEnvelope(
			'namespace target',
			parseProviderEnvelope(row.provider_target_json, `target for namespace ${row.id}`),
			zeropsNamespaceTargetCodec,
		)
		if (target.proxySource === undefined) throw new Error('Zerops namespace proxy source is unpinned; explicit migration is required')
		await verifyZeropsNamespaceProxySource(target.proxySource)
		if (
			input.proxySource !== undefined && (
				input.proxySource.commitSha !== target.proxySource.commitSha
				|| input.proxySource.repository.owner !== target.proxySource.repository.owner
				|| input.proxySource.repository.name !== target.proxySource.repository.name
				|| input.proxySource.descriptor.sha256 !== target.proxySource.descriptor.sha256
			)
		) throw new Error('Namespace proxy source changed since application placement was resolved')
		if (target.proxyServiceId === undefined || (target.proxyBuild === undefined && (target.ready !== true || row.state === 'failed'))) {
			throw new Error(`Namespace ${row.id} is not ready`)
		}
		const signal = input.signal === undefined ? owner.signal : AbortSignal.any([owner.signal, input.signal])
		signal.throwIfAborted()
		const manifest = encodeProxyManifestJson(await compileNamespaceProxyManifest(input.db, row.id))
		await owner.checkpoint(row.provider_target_json, 'provisioning')
		const result = await runZeropsProxyAttempt({
			target,
			manifest,
			api: input.api,
			source: input.source,
			iamUrl: input.iamUrl,
			iamKey: input.iamKey,
			signal,
			ownershipSignal: owner.signal,
			wait: input.wait ?? 'active',
			...(input.sleep === undefined ? {} : { sleep: input.sleep }),
			checkpoint: next =>
				owner.checkpoint(
					JSON.stringify({ provider: 'zerops', version: zeropsNamespaceTargetCodec.version, payload: zeropsNamespaceTargetCodec.encode(next) }),
					'provisioning',
				),
		})
		await owner.checkpoint(
			JSON.stringify({ provider: 'zerops', version: zeropsNamespaceTargetCodec.version, payload: zeropsNamespaceTargetCodec.encode(result) }),
			result.proxyBuild === undefined && result.ready === true ? 'ready' : 'provisioning',
		)
		if (result.proxyBuild !== undefined) {
			if (input.queue === undefined) throw new Error('Namespace proxy background settlement queue is required')
			await input.queue.send({ kind: 'namespace', namespaceId: row.id, mutation: 'reconcile' })
		}
	} finally {
		await owner.close()
	}
}

/** The registry reads one namespace republish needs. */
export type NamespaceProxyRegistry = Pick<
	ControlRegistryRepository,
	'listAppEnvsByNamespace' | 'getDeploymentNamespace' | 'checkpointDeploymentNamespace'
>

export type SyncNamespaceProxyInput = SyncZeropsProxyInput & { queue: JobQueue<ControlJobMessage> }

/**
 * Republish one deployment namespace's proxy from the registry, addressed by namespace id alone.
 *
 * The proxy service and its build source come from the namespace's own stored target, exactly as the
 * deploy path reads them; a namespace that has not finished provisioning has neither, so it is refused
 * rather than published half-configured.
 *
 * This runs inside an HTTP request, so it waits only for the manifest to publish and the roll to START.
 * A roll that fails after that is what `namespaces.reconcile` repairs.
 */

export async function syncNamespaceProxy(input: SyncNamespaceProxyInput): Promise<void> {
	await syncZeropsProxy({ ...input, wait: 'started' })
}
