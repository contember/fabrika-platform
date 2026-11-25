import { BUILTIN_ROLE_KEYS, isCimdClientId, isOAuthClientId, isOAuthResourceUri, parseOAuthScopes } from '@fabrika/auth-core'
import type { KeyGrant } from '@fabrika/auth-core'

/**
 * The kinds of managed client an installation registers. A label only: every kind gets the same authorization code
 * flow with S256 PKCE, the same RFC 8707 resources and the same scope ceilings (ADR-0049).
 */
export const OAUTH_CLIENT_PROVIDERS = ['claude', 'chatgpt', 'external'] as const
export type OAuthClientProvider = (typeof OAUTH_CLIENT_PROVIDERS)[number]

function isOAuthClientProvider(value: unknown): value is OAuthClientProvider {
	return OAUTH_CLIENT_PROVIDERS.some((provider) => provider === value)
}

/**
 * The one resource an identity-only client is served: its own, outside the installation. A token for it carries the
 * person's identity and no permission, under `app`, an id no installation service or application holds. With `roles`,
 * the application's roles are IAM's to grant: the token names those the person holds there, and a person holding none
 * is refused.
 */
export interface OAuthIdentityResource {
	app: string
	resource: string
	roles?: OAuthIdentityRole[]
}

/** A role of an external application: IAM grants it and names it in the token; the application decides what it allows. */
export interface OAuthIdentityRole {
	key: string
	name: string
}

/** How many roles one external application declares. */
export const MAX_OAUTH_IDENTITY_ROLES = 32

/** The one scope of an identity resource: it names the person and grants nothing. */
export const OAUTH_IDENTITY_SCOPE = 'identity'

/** Managed CIMD registrations only; public dynamic registration is not part of this contract. */
export interface OAuthManagedClient {
	provider: OAuthClientProvider
	clientId: string
	redirectUris: string[]
	/** Present only on an `external` client: it is served this resource alone, never a registered one. */
	identity?: OAuthIdentityResource
}

/** RFC 7523 §2.2: the `client_assertion_type` of a JWT client assertion (`private_key_jwt`). */
export const OAUTH_CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'

/** The signing algorithms IAM verifies a client assertion with. */
export const OAUTH_CLIENT_ASSERTION_ALGORITHMS = ['RS256'] as const
export type OAuthClientAssertionAlgorithm = (typeof OAUTH_CLIENT_ASSERTION_ALGORITHMS)[number]

interface OAuthClientMetadataFields {
	client_id: string
	client_name?: string
	redirect_uris: string[]
	grant_types: ('authorization_code' | 'refresh_token')[]
	response_types: ['code']
}

/** A public client, or one that authenticates with a JWT signed by a key its document publishes. */
export type OAuthClientMetadataDocument =
	| (OAuthClientMetadataFields & { token_endpoint_auth_method: 'none' })
	| (OAuthClientMetadataFields & {
		token_endpoint_auth_method: 'private_key_jwt'
		/** HTTPS, on the client id's own origin. */
		jwks_uri: string
		token_endpoint_auth_signing_alg: OAuthClientAssertionAlgorithm
	})

/** How a token or revocation request authenticates its client: no credential, or a JWT assertion. */
export type OAuthClientCredential = { method: 'none' } | { method: 'private_key_jwt'; assertion: string }

export interface OAuthScopeGrant {
	scope: string
	permissions: KeyGrant[]
	/**
	 * A scope dimension type. Such a scope is requested only as `<scope>:<value>`, and each of its scope-less permissions
	 * is narrowed to `{ type: parameter, value }`: `deploy:alpha` with parameter `app` holds its actions at app `alpha` only.
	 */
	parameter?: string
}

