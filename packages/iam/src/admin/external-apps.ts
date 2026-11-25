// The OAuth client registry (ADR-0089): external applications, which an installation administrator registers with their
// roles and clients, and MCP authoring clients, which only the provisioning key writes. Each writer refuses a client id
// the other one owns. Until the deploy imported its client list (`importOnce`, release N), IAM serves `OAUTH_CONFIG`'s
// clients and refuses a registry write, so an administrator's edit can never land before the import overwrites it.

import { displayNameProblem } from '@fabrika/auth-core'
import {
	type ExternalAppDto,
	type ExternalAppInput,
	IAM_APP_ID,
	type ImportOAuthClientsRequest,
	type ImportOAuthClientsResponse,
	type ListResponse,
	MAX_EXTERNAL_APP_CLIENTS,
	type OAuthClientDto,
	type OAuthClientInput,
	type OAuthIdentityResource,
	type OkResponse,
	parseOAuthIdentityResource,
	type PutExternalAppRequest,
	type PutOAuthClientRequest,
} from '@fabrika/iam-contract'
import { parsePresentation } from '../app-presentation'
import { PROVISIONING_ADMIN_ID } from '../auth'
import type { AuditEventInput, AuthoringClientWrite, ExternalAppWrite, OAuthClientRow, RegistryEvents } from '../db'
import { parseJsonOrNull } from '../json'
import { type ManagedOAuthClient, type OAuthConfig, parseManagedClientEntry } from '../oauth-config'
import { type AdminContext, adminEvent, fail } from './context'

const NOT_IMPORTED = 'IAM takes registry writes once a deploy of this release has imported the OAuth client list '
	+ '(oauthClients.importOnce); until then it serves the clients of its OAUTH_CONFIG. Deploy the platform first.'

export async function listExternalAppsUseCase(c: AdminContext): Promise<ListResponse<ExternalAppDto>> {
	const rows = await c.services.repositories.oauthRegistry.listExternalApps()
	return { items: await Promise.all(rows.map((row) => externalAppDto(c, row.app))) }
}

export async function getExternalAppUseCase(c: AdminContext, input: ExternalAppInput): Promise<ExternalAppDto> {
	return externalAppDto(c, input.app)
}

/** Replace an external application whole: record, name, roles and clients, in one transaction with its record. */
export async function putExternalAppUseCase(c: AdminContext, input: PutExternalAppRequest): Promise<ExternalAppDto> {
	const config = requireOAuth(c)
	const registry = c.services.repositories.oauthRegistry
	if (!(await registry.imported())) return fail(409, NOT_IMPORTED)
	const nameProblem = displayNameProblem(input.name)
	if (nameProblem !== null) return fail(400, `name ${nameProblem}`)
	const roles = input.roles ?? []
	const identity = parseOAuthIdentityResource({ app: input.app, resource: input.resource, ...(roles.length === 0 ? {} : { roles }) })
	if (identity === null) {
		return fail(
			400,
			`app must be a lowercase id without \`@\`, resource an https URI, and roles at most 32 of { key, name } with a lowercase key that is not built in`,
		)
	}
	if (input.clients.length > MAX_EXTERNAL_APP_CLIENTS) return fail(400, `an external application has at most ${MAX_EXTERNAL_APP_CLIENTS} clients`)
	const clients: ManagedOAuthClient[] = []
	for (const [index, entry] of input.clients.entries()) {
		const client = parseManagedClientEntry({
			provider: 'external',
			clientId: entry.clientId,
			redirectUris: entry.redirectUris,
			identity,
			...(entry.metadataUrl == null ? {} : { metadataUrl: entry.metadataUrl }),
		})
		if (client === null) {
			return fail(400, `clients[${index}] needs an https client id with a path, 1 to 32 distinct redirect URIs and an https metadataUrl, if any`)
		}
		if (clients.some((known) => known.clientId === client.clientId)) return fail(400, `clients[${index}] repeats client id ${client.clientId}`)
		clients.push(client)
	}
	const existing = await registry.externalApp(identity.app)
	await checkExternalApp(c, config, identity, clients, existing !== null)
	const write = externalAppWrite(identity, input.name, clients)
	await registry.putExternalApp(write, registryEvents(c, 'iam.external_app.put', write))
	return externalAppDto(c, identity.app)
}

