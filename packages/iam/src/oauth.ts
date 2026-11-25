import {
	buildResourceAccessClaims,
	DEFAULT_TOKEN_TTL_SECONDS,
	type KeyGrant,
	narrowPermissions,
	OAUTH_CLI_CLIENT_ID,
	parseOAuthScopes,
	type PermissionEntry,
} from '@fabrika/auth-core'
import {
	OAUTH_DEVICE_CODE_GRANT_TYPE,
	OAUTH_IDENTITY_SCOPE,
	type OAuthAuthorizationRequest,
	type OAuthClientMetadataDocument,
	type OAuthIdentityRole,
	type OAuthResourceDto,
	type OAuthRevocationRequest,
	type OAuthTokenRequest,
	type OAuthTokenResponse,
	resolveOAuthScopeToken,
} from '@fabrika/iam-contract'
import { uuidv7 } from '@fabrika/platform'
import { sessionEndsAt, sessionUsable } from './auth'
import { type AuditEventInput, type OAuthGrantRow, type PrincipalRow, principalStatus, type SessionRow } from './db'
import type { Env } from './env'
import { parseJsonOrNull } from './json'
import { clientMetadata } from './oauth-client'
import { registeredClient } from './oauth-clients'
import type { ManagedOAuthClient, OAuthConfig } from './oauth-config'
import { pkceChallenge } from './oidc'
import { unixNow } from './repositories/sql'
import { authorityDeadline, resolveAuthorityAt } from './resolve'
import { generateToken, hashToken, timingSafeEqualHex } from './secret'
import type { Services } from './services'
import { getSigner, verifyResourceAccessToken } from './signing'
import { boundedToken, mailboxClaim } from './tokens'

/** An authorization code is redeemed by the client's back end within seconds of the redirect. */
export const OAUTH_CODE_TTL_SECONDS = 60

type SigningEnv = Pick<Env, 'FABRIKA_IAM_SIGNING_KEYS' | 'ENVIRONMENT'>

/**
 * A client an authorization or token request comes from: an operator-registered CIMD client, or the installation's own
 * command-line client, a public client IAM knows without a document. The CLI client has no redirect URI, so it never
 * completes an authorization request; it redeems the grants IAM gives it otherwise and refreshes them.
 */
export type EstablishedClient =
	| { kind: 'managed'; registration: ManagedOAuthClient; metadata: OAuthClientMetadataDocument }
	| { kind: 'cli'; clientId: string }

export type ManagedClient = Extract<EstablishedClient, { kind: 'managed' }>

/** The grant types a client may use at the token endpoint: its document's, or the CLI client's fixed set. */
function clientGrantTypes(client: EstablishedClient): readonly string[] {
	return client.kind === 'cli' ? ['refresh_token'] : client.metadata.grant_types
}

/** Whether `resource` is served to the command-line client (`cli`) or to the managed clients; never to both. */
export function servesClient(resource: OAuthResourceDto, cli: boolean): boolean {
	return (resource.client === 'cli') === cli
}

/** The resources a grant was given for: every token it mints names one of them. */
export function grantResources(grant: Pick<OAuthGrantRow, 'resource' | 'resources'>): string[] {
	const stored = grant.resources === null ? null : storedResourceList(grant.resources)
	return stored ?? [grant.resource]
}

/** A stored JSON list of resources, or null when it is not one. */
export function storedResourceList(text: string): string[] | null {
	const value = parseJsonOrNull(text)
	return Array.isArray(value) && value.length > 0 && value.every((entry): entry is string => typeof entry === 'string') ? value : null
}

/**
 * Resolve a client and its redirect URI. Until this succeeds nothing may be redirected to
 * `redirect_uri`. An unregistered client id is refused before any metadata fetch.
 */
export async function establishClient(
	services: Services,
	config: OAuthConfig,
	clientId: string,
	redirectUri: string,
): Promise<ManagedClient | null> {
	const registration = await registeredClient(services, config, clientId)
	if (registration === null || !registration.redirectUris.includes(redirectUri)) return null
	const metadata = await clientMetadata(registration)
	if (metadata === null || !metadata.redirect_uris.includes(redirectUri)) return null
	return { kind: 'managed', registration, metadata }
}

