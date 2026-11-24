import { DEFAULT_LOCALE, type KeyGrant } from '@fabrika/auth-core'
import {
	OAUTH_CLIENT_ASSERTION_ALGORITHMS,
	OAUTH_DEVICE_CODE_GRANT_TYPE,
	type OAuthAuthorizationRequest,
	type OAuthAuthorizationServerMetadata,
	type OAuthClientCredential,
	type OAuthIdentityResource,
	parseOAuthAuthorizationAttempt,
	parseOAuthClientCredential,
	parseOAuthDeviceAuthorizationRequest,
	parseOAuthRevocationRequest,
	parseOAuthTokenRequest,
	resolveOAuthAuthorizationScopes,
	resolveOAuthIdentityScopes,
} from '@fabrika/iam-contract'
import { decodeJwt } from 'jose'
import { readForm, redirectHeaders, sameOrigin } from './auth/http'
import { currentSession } from './auth/sessions'
import { type PrincipalRow, principalStatus } from './db'
import type { Env } from './env'
import { escapeHtml } from './html'
import { installationBrand } from './installation-brand'
import {
	type AuthorizationTarget,
	establishClient,
	exchangeOAuthToken,
	grantAuthorization,
	heldIdentityRoles,
	type ManagedClient,
	revokeOAuthToken,
	scopeCeiling,
	servesClient,
} from './oauth'
import { authenticateOAuthClient, authenticateRevokingClient } from './oauth-client-auth'
import type { OAuthConfig } from './oauth-config'
import { OAUTH_DEVICE_PATH, redeemDeviceCode, startDeviceAuthorization } from './oauth-device'
import { handleDevicePage } from './oauth-device-page'
import { normalizeOrigin } from './origin'
import { htmlPage } from './password-pages'
import type { Services } from './services'

export const OAUTH_METADATA_PATH = '/.well-known/oauth-authorization-server'
const AUTHORIZE_PATH = '/oauth/authorize'
const TOKEN_PATH = '/oauth/token'
const REVOKE_PATH = '/oauth/revoke'
const DEVICE_AUTHORIZATION_PATH = '/oauth/device_authorization'

type SigningEnv = Pick<Env, 'FABRIKA_IAM_SIGNING_KEYS' | 'ENVIRONMENT'>

/**
 * The OAuth authorization server's public surface. With `OAUTH_CONFIG` unset every path is 404. `clientAddress` is the
 * composition's client coordinate (`client-address.ts`), null where it names none.
 */
export async function handleOAuth(
	request: Request,
	services: Services,
	env: SigningEnv,
	requestId: string,
	clientAddress: string | null,
): Promise<Response> {
	const config = services.config.oauth
	if (config === null) return new Response('not found', { status: 404 })
	const pathname = new URL(request.url).pathname
	switch (pathname) {
		case OAUTH_METADATA_PATH:
			return request.method === 'GET' ? authorizationServerMetadata(services.config.issuer) : methodNotAllowed('GET')
		case AUTHORIZE_PATH:
			if (request.method === 'GET') return showConsent(request, services, config)
			if (request.method === 'POST') return decideConsent(request, services, config, requestId)
			return methodNotAllowed('GET, POST')
		case TOKEN_PATH:
			return request.method === 'POST' ? token(request, services, env, config, requestId) : methodNotAllowed('POST')
		case REVOKE_PATH:
			return request.method === 'POST' ? revoke(request, services, env, config, requestId) : methodNotAllowed('POST')
		case DEVICE_AUTHORIZATION_PATH:
			return request.method === 'POST' ? deviceAuthorization(request, services, config, clientAddress) : methodNotAllowed('POST')
		case OAUTH_DEVICE_PATH:
			return handleDevicePage(request, services, config)
		default:
			return new Response('not found', { status: 404 })
	}
}

