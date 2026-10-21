import { isCimdClientId, isOAuthResourceUri, parseOAuthScopes } from '@fabrika/auth-core'
import type { KeyGrant } from '@fabrika/auth-core'

/** Managed CIMD registrations only; public dynamic registration is not part of this contract. */
export interface OAuthManagedClient {
	provider: 'chatgpt' | 'claude'
	clientId: string
	redirectUris: string[]
}

export interface OAuthClientMetadataDocument {
	client_id: string
	client_name?: string
	redirect_uris: string[]
	token_endpoint_auth_method: 'none'
	grant_types: ('authorization_code' | 'refresh_token')[]
	response_types: ['code']
}

export interface OAuthResourceDto {
	app: string
	resource: string
	/** IAM resolves these app-owned grants; OAuth scope text alone never authorizes an action. */
	scopeGrants: { scope: string; permissions: KeyGrant[] }[]
	/** Used only when scope is omitted. No configured default means invalid_scope, never all scopes. */
	defaultScopes?: string[]
}

/** No access token, refresh token, hash, or authorization code appears in a grant DTO. */
export interface OAuthGrantDto {
	id: string
	principalId: string
	clientId: string
	app: string
	resource: string
	scopes: string[]
	createdAt: number
	expiresAt: number
	revokedAt: number | null
}

export interface OAuthAuthorizationRequest {
	response_type: 'code'
	client_id: string
	redirect_uri: string
	resource: string
	scope?: string
	state?: string
	code_challenge: string
	code_challenge_method: 'S256'
}

export type OAuthAuthorizationCoordinates = Omit<OAuthAuthorizationRequest, 'scope'>

export type OAuthAuthorizationParseResult =
	| { kind: 'valid'; request: OAuthAuthorizationRequest }
	| { kind: 'invalid_scope'; coordinates: OAuthAuthorizationCoordinates; rawScope: string }
	| { kind: 'invalid_request' }

export type OAuthTokenRequest =
	| { grant_type: 'authorization_code'; client_id: string; code: string; redirect_uri: string; code_verifier: string; resource: string }
	| { grant_type: 'refresh_token'; client_id: string; refresh_token: string; resource: string }

export interface OAuthTokenResponse {
	access_token: string
	token_type: 'Bearer'
	expires_in: number
	refresh_token?: string
	scope: string
}

export interface OAuthRevocationRequest {
	client_id: string
	token: string
	token_type_hint?: 'access_token' | 'refresh_token'
}

export interface OAuthAuthorizationServerMetadata {
	issuer: string
	authorization_endpoint: string
	token_endpoint: string
	revocation_endpoint: string
	jwks_uri: string
	response_types_supported: ['code']
	grant_types_supported: ['authorization_code', 'refresh_token']
	code_challenge_methods_supported: ['S256']
	token_endpoint_auth_methods_supported: ['none']
	client_id_metadata_document_supported: true
}

function isNonemptyText(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0
}

function field(value: unknown, name: string): unknown {
	return typeof value === 'object' && value !== null && Object.hasOwn(value, name) ? Reflect.get(value, name) : undefined
}

function redirectUris(value: unknown): string[] | null {
	if (!Array.isArray(value) || value.length === 0 || value.length > 32) return null
	const uris: string[] = []
	for (const item of value) {
		if (!isOAuthResourceUri(item) || uris.includes(item)) return null
		uris.push(item)
	}
	return uris
}

export function parseOAuthManagedClient(value: unknown): OAuthManagedClient | null {
	const provider = field(value, 'provider')
	const clientId = field(value, 'clientId')
	const uris = redirectUris(field(value, 'redirectUris'))
	return (provider === 'chatgpt' || provider === 'claude') && isCimdClientId(clientId) && uris !== null
		? { provider, clientId, redirectUris: uris }
		: null
}