/** What a consent grants: a registered resource, or an identity-only client's own resource. */
export type AuthorizationTarget = Pick<OAuthResourceDto, 'app' | 'resource'>

/** Record the consent and return the plaintext authorization code — the only time it exists. */
export async function grantAuthorization(
	services: Services,
	input: { request: OAuthAuthorizationRequest; resource: AuthorizationTarget; scopes: string[]; session: SessionRow; requestId: string },
): Promise<string> {
	const now = unixNow()
	const code = generateToken()
	const grantId = uuidv7()
	await services.repositories.oauth.createGrant(
		{
			id: grantId,
			principal_id: input.session.principal_id,
			session_id: input.session.id,
			client_id: input.request.client_id,
			app: input.resource.app,
			resource: input.resource.resource,
			resources: null,
			scopes: JSON.stringify(input.scopes),
			created_at: now,
			expires_at: input.session.expires_at,
			revoked_at: null,
		},
		{
			token_hash: await hashToken(code),
			redirect_uri: input.request.redirect_uri,
			challenge: input.request.code_challenge,
			expires_at: Math.min(now + OAUTH_CODE_TTL_SECONDS, input.session.expires_at),
		},
		{
			requestId: input.requestId,
			principalId: input.session.principal_id,
			principalLabel: input.session.principal_id,
			app: 'propustka',
			action: 'iam.oauth.grant.create',
			resourceType: 'oauth_grant',
			resourceId: grantId,
			metadata: { clientId: input.request.client_id, app: input.resource.app, resource: input.resource.resource, scopes: input.scopes },
		},
	)
	return code
}

/** RFC 6749 §5.2 and RFC 8628 §3.5: what a refused token request answers. */
export type OAuthTokenError =
	| 'invalid_grant'
	| 'invalid_target'
	| 'unauthorized_client'
	| 'authorization_pending'
	| 'slow_down'
	| 'access_denied'
	| 'expired_token'

export type OAuthTokenOutcome = { ok: true; body: OAuthTokenResponse } | { ok: false; error: OAuthTokenError }

/** Redeem a code or rotate a refresh token for a client `authenticateOAuthClient` established. */
export async function exchangeOAuthToken(
	services: Services,
	env: SigningEnv,
	client: EstablishedClient,
	input: Exclude<OAuthTokenRequest, { grant_type: typeof OAUTH_DEVICE_CODE_GRANT_TYPE }>,
	requestId: string,
): Promise<OAuthTokenOutcome> {
	const grantTypes = clientGrantTypes(client)
	if (input.grant_type === 'authorization_code') {
		// RFC 6749 §5.2: the CLI client may not use this grant type; refused before the code is spent.
		return client.kind === 'managed' ? redeemCode(services, env, client.metadata, input, requestId) : { ok: false, error: 'unauthorized_client' }
	}
	return rotateRefreshToken(services, env, grantTypes, input, requestId)
}

async function redeemCode(
	services: Services,
	env: SigningEnv,
	metadata: OAuthClientMetadataDocument,
	input: Extract<OAuthTokenRequest, { grant_type: 'authorization_code' }>,
	requestId: string,
): Promise<OAuthTokenOutcome> {
	const repository = services.repositories.oauth
	const now = unixNow()
	const hash = await hashToken(input.code)
	// Spent before any comparison, so every presentation of a code is its last — a wrong verifier included.
	const code = await repository.consumeCode(hash, now)
	if (code === null) {
		const spent = await repository.code(hash)
		// A replayed code may mean it leaked; RFC 6749 §4.1.2 says revoke what it issued.
		if (spent !== null) await repository.revokeGrant(spent.grant_id, now, grantRevocation(requestId, spent.grant_id, input.client_id, 'code_replay'))
		return { ok: false, error: 'invalid_grant' }
	}
	const grant = await repository.grant(code.grant_id)
	const proof = timingSafeEqualHex(await hashToken(await pkceChallenge(input.code_verifier)), await hashToken(code.challenge))
	if (
		!proof || code.expires_at <= now || grant === null || grant.client_id !== input.client_id || !grantResources(grant).includes(input.resource)
		|| code.redirect_uri !== input.redirect_uri
	) {
		return { ok: false, error: 'invalid_grant' }
	}
	const access = await mintForGrant(services, env, grant, input.resource, now)
	if (access === null) return { ok: false, error: 'invalid_grant' }
	if (!metadata.grant_types.includes('refresh_token')) return { ok: true, body: access }
	const refreshToken = generateToken()
	await repository.insertRefreshToken({ token_hash: await hashToken(refreshToken), grant_id: grant.id, expires_at: grant.expires_at })
	return { ok: true, body: { ...access, refresh_token: refreshToken } }
}