export interface OAuthResourceDto {
	app: string
	resource: string
	/** IAM resolves these app-owned grants; OAuth scope text alone never authorizes an action. */
	scopeGrants: OAuthScopeGrant[]
	/** Used only when scope is omitted. No configured default means invalid_scope, never all scopes. */
	defaultScopes?: string[]
	/**
	 * `cli`: served only to the installation's command-line client, through the device grant. Absent: served only to the
	 * operator's managed clients, through an authorization code. A token for one never comes from the other's flow.
	 */
	client?: 'cli'
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

/** RFC 8628 §3.4: the grant type a device client polls the token endpoint with. */
export const OAUTH_DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

export type OAuthTokenRequest =
	| { grant_type: 'authorization_code'; client_id: string; code: string; redirect_uri: string; code_verifier: string; resource: string }
	| { grant_type: 'refresh_token'; client_id: string; refresh_token: string; resource: string }
	| { grant_type: typeof OAUTH_DEVICE_CODE_GRANT_TYPE; client_id: string; device_code: string; resource: string }

/** RFC 8628 §3.1, with every resource the grant is asked for (RFC 8707): each token names one of them. */
export interface OAuthDeviceAuthorizationRequest {
	client_id: string
	scope: string[]
	resources: string[]
}

/** RFC 8628 §3.2. */
export interface OAuthDeviceAuthorizationResponse {
	device_code: string
	user_code: string
	verification_uri: string
	verification_uri_complete: string
	expires_in: number
	interval: number
}

/** The lifetimes a person picks between when approving a device: an hour, a day, a week. */
export const OAUTH_DEVICE_GRANT_LIFETIMES_SECONDS = [3600, 86_400, 604_800] as const
export type OAuthDeviceGrantLifetime = (typeof OAUTH_DEVICE_GRANT_LIFETIMES_SECONDS)[number]

/** How many resources one device grant may name. */
export const MAX_OAUTH_DEVICE_RESOURCES = 8

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
	device_authorization_endpoint: string
	jwks_uri: string
	response_types_supported: ['code']
	grant_types_supported: ['authorization_code', 'refresh_token', typeof OAUTH_DEVICE_CODE_GRANT_TYPE]
	code_challenge_methods_supported: ['S256']
	token_endpoint_auth_methods_supported: ['none', 'private_key_jwt']
	token_endpoint_auth_signing_alg_values_supported: OAuthClientAssertionAlgorithm[]
	revocation_endpoint_auth_methods_supported: ['none', 'private_key_jwt']
	revocation_endpoint_auth_signing_alg_values_supported: OAuthClientAssertionAlgorithm[]
	/** RFC 9207: every authorization response carries `iss`. */
	authorization_response_iss_parameter_supported: true
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
	const rawIdentity = field(value, 'identity')
	if (!isOAuthClientProvider(provider) || !isCimdClientId(clientId) || uris === null) return null
	if (rawIdentity === undefined) return { provider, clientId, redirectUris: uris }
	const identity = parseOAuthIdentityResource(rawIdentity)
	// Claude and ChatGPT are authoring clients; only an external application signs people in for itself.
	return identity === null || provider !== 'external' ? null : { provider, clientId, redirectUris: uris, identity }
}

const IDENTITY_KEYS = ['app', 'resource', 'roles']
const ROLE_KEYS = ['key', 'name']
/** An app id as every fabrika config writes one; no `@`, so never an application environment's id. */
const IDENTITY_APP = /^[a-z0-9][a-z0-9-]{0,62}$/
/** A role key; never a built-in one (`admin` means every action of an application). */
const IDENTITY_ROLE_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/

/** An external application's id: lowercase, without `@`, at most 63 characters. */
export function isOAuthIdentityAppId(value: unknown): value is string {
	return typeof value === 'string' && IDENTITY_APP.test(value)
}

/** A role key an external application may declare: lowercase like an app id, and no built-in role key. */
export function isOAuthIdentityRoleKey(value: unknown): value is string {
	return typeof value === 'string' && IDENTITY_ROLE_KEY.test(value) && !BUILTIN_ROLE_KEYS.includes(value)
}

/** An identity resource binding `{ app, resource, roles? }`, or null when it is not one; unknown keys are refused. */
export function parseOAuthIdentityResource(value: unknown): OAuthIdentityResource | null {
	const app = field(value, 'app')
	const resource = field(value, 'resource')
	const rawRoles = field(value, 'roles')
	if (!hasOnlyKeys(value, IDENTITY_KEYS) || !isOAuthIdentityAppId(app) || !isOAuthResourceUri(resource)) return null
	if (rawRoles === undefined) return { app, resource }
	const roles = parseOAuthIdentityRoles(rawRoles)
	return roles === null ? null : { app, resource, roles }
}

function parseOAuthIdentityRoles(value: unknown): OAuthIdentityRole[] | null {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_OAUTH_IDENTITY_ROLES) return null
	const roles: OAuthIdentityRole[] = []
	for (const entry of value) {
		const key = field(entry, 'key')
		const name = field(entry, 'name')
		if (
			!hasOnlyKeys(entry, ROLE_KEYS) || !isOAuthIdentityRoleKey(key) || !isNonemptyText(name)
			|| name.length > 100 || roles.some((role) => role.key === key)
		) return null
		roles.push({ key, name })
	}
	return roles
}

