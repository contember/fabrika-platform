import { waitForProcess, type ZeropsApi, type ZeropsService, type ZeropsServiceStatus } from '../api'
import { defaultSleep, type Sleeper } from '../collaborators'
import {
	SANDBOX_HOST_API_PORT,
	SANDBOX_HOST_DOMAIN,
	SANDBOX_HOST_HOSTNAME,
	SANDBOX_HOST_KEY_VARIABLE,
	SANDBOX_HOST_SERVICE_TYPE,
	SANDBOX_HOST_TYPE,
} from '../sandbox-host'
import { createZboxClient, ZboxApiError, type ZboxClient, type ZboxFetch, type ZboxWorkspace } from '../zbox'
import {
	namespaceError,
	ZEROPS_SANDBOX_HOST_API_OPEN,
	ZEROPS_SANDBOX_HOST_DOMAIN_FORM,
	ZEROPS_SANDBOX_HOST_KEY_REFUSED,
	ZEROPS_SANDBOX_HOST_UNSUPPORTED,
} from './errors'
import { ensureSubdomainAccess, readSubdomainHosts } from './subdomain'
import type { NormalizedZeropsNamespaceTarget, ZeropsNamespaceSandboxHost } from './types'
import { validateService } from './validation'

export type ZeropsSandboxHostApi = Pick<
	ZeropsApi,
	| 'listProjectServices'
	| 'importServices'
	| 'getProcess'
	| 'getService'
	| 'putServiceEnv'
	| 'startService'
	| 'stopService'
	| 'enableSubdomainAccess'
	| 'listServiceEnv'
>

export interface ZeropsSandboxHostInput {
	readonly namespaceId: string
	readonly target: NormalizedZeropsNamespaceTarget
	/** The Box API key Control composed from its vault; written to the service, sent as a bearer, never read back. */
	readonly sandboxKey: string
	readonly api: ZeropsSandboxHostApi
	readonly zboxFetch?: ZboxFetch
	readonly sleep?: Sleeper
	readonly signal: AbortSignal
}

/** One service only, never the steady topology: re-applying that at a service carrying code activates an empty version. */
const SANDBOX_HOST_IMPORT_YAML = `services:
  - hostname: ${SANDBOX_HOST_HOSTNAME}
    type: ${SANDBOX_HOST_TYPE}
    envIsolation: service
`

/** A host someone stopped is started again; UNVERIFIED which of these a stopped `zbox@1` service reads. */
const NOT_STARTED: ReadonlySet<ZeropsServiceStatus> = new Set(['READY_TO_DEPLOY', 'STOPPED', 'SERVICE_STOPPED'])

const POLL_INTERVAL_MS = 3000

/** A started Box answers within seconds; the subdomain's first request can lag it a little more. */
const BOX_REACH_ATTEMPTS = 20

const PROBE_TIMEOUT_MS = 30_000

/** A sandbox host on a `zerops-subdomain` namespace is refused: a dev environment's wildcard needs a custom domain. */
export const assertSandboxHostAllowed = (namespaceId: string, target: NormalizedZeropsNamespaceTarget): void => {
	if (target.publicAccess !== 'zerops-subdomain') return
	throw namespaceError(
		ZEROPS_SANDBOX_HOST_UNSUPPORTED,
		`deployment namespace \`${namespaceId}\` is published on zerops.app subdomains; a dev environment needs a custom-domain namespace`,
		false,
	)
}

const findSandboxHost = async (api: ZeropsSandboxHostApi, projectId: string, signal: AbortSignal): Promise<ZeropsService | null> => {
	const matches = (await api.listProjectServices({ projectId, signal })).filter((service) => service.name === SANDBOX_HOST_HOSTNAME)
	if (matches.length > 1) throw new Error(`Zerops namespace has multiple services named \`${SANDBOX_HOST_HOSTNAME}\``)
	return matches[0] ?? null
}

const waitFor = async (input: ZeropsSandboxHostInput, processId: string, label: string): Promise<void> => {
	await waitForProcess({ api: input.api, processId, sleep: input.sleep ?? defaultSleep, signal: input.signal, label })
}

