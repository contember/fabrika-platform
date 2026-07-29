import type { AppGates } from '@fabrika/auth'
import type { ProviderCodec, ProviderEnvelope } from '@fabrika/provider-contract'
import {
	type FabrikaManifestV1,
	parseFabrikaManifest,
	ZEROPS_ACTIVE,
	ZEROPS_TERMINAL,
	type ZeropsApi,
	zeropsArtifactCodec,
	zeropsStoredTargetCodec,
} from '@fabrika/provider-zerops'
import type { Db } from './db'
import { parseProviderEnvelope } from './run-lifecycle'

export const PROXY_MANIFEST_VARIABLE = 'FABRIKA_PROXY_MANIFEST_JSON'
const POLL_INTERVAL_MS = 3000
const POLL_TIMEOUT_MS = 70 * 60 * 1000

export interface CompiledProxyManifest {
	apps: Array<{
		id: string
		hosts: string[]
		upstream: string
		gates: AppGates
	}>
}

type ProxyApi = Pick<ZeropsApi, 'findService' | 'putServiceEnv' | 'triggerPipeline' | 'latestAppVersion' | 'getAppVersion'>

const decodeEnvelope = <T>(kind: string, envelope: ProviderEnvelope, codec: ProviderCodec<T>): T => {
	if (envelope.provider !== 'zerops' || envelope.version !== codec.version) {
		throw new Error(`Zerops ${kind} envelope is not supported`)
	}
	return codec.decode(envelope.payload)
}

/** Compile every public app in one Zerops environment project into the proxy's strict manifest shape. */
export async function compileProjectProxyManifest(db: Db, projectId: string): Promise<CompiledProxyManifest> {
	const rows = await db.listAppEnvsByProvider('zerops')
	const apps: CompiledProxyManifest['apps'] = []
	const ids = new Set<string>()
	const hosts = new Set<string>()
	for (const row of rows) {
		const target = decodeEnvelope(
			'target',
			parseProviderEnvelope(row.provider_target_json, `target for ${row.app_id}/${row.env}`),
			zeropsStoredTargetCodec,
		)
		if (target.projectId !== projectId) {
			continue
		}
		const artifact = decodeEnvelope(
			'artifact',
			parseProviderEnvelope(row.provider_artifact_json, `artifact for ${row.app_id}/${row.env}`),
			zeropsArtifactCodec,
		)
		const manifest: FabrikaManifestV1 = parseFabrikaManifest(artifact, { appId: row.app_id, env: row.env })
		const proxy = manifest.target.proxy
		if (proxy === undefined) {
			continue
		}
		if (row.domain === null || row.domain === '') {
			throw new Error(`Zerops proxy target ${row.app_id}/${row.env} requires a public domain`)
		}
		const host = row.domain.toLowerCase()
		if (ids.has(row.app_id)) {
			throw new Error(`duplicate proxy app id \`${row.app_id}\` in Zerops project ${projectId}`)
		}
		if (hosts.has(host)) {
			throw new Error(`duplicate proxy host \`${host}\` in Zerops project ${projectId}`)
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
	projectId: string
	/** Defaults to the repository topology's `proxy` hostname. */
	proxyServiceName?: string
	signal?: AbortSignal
	sleep?: (ms: number) => Promise<void>
}

/**
 * Write the baked proxy manifest through the service-level env API, then roll the proxy so its build
 * materializes the new JSON. No project-level variable method exists on the API surface.
 */
export async function syncZeropsProxy(input: SyncZeropsProxyInput): Promise<void> {
	const signal = input.signal ?? new AbortController().signal
	const proxy = await input.api.findService({
		projectId: input.projectId,
		hostname: input.proxyServiceName ?? 'proxy',
		signal,
	})
	if (proxy === null) {
		throw new Error(`Zerops project ${input.projectId} has no proxy service`)
	}
	const manifest = await compileProjectProxyManifest(input.db, input.projectId)
	await input.api.putServiceEnv({
		serviceId: proxy.id,
		key: PROXY_MANIFEST_VARIABLE,
		value: JSON.stringify(manifest),
		signal,
	})
	const process = await input.api.triggerPipeline({ serviceId: proxy.id, zeropsSetup: 'proxy', signal })
	const version = process?.appVersionId === undefined
		? await input.api.latestAppVersion({ serviceId: proxy.id, signal })
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
