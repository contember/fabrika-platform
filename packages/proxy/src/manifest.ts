/**
 * The proxy manifest — the deployed artifact that tells one proxy which apps it fronts, on which
 * hosts, at which internal upstream, and under which gates.
 *
 * It is BAKED IN at deploy time, not fetched at runtime: gates only change when an app deploys, and
 * ADR-0008 says keep the proxy stateless and thin (see
 * `docs/backlog/08-distribute-gate-config-to-proxy.md`, which chose redeploy over Caddy's admin API).
 *
 * `parseProxyManifest` is deliberately strict — a manifest with one malformed rule is rejected
 * whole. A proxy that boots on a half-understood gate list is a proxy that enforces a gate list
 * nobody wrote.
 */

import type { AppGates, CredentialLocation, GateRule } from '@fabrika/auth-core'
import { prop, stringArrayField, stringField } from './json'

/** One app behind this proxy. `hosts` are the public hostnames; `upstream` is the private dial address. */
export interface ProxyApp {
	/** The IAM app id — becomes the minted token's `aud`. */
	id: string
	/** Public hostnames routed to this app (lower-cased on parse; port-insensitive at match time). */
	hosts: string[]
	/** Internal dial address, e.g. `app:3000`. Never publicly routed (ADR-0007). */
	upstream: string
	/** The ordered gate rules. Order IS the precedence. */
	gates: AppGates
}

export interface ProxyManifest {
	apps: ProxyApp[]
}

/**
 * Narrow an untrusted value (a parsed `proxy.manifest.json`) into a `ProxyManifest`. Returns null on
 * ANY malformed field — there is no partial acceptance, and no defaulting of a missing gate list to
 * something permissive.
 */
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
	// An EMPTY rule list is legal and means "deny everything" — the fail-closed identity. It is
	// accepted rather than rejected so an app can be deployed sealed on purpose.
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
