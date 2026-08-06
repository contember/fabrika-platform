// Where one installation's platform services answer, and the two ways a deploy can know.
//
// ── Why this is not a constant ────────────────────────────────────────────────────────────────────
//
// `resolvePlatformProxyManifest` takes the hosts as an argument precisely because they belong to ONE
// installation. There are exactly two sources for them, and which one is used decides something else
// too — whether the proxy should be published on a Zerops subdomain at all:
//
//   derived   the operator names none, and each platform app's host is read off the PROXY service's
//             `zeropsSubdomain` variable, keyed by the listener port the committed template assigns.
//             This is the `zerops-subdomain` installation, and the deploy ensures the subdomain.
//   explicit  the operator names all three. This is the `custom-domain` installation: the domains are
//             bound to the project's L7 balancer out of band, and the deploy must NOT publish a
//             subdomain — doing so would add a second public address nobody asked for.
//
// All three or none. A mix would leave the deploy unable to say which installation it is looking at.
//
// ── `zeropsSubdomain` is a NAME, not a state ──────────────────────────────────────────────────────
//
// Live-verified (`docs/reference/zerops-platform.md`): the variable is present and non-empty on a
// service whose subdomain was never enabled, and unchanged after one is disabled. That is exactly what
// makes it usable HERE, one step before `enableSubdomainAccess` — the manifest has to carry the hosts
// before the proxy that serves them is built. What it needs is a DEPLOYED HTTP port: a proxy that has
// never been deployed publishes none, so the variable names nothing and this refuses rather than
// guessing at a hostname.

import type { PlatformProxyService } from './proxy-manifest'

/** The public hostname of each platform service, without a scheme and without a port. */
export type PlatformHosts = Readonly<Record<PlatformProxyService, string>>

/** Everything the deploy needs to know about where this installation answers. */
export interface PlatformPlacement {
	readonly hosts: PlatformHosts
	/** The scheme the BROWSER speaks. Configuration, never a header — see `ProxyApp.scheme`. */
	readonly scheme: 'http' | 'https'
	/**
	 * Whether the proxy's public entry point is Zerops' generated subdomain. True only on the derived
	 * path: a custom-domain installation must not additionally publish a `.zerops.app` address.
	 */
	readonly zeropsSubdomain: boolean
}

/** The Zerops variable naming one URL per published HTTP port. READ_ONLY, written by the platform. */
export const ZEROPS_SUBDOMAIN_VARIABLE = 'zeropsSubdomain'

/**
 * Map the proxy's generated subdomains by the listener port each one fronts.
 *
 * The host form is `<hostname>-<hash>-<port>.<region>.zerops.app`, one line per HTTP port. Read as
 * URLs rather than by splitting on `-`, so a hostname that itself contains a digit-suffixed segment
 * cannot be misread: the port is the trailing `-<digits>` of the FIRST label only.
 */
export const parseZeropsSubdomains = (value: string): Map<number, string> => {
	const byPort = new Map<number, string>()
	for (const line of value.split('\n')) {
		const trimmed = line.trim()
		if (trimmed === '') {
			continue
		}
		let hostname: string
		try {
			hostname = new URL(trimmed).hostname
		} catch {
			continue
		}
		const label = hostname.split('.')[0] ?? ''
		const match = /-(\d+)$/.exec(label)
		if (match?.[1] === undefined) {
			continue
		}
		byPort.set(Number.parseInt(match[1], 10), hostname)
	}
	return byPort
}

/** One platform app's listener, as the committed template assigns it. */
export interface PlatformListener {
	readonly service: PlatformProxyService
	readonly port: number
}

/**
 * Bind every platform service to the generated subdomain of its listener.
 *
 * Throws naming every port it could not find, because the alternative — writing a manifest with a
 * guessed or missing host — is a proxy that fronts nothing at an address the console then bounces to.
 */
export const derivePlatformHosts = (subdomains: string, listeners: readonly PlatformListener[]): PlatformHosts => {
	const byPort = parseZeropsSubdomains(subdomains)
	const resolved = new Map<PlatformProxyService, string>()
	const missing: string[] = []
	for (const listener of listeners) {
		const host = byPort.get(listener.port)
		if (host === undefined) {
			missing.push(`${listener.service} (:${listener.port})`)
			continue
		}
		resolved.set(listener.service, host)
	}
	if (missing.length > 0) {
		throw new Error(
			`the proxy publishes no Zerops subdomain for ${missing.join(', ')} — deploy the proxy once so it has HTTP ports, `
				+ 'or name every host explicitly with --iam-host / --console-host / --operations-host',
		)
	}
	const iam = resolved.get('iam')
	const control = resolved.get('control')
	const operations = resolved.get('operations')
	if (iam === undefined || control === undefined || operations === undefined) {
		throw new Error('the platform proxy manifest template does not assign a listener to every platform service')
	}
	return { iam, control, operations }
}

/** `https://<host>` — the origin a browser, a token's `iss` and a return-origin registry all use. */
export const platformOrigin = (scheme: 'http' | 'https', host: string): string => `${scheme}://${host}`