/** Remove an external application: its clients and their grants, its vocabulary and name, and its record. */
export async function deleteExternalAppUseCase(c: AdminContext, input: ExternalAppInput): Promise<OkResponse> {
	const registry = c.services.repositories.oauthRegistry
	if ((await registry.externalApp(input.app)) === null) return fail(404, 'unknown external application')
	const deleted = await registry.deleteExternalApp(input.app, {
		change: adminEvent(c, { action: 'iam.external_app.delete', resourceType: 'external_app', resourceId: input.app }),
		revocation: (clientId) => clientRevocation(c, clientId, input.app),
	})
	if (!deleted) return fail(404, 'unknown external application')
	return { ok: true }
}

export async function listOAuthClientsUseCase(c: AdminContext): Promise<ListResponse<OAuthClientDto>> {
	return { items: (await c.services.repositories.oauthRegistry.listClients()).map(oauthClientDto) }
}

/** Write an MCP authoring client: the provisioning key's alone, because its tokens reach `/mcp` (ADR-0049). */
export async function putOAuthClientUseCase(c: AdminContext, input: PutOAuthClientRequest): Promise<OAuthClientDto> {
	requireProvisioningKey(c, 'writes an MCP authoring client')
	requireOAuth(c)
	const registry = c.services.repositories.oauthRegistry
	if (!(await registry.imported())) return fail(409, NOT_IMPORTED)
	const client = parseManagedClientEntry({
		provider: input.label,
		clientId: input.clientId,
		redirectUris: input.redirectUris,
		...(input.metadataUrl == null ? {} : { metadataUrl: input.metadataUrl }),
	})
	if (client === null) {
		return fail(400, 'an OAuth client needs an https client id with a path, 1 to 32 distinct redirect URIs and an https metadataUrl, if any')
	}
	const owner = await registry.client(client.clientId)
	if (owner?.external_app != null) return fail(409, ownedByExternalApp(client.clientId, owner.external_app))
	const write = authoringClientWrite(client)
	const row = await registry.putAuthoringClient(
		write,
		adminEvent(c, {
			action: 'iam.oauth_client.put',
			resourceType: 'oauth_client',
			resourceId: client.clientId,
			metadata: { label: write.label, redirectUris: write.redirectUris, metadataUrl: write.metadataUrl },
		}),
	)
	if (row === null) return fail(409, `the client ${client.clientId} is a client of an external application`)
	return oauthClientDto(row)
}

/** Remove an MCP authoring client and revoke its grants. */
export async function deleteOAuthClientUseCase(c: AdminContext, input: OAuthClientInput): Promise<OkResponse> {
	requireProvisioningKey(c, 'removes an MCP authoring client')
	const registry = c.services.repositories.oauthRegistry
	const owner = await registry.client(input.clientId)
	if (owner === null) return fail(404, 'unknown OAuth client')
	if (owner.external_app !== null) return fail(409, ownedByExternalApp(input.clientId, owner.external_app))
	const deleted = await registry.deleteAuthoringClient(input.clientId, {
		change: adminEvent(c, { action: 'iam.oauth_client.delete', resourceType: 'oauth_client', resourceId: input.clientId }),
		revocation: (clientId) => clientRevocation(c, clientId, null),
	})
	if (!deleted) return fail(404, 'unknown OAuth client')
	return { ok: true }
}

/**
 * The deploy's one import of its client list (release N of ADR-0089), the provisioning key's alone. The first call writes
 * every entry bound to an application as an external application, adopting the roles earlier deploys reconciled under
 * its id, every other entry as an authoring client, and the mark, in one transaction. Every later call writes nothing.
 */
