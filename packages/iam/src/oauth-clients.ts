import { parseJsonOrNull } from './json'
import { type ManagedOAuthClient, parseManagedClientEntry } from './oauth-config'
import type { Services } from './services'

/**
 * The managed client `clientId` names, or null when none is registered: THE ONE LOOKUP of every OAuth path, and it
 * reads IAM's registry only (ADR-0089). A stored row is checked again with the managed-client parser, so a client bound
 * to an external application has its identity resource and roles in the checked shape, and a row the parser refuses is
 * no client.
 */
export async function registeredClient(services: Services, clientId: string): Promise<ManagedOAuthClient | null> {
	const found = await services.repositories.oauthRegistry.lookupClient(clientId)
	if (found === null) return null
	const row = found.client
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
