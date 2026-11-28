import {
	iamAdminOAuthResource,
	isHttpsDocumentUrl,
	type OAuthManagedClient,
	type OAuthResourceDto,
	parseOAuthManagedClient,
	parseOAuthResourceDto,
} from '@fabrika/iam-contract'
import { parseJsonOrNull, prop } from './json'

/** A registered managed client (ADR-0089): its CIMD identity plus where IAM fetches that document. */
export interface ManagedOAuthClient extends OAuthManagedClient {
	metadataUrl: string
}

/** `OAUTH_CONFIG`, parsed once. `null` from `parseOAuthConfig` means OAuth is off. */
export interface OAuthConfig {
	resources: OAuthResourceDto[]
	/** The installation's hostnames, which no external application's resource may be on; empty when the deploy names none. */
	hosts: string[]
}

const MAX_RESOURCES = 32
const MAX_HOSTS = 64
const CONFIG_KEYS = ['resources', 'hosts']
const CLIENT_KEYS = ['provider', 'clientId', 'redirectUris', 'metadataUrl', 'identity']
const RESOURCE_KEYS = ['app', 'resource', 'defaultScopes', 'scopeGrants', 'client']

/**
 * Parse `OAUTH_CONFIG`. Absent or empty disables OAuth; anything malformed THROWS, so a typo fails the boot instead of
 * quietly serving fewer scopes than the deploy wrote. Unknown keys are refused for the same reason, `clients` included:
 * the clients are rows in IAM's registry (ADR-0089), and a config that still lists them was written for an older IAM.
 */
export function parseOAuthConfig(raw: string | undefined): OAuthConfig | null {
	if (raw === undefined || raw.trim() === '') return null
	const value = parseJsonOrNull(raw)
	const rawResources = prop(value, 'resources')
	if (!hasOnlyKeys(value, CONFIG_KEYS) || !Array.isArray(rawResources) || rawResources.length === 0 || rawResources.length > MAX_RESOURCES) {
		throw new Error('OAUTH_CONFIG must be a JSON object { resources: [...], hosts?: [...] }')
	}
	const hosts = parseHosts(prop(value, 'hosts'))
	if (hosts === null) throw new Error('OAUTH_CONFIG.hosts must be an array of hostnames')
	const resources: OAuthResourceDto[] = []
	for (const entry of rawResources) {
		const resource = parseOAuthResourceDto(entry)
		if (resource === null || !hasOnlyKeys(entry, RESOURCE_KEYS) || resources.some((existing) => existing.resource === resource.resource)) {
			throw new Error(`OAUTH_CONFIG.resources[${resources.length}] is not a valid resource`)
		}
		resources.push(resource)
	}
	return { resources, hosts }
}

/**
 * The configured resources plus IAM's own administration resource for the command-line client (ADR-0049 rule 2), which
 * IAM serves wherever it serves OAuth. A configuration that names that resource itself fails the boot.
 */
export function withIamAdminResource(config: OAuthConfig | null, issuer: string): OAuthConfig | null {
	if (config === null) return null
	const admin = iamAdminOAuthResource(issuer)
	if (config.resources.some((resource) => resource.resource === admin.resource)) {
		throw new Error(`OAUTH_CONFIG must not name ${admin.resource}: IAM serves its administration resource itself`)
	}
	return { ...config, resources: [...config.resources, admin] }
}

/**
 * One managed client in its wire shape (`OAuthManagedClient` with an optional `metadataUrl`), or null when it is not
 * one. Unknown keys are refused.
 */
export function parseManagedClientEntry(entry: unknown): ManagedOAuthClient | null {
	const client = parseOAuthManagedClient(entry)
	const metadataUrl = prop(entry, 'metadataUrl') ?? client?.clientId
	if (client === null || !hasOnlyKeys(entry, CLIENT_KEYS) || typeof metadataUrl !== 'string' || !isHttpsDocumentUrl(metadataUrl)) return null
	return { ...client, metadataUrl }
}

function parseHosts(value: unknown): string[] | null {
	if (value === undefined) return []
	if (!Array.isArray(value) || value.length > MAX_HOSTS) return null
	const hosts: string[] = []
	for (const entry of value) {
		if (!isHostname(entry)) return null
		if (!hosts.includes(entry)) hosts.push(entry)
	}
	return hosts
}

/** A hostname as a URL spells it: lowercase, no port, no path. */
function isHostname(value: unknown): value is string {
	if (typeof value !== 'string' || value === '') return false
	try {
		return new URL(`https://${value}/`).hostname === value
	} catch {
		return false
	}
}

function hasOnlyKeys(value: unknown, allowed: readonly string[]): boolean {
	return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key))
}
