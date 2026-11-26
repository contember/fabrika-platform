// IAM's OAuth configuration for an installation (ADR-0049): the command-line client's resources on every composition
// with an authorization server, and MCP authoring, opt-in, on top.
//
// The operator names the MCP clients it trusts; everything else is derived from the same template the proxy manifest
// is resolved from, so the two cannot disagree: each `oauth` row's registered resource in the manifest, and IAM's
// `FABRIKA_IAM_OAUTH_CONFIG`, which issues tokens for exactly those resources.

import { IAM_APP_ID, OAUTH_CLIENT_PROVIDERS, type OAuthManagedClient, type OAuthResourceDto, parseOAuthManagedClient } from '@fabrika/iam-contract'
import { platformOAuthResourceUris, platformOAuthServed, type PlatformProxyComposition, type PlatformProxyManifestTemplate } from './proxy-manifest'

/** One operator-registered MCP client: its CIMD identity, plus where IAM fetches it when that differs. */
export interface McpClient extends OAuthManagedClient {
	readonly metadataUrl?: string
}

/** The document IAM parses from `FABRIKA_IAM_OAUTH_CONFIG`. */
export interface IamOAuthConfig {
	readonly clients: readonly McpClient[]
	readonly resources: readonly OAuthResourceDto[]
	/** The installation's hostnames: IAM refuses an external application whose resource is on one (ADR-0089). */
	readonly hosts: readonly string[]
}

const CLIENT_KEYS = ['provider', 'clientId', 'redirectUris', 'metadataUrl', 'identity']
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
		throw new Error(
			`MCP client ${index} must be { provider: ${PROVIDERS}, clientId: <https URL>, redirectUris: [...], metadataUrl?, identity? }; `
				+ 'identity is { app: <app id>, resource: <https URL>, roles?: [{ key, name }] } and only on an external client',
		)
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
	assertOneIdentityPerApp(clients)
	return clients
}

/**
 * IAM's registry holds one resource and one list of roles per external application, and no resource under two
 * applications (ADR-0089); its import refuses a list that breaks either. Refused here, before the deploy writes anything.
 */
const assertOneIdentityPerApp = (clients: readonly McpClient[]): void => {
	const declared = new Map<string, string>()
	const resources = new Map<string, string>()
	for (const { clientId, identity } of clients) {
		if (identity === undefined) continue
		const shape = JSON.stringify({ resource: identity.resource, roles: identity.roles ?? null })
		const known = declared.get(identity.app)
		if (known !== undefined && known !== shape) {
			throw new Error(`MCP client ${clientId}: another client of \`${identity.app}\` names another resource or other roles`)
		}
		const owner = resources.get(identity.resource)
		if (owner !== undefined && owner !== identity.app) {
			throw new Error(`MCP client ${clientId}: \`${owner}\` and \`${identity.app}\` name one identity resource, ${identity.resource}`)
		}
		declared.set(identity.app, shape)
		resources.set(identity.resource, identity.app)
	}
}

/** MCP authoring is on when the operator registers a client that is not identity-only: those sign people in, nothing more. */
export const mcpAuthoringOn = (clients: readonly McpClient[] | undefined): boolean =>
	clients?.some((client) => client.identity === undefined) ?? false

/** The operator's OAuth client list, read by this release only to import it into IAM's registry once (ADR-0089). */
export const MCP_CLIENTS_VARIABLE = 'FABRIKA_PLATFORM_MCP_CLIENTS_JSON'

/** The deploy setting that decides whether MCP authoring is on (ADR-0089 §4). */
export const MCP_AUTHORING_VARIABLE = 'FABRIKA_PLATFORM_MCP_AUTHORING'

/** The switch as `on` or `off`, absent when unset; any other value is refused, naming where it came from. */
export const parseMcpAuthoring = (raw: string | undefined, name: string): boolean | undefined => {
	if (raw === undefined) return undefined
	if (raw === 'on') return true
	if (raw === 'off') return false
	throw new Error(`${name} must be on or off`)
}

export interface McpAuthoring {
	readonly on: boolean
	/** Set when the switch is unset and the client list turned authoring on: the next release needs the switch. */
	readonly warning?: string
}

/**
 * Whether MCP authoring is on: the switch decides when it is set. Unset, this release alone still infers it from an
 * authoring entry in the client list, and says that the switch must be set before the variable goes.
 */
export const resolveMcpAuthoring = (
	setting: boolean | undefined,
	clients: readonly McpClient[] | undefined,
	names: { readonly setting: string; readonly clients: string },
): McpAuthoring => {
	if (setting !== undefined) return { on: setting }
	if (!mcpAuthoringOn(clients)) return { on: false }
	return {
		on: true,
		warning: `MCP authoring is on because ${names.clients} lists an authoring client; set ${names.setting}=on, `
			+ 'which the next release reads instead',
	}
}

/**
 * IAM's OAuth configuration for one placed installation: the MCP clients (none when MCP authoring is off; the
 * command-line client is IAM's own and is never listed), and every resource the composition registers, each marked
 * for the one kind of client it is served to.
 */
export const platformIamOAuthConfig = (
	template: PlatformProxyManifestTemplate,
	composition: PlatformProxyComposition,
	clients: readonly McpClient[],
): IamOAuthConfig => {
	const resources: OAuthResourceDto[] = []
	for (const app of template.apps) {
		const served = platformOAuthServed(app, composition)
		for (const { template: entry, cli } of served?.resources ?? []) {
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
				// IAM serves a resource to one kind of client: the command-line client's never reach an MCP client, nor MCP's it.
				...(cli ? { client: 'cli' } : {}),
			})
		}
	}
	if (resources.length === 0) {
		throw new Error('the platform proxy manifest template declares no OAuth resource on this composition')
	}
	// An identity token must never be one a platform service accepts: not its app id, not a resource on its hosts.
	const platformHosts = [...new Set(Object.values(composition.placement).flatMap((placement) => placement.hosts))]
	for (const { clientId, identity } of clients) {
		if (identity === undefined) continue
		// IAM's own id is no proxy app's: an external application under it would take IAM's vocabulary.
		const platformApps = [IAM_APP_ID, ...template.apps.map((app) => app.id)]
		if (platformApps.includes(identity.app) || platformHosts.includes(new URL(identity.resource).hostname)) {
			throw new Error(`MCP client ${clientId}: its identity resource names a platform service's app id or host`)
		}
	}
	// IAM checks an external application registered at runtime against the same hosts.
	return { clients, resources, hosts: platformHosts }
}