function authorizationServerMetadata(issuer: string): Response {
	const metadata: OAuthAuthorizationServerMetadata = {
		issuer,
		authorization_endpoint: `${issuer}${AUTHORIZE_PATH}`,
		token_endpoint: `${issuer}${TOKEN_PATH}`,
		revocation_endpoint: `${issuer}${REVOKE_PATH}`,
		device_authorization_endpoint: `${issuer}${DEVICE_AUTHORIZATION_PATH}`,
		jwks_uri: `${issuer}/.well-known/jwks.json`,
		response_types_supported: ['code'],
		grant_types_supported: ['authorization_code', 'refresh_token', OAUTH_DEVICE_CODE_GRANT_TYPE],
		code_challenge_methods_supported: ['S256'],
		token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
		token_endpoint_auth_signing_alg_values_supported: [...OAUTH_CLIENT_ASSERTION_ALGORITHMS],
		revocation_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
		revocation_endpoint_auth_signing_alg_values_supported: [...OAUTH_CLIENT_ASSERTION_ALGORITHMS],
		authorization_response_iss_parameter_supported: true,
		client_id_metadata_document_supported: true,
	}
	return Response.json(metadata, { headers: { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' } })
}

type AuthorizationCheck =
	| { kind: 'refused'; message: string }
	| { kind: 'redirect'; response: Response }
	| { kind: 'valid'; request: OAuthAuthorizationRequest; client: ManagedClient; resource: AuthorizationTarget; scopes: string[]; ceiling: KeyGrant[] }

/**
 * Validate an authorization request in the order RFC 6749 §4.1.2.1 requires: until the client and its
 * redirect URI are established an error is a page here, never a redirect to an unverified address.
 */
async function checkAuthorization(issuer: string, config: OAuthConfig, input: Record<string, string> | null): Promise<AuthorizationCheck> {
	const attempt = parseOAuthAuthorizationAttempt(input)
	if (attempt.kind === 'invalid_request') return { kind: 'refused', message: 'The authorization request is malformed.' }
	const coordinates = attempt.kind === 'valid' ? attempt.request : attempt.coordinates
	const client = await establishClient(config, coordinates.client_id, coordinates.redirect_uri)
	if (client === null) return { kind: 'refused', message: 'The client or its redirect URI is not registered.' }
	if (attempt.kind === 'invalid_scope') return { kind: 'redirect', response: clientRedirect(issuer, coordinates, { error: 'invalid_scope' }) }
	const identity = client.registration.identity
	if (identity !== undefined) return checkIdentityAuthorization(issuer, attempt.request, client, identity)
	// The command-line client's resources are served through the device grant only, never to a managed client.
	const resource = config.resources.find((entry) => entry.resource === coordinates.resource && servesClient(entry, false))
	if (resource === undefined) return { kind: 'redirect', response: clientRedirect(issuer, coordinates, { error: 'invalid_target' }) }
	const scopes = resolveOAuthAuthorizationScopes(attempt.request.scope, resource)
	const ceiling = scopes === null ? null : scopeCeiling(resource, scopes)
	if (scopes === null || ceiling === null) return { kind: 'redirect', response: clientRedirect(issuer, coordinates, { error: 'invalid_scope' }) }
	return { kind: 'valid', request: attempt.request, client, resource, scopes, ceiling }
}

/** An identity-only client is served its own resource alone, with the `identity` scope and no permission. */
function checkIdentityAuthorization(
	issuer: string,
	request: OAuthAuthorizationRequest,
	client: ManagedClient,
	identity: OAuthIdentityResource,
): AuthorizationCheck {
	if (request.resource !== identity.resource) return { kind: 'redirect', response: clientRedirect(issuer, request, { error: 'invalid_target' }) }
	const scopes = resolveOAuthIdentityScopes(request.scope)
	if (scopes === null) return { kind: 'redirect', response: clientRedirect(issuer, request, { error: 'invalid_scope' }) }
	return { kind: 'valid', request, client, resource: identity, scopes, ceiling: [] }
}

/** An external application that declares roles admits only a person holding one of them there. */
async function refusedByIdentityRoles(
	services: Services,
	check: Extract<AuthorizationCheck, { kind: 'valid' }>,
	principal: PrincipalRow,
): Promise<boolean> {
	const roles = check.client.registration.identity?.roles
	return roles !== undefined && await heldIdentityRoles(services, principal, check.resource.app, roles) === null
}

async function showConsent(request: Request, services: Services, config: OAuthConfig): Promise<Response> {
	const url = new URL(request.url)
	const check = await checkAuthorization(services.config.issuer, config, singleValued(url.searchParams))
	if (check.kind === 'refused') return errorPage(services, check.message, 400)
	if (check.kind === 'redirect') return check.response
	const session = await currentSession(request, services)
	if (session === null) {
		const back = `${services.config.issuer}${AUTHORIZE_PATH}${url.search}`
		return new Response(null, { status: 302, headers: redirectHeaders(`${services.config.issuer}/auth/login?redirect=${encodeURIComponent(back)}`) })
	}
	const principal = await services.repositories.principals.getPrincipalById(session.principal_id)
	if (principal === null || principal.type !== 'user' || principalStatus(principal) !== 'active') {
		return errorPage(services, 'This account cannot authorize applications.', 403)
	}
	if (await refusedByIdentityRoles(services, check, principal)) {
		return clientRedirect(services.config.issuer, check.request, { error: 'access_denied' })
	}
	return consentPage(services, check, principal.label)
}

async function decideConsent(request: Request, services: Services, config: OAuthConfig, requestId: string): Promise<Response> {
	if (!sameOrigin(request, services.config)) return errorPage(services, 'The consent was not submitted from this page.', 403)
	const form = await readForm(request)
	const fields = form === null ? null : singleValued(form)
	const decision = fields?.['decision']
	const issuer = services.config.issuer
	const check = await checkAuthorization(issuer, config, fields)
	if (check.kind === 'refused') return errorPage(services, check.message, 400)
	if (check.kind === 'redirect') return check.response
	if (decision === 'deny') return clientRedirect(issuer, check.request, { error: 'access_denied' })
	if (decision !== 'approve') return errorPage(services, 'The consent decision is missing.', 400)
	const session = await currentSession(request, services)
	if (session === null) return errorPage(services, 'Your sign-in has ended. Start the authorization again.', 401)
	const principal = await services.repositories.principals.getPrincipalById(session.principal_id)
	if (principal === null || await refusedByIdentityRoles(services, check, principal)) {
		return clientRedirect(issuer, check.request, { error: 'access_denied' })
	}
	const code = await grantAuthorization(services, { request: check.request, resource: check.resource, scopes: check.scopes, session, requestId })
	return clientRedirect(issuer, check.request, { code })
}

async function token(request: Request, services: Services, env: SigningEnv, config: OAuthConfig, requestId: string): Promise<Response> {
	const form = await readForm(request)
	const fields = form === null ? null : singleValued(form)
	const credential = parseOAuthClientCredential(fields)
	if (credential === null) return protocolError('invalid_client', 401)
	const input = parseOAuthTokenRequest(withAssertedClientId(fields, credential))
	if (input === null) return protocolError('invalid_request', 400)
	const issuer = services.config.issuer
	const client = await authenticateOAuthClient(services, config, {
		clientId: input.client_id,
		credential,
		audiences: [`${issuer}${TOKEN_PATH}`, issuer],
	})
	if (client === null) return protocolError('invalid_client', 401)
	const outcome = input.grant_type === OAUTH_DEVICE_CODE_GRANT_TYPE
		? await redeemDeviceCode(services, env, client, input, requestId)
		: await exchangeOAuthToken(services, env, client, input, requestId)
	if (!outcome.ok) return protocolError(outcome.error, 400)
	return Response.json(outcome.body, { headers: { 'cache-control': 'no-store', pragma: 'no-cache' } })
}

async function revoke(request: Request, services: Services, env: SigningEnv, config: OAuthConfig, requestId: string): Promise<Response> {
	const form = await readForm(request)
	const fields = form === null ? null : singleValued(form)
	const credential = parseOAuthClientCredential(fields)
	if (credential === null) return protocolError('invalid_client', 401)
	const input = parseOAuthRevocationRequest(withAssertedClientId(fields, credential))
	if (input === null) return protocolError('invalid_request', 400)
	const issuer = services.config.issuer
	const authenticated = await authenticateRevokingClient(services, config, {
		clientId: input.client_id,
		credential,
		audiences: [`${issuer}${REVOKE_PATH}`, `${issuer}${TOKEN_PATH}`, issuer],
	})
	if (!authenticated) return protocolError('invalid_client', 401)
	await revokeOAuthToken(services, env, input, requestId)
	return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } })
}