/** A fetched document cannot enlarge the managed registration's exact redirect allowlist. */
export function parseOAuthClientMetadata(value: unknown, registration: OAuthManagedClient): OAuthClientMetadataDocument | null {
	const managed = parseOAuthManagedClient(registration)
	const clientId = field(value, 'client_id')
	const clientName = field(value, 'client_name')
	const uris = redirectUris(field(value, 'redirect_uris'))
	const grants = parseClientGrantTypes(field(value, 'grant_types'))
	const rawResponses = field(value, 'response_types')
	const responses = rawResponses === undefined ? ['code'] : rawResponses
	if (
		managed === null || clientId !== managed.clientId || uris === null || !uris.every((uri) => managed.redirectUris.includes(uri))
		|| field(value, 'token_endpoint_auth_method') !== 'none' || (clientName !== undefined && !isNonemptyText(clientName))
		|| field(value, 'client_secret') !== undefined || field(value, 'client_secret_expires_at') !== undefined || grants === null
		|| !Array.isArray(responses) || responses.length !== 1 || responses[0] !== 'code'
	) return null
	const metadata: OAuthClientMetadataDocument = {
		client_id: managed.clientId,
		redirect_uris: uris,
		token_endpoint_auth_method: 'none',
		grant_types: grants,
		response_types: ['code'],
	}
	if (isNonemptyText(clientName)) metadata.client_name = clientName
	return metadata
}

function parseClientGrantTypes(value: unknown): OAuthClientMetadataDocument['grant_types'] | null {
	if (value === undefined) return ['authorization_code']
	if (!Array.isArray(value) || value.length === 0 || value.length > 16) return null
	const grants: OAuthClientMetadataDocument['grant_types'] = []
	for (const grant of value) {
		if (typeof grant !== 'string') return null
		// A client may list grants IAM does not serve (Claude lists jwt-bearer); IAM serves the intersection.
		if ((grant !== 'authorization_code' && grant !== 'refresh_token') || grants.includes(grant)) continue
		grants.push(grant)
	}
	return grants.includes('authorization_code') ? grants : null
}

export function parseOAuthResourceDto(value: unknown): OAuthResourceDto | null {
	const app = field(value, 'app')
	const resource = field(value, 'resource')
	const rawGrants = field(value, 'scopeGrants')
	const rawDefaultScopes = field(value, 'defaultScopes')
	if (
		!isNonemptyText(app) || app.includes('*') || !isOAuthResourceUri(resource) || !Array.isArray(rawGrants) || rawGrants.length === 0
		|| rawGrants.length > 64
	) return null
	const scopeGrants: OAuthResourceDto['scopeGrants'] = []
	for (const entry of rawGrants) {
		const scope = field(entry, 'scope')
		const permissions = parseResourcePermissions(field(entry, 'permissions'))
		if (typeof scope !== 'string' || parseOAuthScopes([scope]) === null || permissions === null || scopeGrants.some((grant) => grant.scope === scope)) {
			return null
		}
		scopeGrants.push({ scope, permissions })
	}
	const dto: OAuthResourceDto = { app, resource, scopeGrants }
	if (rawDefaultScopes !== undefined) {
		const defaultScopes = parseOAuthScopes(rawDefaultScopes)
		if (defaultScopes === null || !defaultScopes.every((scope) => scopeGrants.some((grant) => grant.scope === scope))) return null
		dto.defaultScopes = defaultScopes
	}
	return dto
}

function parseResourcePermissions(value: unknown): KeyGrant[] | null {
	if (!Array.isArray(value) || value.length === 0 || value.length > 64) return null
	const permissions: KeyGrant[] = []
	for (const entry of value) {
		const action = field(entry, 'action')
		const rawScope = field(entry, 'scope')
		if (!isNonemptyText(action)) return null
		if (rawScope === undefined) permissions.push({ action })
		else if (rawScope === null) permissions.push({ action, scope: null })
		else {
			const type = field(rawScope, 'type')
			const scopeValue = field(rawScope, 'value')
			if (!isNonemptyText(type) || !isNonemptyText(scopeValue)) return null
			permissions.push({ action, scope: { type, value: scopeValue } })
		}
	}
	return permissions
}

