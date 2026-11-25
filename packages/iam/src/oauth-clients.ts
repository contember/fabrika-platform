import { parseJsonOrNull } from './json'
import { type ManagedOAuthClient, type OAuthConfig, parseManagedClientEntry } from './oauth-config'
import type { Services } from './services'

/**
 * The managed client `clientId` names, or null when none is registered: THE ONE LOOKUP of every OAuth path (ADR-0089).
 * Until the deploy variable was imported into the registry it is `OAUTH_CONFIG`'s, as before the registry existed; from
 * then on only the registry's. A stored row is checked again with the parser `OAUTH_CONFIG` uses, so a client bound to an
 * external application has the same shape, its identity resource and roles included, and a row the parser refuses is
 * no client.
 */
export async function registeredClient(services: Services, config: OAuthConfig, clientId: string): Promise<ManagedOAuthClient | null> {
	const found = await services.repositories.oauthRegistry.lookupClient(clientId)
	if (!found.imported) return config.clients.find((client) => client.clientId === clientId) ?? null
	const row = found.client
	if (row === null) return null
	const roles = found.roles.map((role) => ({ key: role.role_key, name: role.name }))
	const identity = row.external_app === null
		? undefined
		: { app: row.external_app, resource: found.resource, ...(roles.length === 0 ? {} : { roles }) }
	return parseManagedClientEntry({
		provider: row.label,
		clientId: row.client_id,
		redirectUris: parseJsonOrNull(row.redirect_uris),
		...(row.metadata_url === null ? {} : { metadataUrl: row.metadata_url }),
		...(identity === undefined ? {} : { identity }),
	})
}
