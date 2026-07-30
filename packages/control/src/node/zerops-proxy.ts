import type { ProviderCodec, ProviderEnvelope } from '@fabrika/provider-contract'
import {
	type FabrikaManifest,
	parseFabrikaManifest,
	ZEROPS_ACTIVE,
	ZEROPS_TERMINAL,
	type ZeropsApi,
	zeropsArtifactCodec,
} from '@fabrika/provider-zerops'
import { encodeProxyManifestJson, FABRIKA_PROXY_MANIFEST_JSON, type ProxyManifest } from '@fabrika/proxy-contract'
import type { Db } from '../db'
import { parseProviderEnvelope } from '../run-lifecycle'

const POLL_INTERVAL_MS = 3000
const POLL_TIMEOUT_MS = 70 * 60 * 1000

type ProxyApi = Pick<ZeropsApi, 'putServiceEnv' | 'triggerPipeline' | 'latestAppVersion' | 'getAppVersion'>

const decodeEnvelope = <T>(kind: string, envelope: ProviderEnvelope, codec: ProviderCodec<T>): T => {
	if (envelope.provider !== 'zerops' || envelope.version !== codec.version) {
		throw new Error(`Zerops ${kind} envelope is not supported`)
	}
	return codec.decode(envelope.payload)
}

/** Compile every public app assigned to one deployment namespace into its strict proxy manifest. */
export async function compileNamespaceProxyManifest(db: Db, namespaceId: string): Promise<ProxyManifest> {
	const rows = await db.listAppEnvsByNamespace(namespaceId)
	const apps: ProxyManifest['apps'] = []
	const ids = new Set<string>()
	const hosts = new Set<string>()
	for (const row of rows) {
		if (row.provider !== 'zerops') {
			throw new Error(`deployment namespace ${namespaceId} contains an app owned by provider ${row.provider}`)
		}
		const artifact = decodeEnvelope(
			'artifact',
			parseProviderEnvelope(row.provider_artifact_json, `artifact for ${row.app_id}/${row.env}`),
			zeropsArtifactCodec,
		)
		const manifest: FabrikaManifest = parseFabrikaManifest(artifact, { appId: row.app_id, env: row.env })
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
		apps.push({ id: row.app_id, hosts: [host], upstream: proxy.upstream, gates: proxy.gates })
	}
	return { apps }
}

export interface SyncZeropsProxyInput {
	db: Db
	api: ProxyApi
	namespaceId: string
	proxyServiceId: string
	signal?: AbortSignal
	sleep?: (ms: number) => Promise<void>
}

/**
 * Write the baked proxy manifest through the service-level env API, then roll the proxy so its build
 * materializes the new JSON. No project-level variable method exists on the API surface.
 */
export async function syncZeropsProxy(input: SyncZeropsProxyInput): Promise<void> {
	const signal = input.signal ?? new AbortController().signal
	const manifest = await compileNamespaceProxyManifest(input.db, input.namespaceId)
	await input.api.putServiceEnv({
		serviceId: input.proxyServiceId,
		key: FABRIKA_PROXY_MANIFEST_JSON,
		value: encodeProxyManifestJson(manifest),
		signal,
	})
	const process = await input.api.triggerPipeline({ serviceId: input.proxyServiceId, zeropsSetup: 'proxy', signal })
	const version = process?.appVersionId === undefined
		? await input.api.latestAppVersion({ serviceId: input.proxyServiceId, signal })
		: { id: process.appVersionId }
	if (version === null || version.id === '') {
		throw new Error('Zerops proxy deploy did not expose an app-version')
	}
	const deadline = Date.now() + POLL_TIMEOUT_MS
	for (;;) {
		const current = await input.api.getAppVersion({ appVersionId: version.id, signal })
		if (current.status !== undefined && ZEROPS_TERMINAL.has(current.status)) {
			if (current.status === ZEROPS_ACTIVE) return
			throw new Error(`Zerops proxy deploy ${version.id} finished as ${current.status}`)
		}
		if (Date.now() > deadline) {
			throw new Error(`Zerops proxy deploy ${version.id} timed out`)
		}
		await (input.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(POLL_INTERVAL_MS)
	}
}