async function rotateRefreshToken(
	services: Services,
	env: SigningEnv,
	grantTypes: readonly string[],
	input: Extract<OAuthTokenRequest, { grant_type: 'refresh_token' }>,
	requestId: string,
): Promise<OAuthTokenOutcome> {
	if (!grantTypes.includes('refresh_token')) return { ok: false, error: 'invalid_grant' }
	const repository = services.repositories.oauth
	const now = unixNow()
	const hash = await hashToken(input.refresh_token)
	// RFC 8707: a live token asking for a resource its grant does not cover is refused unspent, so the client keeps it.
	const unspent = await repository.refreshToken(hash)
	if (unspent !== null && unspent.used_at === null) {
		const covering = await repository.grant(unspent.grant_id)
		if (covering !== null && covering.client_id === input.client_id && !grantResources(covering).includes(input.resource)) {
			return { ok: false, error: 'invalid_target' }
		}
	}
	const presented = await repository.consumeRefreshToken(hash, now)
	if (presented === null) {
		const spent = await repository.refreshToken(hash)
		// A rotated token presented again: one of the two holders is not the client. The grant is the family.
		if (spent !== null) await repository.revokeGrant(spent.grant_id, now, grantRevocation(requestId, spent.grant_id, input.client_id, 'refresh_replay'))
		return { ok: false, error: 'invalid_grant' }
	}
	const grant = await repository.grant(presented.grant_id)
	if (presented.expires_at <= now || grant === null || grant.client_id !== input.client_id || !grantResources(grant).includes(input.resource)) {
		return { ok: false, error: 'invalid_grant' }
	}
	const access = await mintForGrant(services, env, grant, input.resource, now)
	if (access === null) return { ok: false, error: 'invalid_grant' }
	const next = generateToken()
	await repository.insertRefreshToken({ token_hash: await hashToken(next), grant_id: grant.id, expires_at: grant.expires_at })
	return { ok: true, body: { ...access, refresh_token: next } }
}

/** RFC 7009: revoking either token kind revokes its grant. An unknown or foreign token is a silent no-op. */
export async function revokeOAuthToken(services: Services, env: SigningEnv, input: OAuthRevocationRequest, requestId: string): Promise<void> {
	const repository = services.repositories.oauth
	const now = unixNow()
	const refresh = await repository.refreshToken(await hashToken(input.token))
	if (refresh !== null) {
		const grant = await repository.grant(refresh.grant_id)
		if (grant?.client_id === input.client_id) {
			await repository.revokeGrant(grant.id, now, grantRevocation(requestId, grant.id, input.client_id, 'client_revocation'))
		}
		return
	}
	const claims = await verifyResourceAccessToken(await getSigner(env), input.token, { issuer: services.config.issuer })
	if (claims?.oauth === undefined || claims.oauth.clientId !== input.client_id) return
	const grant = await repository.grant(claims.oauth.grantId)
	if (grant !== null && grant.client_id === input.client_id && grant.principal_id === claims.sub) {
		await repository.revokeGrant(grant.id, now, grantRevocation(requestId, grant.id, input.client_id, 'client_revocation'))
	}
}

