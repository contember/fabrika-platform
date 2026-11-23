// IAM's OAuth configuration for an installation (ADR-0049): the command-line client's resources on every composition
// with an authorization server, and MCP authoring, opt-in, on top.
//
// The operator names the MCP clients it trusts; everything else is derived from the same template the proxy manifest
// is resolved from, so the two cannot disagree: each `oauth` row's registered resource in the manifest, and IAM's
// `FABRIKA_IAM_OAUTH_CONFIG`, which issues tokens for exactly those resources.

import { OAUTH_CLIENT_PROVIDERS, type OAuthManagedClient, type OAuthResourceDto, parseOAuthManagedClient } from '@fabrika/iam-contract'
import { platformOAuthResourceUris, platformOAuthServed, type PlatformProxyComposition, type PlatformProxyManifestTemplate } from './proxy-manifest'

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

const PROVIDERS = OAUTH_CLIENT_PROVIDERS.map((provider) => `'${provider}'`).join(' | ')

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
		throw new Error(`MCP client ${index} must be { provider: ${PROVIDERS}, clientId: <https URL>, redirectUris: [...], metadataUrl? }`)
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

/**
 * IAM's OAuth configuration for one placed installation: the MCP clients (none when MCP authoring is off; the
 * command-line client is IAM's own and is never listed), and every resource the composition registers.
 */
export const platformIamOAuthConfig = (
	template: PlatformProxyManifestTemplate,
	composition: PlatformProxyComposition,
	clients: readonly McpClient[],
): IamOAuthConfig => {
	const resources: OAuthResourceDto[] = []
	for (const app of template.apps) {
		const served = platformOAuthServed(app, composition)
		for (const entry of served?.resources ?? []) {
			const { resource } = platformOAuthResourceUris(composition, composition.placement[app.service].hosts, entry)
			resources.push({
				app: app.id,
				resource,
				...(entry.defaultScopes === undefined ? {} : { defaultScopes: [...entry.defaultScopes] }),
				scopeGrants: entry.scopeGrants.map((grant) => ({
					scope: grant.scope,
					...(grant.parameter === undefined ? {} : { parameter: grant.parameter }),
					permissions: grant.actions.map((action) => ({ action })),
				})),
			})
		}
	}
	if (resources.length === 0) {
		throw new Error('the platform proxy manifest template declares no OAuth resource on this composition')
	}
	return { clients, resources }
}
