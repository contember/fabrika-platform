import { type OAuthManagedClient, type OAuthResourceDto, parseOAuthManagedClient, parseOAuthResourceDto } from '@fabrika/iam-contract'
import { parseJsonOrNull, prop } from './json'

/** An operator-registered MCP client: its CIMD identity plus where IAM fetches that document. */
export interface ManagedOAuthClient extends OAuthManagedClient {
	metadataUrl: string
}

/** `OAUTH_CONFIG`, parsed once. `null` from `parseOAuthConfig` means OAuth is off. */
export interface OAuthConfig {
	clients: ManagedOAuthClient[]
	resources: OAuthResourceDto[]
}

const MAX_CLIENTS = 16
const MAX_RESOURCES = 32
const CONFIG_KEYS = ['clients', 'resources']
const CLIENT_KEYS = ['provider', 'clientId', 'redirectUris', 'metadataUrl']
const RESOURCE_KEYS = ['app', 'resource', 'defaultScopes', 'scopeGrants']

/**
 * Parse `OAUTH_CONFIG`. Absent or empty disables OAuth; anything malformed THROWS, so a typo fails the
 * boot instead of quietly serving fewer clients or scopes than the operator wrote. Unknown keys are
 * refused for the same reason.
 */
export function parseOAuthConfig(raw: string | undefined): OAuthConfig | null {
	if (raw === undefined || raw.trim() === '') return null
	const value = parseJsonOrNull(raw)
	const rawClients = prop(value, 'clients')
	const rawResources = prop(value, 'resources')
	if (
		!hasOnlyKeys(value, CONFIG_KEYS) || !Array.isArray(rawClients) || rawClients.length === 0 || rawClients.length > MAX_CLIENTS
		|| !Array.isArray(rawResources)
		|| rawResources.length === 0 || rawResources.length > MAX_RESOURCES
	) {
		throw new Error('OAUTH_CONFIG must be a JSON object { clients: [...], resources: [...] }')
	}
	const clients: ManagedOAuthClient[] = []
	for (const entry of rawClients) {
		const client = parseOAuthManagedClient(entry)
		const metadataUrl = prop(entry, 'metadataUrl') ?? client?.clientId
		if (
			client === null || !hasOnlyKeys(entry, CLIENT_KEYS) || typeof metadataUrl !== 'string' || !isHttpsDocumentUrl(metadataUrl)
			|| clients.some((existing) => existing.clientId === client.clientId)
		) {
			throw new Error(`OAUTH_CONFIG.clients[${clients.length}] is not a valid managed client`)
		}
		clients.push({ ...client, metadataUrl })
	}
	const resources: OAuthResourceDto[] = []
	for (const entry of rawResources) {
		const resource = parseOAuthResourceDto(entry)
		if (resource === null || !hasOnlyKeys(entry, RESOURCE_KEYS) || resources.some((existing) => existing.resource === resource.resource)) {
			throw new Error(`OAUTH_CONFIG.resources[${resources.length}] is not a valid resource`)
		}
		resources.push(resource)
	}
	return { clients, resources }
}

function hasOnlyKeys(value: unknown, allowed: readonly string[]): boolean {
	return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key))
}

function isHttpsDocumentUrl(value: string): boolean {
	try {
		const url = new URL(value)
		return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hash === ''
	} catch {
		return false
	}
}