/** RFC 8628 §3.1: a public client starts a device authorization; a client that sends an assertion is refused. */
async function deviceAuthorization(request: Request, services: Services, config: OAuthConfig, clientAddress: string | null): Promise<Response> {
	const form = await readForm(request)
	const fields = form === null ? null : withRepeatedResource(form)
	if (fields === null) return protocolError('invalid_request', 400)
	if (parseOAuthClientCredential(fields.fields)?.method !== 'none') return protocolError('invalid_client', 401)
	const input = parseOAuthDeviceAuthorizationRequest(fields)
	if (input === null) return protocolError('invalid_request', 400)
	const outcome = await startDeviceAuthorization(services, config, input, clientAddress)
	if (!outcome.ok && outcome.error === 'temporarily_unavailable') {
		return Response.json({ error: outcome.error }, { status: 429, headers: { 'retry-after': '60', 'cache-control': 'no-store', pragma: 'no-cache' } })
	}
	if (!outcome.ok) return protocolError(outcome.error, 400)
	return Response.json(outcome.body, { headers: { 'cache-control': 'no-store', pragma: 'no-cache' } })
}

/** RFC 8707 §2: `resource` may repeat to name several resources; every other parameter still must not. */
function withRepeatedResource(params: URLSearchParams): { fields: Record<string, string>; resources: string[] } | null {
	const resources = params.getAll('resource')
	const rest = new URLSearchParams([...params].filter(([name]) => name !== 'resource'))
	const fields = singleValued(rest)
	return fields === null ? null : { fields, resources }
}

/**
 * RFC 7521 §4.2 lets a client that authenticates with an assertion omit `client_id`; the assertion's
 * `sub` then names it. Nothing is trusted from it here: verification requires `iss` = `sub` = that id.
 */
