import type { AppGates, CredentialLocation, GateRule } from '@fabrika/auth-core'
import { prop, stringArrayField, stringField } from './json'

/** Service environment variable containing the baked proxy manifest JSON. */
export const FABRIKA_PROXY_MANIFEST_JSON = 'FABRIKA_PROXY_MANIFEST_JSON'

/** One app behind this proxy. */
export interface ProxyApp {
	/** The IAM app id, used as the minted token audience. */
	id: string
	/** Public hostnames, lower-cased on parse and matched without a port. */
	hosts: string[]
	/** Private upstream dial address, for example `app:3000`. */
	upstream: string
	/** Ordered gate rules; order defines precedence. */
	gates: AppGates
	/**
	 * The scheme the BROWSER speaks to this app. Configuration, because no header can be trusted for
	 * it: a TLS-terminating balancer forwards plain HTTP, and `X-Forwarded-Proto` is then rewritten by
	 * the next hop to the scheme *it* received. Used to build the login bounce and the handoff callback
	 * (ADR-0021), so a wrong value is a broken sign-in, not a cosmetic issue.
	 *
	 * Defaults to `https`. Set `http` only for local development.
	 */
	scheme: 'http' | 'https'
}

export interface ProxyManifest {
	apps: ProxyApp[]
}

/** A trailing `:<port>` on a declared host. Matches an IPv6 literal's port too (`[::1]:8080`). */
const HOST_PORT_SUFFIX = /:\d+$/

/** Parse a complete proxy manifest, rejecting the whole value when any field is malformed. */
export function parseProxyManifest(value: unknown): ProxyManifest | null {
	const rawApps = prop(value, 'apps')
	if (!Array.isArray(rawApps)) {
		return null
	}
	const apps: ProxyApp[] = []
	const seenIds = new Set<string>()
	const seenHosts = new Set<string>()
	for (const raw of rawApps) {
		const app = parseProxyApp(raw)
		if (app === null || seenIds.has(app.id)) {
			return null
		}
		// Two apps on one host would let route order — not the manifest — decide which app answers, and
		// the proxy's host lookup would silently pick one of them. The generator already refuses it; a
		// manifest loaded at runtime must be refused by the same rule, not by whoever generated it.
		for (const host of app.hosts) {
			if (seenHosts.has(host)) {
				return null
			}
			seenHosts.add(host)
		}
		seenIds.add(app.id)
		apps.push(app)
	}
	return { apps }
}

/** Decode a JSON wire value without allowing malformed JSON to escape the contract boundary. */
export function parseProxyManifestJson(value: string): ProxyManifest | null {
	let parsed: unknown
	try {
		parsed = JSON.parse(value)
	} catch {
		return null
	}
	return parseProxyManifest(parsed)
}

/** Encode a producer-typed manifest for the service environment variable. */
export function encodeProxyManifestJson(manifest: ProxyManifest): string {
	return JSON.stringify(manifest)
}

function parseProxyApp(value: unknown): ProxyApp | null {
	const id = stringField(value, 'id')
	const upstream = stringField(value, 'upstream')
	const hosts = stringArrayField(value, 'hosts')
	const gates = parseAppGates(prop(value, 'gates'))
	if (id === undefined || id === '' || upstream === undefined || upstream === '' || hosts === undefined || gates === null) {
		return null
	}
	// A `:port` can never match: Caddy strips the port before its host matcher runs and the proxy looks
	// a host up without one. Refuse it rather than accept a host that silently gates nothing.
	if (hosts.length === 0 || hosts.some((host) => host === '' || HOST_PORT_SUFFIX.test(host))) {
		return null
	}
	// Absent means `https`, so an older manifest keeps working and the safe value is the one you get by
	// saying nothing. A present-but-unrecognised scheme is rejected rather than coerced.
	const rawScheme = stringField(value, 'scheme')
	if (rawScheme !== undefined && rawScheme !== 'http' && rawScheme !== 'https') {
		return null
	}
	const scheme = rawScheme ?? 'https'
	return { id, hosts: hosts.map((host) => host.toLowerCase()), upstream, gates, scheme }
}

function parseAppGates(value: unknown): AppGates | null {
	const rawRules = prop(value, 'rules')
	if (!Array.isArray(rawRules)) {
		return null
	}
	const rules: GateRule[] = []
	for (const raw of rawRules) {
		const rule = parseGateRule(raw)
		if (rule === null) {
			return null
		}
		rules.push(rule)
	}
	// An empty list is the fail-closed identity and deliberately seals the app.
	return { rules }
}

function parseGateRule(value: unknown): GateRule | null {
	const path = stringField(value, 'path')
	const kind = stringField(value, 'kind')
	if (path === undefined || !path.startsWith('/')) {
		return null
	}
	if (kind === 'public' || kind === 'human') {
		return { path, kind }
	}
	if (kind !== 'service') {
		return null
	}
	const rawCredential = prop(value, 'credential')
	if (rawCredential === undefined || rawCredential === null) {
		return { path, kind }
	}
	const credential = parseCredentialLocation(rawCredential)
	return credential === null ? null : { path, kind, credential }
}

function parseCredentialLocation(value: unknown): CredentialLocation | null {
	const location = stringField(value, 'in')
	const name = stringField(value, 'name')
	if (name === undefined || name === '') {
		return null
	}
	if (location !== 'header' && location !== 'query' && location !== 'cookie') {
		return null
	}
	return { in: location, name }
}