/** The scopes an identity resource's authorization asks for: none, or exactly `identity`. */
export function resolveOAuthIdentityScopes(scope: string | undefined): string[] | null {
	return scope === undefined || scope === OAUTH_IDENTITY_SCOPE ? [OAUTH_IDENTITY_SCOPE] : null
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
		|| (clientName !== undefined && !isNonemptyText(clientName))
		|| field(value, 'client_secret') !== undefined || field(value, 'client_secret_expires_at') !== undefined || grants === null
		|| !Array.isArray(responses) || responses.length !== 1 || responses[0] !== 'code'
	) return null
	const fields: OAuthClientMetadataFields = {
		client_id: managed.clientId,
		redirect_uris: uris,
		grant_types: grants,
		response_types: ['code'],
	}
	if (isNonemptyText(clientName)) fields.client_name = clientName
	const method = field(value, 'token_endpoint_auth_method')
	if (method === 'none') return { ...fields, token_endpoint_auth_method: 'none' }
	if (method !== 'private_key_jwt') return null
	const jwksUri = field(value, 'jwks_uri')
	const algorithm = field(value, 'token_endpoint_auth_signing_alg')
	// An inline `jwks` would bypass the origin rule below; RFC 7591 §2 forbids it beside `jwks_uri` anyway.
	if (field(value, 'jwks') !== undefined || !isClientOriginUrl(jwksUri, managed.clientId) || !isClientAssertionAlgorithm(algorithm)) return null
	return { ...fields, token_endpoint_auth_method: 'private_key_jwt', jwks_uri: jwksUri, token_endpoint_auth_signing_alg: algorithm }
}

function isClientAssertionAlgorithm(value: unknown): value is OAuthClientAssertionAlgorithm {
	return OAUTH_CLIENT_ASSERTION_ALGORITHMS.some((algorithm) => algorithm === value)
}

/** An HTTPS URL on the client id's own origin, so the client's own host vouches for its keys. */
function isClientOriginUrl(value: unknown, clientId: string): value is string {
	if (typeof value !== 'string' || value.includes('#')) return false
	try {
		const url = new URL(value)
		return url.protocol === 'https:' && url.username === '' && url.password === '' && url.origin === new URL(clientId).origin
	} catch {
		return false
	}
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

const SCOPE_GRANT_KEYS = ['scope', 'permissions', 'parameter']
const PERMISSION_KEYS = ['action', 'scope']
const PERMISSION_SCOPE_KEYS = ['type', 'value']

function hasOnlyKeys(value: unknown, allowed: readonly string[]): boolean {
	return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key))
}

export function parseOAuthResourceDto(value: unknown): OAuthResourceDto | null {
	const app = field(value, 'app')
	const resource = field(value, 'resource')
	const rawGrants = field(value, 'scopeGrants')
	const rawDefaultScopes = field(value, 'defaultScopes')
	const client = field(value, 'client')
	if (client !== undefined && client !== 'cli') return null
	if (
		!isNonemptyText(app) || app.includes('*') || !isOAuthResourceUri(resource) || !Array.isArray(rawGrants) || rawGrants.length === 0
		|| rawGrants.length > 64
	) return null
	const scopeGrants: OAuthScopeGrant[] = []
	for (const entry of rawGrants) {
		// An unknown key is refused: a misspelled `parameter` would otherwise leave the scope unnarrowed.
		if (!hasOnlyKeys(entry, SCOPE_GRANT_KEYS)) return null
		const scope = field(entry, 'scope')
		const permissions = parseResourcePermissions(field(entry, 'permissions'))
		const parameter = field(entry, 'parameter')
		if (
			typeof scope !== 'string' || parseOAuthScopes([scope]) === null || scope.includes(SCOPE_PARAMETER_SEPARATOR) || permissions === null
			|| scopeGrants.some((grant) => grant.scope === scope)
		) {
			return null
		}
		if (parameter === undefined) {
			scopeGrants.push({ scope, permissions })
			continue
		}
		// A parameter narrows scope-less permissions only; a permission that names its own scope would ignore it.
		if (!isScopeParameterText(parameter) || permissions.some((permission) => permission.scope != null)) return null
		scopeGrants.push({ scope, permissions, parameter })
	}
	const dto: OAuthResourceDto = { app, resource, scopeGrants, ...(client === undefined ? {} : { client }) }
	if (rawDefaultScopes !== undefined) {
		const defaultScopes = parseOAuthScopes(rawDefaultScopes)
		if (
			defaultScopes === null || !defaultScopes.every((scope) => scopeGrants.some((grant) => grant.scope === scope && grant.parameter === undefined))
		) {
			return null
		}
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
		if (!hasOnlyKeys(entry, PERMISSION_KEYS) || !isNonemptyText(action)) return null
		if (rawScope === undefined) permissions.push({ action })
		else if (rawScope === null) permissions.push({ action, scope: null })
		else {
			const type = field(rawScope, 'type')
			const scopeValue = field(rawScope, 'value')
			if (!hasOnlyKeys(rawScope, PERMISSION_SCOPE_KEYS) || !isNonemptyText(type) || !isNonemptyText(scopeValue)) return null
			permissions.push({ action, scope: { type, value: scopeValue } })
		}
	}
	return permissions
}

