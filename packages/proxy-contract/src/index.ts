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
}

export interface ProxyManifest {
	apps: ProxyApp[]
}

/** Parse a complete proxy manifest, rejecting the whole value when any field is malformed. */
export function parseProxyManifest(value: unknown): ProxyManifest | null {
	const rawApps = prop(value, 'apps')
	if (!Array.isArray(rawApps)) {
		return null
	}
	const apps: ProxyApp[] = []
	const seen = new Set<string>()
	for (const raw of rawApps) {
		const app = parseProxyApp(raw)
		if (app === null || seen.has(app.id)) {
			return null
		}
		seen.add(app.id)
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
	if (hosts.length === 0 || hosts.some((host) => host === '')) {
		return null
	}
	return { id, hosts: hosts.map((host) => host.toLowerCase()), upstream, gates }
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
