import type { ProviderNamespaceHost } from '@fabrika/provider-contract'
import { enableSubdomainAccessWhenHttp, readableContent, ZEROPS_SERVICE_NOT_HTTP, type ZeropsApi, ZeropsApiError } from '../api'
import { defaultSleep, type Sleeper } from '../collaborators'
import { ZEROPS_NAMESPACE_SUBDOMAIN_VARIABLE } from './constants'
import { namespaceError, ZEROPS_NAMESPACE_CANCELLED, ZEROPS_SUBDOMAIN_NOT_PUBLISHED } from './errors'

const POLL_INTERVAL_MS = 3000

/** The live enable finishes in under a second, but one run still read `false` once before flipping; ten reads is slack. */
const SUBDOMAIN_READBACK_ATTEMPTS = 10

/**
 * One host per published HTTP port, out of the newline-separated URLs the platform writes.
 *
 * The form is `<hostname>-<hash>-<port>.<region>.zerops.app` (e.g. `proxy-2ec8-8080`). Read as URLs
 * rather than split on `-`, so a hostname whose own first label ends in digits cannot be misread; a line
 * that is not a URL, or whose first label carries no trailing port — the single portless line a proxy
 * that has never deployed publishes — is skipped rather than guessed at.
 */
export const parseZeropsSubdomainHosts = (value: string): ProviderNamespaceHost[] => {
	const hosts: ProviderNamespaceHost[] = []
	for (const line of value.split('\n')) {
		const trimmed = line.trim()
		if (trimmed === '') continue
		let hostname: string
		try {
			hostname = new URL(trimmed).hostname
		} catch {
			continue
		}
		const port = /-(\d+)$/.exec(hostname.split('.')[0] ?? '')?.[1]
		if (port === undefined) continue
		hosts.push({ host: hostname, port: Number.parseInt(port, 10) })
	}
	return hosts.sort((left, right) => left.port - right.port)
}

/** The hosts a service publishes, off the platform-owned `zeropsSubdomain` variable; none while it names none. */
export const readSubdomainHosts = async (
	api: Pick<ZeropsApi, 'listServiceEnv'>,
	serviceId: string,
	signal: AbortSignal,
): Promise<ProviderNamespaceHost[]> => {
	const variables = await api.listServiceEnv({ serviceId, signal })
	const subdomains = readableContent(variables.find((variable) => variable.key === ZEROPS_NAMESPACE_SUBDOMAIN_VARIABLE))
	return subdomains === undefined ? [] : parseZeropsSubdomainHosts(subdomains)
}

export interface SubdomainAccessInput {
	readonly api: Pick<ZeropsApi, 'getService' | 'enableSubdomainAccess'>
	readonly serviceId: string
	/** Names the service in a refusal, e.g. `Zerops namespace proxy`. */
	readonly label: string
	/** What is missing when the subdomain stays off, e.g. `the namespace has no public entry point`. */
	readonly consequence: string
	readonly sleep?: Sleeper
	readonly signal: AbortSignal
}

/**
 * Publish a service on its `*.zerops.app` subdomain — the ONE thing the import document cannot do.
 *
 * `enableSubdomainAccess: true` is accepted by the import and then silently dropped, on a service the
 * document CREATES as much as on one `override` leaves alone; a service imported with it reads back
 * `subdomainAccess: false` for ever. The subdomain is established by
 * `PUT /service-stack/{id}/enable-subdomain-access` and by nothing else, and that call needs a DEPLOYED
 * HTTP port.
 *
 * It runs on RECONCILE too, so a subdomain someone turned off in the GUI comes back, and it either
 * observes `subdomainAccess === true` or throws naming what is missing.
 *
 * The decision is the READ-BACK, never the call returning. On an already-published service the platform
 * answers 2xx and then fails the process it handed back — live-verified — so a 2xx proves nothing.
 *
 * The HTTP ports lag the service's ACTIVE version, so `serviceStackIsNotHttp` is retried for a bounded
 * window (`enableSubdomainAccessWhenHttp`) before it fails the namespace.
 */
export const ensureSubdomainAccess = async (input: SubdomainAccessInput): Promise<void> => {
	const { api, serviceId, signal } = input
	const sleep = input.sleep ?? defaultSleep
	const published = async (): Promise<boolean> => (await api.getService({ serviceId, signal })).subdomainAccess === true
	if (await published()) {
		return
	}
	try {
		await enableSubdomainAccessWhenHttp({ api, serviceId, sleep, signal })
	} catch (error) {
		if (error instanceof ZeropsApiError && error.code === ZEROPS_SERVICE_NOT_HTTP) {
			throw namespaceError(
				ZEROPS_SERVICE_NOT_HTTP,
				`${input.label} ${serviceId} cannot be published on a zerops.app subdomain: it still exposes no deployed HTTP port (${ZEROPS_SERVICE_NOT_HTTP}) minutes after its deploy`,
				false,
			)
		}
		throw error
	}
	for (let attempt = 0;; attempt += 1) {
		if (signal.aborted) {
			throw namespaceError(ZEROPS_NAMESPACE_CANCELLED, 'Zerops namespace provisioning was cancelled', true)
		}
		if (await published()) {
			return
		}
		if (attempt >= SUBDOMAIN_READBACK_ATTEMPTS) {
			throw namespaceError(
				ZEROPS_SUBDOMAIN_NOT_PUBLISHED,
				`${input.label} ${serviceId} accepted enable-subdomain-access but still reads subdomainAccess: false — ${input.consequence}`,
				true,
			)
		}
		await sleep(POLL_INTERVAL_MS, signal)
	}
}