/** The key is a credential: written sensitive, never compared, never read back (a sensitive value reads REDACTED). */
const writeKey = async (input: ZeropsSandboxHostInput, serviceId: string): Promise<void> => {
	await input.api.putServiceEnv({ serviceId, key: SANDBOX_HOST_KEY_VARIABLE, value: input.sandboxKey, sensitive: true, signal: input.signal })
}

/**
 * Create the service. The platform starts it at once with a key it generated itself (measured live), so Box first
 * refuses ours and the rekey below is what keys it.
 */
const createSandboxHost = async (input: ZeropsSandboxHostInput, projectId: string): Promise<ZeropsService> => {
	const imported = await input.api.importServices({ projectId, yaml: SANDBOX_HOST_IMPORT_YAML, signal: input.signal })
	for (const service of imported.services) {
		for (const process of service.processes) await waitFor(input, process.id, 'sandbox host import')
	}
	const created = await findSandboxHost(input.api, projectId, input.signal)
	if (created === null) throw new Error(`Zerops namespace project ${projectId} has no sandbox host after its import`)
	return created
}

/** The Box API origin: the `https://` subdomain the platform published for the API port. */
const readApiOrigin = async (input: ZeropsSandboxHostInput, serviceId: string): Promise<string> => {
	const host = (await readSubdomainHosts(input.api, serviceId, input.signal)).find((entry) => entry.port === SANDBOX_HOST_API_PORT)
	if (host === undefined) {
		throw namespaceError(
			'sandboxHostNotPublished',
			`Zerops sandbox host ${serviceId} publishes no subdomain for port ${SANDBOX_HOST_API_PORT} yet`,
			true,
		)
	}
	return `https://${host.host}`
}

const isUnauthorized = (error: unknown): boolean => error instanceof ZboxApiError && (error.status === 401 || error.code === 'unauthorized')

/** Box not answering yet: unreachable, timed out, or the platform's balancer answering for a starting container. */
const isStarting = (error: unknown): boolean => error instanceof ZboxApiError && (error.status === 0 || error.status >= 500)

/** The workspace, or `unauthorized` when Box refuses the key. Retries only while Box is starting. */
const reachWorkspace = async (input: ZeropsSandboxHostInput, client: ZboxClient): Promise<ZboxWorkspace | 'unauthorized'> => {
	for (let attempt = 1;; attempt += 1) {
		try {
			return await client.getWorkspace(input.signal)
		} catch (error) {
			if (isUnauthorized(error)) return 'unauthorized'
			input.signal.throwIfAborted()
			if (!isStarting(error) || attempt >= BOX_REACH_ATTEMPTS) throw error
		}
		await (input.sleep ?? defaultSleep)(POLL_INTERVAL_MS, input.signal)
	}
}

/**
 * Box reads its key from its environment when it starts, so a refused key is written again and the service restarted.
 * Measured live: a fresh host always takes this path, since the platform generated its own key at import.
 */
const rekey = async (input: ZeropsSandboxHostInput, client: ZboxClient, serviceId: string): Promise<ZboxWorkspace> => {
	console.info(`Zerops namespace ${input.namespaceId}: restarting sandbox host ${serviceId} with the namespace's key`)
	await writeKey(input, serviceId)
	await waitFor(input, (await input.api.stopService({ serviceId, signal: input.signal })).id, 'sandbox host stop')
	await waitFor(input, (await input.api.startService({ serviceId, signal: input.signal })).id, 'sandbox host start')
	const workspace = await reachWorkspace(input, client)
	if (workspace === 'unauthorized') {
		throw namespaceError(
			ZEROPS_SANDBOX_HOST_KEY_REFUSED,
			`Zerops sandbox host ${serviceId} still refuses the namespace's key after a restart with it`,
			false,
		)
	}
	return workspace
}

