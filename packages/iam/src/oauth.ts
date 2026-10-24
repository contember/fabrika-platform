import { buildResourceAccessClaims, DEFAULT_TOKEN_TTL_SECONDS, type KeyGrant, parseOAuthScopes, type PermissionEntry } from '@fabrika/auth-core'
import type {
	OAuthAuthorizationRequest,
	OAuthClientMetadataDocument,
	OAuthResourceDto,
	OAuthRevocationRequest,
	OAuthTokenRequest,
	OAuthTokenResponse,
} from '@fabrika/iam-contract'
import { uuidv7 } from '@fabrika/platform'
import { sessionUsable } from './auth'
import { type AuditEventInput, type OAuthGrantRow, type PrincipalRow, principalStatus, type SessionRow } from './db'
import type { Env } from './env'
import { parseJsonOrNull } from './json'
import { narrowPermissions } from './narrow-permissions'
import { clientMetadata } from './oauth-client'
import type { ManagedOAuthClient, OAuthConfig } from './oauth-config'
import { pkceChallenge } from './oidc'
import { unixNow } from './repositories/sql'
import { resolvePermissionsAt } from './resolve'
import { generateToken, hashToken, timingSafeEqualHex } from './secret'
import type { Services } from './services'
import { getSigner, verifyResourceAccessToken } from './signing'
import { boundedToken } from './tokens'

/** An authorization code is redeemed by the client's back end within seconds of the redirect. */
export const OAUTH_CODE_TTL_SECONDS = 60

type SigningEnv = Pick<Env, 'FABRIKA_IAM_SIGNING_KEYS' | 'ENVIRONMENT'>

export interface EstablishedClient {
	registration: ManagedOAuthClient
	metadata: OAuthClientMetadataDocument
}

/**
 * Resolve a client and its redirect URI. Until this succeeds nothing may be redirected to
 * `redirect_uri`. An unregistered client id is refused before any metadata fetch.
 */
export async function establishClient(config: OAuthConfig, clientId: string, redirectUri: string): Promise<EstablishedClient | null> {
	const registration = config.clients.find((client) => client.clientId === clientId)
	if (registration === undefined || !registration.redirectUris.includes(redirectUri)) return null
	const metadata = await clientMetadata(registration)
	if (metadata === null || !metadata.redirect_uris.includes(redirectUri)) return null
	return { registration, metadata }
}

/** Record the consent and return the plaintext authorization code — the only time it exists. */
export async function grantAuthorization(
	services: Services,
	input: { request: OAuthAuthorizationRequest; resource: OAuthResourceDto; scopes: string[]; session: SessionRow; requestId: string },
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

export type OAuthTokenOutcome = { ok: true; body: OAuthTokenResponse } | { ok: false; error: 'invalid_grant' }

/** Redeem a code or rotate a refresh token for a client `authenticateOAuthClient` established. */
export async function exchangeOAuthToken(
	services: Services,
	env: SigningEnv,
	client: EstablishedClient,
	input: OAuthTokenRequest,
	requestId: string,
): Promise<OAuthTokenOutcome> {
	return input.grant_type === 'authorization_code'
		? redeemCode(services, env, client.metadata, input, requestId)
		: rotateRefreshToken(services, env, client.metadata, input, requestId)
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
		!proof || code.expires_at <= now || grant === null || grant.client_id !== input.client_id || grant.resource !== input.resource
		|| code.redirect_uri !== input.redirect_uri
	) {
		return { ok: false, error: 'invalid_grant' }
	}
	const access = await mintForGrant(services, env, grant, now)
	if (access === null) return { ok: false, error: 'invalid_grant' }
	if (!metadata.grant_types.includes('refresh_token')) return { ok: true, body: access }
	const refreshToken = generateToken()
	await repository.insertRefreshToken({ token_hash: await hashToken(refreshToken), grant_id: grant.id, expires_at: grant.expires_at })
	return { ok: true, body: { ...access, refresh_token: refreshToken } }
}