export async function importOAuthClientsUseCase(c: AdminContext, input: ImportOAuthClientsRequest): Promise<ImportOAuthClientsResponse> {
	requireProvisioningKey(c, 'imports the OAuth client list')
	const registry = c.services.repositories.oauthRegistry
	if (await registry.imported()) return { status: 'already_imported' }
	const config = c.services.config.oauth ?? { clients: [], resources: [], hosts: [] }
	const entries: ManagedOAuthClient[] = []
	for (const [index, raw] of input.clients.entries()) {
		const client = parseManagedClientEntry(raw)
		if (client === null) return fail(400, `clients[${index}] is not a valid managed client`)
		if (entries.some((known) => known.clientId === client.clientId)) return fail(400, `clients[${index}] repeats client id ${client.clientId}`)
		entries.push(client)
	}
	const apps = new Map<string, { identity: OAuthIdentityResource; clients: ManagedOAuthClient[] }>()
	for (const client of entries) {
		const { identity } = client
		if (identity === undefined) continue
		const group = apps.get(identity.app)
		if (group === undefined) {
			apps.set(identity.app, { identity, clients: [client] })
			continue
		}
		if (JSON.stringify(group.identity) !== JSON.stringify(identity)) {
			return fail(400, `the clients of \`${identity.app}\` name different resources or roles`)
		}
		group.clients.push(client)
	}
	const writes: ExternalAppWrite[] = []
	for (const { identity, clients } of apps.values()) {
		if (writes.some((write) => write.resource === identity.resource)) return fail(400, `two applications name the resource ${identity.resource}`)
		if (clients.length > MAX_EXTERNAL_APP_CLIENTS) return fail(400, `\`${identity.app}\` has more than ${MAX_EXTERNAL_APP_CLIENTS} clients`)
		await checkExternalApp(c, config, identity, clients, false)
		writes.push(externalAppWrite(identity, null, clients))
	}
	const authoring = entries.filter((client) => client.identity === undefined).map(authoringClientWrite)
	const externalApps = writes.map((write) => write.app)
	const oauthClients = entries.map((client) => client.clientId)
	const imported = await registry.importOnce(
		writes.map((write) => ({ write, events: registryEvents(c, 'iam.external_app.put', write) })),
		authoring.map((write) => ({
			write,
			event: adminEvent(c, {
				action: 'iam.oauth_client.put',
				resourceType: 'oauth_client',
				resourceId: write.clientId,
				metadata: { label: write.label },
			}),
		})),
		adminEvent(c, { action: 'iam.oauth_registry.import', resourceType: 'oauth_registry', metadata: { externalApps, oauthClients } }),
	)
	return imported ? { status: 'imported', externalApps, oauthClients } : { status: 'already_imported' }
}

/**
 * The rules of ADR-0089 §1 for an external application, checked against IAM's state; each refusal names what is wrong.
 * `registered`: the id is an external application already, so its vocabulary is its own.
 */
async function checkExternalApp(
	c: AdminContext,
	config: OAuthConfig,
	identity: OAuthIdentityResource,
	clients: readonly ManagedOAuthClient[],
	registered: boolean,
): Promise<void> {
	const { app, resource } = identity
	const { repositories } = c.services
	if (app === IAM_APP_ID || c.services.config.platformAudiences.has(app) || config.resources.some((entry) => entry.app === app)) {
		return fail(400, `\`${app}\` is an installation service's app id`)
	}
	const host = new URL(resource).hostname
	const installationHosts = new Set([
		...config.hosts,
		new URL(c.services.config.issuer).hostname,
		...config.resources.map((entry) => new URL(entry.resource).hostname),
	])
	if (config.resources.some((entry) => entry.resource === resource) || installationHosts.has(host)) {
		return fail(400, `the resource ${resource} is on one of the installation's hosts`)
	}
	const sharing = await repositories.oauthRegistry.externalAppWithResource(resource)
	if (sharing !== null && sharing.app !== app) return fail(409, `the resource ${resource} is the external application \`${sharing.app}\`'s`)
	for (const client of clients) {
		const owner = await repositories.oauthRegistry.client(client.clientId)
		if (owner !== null && owner.external_app !== app) return fail(409, ownedByExternalApp(client.clientId, owner.external_app))
	}
	if (!registered) {
		const foreign = await repositories.oauthRegistry.foreignVocabulary(app)
		if (foreign.length > 0) {
			return fail(
				409,
				`IAM holds ${foreign.join(', ')} under \`${app}\`; only an id whose roles grant no action and that declares nothing else `
					+ 'becomes an external application',
			)
		}
	}
	const declared = identity.roles ?? []
	const custom = (await repositories.appSchema.listRolesByOrigin(app, 'custom')).filter((row) => declared.some((role) => role.key === row.role_key))
	if (custom.length > 0) {
		return fail(409, `the role ${custom.map((row) => `'${row.role_key}'`).join(', ')} is an administrator's custom policy at \`${app}\``)
	}
	for (const role of declared) {
		if ((await repositories.grants.listExternalHoldersOfRole(app, role.key)).length > 0) {
			return fail(409, `external principals hold the role '${role.key}' at \`${app}\`; delete those grants first`)
		}
	}
}