function withAssertedClientId(fields: Record<string, string> | null, credential: OAuthClientCredential): Record<string, string> | null {
	if (fields === null || credential.method !== 'private_key_jwt' || Object.hasOwn(fields, 'client_id')) return fields
	try {
		const subject = decodeJwt(credential.assertion).sub
		return subject === undefined ? fields : { ...fields, client_id: subject }
	} catch {
		return fields
	}
}

async function consentPage(services: Services, check: Extract<AuthorizationCheck, { kind: 'valid' }>, signedInAs: string): Promise<Response> {
	const { request, client, resource, scopes, ceiling } = check
	const clientName = client.metadata.client_name ?? client.registration.clientId
	const permissions = ceiling.map((permission) => {
		const scope = permission.scope == null ? 'everywhere' : `${permission.scope.type} ${permission.scope.value}`
		return `<li><code>${escapeHtml(permission.action)}</code> — ${escapeHtml(scope)}</li>`
	})
	const asks = client.registration.identity === undefined
		? `<p><strong>${escapeHtml(clientName)}</strong> asks to act as you in <strong>${escapeHtml(resource.app)}</strong>.</p>`
		: `<p><strong>${escapeHtml(clientName)}</strong> asks to know who you are. It receives your account, name and e-mail${
			client.registration.identity.roles === undefined ? '' : ` and the roles you hold in <strong>${escapeHtml(resource.app)}</strong>`
		}, and no permission.</p>`
	const grants = client.registration.identity === undefined
		? `<p>At most these permissions, and only those you hold yourself:</p>
		<ul>${permissions.join('')}</ul>`
		: ''
	const fields: [string, string | undefined][] = [
		['response_type', request.response_type],
		['client_id', request.client_id],
		['redirect_uri', request.redirect_uri],
		['resource', request.resource],
		['scope', request.scope],
		['state', request.state],
		['code_challenge', request.code_challenge],
		['code_challenge_method', request.code_challenge_method],
	]
	const hidden = fields.flatMap(([name, value]) => value === undefined ? [] : [`<input type="hidden" name="${name}" value="${escapeHtml(value)}">`])
	return htmlPage({
		locale: DEFAULT_LOCALE,
		brand: await installationBrand(services),
		title: 'Authorize application',
		content: `<h1>Authorize ${escapeHtml(clientName)}</h1>
		<p>Signed in as <strong>${escapeHtml(signedInAs)}</strong>.</p>
		${asks}
		<p>Client: <code>${escapeHtml(client.registration.clientId)}</code></p>
		<p>Resource: <code>${escapeHtml(resource.resource)}</code></p>
		<p>Scopes: <code>${escapeHtml(scopes.join(' '))}</code></p>
		${grants}
		<p>Access ends when this sign-in ends or when it is revoked.</p>
		<form method="post" action="${AUTHORIZE_PATH}">${hidden.join('')}
		<button name="decision" value="approve">Allow</button>
		<button name="decision" value="deny">Deny</button></form>`,
		// Chromium applies `form-action` to the redirect a submission answers with (see CLAUDE.md).
		formActionOrigin: normalizeOrigin(request.redirect_uri) ?? undefined,
	})
}

/** Every authorization response names the issuer (RFC 9207), so a client can detect a mix-up of servers. */
function clientRedirect(
	issuer: string,
	target: Pick<OAuthAuthorizationRequest, 'redirect_uri' | 'state'>,
	parameters: Record<string, string>,
): Response {
	const url = new URL(target.redirect_uri)
	for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value)
	if (target.state !== undefined) url.searchParams.set('state', target.state)
	url.searchParams.set('iss', issuer)
	return new Response(null, { status: 302, headers: redirectHeaders(url.href) })
}

/** OAuth parameters must not repeat (RFC 6749 §3.1); a repeated one makes the whole request invalid. */
function singleValued(params: URLSearchParams): Record<string, string> | null {
	const result: Record<string, string> = {}
	for (const [name, value] of params) {
		if (Object.hasOwn(result, name)) return null
		result[name] = value
	}
	return result
}

async function errorPage(services: Services, message: string, status: number): Promise<Response> {
	return htmlPage({
		locale: DEFAULT_LOCALE,
		brand: await installationBrand(services),
		title: 'Authorization failed',
		content: `<h1>Authorization failed</h1><p>${escapeHtml(message)}</p>`,
		status,
	})
}

function protocolError(error: string, status: number): Response {
	return Response.json({ error }, { status, headers: { 'cache-control': 'no-store', pragma: 'no-cache' } })
}

function methodNotAllowed(allow: string): Response {
	return new Response(null, { status: 405, headers: { allow, 'cache-control': 'no-store' } })
}
