/** `${<host>_<KEY>}` — Zerops resolves it across services regardless of `envIsolation`, so the host is the boundary. */
const SERVICE_REFERENCE = /\$\{([a-z0-9]{1,25})_[A-Za-z0-9_]+\}/g

/** Namespace services every app in it may reference; the proxy is deliberately not one of them. */
const SHARED_NAMESPACE_HOSTNAMES: readonly string[] = ['postgres']

/** Hosts named by cross-service references in `text`, deduplicated, in order of first appearance. */
export function serviceReferenceHosts(text: string): string[] {
	const hosts: string[] = []
	for (const match of text.matchAll(SERVICE_REFERENCE)) {
		const host = match[1]
		if (host !== undefined && !hosts.includes(host)) hosts.push(host)
	}
	return hosts
}

/** The hosts a service of this app may reference: its own declared hostnames plus the namespace's shared services. */
export function allowedReferenceHosts(ownHostnames: readonly string[]): ReadonlySet<string> {
	return new Set([...ownHostnames, ...SHARED_NAMESPACE_HOSTNAMES])
}

/** The first referenced host outside `allowed`, or null when every reference stays inside the app. */
export function foreignReferenceHost(text: string, allowed: ReadonlySet<string>): string | null {
	return serviceReferenceHosts(text).find((host) => !allowed.has(host)) ?? null
}
