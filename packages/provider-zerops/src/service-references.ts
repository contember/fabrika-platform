/**
 * `${<host>_<KEY>}` — Zerops resolves it across services regardless of `envIsolation`, so the host is the boundary.
 * `${RUNTIME_<host>_<KEY>}`, the build-time bridge, counts as a reference to that host until measured otherwise.
 */
const SERVICE_REFERENCE = /\$\{(?:RUNTIME_)?([a-z0-9]{1,25})_([A-Za-z0-9_]+)\}/g

/** Namespace services every app in it may reference; the proxy is deliberately not one of them. */
const SHARED_NAMESPACE_HOSTNAMES: readonly string[] = ['postgres']

/**
 * Service variables only the platform references: a PostgreSQL service's superuser is the provisioning credential of an
 * application's database roles (ADR-0017), and on Zerops it shares the container's environment with application code.
 */
const PLATFORM_ONLY_SERVICE_KEYS: ReadonlySet<string> = new Set(['superuserpassword'])

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

/**
 * The first reference in `text` to a service variable only the platform may reference, or null. The key is compared
 * without case, because whether Zerops resolves one case-insensitively is not measured.
 */
export function platformOnlyServiceReference(text: string): string | null {
	for (const match of text.matchAll(SERVICE_REFERENCE)) {
		const key = match[2]
		if (key !== undefined && PLATFORM_ONLY_SERVICE_KEYS.has(key.toLowerCase())) return match[0]
	}
	return null
}

/** Refuse an application value that references a platform-only service variable, naming only the reference. */
export function assertNoPlatformOnlyReference(text: string): void {
	const reference = platformOnlyServiceReference(text)
	if (reference !== null) {
		throw new Error(`zerops: application configuration references \`${reference}\`, the PostgreSQL superuser's password, which only the platform uses`)
	}
}
