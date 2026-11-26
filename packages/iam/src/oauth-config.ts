import {
	isHttpsDocumentUrl,
	type OAuthManagedClient,
	type OAuthResourceDto,
	parseOAuthManagedClient,
	parseOAuthResourceDto,
} from '@fabrika/iam-contract'
import { parseJsonOrNull, prop } from './json'

/** An operator-registered MCP client: its CIMD identity plus where IAM fetches that document. */
export interface ManagedOAuthClient extends OAuthManagedClient {
	metadataUrl: string
}

/** `OAUTH_CONFIG`, parsed once. `null` from `parseOAuthConfig` means OAuth is off. */
export interface OAuthConfig {
	/** Served only until the deploy variable is imported into the registry (ADR-0089), then never. */
	clients: ManagedOAuthClient[]
	resources: OAuthResourceDto[]
	/** The installation's hostnames, which no external application's resource may be on; empty when the deploy names none. */
	hosts: string[]
}

const MAX_CLIENTS = 16
const MAX_RESOURCES = 32
const MAX_HOSTS = 64
const CONFIG_KEYS = ['clients', 'resources', 'hosts']
const CLIENT_KEYS = ['provider', 'clientId', 'redirectUris', 'metadataUrl', 'identity']
const RESOURCE_KEYS = ['app', 'resource', 'defaultScopes', 'scopeGrants', 'client']

/**
 * Parse `OAUTH_CONFIG`. Absent or empty disables OAuth; anything malformed THROWS, so a typo fails the boot instead of
 * quietly serving fewer clients or scopes than the operator wrote. Unknown keys are refused for the same reason.
 * `clients` may be empty: the command-line client is IAM's own and never listed. A client's identity resource names
 * neither a registered resource nor a `platformAudiences` app, so its token is never one an installation service accepts.
 */
export function parseOAuthConfig(raw: string | undefined, platformAudiences: ReadonlySet<string>): OAuthConfig | null {
	if (raw === undefined || raw.trim() === '') return null
	const value = parseJsonOrNull(raw)
	// Absent: a deploy that writes no clients, which this IAM reads as none.
	const rawClients = prop(value, 'clients') ?? []
	const rawResources = prop(value, 'resources')
	if (
		!hasOnlyKeys(value, CONFIG_KEYS) || !Array.isArray(rawClients) || rawClients.length > MAX_CLIENTS
		|| !Array.isArray(rawResources)
		|| rawResources.length === 0 || rawResources.length > MAX_RESOURCES
	) {
		throw new Error('OAUTH_CONFIG must be a JSON object { clients: [...], resources: [...] }')
	}
	const hosts = parseHosts(prop(value, 'hosts'))
	if (hosts === null) throw new Error('OAUTH_CONFIG.hosts must be an array of hostnames')
	const clients: ManagedOAuthClient[] = []
	for (const entry of rawClients) {
		const client = parseManagedClientEntry(entry)
		if (client === null || clients.some((existing) => existing.clientId === client.clientId)) {
			throw new Error(`OAUTH_CONFIG.clients[${clients.length}] is not a valid managed client`)
		}
		clients.push(client)
	}
	const resources: OAuthResourceDto[] = []
	for (const entry of rawResources) {
		const resource = parseOAuthResourceDto(entry)
		if (resource === null || !hasOnlyKeys(entry, RESOURCE_KEYS) || resources.some((existing) => existing.resource === resource.resource)) {
			throw new Error(`OAUTH_CONFIG.resources[${resources.length}] is not a valid resource`)
		}
		resources.push(resource)
	}
	for (const [index, { identity }] of clients.entries()) {
		if (
			identity !== undefined
			&& (platformAudiences.has(identity.app) || resources.some((entry) => entry.resource === identity.resource || entry.app === identity.app))
		) {
			throw new Error(`OAUTH_CONFIG.clients[${index}].identity names an installation service's app or resource`)
		}
	}
	return { clients, resources, hosts }
}

/**
 * One managed client as `OAUTH_CONFIG.clients` and the deploy variable list it (`OAuthManagedClient` with an optional
 * `metadataUrl`), or null when it is not one. Unknown keys are refused.
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