/** An access token for `resource`, one of the grant's resources, carrying the grant's live authority there. */
export async function mintForGrant(
	services: Services,
	env: SigningEnv,
	grant: OAuthGrantRow,
	resource: string,
	now: number,
): Promise<OAuthTokenResponse | null> {
	const authority = await grantAuthority(services, grant, now, resource)
	if (authority === null) return null
	// A replay or a revocation may have landed while authority was resolved; read the grant once more.
	const current = await services.repositories.oauth.grant(grant.id)
	if (current === null || current.revoked_at !== null) return null
	const expiresAt = Math.min(now + DEFAULT_TOKEN_TTL_SECONDS, grant.expires_at, authority.expiresAt ?? Number.POSITIVE_INFINITY)
	const claims = buildResourceAccessClaims({
		iss: services.config.issuer,
		app: grant.app,
		resource,
		subject: authority.principal.id,
		label: authority.principal.label,
		permissions: authority.permissions,
		issuedAt: now,
		expiresAt,
		clientId: grant.client_id,
		scopes: authority.scopes,
		grantId: grant.id,
		tokenId: uuidv7(),
		...(authority.identity === undefined ? {} : { ...mailboxClaim(authority.principal), ...authority.identity }),
	})
	const token = await boundedToken((await getSigner(env)).signResourceToken(claims), { app: grant.app, subject: authority.principal.id })
	if (token === null) return null
	return {
		access_token: token,
		token_type: 'Bearer',
		expires_in: expiresAt - now,
		scope: authority.scopes.join(' '),
	}
}

/** What a grant's next token carries. `identity` is present on an identity resource's: its roles, when it declares them. */
export interface GrantAuthority {
	principal: PrincipalRow
	scopes: string[]
	permissions: PermissionEntry[]
	expiresAt: number | null
	identity?: { roles?: string[] }
}

/**
 * Everything a grant needs to still mean something, checked at every code exchange and refresh: the
 * grant live, its client and resource still configured, the IAM session it was given under live and
 * usable, the principal an active user. The permissions are resolved live, never from the consent.
 */
export async function grantAuthority(
	services: Services,
	grant: OAuthGrantRow,
	now: number,
	resourceUri: string = grant.resource,
): Promise<GrantAuthority | null> {
	const config = services.config.oauth
	if (config === null || grant.revoked_at !== null || grant.expires_at <= now || !grantResources(grant).includes(resourceUri)) return null
	const scopes = parseOAuthScopes(parseJsonOrNull(grant.scopes))
	const ceiling = scopes === null ? null : await grantCeiling(services, config, grant, resourceUri, scopes)
	if (scopes === null || ceiling === null) return null
	const session = await services.repositories.sessions.getActiveSessionById(grant.session_id)
	if (session === null || session.app !== null || session.principal_id !== grant.principal_id || !sessionUsable(session, services.config, now)) {
		return null
	}
	const principal = await services.repositories.principals.getPrincipalById(grant.principal_id)
	if (principal === null || principal.type !== 'user' || principalStatus(principal) !== 'active') return null
	if (ceiling.kind === 'identity') {
		// An identity resource's token names the person and carries no permission. With declared roles it names those
		// the person holds, and a person holding none gets no token: the grant stops at the next refresh.
		const sessionEnd = sessionEndsAt(session, services.config)
		if (ceiling.roles === undefined) return { principal, scopes, permissions: [], expiresAt: sessionEnd, identity: {} }
		const held = await heldIdentityRoles(services, principal, grant.app, ceiling.roles)
		if (held === null) return null
		const expiresAt = Math.min(held.until ?? Number.POSITIVE_INFINITY, sessionEnd)
		return { principal, scopes, permissions: [], expiresAt, identity: { roles: held.keys } }
	}
	const live = await resolveAuthorityAt(services, principal, grant.app)
	const permissions = narrowPermissions(live.permissions, ceiling.permissions)
	// A refreshed token ends with its login too: an OIDC login issued before the cap stores a later expiry than its end.
	const expiresAt = Math.min(authorityDeadline(live, permissions, now) ?? Number.POSITIVE_INFINITY, sessionEndsAt(session, services.config))
	return { principal, scopes, permissions, expiresAt }
}

