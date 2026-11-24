import { DEFAULT_LOCALE, narrowPermissions, type PermissionEntry } from '@fabrika/auth-core'
import { CONTROL_APP_ID, CONTROL_CLI_RESOURCES } from '@fabrika/control-contract'
import { isOAuthDeviceGrantLifetime, OAUTH_DEVICE_GRANT_LIFETIMES_SECONDS, type OAuthResourceDto } from '@fabrika/iam-contract'
import { sessionEndsAt } from './auth'
import { readForm, redirectHeaders, sameOrigin } from './auth/http'
import { currentSession } from './auth/sessions'
import { type PrincipalRow, principalStatus } from './db'
import { escapeHtml } from './html'
import { installationBrand } from './installation-brand'
import { scopeCeiling, servesClient } from './oauth'
import type { OAuthConfig } from './oauth-config'
import { attemptRequest, enterUserCode, formatUserCode, normalizeUserCode, OAUTH_DEVICE_PATH, userCodeHash } from './oauth-device'
import { htmlPage } from './password-pages'
import type { OAuthDeviceAuthorizationRow } from './repositories/oauth'
import type { SignedInSessionRow } from './repositories/sessions'
import { unixNow } from './repositories/sql'
import { resolveAuthorityAt } from './resolve'
import type { Services } from './services'

const LIFETIME_LABELS: Record<(typeof OAUTH_DEVICE_GRANT_LIFETIMES_SECONDS)[number], string> = {
	3600: '1 hour',
	86_400: '24 hours',
	604_800: '7 days',
}

/**
 * `/oauth/device`: a signed-in person enters the code a device shows, reads what it asks for and decides. GET only
 * renders the entry form, so a link can neither decide nor spend the person's code-entry budget.
 */
export async function handleDevicePage(request: Request, services: Services, config: OAuthConfig): Promise<Response> {
	if (request.method !== 'GET' && request.method !== 'POST') {
		return new Response(null, { status: 405, headers: { allow: 'GET, POST', 'cache-control': 'no-store' } })
	}
	if (request.method === 'POST' && !sameOrigin(request, services.config)) {
		return page(services, 'Not allowed', '<p>The form was not submitted from this page.</p>', 403)
	}
	const signedIn = await signedInPerson(request, services)
	if (signedIn === null) {
		if (request.method === 'POST') return page(services, 'Signed out', '<p>Your sign-in has ended. Open the link from your terminal again.</p>', 401)
		const back = `${services.config.issuer}${OAUTH_DEVICE_PATH}${new URL(request.url).search}`
		return new Response(null, { status: 302, headers: redirectHeaders(`${services.config.issuer}/auth/login?redirect=${encodeURIComponent(back)}`) })
	}
	if (signedIn === 'refused') return page(services, 'Not allowed', '<p>This account cannot authorize devices.</p>', 403)
	if (request.method === 'GET') {
		const offered = new URL(request.url).searchParams.get('user_code')
		const code = offered === null ? null : normalizeUserCode(offered)
		return entryPage(services, signedIn.principal, code === null ? '' : formatUserCode(code), null)
	}
	const form = await readForm(request)
	const rawCode = form?.get('user_code') ?? ''
	const entry = await enterUserCode(services, signedIn.principal.id, rawCode)
	if (entry.kind === 'throttled') return page(services, 'Too many attempts', '<p>Too many wrong codes. Wait ten minutes and try again.</p>', 429)
	if (entry.kind === 'unknown') return entryPage(services, signedIn.principal, '', 'That code is not valid, or it has expired.')
	const decision = form?.get('decision')
	if (decision === null || decision === undefined) return consentPage(services, config, signedIn.principal, entry.attempt, entry.userCode)
	const hash = await userCodeHash(entry.userCode)
	const now = unixNow()
	if (decision === 'deny') {
		await services.repositories.oauth.denyDeviceAuthorization(hash, now)
		return page(services, 'Access denied', '<p>The device was not given access. You can close this page.</p>')
	}
	const lifetime = Number(form?.get('lifetime'))
	if (decision !== 'approve' || !isOAuthDeviceGrantLifetime(lifetime)) return page(services, 'Not allowed', '<p>The decision is missing.</p>', 400)
	// The grant stays bound to this IAM session and ends with it, an OIDC login's cap included.
	const grantExpiresAt = Math.min(now + lifetime, sessionEndsAt(signedIn.session, services.config))
	const approved = await services.repositories.oauth.approveDeviceAuthorization(
		hash,
		{ principalId: signedIn.principal.id, sessionId: signedIn.session.id, grantExpiresAt },
		now,
	)
	if (!approved) return page(services, 'Expired', '<p>This request was decided already, or it has expired.</p>', 409)
	return page(services, 'Access granted', '<p>The device has access. Return to your terminal; you can close this page.</p>')
}

async function signedInPerson(
	request: Request,
	services: Services,
): Promise<{ session: SignedInSessionRow; principal: PrincipalRow } | 'refused' | null> {
	const session = await currentSession(request, services)
	if (session === null) return null
	const principal = await services.repositories.principals.getPrincipalById(session.principal_id)
	if (principal === null || principal.type !== 'user' || principalStatus(principal) !== 'active') return 'refused'
	return { session, principal }
}

