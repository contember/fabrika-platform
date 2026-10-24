// MCP authoring, opt-in per installation (ADR-0049).
//
// The operator names the MCP clients it trusts; everything else is derived. One input turns on BOTH
// halves, so they cannot disagree: the console's `oauth` row with its registered resource in the proxy
// manifest, and IAM's `FABRIKA_IAM_OAUTH_CONFIG`, which issues tokens for exactly that resource.

import { type OAuthManagedClient, type OAuthResourceDto, parseOAuthManagedClient } from '@fabrika/iam-contract'
import { platformOAuthResourceUris, type PlatformProxyComposition, type PlatformProxyManifestTemplate } from './proxy-manifest'

/** One operator-registered MCP client: its CIMD identity, plus where IAM fetches it when that differs. */
export interface McpClient extends OAuthManagedClient {
	readonly metadataUrl?: string
}

/** The document IAM parses from `FABRIKA_IAM_OAUTH_CONFIG`. */
export interface IamOAuthConfig {
	readonly clients: readonly McpClient[]
	readonly resources: readonly OAuthResourceDto[]
}

const CLIENT_KEYS = ['provider', 'clientId', 'redirectUris', 'metadataUrl']
/** IAM's own ceiling: it refuses to boot with more. */
const MAX_CLIENTS = 16

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const isHttpsUrl = (value: string): boolean => {
	try {
		const url = new URL(value)
		return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hash === ''
	} catch {
		return false
	}
}

const parseClient = (value: unknown, index: number): McpClient => {
	const client = parseOAuthManagedClient(value)
	if (client === null || !isObject(value) || !Object.keys(value).every((key) => CLIENT_KEYS.includes(key))) {
		throw new Error(`MCP client ${index} must be { provider: 'claude' | 'chatgpt', clientId: <https URL>, redirectUris: [...], metadataUrl? }`)
	}
	const metadataUrl = value['metadataUrl']
	if (metadataUrl === undefined) {
		return client
	}
	if (typeof metadataUrl !== 'string' || !isHttpsUrl(metadataUrl)) {
		throw new Error(`MCP client ${index}: metadataUrl must be an https URL`)
	}
	return { ...client, metadataUrl }
}

/**
 * Parse the operator's MCP client list — a JSON array. Anything malformed, an empty list or a repeated
 * client id is refused here, before a deploy writes a value IAM would refuse to boot with.
 */
export const parseMcpClientsJson = (raw: string): readonly McpClient[] => {
	let value: unknown
	try {
		value = JSON.parse(raw)
	} catch {
		throw new Error('the MCP client list is not valid JSON')
	}
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error('the MCP client list must be a non-empty JSON array')
	}
	if (value.length > MAX_CLIENTS) {
		throw new Error(`the MCP client list names more than ${MAX_CLIENTS} clients, which IAM refuses`)
	}
	const clients = value.map(parseClient)
	const ids = new Set(clients.map((client) => client.clientId))
	if (ids.size !== clients.length) {
		throw new Error('the MCP client list names one client id twice')
	}
	return clients
}

/** IAM's OAuth configuration for one placed installation: the clients, and one resource per app that serves one. */
export const platformIamOAuthConfig = (
	template: PlatformProxyManifestTemplate,
	composition: PlatformProxyComposition,
	clients: readonly McpClient[],
): IamOAuthConfig => {
	const resources: OAuthResourceDto[] = []
	for (const app of template.apps) {
		if (app.oauthResource === undefined) {
			continue
		}
		const { resource } = platformOAuthResourceUris(composition, composition.placement[app.service].hosts, app.oauthResource)
		resources.push({
			app: app.id,
			resource,
			defaultScopes: [...app.oauthResource.scopes],
			scopeGrants: app.oauthResource.scopeGrants.map((grant) => ({
				scope: grant.scope,
				permissions: grant.actions.map((action) => ({ action })),
			})),
		})
	}
	if (resources.length === 0) {
		throw new Error('the platform proxy manifest template declares no OAuth resource for MCP clients to reach')
	}
	return { clients, resources }
}