async function externalAppDto(c: AdminContext, app: string): Promise<ExternalAppDto> {
	const { oauthRegistry, appSchema } = c.services.repositories
	const row = await oauthRegistry.externalApp(app)
	if (row === null) return fail(404, 'unknown external application')
	const roles = (await appSchema.listRolesByOrigin(app, 'app')).map((role) => ({ key: role.role_key, name: role.name }))
	return {
		app: row.app,
		name: parsePresentation(await appSchema.getPresentation(app)).displayName,
		resource: row.resource,
		roles: roles.length === 0 ? null : roles,
		clients: (await oauthRegistry.clientsOf(app)).map((client) => ({
			clientId: client.client_id,
			redirectUris: storedRedirectUris(client),
			metadataUrl: client.metadata_url,
		})),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

function oauthClientDto(row: OAuthClientRow): OAuthClientDto {
	return {
		clientId: row.client_id,
		label: row.label,
		redirectUris: storedRedirectUris(row),
		metadataUrl: row.metadata_url,
		externalApp: row.external_app,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

/** A row's redirect URIs as stored; a value that is no list of strings shows as none (the OAuth paths refuse the client). */
function storedRedirectUris(row: OAuthClientRow): string[] {
	const value = parseJsonOrNull(row.redirect_uris)
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function externalAppWrite(identity: OAuthIdentityResource, name: string | null, clients: readonly ManagedOAuthClient[]): ExternalAppWrite {
	return {
		app: identity.app,
		displayName: name,
		resource: identity.resource,
		roles: identity.roles ?? [],
		clients: clients.map((client) => ({ clientId: client.clientId, redirectUris: client.redirectUris, metadataUrl: storedMetadataUrl(client) })),
	}
}

function authoringClientWrite(client: ManagedOAuthClient): AuthoringClientWrite {
	return { clientId: client.clientId, label: client.provider, redirectUris: client.redirectUris, metadataUrl: storedMetadataUrl(client) }
}

/** Null when IAM fetches the document at the client id itself. */
function storedMetadataUrl(client: ManagedOAuthClient): string | null {
	return client.metadataUrl === client.clientId ? null : client.metadataUrl
}

function registryEvents(c: AdminContext, action: string, write: ExternalAppWrite): RegistryEvents {
	return {
		change: adminEvent(c, {
			action,
			resourceType: 'external_app',
			resourceId: write.app,
			metadata: {
				name: write.displayName,
				resource: write.resource,
				roles: write.roles.map((role) => role.key),
				clients: write.clients.map((client) => client.clientId),
			},
		}),
		revocation: (clientId) => clientRevocation(c, clientId, write.app),
	}
}

function clientRevocation(c: AdminContext, clientId: string, app: string | null): AuditEventInput {
	return adminEvent(c, {
		action: 'iam.oauth.grant.revoke',
		resourceType: 'oauth_client',
		resourceId: clientId,
		metadata: { app, reason: 'client_removed' },
	})
}

function ownedByExternalApp(clientId: string, app: string | null): string {
	return app === null
		? `the client ${clientId} is an MCP authoring client, which only the provisioning key writes`
		: `the client ${clientId} is a client of the external application \`${app}\``
}

function requireOAuth(c: AdminContext): OAuthConfig {
	const config = c.services.config.oauth
	if (config === null) return fail(409, "this installation's OAuth authorization server is off (no OAUTH_CONFIG)")
	return config
}

function requireProvisioningKey(c: AdminContext, what: string): void {
	if (c.admin.id !== PROVISIONING_ADMIN_ID) fail(403, `only the operator's provisioning key ${what}`)
}