/** Whether Box refuses a request that carries no key. Body never read: Box echoes request data in it. */
const refusesWithoutKey = async (input: ZeropsSandboxHostInput, apiOrigin: string): Promise<boolean> => {
	let response: Response
	try {
		response = await (input.zboxFetch ?? fetch)(`${apiOrigin}/api/rest/workspace`, {
			method: 'GET',
			headers: { accept: 'application/json' },
			signal: AbortSignal.any([input.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
		})
	} catch {
		input.signal.throwIfAborted()
		throw new ZboxApiError('probe workspace without a key', 0, 'unreachable')
	}
	await response.body?.cancel()
	if (response.status === 401) return true
	if (response.status >= 500 || response.status === 429) {
		throw new ZboxApiError('probe workspace without a key', response.status, `http_${response.status}`)
	}
	return false
}

/** The DOT domain the proxy routes sandboxes by; the list is replaced whole, so every other domain is sent back. */
const ensureDomain = async (client: ZboxClient, workspace: ZboxWorkspace, serviceId: string, signal: AbortSignal): Promise<void> => {
	const existing = workspace.domains.find((domain) => domain.domain === SANDBOX_HOST_DOMAIN)
	if (existing?.form === 'DOT') return
	if (existing !== undefined) {
		throw namespaceError(
			ZEROPS_SANDBOX_HOST_DOMAIN_FORM,
			`Zerops sandbox host ${serviceId} routes ${SANDBOX_HOST_DOMAIN} in ${existing.form} form; the namespace proxy needs DOT`,
			false,
		)
	}
	await client.putDomains([...workspace.domains, { domain: SANDBOX_HOST_DOMAIN, form: 'DOT' }], signal)
}

/**
 * Bring the namespace's sandbox host to what a dev environment needs: the `zbox` service, its key, its API subdomain,
 * and the DOT domain the namespace proxy routes sandboxes by. Each step decides by reading back, so a reconcile
 * converges a host any earlier attempt left half done and changes nothing on a complete one.
 */
export const ensureSandboxHost = async (input: ZeropsSandboxHostInput): Promise<ZeropsNamespaceSandboxHost> => {
	const { target, signal } = input
	assertSandboxHostAllowed(input.namespaceId, target)
	const projectId = target.projectId
	if (projectId === undefined) throw new Error('Zerops namespace has no project id')
	const found = await findSandboxHost(input.api, projectId, signal)
	if (target.sandboxHost !== undefined && found?.id !== target.sandboxHost.serviceId) {
		throw new Error('Checkpointed namespace sandbox host service identity changed')
	}
	const service = found ?? await createSandboxHost(input, projectId)
	// Before the start: a service of another type that holds the name is never touched.
	validateService(service, projectId, SANDBOX_HOST_SERVICE_TYPE, false)
	if (found?.status !== undefined && NOT_STARTED.has(found.status)) {
		await waitFor(input, (await input.api.startService({ serviceId: found.id, signal })).id, 'sandbox host start')
	}
	await ensureSubdomainAccess({
		api: input.api,
		serviceId: service.id,
		label: 'Zerops namespace sandbox host',
		consequence: 'Control cannot reach its API',
		...(input.sleep === undefined ? {} : { sleep: input.sleep }),
		signal,
	})
	const apiOrigin = await readApiOrigin(input, service.id)
	const client = createZboxClient({
		baseUrl: apiOrigin,
		apiKey: input.sandboxKey,
		...(input.zboxFetch === undefined ? {} : { fetch: input.zboxFetch }),
	})
	const reached = await reachWorkspace(input, client)
	const rekeyed = reached === 'unauthorized'
	let workspace = reached === 'unauthorized' ? await rekey(input, client, service.id) : reached
	// A host whose API answers without a key is never recorded: one rekey, then a refusal.
	if (!(await refusesWithoutKey(input, apiOrigin))) {
		if (!rekeyed) workspace = await rekey(input, client, service.id)
		if (!(await refusesWithoutKey(input, apiOrigin))) {
			throw namespaceError(ZEROPS_SANDBOX_HOST_API_OPEN, `Zerops sandbox host ${service.id} answers its API without a key`, false)
		}
	}
	await ensureDomain(client, workspace, service.id, signal)
	return { serviceId: service.id, apiOrigin }
}