/**
 * What a grant's token may carry at `resourceUri` under the current configuration, or null when its client or resource
 * is no longer configured for it. An identity-only client is served its own resource alone, so a grant it holds for
 * any other one (given before it was bound) mints nothing, and a grant for an identity resource carries no permission.
 */
async function grantCeiling(
	services: Services,
	config: OAuthConfig,
	grant: OAuthGrantRow,
	resourceUri: string,
	scopes: readonly string[],
): Promise<{ kind: 'identity'; roles: readonly OAuthIdentityRole[] | undefined } | { kind: 'scoped'; permissions: KeyGrant[] } | null> {
	const cli = grant.client_id === OAUTH_CLI_CLIENT_ID
	const client = cli ? null : await registeredClient(services, config, grant.client_id)
	if (!cli && client === null) return null
	const identity = client?.identity
	if (identity !== undefined) {
		const matches = identity.resource === resourceUri && identity.app === grant.app && sameScopes(scopes, [OAUTH_IDENTITY_SCOPE])
		return matches ? { kind: 'identity', roles: identity.roles } : null
	}
	const resource = config.resources.find((entry) => entry.resource === resourceUri && entry.app === grant.app && servesClient(entry, cli))
	const permissions = resource === undefined ? null : scopeCeiling(resource, scopes)
	return permissions === null ? null : { kind: 'scoped', permissions }
}

/**
 * The declared roles `principal` holds at an external application, in declared order, and when the earliest of them
 * ends (null: none ends); null when it holds none. Only a global grant of a declared role counts, and only for an
 * internal principal: an external one holds nothing but roles its application declares external (ADR-0051).
 */
export async function heldIdentityRoles(
	services: Services,
	principal: PrincipalRow,
	app: string,
	declared: readonly OAuthIdentityRole[],
): Promise<{ keys: string[]; until: number | null } | null> {
	if (principal.affiliation !== 'internal') return null
	const grants = await services.repositories.grants.getActiveGrantsForApp(principal.id, app, { includeCrossApp: false })
	const held = new Map<string, number | null>()
	for (const grant of grants) {
		const key = grant.role_key
		if (key === null || grant.app !== app || grant.scope_type !== null || !declared.some((role) => role.key === key)) continue
		const known = held.get(key)
		// A role holds until the last of its grants ends.
		held.set(key, known === undefined ? grant.expires_at : known === null || grant.expires_at === null ? null : Math.max(known, grant.expires_at))
	}
	const keys = declared.map((role) => role.key).filter((key) => held.has(key))
	if (keys.length === 0) return null
	const ends = [...held.values()].filter((until): until is number => until !== null)
	return { keys, until: ends.length === 0 ? null : Math.min(...ends) }
}

function sameScopes(scopes: readonly string[], expected: readonly string[]): boolean {
	return scopes.length === expected.length && scopes.every((scope, index) => scope === expected[index])
}

/** The union of the scopes' grants, or null when a scope is no longer configured. */
export function scopeCeiling(resource: OAuthResourceDto, scopes: readonly string[]): KeyGrant[] | null {
	const ceiling: KeyGrant[] = []
	for (const scope of scopes) {
		const permissions = resolveOAuthScopeToken(scope, resource)
		if (permissions === null) return null
		ceiling.push(...permissions)
	}
	return ceiling
}

/** The record of a grant's revocation: by its client, or by IAM on a replayed code or refresh token. */
export function grantRevocation(
	requestId: string,
	grantId: string,
	clientId: string,
	reason: 'code_replay' | 'refresh_replay' | 'device_code_replay' | 'client_revocation',
): AuditEventInput {
	return {
		requestId,
		principalId: null,
		principalLabel: 'oauth-client',
		app: 'propustka',
		action: 'iam.oauth.grant.revoke',
		resourceType: 'oauth_grant',
		resourceId: grantId,
		metadata: { clientId, reason },
	}
}