async function rotateRefreshToken(
	services: Services,
	env: SigningEnv,
	metadata: OAuthClientMetadataDocument,
	input: Extract<OAuthTokenRequest, { grant_type: 'refresh_token' }>,
	requestId: string,
): Promise<OAuthTokenOutcome> {
	if (!metadata.grant_types.includes('refresh_token')) return { ok: false, error: 'invalid_grant' }
	const repository = services.repositories.oauth
	const now = unixNow()
	const hash = await hashToken(input.refresh_token)
	const presented = await repository.consumeRefreshToken(hash, now)
	if (presented === null) {
		const spent = await repository.refreshToken(hash)
		// A rotated token presented again: one of the two holders is not the client. The grant is the family.
		if (spent !== null) await repository.revokeGrant(spent.grant_id, now, grantRevocation(requestId, spent.grant_id, input.client_id, 'refresh_replay'))
		return { ok: false, error: 'invalid_grant' }
	}
	const grant = await repository.grant(presented.grant_id)
	if (presented.expires_at <= now || grant === null || grant.client_id !== input.client_id || grant.resource !== input.resource) {
		return { ok: false, error: 'invalid_grant' }
	}
	const access = await mintForGrant(services, env, grant, now)
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

async function mintForGrant(services: Services, env: SigningEnv, grant: OAuthGrantRow, now: number): Promise<OAuthTokenResponse | null> {
	const authority = await grantAuthority(services, grant, now)
	if (authority === null) return null
	// A replay or a revocation may have landed while authority was resolved; read the grant once more.
	const current = await services.repositories.oauth.grant(grant.id)
	if (current === null || current.revoked_at !== null) return null
	const expiresAt = Math.min(now + DEFAULT_TOKEN_TTL_SECONDS, grant.expires_at)
	const claims = buildResourceAccessClaims({
		iss: services.config.issuer,
		app: grant.app,
		resource: grant.resource,
		subject: authority.principal.id,
		label: authority.principal.label,
		permissions: authority.permissions,
		issuedAt: now,
		expiresAt,
		clientId: grant.client_id,
		scopes: authority.scopes,
		grantId: grant.id,
		tokenId: uuidv7(),
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

/**
 * Everything a grant needs to still mean something, checked at every code exchange and refresh: the
 * grant live, its client and resource still configured, the IAM session it was given under live and
 * usable, the principal an active user. The permissions are resolved live, never from the consent.
 */
export async function grantAuthority(
	services: Services,
	grant: OAuthGrantRow,
	now: number,
): Promise<{ principal: PrincipalRow; scopes: string[]; permissions: PermissionEntry[] } | null> {
	const config = services.config.oauth
	if (config === null || grant.revoked_at !== null || grant.expires_at <= now) return null
	const resource = config.resources.find((entry) => entry.resource === grant.resource && entry.app === grant.app)
	if (resource === undefined || !config.clients.some((client) => client.clientId === grant.client_id)) return null
	const scopes = parseOAuthScopes(parseJsonOrNull(grant.scopes))
	const ceiling = scopes === null ? null : scopeCeiling(resource, scopes)
	if (scopes === null || ceiling === null) return null
	const session = await services.repositories.sessions.getActiveSessionById(grant.session_id)
	if (session === null || session.app !== null || session.principal_id !== grant.principal_id || !sessionUsable(session, services.config)) return null
	const principal = await services.repositories.principals.getPrincipalById(grant.principal_id)
	if (principal === null || principal.type !== 'user' || principalStatus(principal) !== 'active') return null
	const live = await resolvePermissionsAt(services, principal, grant.app)
	return { principal, scopes, permissions: narrowPermissions(live, ceiling) }
}

/** The union of the scopes' grants, or null when a scope is no longer configured. */
export function scopeCeiling(resource: OAuthResourceDto, scopes: readonly string[]): KeyGrant[] | null {
	const ceiling: KeyGrant[] = []
	for (const scope of scopes) {
		const grant = resource.scopeGrants.find((entry) => entry.scope === scope)
		if (grant === undefined) return null
		ceiling.push(...grant.permissions)
	}
	return ceiling
}

/** The record of a grant's revocation: by its client, or by IAM on a replayed code or refresh token. */
function grantRevocation(
	requestId: string,
	grantId: string,
	clientId: string,
	reason: 'code_replay' | 'refresh_replay' | 'client_revocation',
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