export function resolveOAuthAuthorizationScopes(scope: string | undefined, resource: OAuthResourceDto): string[] | null {
	const scopes = scope === undefined ? resource.defaultScopes : parseOAuthScopes(scope.split(' '))
	if (!scopes || scopes.length === 0) return null
	return scopes.every((entry) => resource.scopeGrants.some((grant) => grant.scope === entry))
		? [...scopes]
		: null
}

export function parseOAuthAuthorizationAttempt(value: unknown): OAuthAuthorizationParseResult {
	const clientId = field(value, 'client_id')
	const redirectUri = field(value, 'redirect_uri')
	const resource = field(value, 'resource')
	const scope = field(value, 'scope')
	const state = field(value, 'state')
	const challenge = field(value, 'code_challenge')
	if (
		field(value, 'response_type') !== 'code' || field(value, 'code_challenge_method') !== 'S256' || !isCimdClientId(clientId)
		|| !isOAuthResourceUri(redirectUri) || !isOAuthResourceUri(resource)
		|| (state !== undefined && (typeof state !== 'string' || state.length > 2048)) || typeof challenge !== 'string'
		|| !/^[A-Za-z0-9_-]{43}$/.test(challenge)
	) return { kind: 'invalid_request' }
	if (scope !== undefined && typeof scope !== 'string') return { kind: 'invalid_request' }
	const coordinates: OAuthAuthorizationCoordinates = {
		response_type: 'code',
		client_id: clientId,
		redirect_uri: redirectUri,
		resource,
		code_challenge: challenge,
		code_challenge_method: 'S256',
	}
	if (typeof state === 'string') coordinates.state = state
	if (typeof scope === 'string' && parseOAuthScopes(scope.split(' ')) === null) return { kind: 'invalid_scope', coordinates, rawScope: scope }
	const request: OAuthAuthorizationRequest = { ...coordinates }
	if (typeof scope === 'string') request.scope = scope
	return { kind: 'valid', request }
}

export function parseOAuthAuthorizationRequest(value: unknown): OAuthAuthorizationRequest | null {
	const result = parseOAuthAuthorizationAttempt(value)
	return result.kind === 'valid' ? result.request : null
}

export function parseOAuthTokenRequest(value: unknown): OAuthTokenRequest | null {
	const clientId = field(value, 'client_id')
	const resource = field(value, 'resource')
	const grantType = field(value, 'grant_type')
	if (!isCimdClientId(clientId) || !isOAuthResourceUri(resource)) return null
	if (grantType === 'authorization_code') {
		const code = field(value, 'code')
		const redirectUri = field(value, 'redirect_uri')
		const verifier = field(value, 'code_verifier')
		if (!isNonemptyText(code) || !isOAuthResourceUri(redirectUri) || typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
			return null
		}
		return { grant_type: grantType, client_id: clientId, code, redirect_uri: redirectUri, code_verifier: verifier, resource }
	}
	if (grantType === 'refresh_token') {
		const refreshToken = field(value, 'refresh_token')
		return isNonemptyText(refreshToken) ? { grant_type: grantType, client_id: clientId, refresh_token: refreshToken, resource } : null
	}
	return null
}

export function parseOAuthRevocationRequest(value: unknown): OAuthRevocationRequest | null {
	const clientId = field(value, 'client_id')
	const token = field(value, 'token')
	const hint = field(value, 'token_type_hint')
	if (
		!isCimdClientId(clientId) || typeof token !== 'string' || token.length === 0 || token.length > 32768
		|| (hint !== undefined && (typeof hint !== 'string' || hint.length > 200))
	) return null
	const request: OAuthRevocationRequest = { client_id: clientId, token }
	if (hint === 'access_token' || hint === 'refresh_token') request.token_type_hint = hint
	return request
}