async function entryPage(services: Services, principal: PrincipalRow, code: string, problem: string | null): Promise<Response> {
	return page(
		services,
		'Connect a device',
		`<h1>Connect a device</h1>
		<p>Signed in as <strong>${escapeHtml(principal.label)}</strong>.</p>
		${problem === null ? '' : `<p role="alert">${escapeHtml(problem)}</p>`}
		<p>Enter the code your terminal shows. Only enter a code you started yourself.</p>
		<form method="post" action="${OAUTH_DEVICE_PATH}">
		<label for="user_code">Code</label>
		<input id="user_code" name="user_code" value="${escapeHtml(code)}" autocomplete="off" autocapitalize="characters" spellcheck="false" required>
		<button>Continue</button></form>`,
		problem === null ? 200 : 400,
	)
}

async function consentPage(
	services: Services,
	config: OAuthConfig,
	principal: PrincipalRow,
	attempt: OAuthDeviceAuthorizationRow,
	userCode: string,
): Promise<Response> {
	const request = attemptRequest(attempt)
	const resources = request?.resources.map((uri) =>
		config.resources.find((entry) => entry.resource === uri && entry.app === attempt.app && servesClient(entry, true))
	)
	if (request === null || resources === undefined || !resources.every((resource): resource is OAuthResourceDto => resource !== undefined)) {
		return page(services, 'Not available', '<p>This request asks for something the server no longer offers.</p>', 409)
	}
	const authority = await resolveAuthorityAt(services, principal, attempt.app)
	const sections = resources.map((resource) => {
		const permissions = narrowPermissions(authority.permissions, scopeCeiling(resource, request.scopes) ?? [])
		return `<h2>${escapeHtml(resourceLabel(resource))}</h2><p class="uri">${escapeHtml(resource.resource)}</p>${permissionList(permissions)}`
	})
	const unbounded = request.scopes.filter((token) => resources.some((resource) => isUnbounded(resource, token)))
	const warning = unbounded.length === 0
		? ''
		: `<p role="alert"><strong>Warning:</strong> ${
			unbounded.map((token) => `<code>${escapeHtml(token)}</code>`).join(', ')
		} is not limited to one scope value: it holds its actions everywhere you hold them.</p>`
	const lifetimes = OAUTH_DEVICE_GRANT_LIFETIMES_SECONDS.map((seconds, index) =>
		`<label class="choice"><input type="radio" name="lifetime" value="${seconds}"${index === 0 ? ' checked' : ''}> ${LIFETIME_LABELS[seconds]}</label>`
	)
	return page(
		services,
		'Authorize device',
		`<h1>Authorize the fabrika command-line client</h1>
		<p>Signed in as <strong>${escapeHtml(principal.label)}</strong>.</p>
		<p>A device asks to act as you in <strong>${escapeHtml(attempt.app)}</strong>. It started this request at
		<strong>${new Date(attempt.created_at * 1000).toISOString()}</strong> with the code <code>${escapeHtml(formatUserCode(userCode))}</code>.
		Allow it only if you started it yourself.</p>
		<p>Scopes: ${request.scopes.map((token) => `<code>${escapeHtml(token)}</code>`).join(' ')}</p>
		${warning}
		<p>At most these permissions, and only while you hold them yourself:</p>
		${sections.join('')}
		<form method="post" action="${OAUTH_DEVICE_PATH}">
		<input type="hidden" name="user_code" value="${escapeHtml(formatUserCode(userCode))}">
		<fieldset><legend>Access lasts</legend>${lifetimes.join('')}</fieldset>
		<p>Access also ends when this sign-in ends or when it is revoked.</p>
		<div class="actions"><button name="decision" value="approve">Allow</button>
		<button name="decision" value="deny">Deny</button></div></form>`,
	)
}

/**
 * What a person reads a resource as: the name the console gives its command-line resource (the device grant serves
 * only those), else the resource's path, which tells two resources of one app apart. The full URI stays under it.
 */
function resourceLabel(resource: OAuthResourceDto): string {
	const path = new URL(resource.resource).pathname
	const known = resource.app === CONTROL_APP_ID ? CONTROL_CLI_RESOURCES.find((entry) => entry.path === path) : undefined
	return known?.label ?? path
}

/** A scope whose actions no parameter narrows and at least one of which names no scope of its own. */
function isUnbounded(resource: OAuthResourceDto, token: string): boolean {
	const grant = resource.scopeGrants.find((entry) => entry.scope === token)
	return grant !== undefined && grant.parameter === undefined && grant.permissions.some((permission) => permission.scope == null)
}

function permissionList(permissions: readonly PermissionEntry[]): string {
	if (permissions.length === 0) return '<p>None: you hold none of these permissions yourself.</p>'
	const items = permissions.map((permission) => {
		const scope = permission.scope == null ? 'everywhere' : `${permission.scope.type} ${permission.scope.value}`
		return `<li><code>${escapeHtml(permission.action)}</code> <span>${escapeHtml(scope)}</span></li>`
	})
	return `<ul class="rows">${items.join('')}</ul>`
}

async function page(services: Services, title: string, content: string, status = 200): Promise<Response> {
	return htmlPage({
		locale: DEFAULT_LOCALE,
		brand: await installationBrand(services),
		title,
		content: content.startsWith('<h1>') ? content : `<h1>${escapeHtml(title)}</h1>${content}`,
		status,
	})
}