/** Separates a parameterized scope from its value: `deploy:alpha`. */
export const SCOPE_PARAMETER_SEPARATOR = ':'

/** A scope dimension type, or a value of one, as a scope token may carry it. */
function isScopeParameterText(value: unknown): value is string {
	return typeof value === 'string' && value.length <= 100 && /^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(value)
}

/**
 * The resource's grant a requested scope token selects and the narrowed permissions it holds, or null when the token
 * selects none: an unknown scope, a parameterized scope without its value, a value on a scope that takes none.
 */
export function resolveOAuthScopeToken(token: string, resource: OAuthResourceDto): KeyGrant[] | null {
	const separator = token.indexOf(SCOPE_PARAMETER_SEPARATOR)
	const name = separator === -1 ? token : token.slice(0, separator)
	const grant = resource.scopeGrants.find((entry) => entry.scope === name)
	if (grant === undefined) return null
	const type = grant.parameter
	if (type === undefined) return separator === -1 ? grant.permissions : null
	const value = separator === -1 ? null : token.slice(separator + 1)
	if (value === null || !isScopeParameterText(value)) return null
	return grant.permissions.map((permission) => ({ action: permission.action, scope: { type, value } }))
}

export function resolveOAuthAuthorizationScopes(scope: string | undefined, resource: OAuthResourceDto): string[] | null {
	const scopes = scope === undefined ? resource.defaultScopes : parseOAuthScopes(scope.split(' '))
	if (!scopes || scopes.length === 0) return null
	return scopes.every((entry) => resolveOAuthScopeToken(entry, resource) !== null)
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
	if (!isOAuthClientId(clientId) || !isOAuthResourceUri(resource)) return null
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
	if (grantType === OAUTH_DEVICE_CODE_GRANT_TYPE) {
		const deviceCode = field(value, 'device_code')
		return isNonemptyText(deviceCode) && deviceCode.length <= 256
			? { grant_type: grantType, client_id: clientId, device_code: deviceCode, resource }
			: null
	}
	return null
}

/**
 * A device authorization request: its client, at least one scope and one to `MAX_OAUTH_DEVICE_RESOURCES` distinct
 * resources. `resource` is the one parameter that may repeat (RFC 8707 §2), so the caller collects it into a list.
 */
export function parseOAuthDeviceAuthorizationRequest(
	value: { fields: Record<string, string>; resources: string[] },
): OAuthDeviceAuthorizationRequest | null {
	const clientId = field(value.fields, 'client_id')
	const scope = field(value.fields, 'scope')
	if (!isOAuthClientId(clientId) || typeof scope !== 'string') return null
	const scopes = parseOAuthScopes(scope.split(' '))
	const resources = value.resources
	if (
		scopes === null || scopes.length === 0 || resources.length === 0 || resources.length > MAX_OAUTH_DEVICE_RESOURCES
		|| !resources.every(isOAuthResourceUri) || new Set(resources).size !== resources.length
	) return null
	return { client_id: clientId, scope: scopes, resources: [...resources] }
}

export function isOAuthDeviceGrantLifetime(value: number): value is OAuthDeviceGrantLifetime {
	return OAUTH_DEVICE_GRANT_LIFETIMES_SECONDS.some((lifetime) => lifetime === value)
}

const MAX_CLIENT_ASSERTION_LENGTH = 16_384

/**
 * The client credential of a token or revocation request (RFC 7521 §4.2). Neither assertion field is no
 * credential; a half-present pair, another assertion type or an oversized assertion is null.
 */
export function parseOAuthClientCredential(value: unknown): OAuthClientCredential | null {
	const type = field(value, 'client_assertion_type')
	const assertion = field(value, 'client_assertion')
	if (type === undefined && assertion === undefined) return { method: 'none' }
	if (type !== OAUTH_CLIENT_ASSERTION_TYPE || !isNonemptyText(assertion) || assertion.length > MAX_CLIENT_ASSERTION_LENGTH) return null
	return { method: 'private_key_jwt', assertion }
}

export function parseOAuthRevocationRequest(value: unknown): OAuthRevocationRequest | null {
	const clientId = field(value, 'client_id')
	const token = field(value, 'token')
	const hint = field(value, 'token_type_hint')
	if (
		!isOAuthClientId(clientId) || typeof token !== 'string' || token.length === 0 || token.length > 32768
		|| (hint !== undefined && (typeof hint !== 'string' || hint.length > 200))
	) return null
	const request: OAuthRevocationRequest = { client_id: clientId, token }
	if (hint === 'access_token' || hint === 'refresh_token') request.token_type_hint = hint
	return request
}
