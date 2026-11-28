import {
	AGENT_CLIENT_ID,
	type AgentScope,
	type AgentScopeMode,
	agentScopeToken,
	DEFAULT_LOCALE,
	narrowPermissions,
	narrowToValue,
	parseAgentScope,
	parseAppEnvironmentId,
	type PermissionEntry,
} from '@fabrika/auth-core'
import { CONTROL_APP_ID, CONTROL_CLI_RESOURCES } from '@fabrika/control-contract'
import {
	type AgentWriteGate,
	IAM_ADMIN_GRANT_MAX_LIFETIME_SECONDS,
	IAM_BINDING_PREFIX,
	isOAuthDeviceGrantLifetime,
	OAUTH_DEVICE_GRANT_LIFETIMES_SECONDS,
	type OAuthResourceDto,
} from '@fabrika/iam-contract'
import { agentModeTakesPasskey, agentWriteGate, applicationResource, approvableAgentScopes, storedAgentScope } from './agent-resource'
import { parsePresentation } from './app-presentation'
import { sessionEndsAt } from './auth'
import { ACCOUNT_PATH } from './auth/account'
import { readForm, redirectHeaders, sameOrigin } from './auth/http'
import { ceremonyContext, ceremonyPage, credentialField } from './auth/passkey-pages'
import { currentSession } from './auth/sessions'
import { type PrincipalRow, principalStatus } from './db'
import { escapeHtml } from './html'
import { installationBrand } from './installation-brand'
import { isIamAdminResource, scopeCeiling, servesClient } from './oauth'
import type { OAuthConfig } from './oauth-config'
import { attemptRequest, enterUserCode, formatUserCode, normalizeUserCode, OAUTH_DEVICE_PATH, userCodeHash } from './oauth-device'
import { assertionSchema, issueAssertionChallenge, relyingParty, verifyPasskeyAssertion } from './passkeys'
import { htmlPage } from './password-pages'
import type { OAuthDeviceAuthorizationRow, PasskeyConfirmation } from './repositories/oauth'
import type { SignedInSessionRow } from './repositories/sessions'
import { unixNow } from './repositories/sql'
import { resolveAuthorityAt } from './resolve'
import { hashToken } from './secret'
import type { Services } from './services'
import { parseStoredValueList } from './stored-permissions'

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
	if (lifetime > maxLifetime(services, entry.attempt)) {
		return page(services, 'Not allowed', '<p>Administration access lasts one hour at most.</p>', 400)
	}
	// An agent's grant is approved at the scope the page offered, never wider than the request (ADR-0090 §2).
	let scopes: string | undefined
	let passkey: PasskeyConfirmation | undefined
	if (entry.attempt.client_id === AGENT_CLIENT_ID) {
		const gate = await agentWriteGate(services, entry.attempt.app)
		const chosen = approvedAgentScope(entry.attempt, form?.get('scope') ?? null, gate, await holdsPasskey(services, signedIn.principal.id))
		if (chosen === null) return page(services, 'Not allowed', '<p>That scope cannot be approved for this request.</p>', 400)
		scopes = JSON.stringify([agentScopeToken(chosen)])
		if (agentModeTakesPasskey(chosen.mode, gate)) {
			const confirmed = await confirmWithPasskey(services, signedIn.principal.id, form, {
				userCodeHash: hash,
				userCode: entry.userCode,
				scope: chosen,
				lifetime,
			})
			if (confirmed instanceof Response) return confirmed
			passkey = confirmed
		}
	}
	// The grant stays bound to this IAM session and ends with it, an OIDC login's cap included.
	const grantExpiresAt = Math.min(now + lifetime, sessionEndsAt(signedIn.session, services.config))
	const approved = await services.repositories.oauth.approveDeviceAuthorization(
		hash,
		{
			principalId: signedIn.principal.id,
			sessionId: signedIn.session.id,
			grantExpiresAt,
			...(scopes === undefined ? {} : { scopes }),
			...(passkey === undefined ? {} : { passkey }),
		},
		now,
	)
	if (!approved) return page(services, 'Expired', '<p>This request was decided already, or it has expired.</p>', 409)
	return page(
		services,
		'Access granted',
		`<p>The device has access. Return to your terminal; you can close this page.</p>
		<p>Your <a href="${ACCOUNT_PATH}">account page</a> lists what has access to your account, and ends it.</p>`,
	)
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
	if (attempt.client_id === AGENT_CLIENT_ID) return agentConsentPage(services, principal, attempt, userCode)
	const request = attemptRequest(attempt)
	const resources = request?.resources.map((uri) =>
		config.resources.find((entry) => entry.resource === uri && entry.app === attempt.app && servesClient(entry, 'cli'))
	)
	if (request === null || resources === undefined || !resources.every((resource): resource is OAuthResourceDto => resource !== undefined)) {
		return page(services, 'Not available', '<p>This request asks for something the server no longer offers.</p>', 409)
	}
	const authority = await resolveAuthorityAt(services, principal, attempt.app)
	const sections = resources.map((resource) => {
		const permissions = narrowPermissions(authority.permissions, scopeCeiling(resource, request.scopes) ?? [])
		return `<h2>${escapeHtml(resourceLabel(resource))}</h2><p class="uri">${escapeHtml(resource.resource)}</p>${permissionList(permissions)}`
	})
	const admin = resources.some((resource) => isIamAdminResource(services, resource.resource))
	const unbounded = request.scopes.filter((token) =>
		resources.some((resource) => !isIamAdminResource(services, resource.resource) && isUnbounded(resource, token))
	)
	const warning = unbounded.length === 0
		? ''
		: `<p role="alert"><strong>Warning:</strong> ${
			unbounded.map((token) => `<code>${escapeHtml(token)}</code>`).join(', ')
		} is not limited to one scope value: it holds its actions everywhere you hold them.</p>`
	return page(
		services,
		'Authorize device',
		`<h1>Authorize the fabrika command-line client</h1>
		<p>Signed in as <strong>${escapeHtml(principal.label)}</strong>.</p>
		<p>A device asks to act as you in <strong>${escapeHtml(attempt.app)}</strong>. It started this request at
		<strong>${new Date(attempt.created_at * 1000).toISOString()}</strong> with the code <code>${escapeHtml(formatUserCode(userCode))}</code>.
		Allow it only if you started it yourself.</p>
		<p>Scopes: ${request.scopes.map((token) => `<code>${escapeHtml(token)}</code>`).join(' ')}</p>
		${admin ? ADMIN_WARNING : ''}
		${warning}
		<p>At most these permissions, and only while you hold them yourself:</p>
		${sections.join('')}
		<form method="post" action="${OAUTH_DEVICE_PATH}">
		<input type="hidden" name="user_code" value="${escapeHtml(formatUserCode(userCode))}">
		${decisionFields(maxLifetime(services, attempt))}</form>`,
	)
}

/**
 * What the person reads before giving a device IAM's administration (ADR-0049 rule 2): the scope reaches the whole
 * installation, which no other preset does.
 */
const ADMIN_WARNING = `<div role="alert" class="error"><div><p><strong>This gives the device full administration of identity and access
		on this installation (<code>iam.admin</code>) for up to one hour.</strong></p>
		<p>Acting as you, it can grant and revoke any role to anyone, invite and disable people and end their sessions, issue
		and revoke keys, and register and remove external applications. Each call it makes is recorded under your name and
		this grant.</p>
		<p>Allow it only for a device you started yourself, for the task in front of you.</p></div></div>`

/** The longest grant the attempt may be approved for: one hour when it reaches IAM's administration. */
function maxLifetime(services: Services, attempt: OAuthDeviceAuthorizationRow): number {
	const resources = attemptRequest(attempt)?.resources ?? []
	return resources.some((uri) => isIamAdminResource(services, uri)) ? IAM_ADMIN_GRANT_MAX_LIFETIME_SECONDS : Number.POSITIVE_INFINITY
}

/** The lifetime choices up to `longest`, the closing note and the two buttons every device consent ends with. */
function decisionFields(longest = Number.POSITIVE_INFINITY): string {
	const lifetimes = OAUTH_DEVICE_GRANT_LIFETIMES_SECONDS.filter((seconds) => seconds <= longest).map((seconds, index) =>
		`<label class="choice"><input type="radio" name="lifetime" value="${seconds}"${index === 0 ? ' checked' : ''}> ${LIFETIME_LABELS[seconds]}</label>`
	)
	return `<fieldset><legend>Access lasts</legend>${lifetimes.join('')}</fieldset>
		<p>Access also ends when this sign-in ends or when it is revoked.</p>
		<div class="actions"><button name="decision" value="approve">Allow</button>
		<button name="decision" value="deny">Deny</button></div>`
}

/** The scope an agent's approval writes, or null when `offered` is not a scope the request may be approved at. */
function approvedAgentScope(
	attempt: OAuthDeviceAuthorizationRow,
	offered: string | null,
	gate: AgentWriteGate,
	holdsPasskey: boolean,
): AgentScope | null {
	const requested = storedAgentScope(attemptRequest(attempt)?.scopes ?? [])
	const chosen = offered === null ? null : parseAgentScope(offered)
	if (requested === null || chosen === null) return null
	const approvable = approvableAgentScopes(requested, gate, holdsPasskey).some((scope) => agentScopeToken(scope) === agentScopeToken(chosen))
	return approvable ? chosen : null
}

async function holdsPasskey(services: Services, principalId: string): Promise<boolean> {
	return (await services.repositories.passkeys.list(principalId)).length > 0
}

/**
 * The binding of the passkey check that approving an agent's `write` grant takes: this attempt, the scope and the
 * lifetime the person chose, so an answer approves exactly that and nothing else.
 */
async function devicePasskeyBinding(userCodeHash: string, scope: AgentScope, lifetime: number): Promise<string> {
	return `${IAM_BINDING_PREFIX}device:${await hashToken(JSON.stringify([userCodeHash, agentScopeToken(scope), lifetime]))}`
}

/**
 * The passkey check of an approval that takes one (ADR-0090 §5). Without an answer in the form, a page that asks the
 * passkey and posts the same decision back with it; with one, when and which passkey answered, or a refusal page. An
 * answer that reaches verification spends the challenge, right or wrong; a malformed one leaves it to expire.
 */
async function confirmWithPasskey(
	services: Services,
	principalId: string,
	form: URLSearchParams | null,
	decision: { userCodeHash: string; userCode: string; scope: AgentScope; lifetime: number },
): Promise<PasskeyConfirmation | Response> {
	const rp = relyingParty(services.config)
	const binding = await devicePasskeyBinding(decision.userCodeHash, decision.scope, decision.lifetime)
	const challengeId = form?.get('challengeId') ?? null
	if (challengeId === null) {
		const issued = await issueAssertionChallenge(services, rp, principalId, binding)
		if (issued === 'no_passkey') return page(services, 'No passkey', NO_PASSKEY_TEXT, 409)
		if (issued === 'too_many') return page(services, 'Too many attempts', '<p>Too many open passkey checks. Wait a few minutes and try again.</p>', 429)
		return ceremonyPage(ceremonyContext(services, DEFAULT_LOCALE), {
			title: 'Confirm with a passkey',
			text: 'Allowing an agent to change things in this environment takes a passkey. Confirm with one of yours to allow it.',
			ceremony: 'get',
			options: issued.options,
			action: OAUTH_DEVICE_PATH,
			fields: {
				user_code: formatUserCode(decision.userCode),
				decision: 'approve',
				scope: agentScopeToken(decision.scope),
				lifetime: String(decision.lifetime),
				challengeId: issued.challengeId,
			},
			back: false,
		})
	}
	const assertion = form === null ? null : assertionSchema.safeParse({ challengeId, credential: credentialField(form) })
	const verified = assertion === null || !assertion.success ? null : await verifyPasskeyAssertion(services, rp, principalId, binding, assertion.data)
	if (verified === null || !verified.ok) {
		return page(
			services,
			'Not confirmed',
			'<p>The passkey was not accepted, so the agent was not given access. Open the link from your terminal to try again.</p>',
			403,
		)
	}
	return { at: verified.value.at, credentialId: verified.value.credentialId }
}

const NO_PASSKEY_TEXT =
	`<p>This environment lets an agent change things only after a passkey confirmation, and you have no passkey. Add one on your <a href="${ACCOUNT_PATH}#passkeys">account page</a>, then start again from your terminal.</p>`

/** Why the page offers `read` to an agent that asked to write, by the environment's `agent-write` gate, as HTML. */
const DOWNGRADE_REASONS: Readonly<Record<AgentWriteGate, string>> = {
	open: '',
	passkey:
		`This environment lets an agent write only after a passkey confirmation, and you have no passkey. Add one on your <a href="${ACCOUNT_PATH}#passkeys">account page</a>, then start again from your terminal.`,
	refuse: 'This environment does not let agents write.',
}

const AGENT_MODE_WORDS: Readonly<Record<AgentScopeMode, string>> = {
	read: 'reads what you can read, and changes nothing',
	write: 'acts as you, including changes',
}

/**
 * The application case (ADR-0090): an agent asks to call one application environment as the person. The page names the
 * environment, the scope in words, the narrowing and the agent's own label, and lists the actions the agent would get
 * now, the person's live set narrowed. It offers no more than was asked, and `read` where the environment serves no `write`.
 */
async function agentConsentPage(
	services: Services,
	principal: PrincipalRow,
	attempt: OAuthDeviceAuthorizationRow,
	userCode: string,
): Promise<Response> {
	const request = attemptRequest(attempt)
	const [uri] = request?.resources ?? []
	const resource = uri === undefined ? null : await applicationResource(services, uri)
	const requested = storedAgentScope(request?.scopes ?? [])
	const gate = await agentWriteGate(services, attempt.app)
	const [offered] = requested === null ? [] : approvableAgentScopes(requested, gate, await holdsPasskey(services, principal.id))
	if (resource === null || resource.app !== attempt.app || requested === null || offered === undefined) {
		return page(services, 'Not available', '<p>This request asks for something the server no longer offers.</p>', 409)
	}
	const environment = parseAppEnvironmentId(attempt.app)
	const declared = parsePresentation(await services.repositories.appSchema.getPresentation(attempt.app))
	const name = declared.displayName ?? environment?.app ?? attempt.app
	const authority = await resolveAuthorityAt(services, principal, attempt.app)
	const permissions = offered.within === null ? authority.permissions : narrowToValue(authority.permissions, offered.within)
	const label = attempt.agent_label === null
		? '<p>The agent gave no name for itself.</p>'
		: `<p>The agent calls itself <q>${escapeHtml(attempt.agent_label)}</q>. These are its own words; nothing checks them.</p>`
	const downgrade = offered.mode === requested.mode
		? ''
		: `<p role="alert">The agent asked to <strong>write</strong>. ${DOWNGRADE_REASONS[gate]} You can allow it to read.</p>`
	const passkeyNote = agentModeTakesPasskey(offered.mode, gate)
		? '<p>This environment asks for a passkey before an agent may change things: Allow asks you to confirm with one of your passkeys.</p>'
		: ''
	return page(
		services,
		'Authorize agent',
		`<h1>Authorize an agent in ${escapeHtml(name)}</h1>
		<p>Signed in as <strong>${escapeHtml(principal.label)}</strong>.</p>
		<p>An agent asks to act as you in <strong>${escapeHtml(name)}</strong>${
			environment === null ? '' : `, environment <strong>${escapeHtml(environment.env)}</strong>`
		}, at <code>${escapeHtml(resource.resource)}</code>. It started this request at
		<strong>${new Date(attempt.created_at * 1000).toISOString()}</strong> with the code <code>${escapeHtml(formatUserCode(userCode))}</code>.
		Allow it only if you started it yourself.</p>
		${label}
		<p>Client: <code>${escapeHtml(attempt.client_id)}</code></p>
		${downgrade}
		<p>It ${AGENT_MODE_WORDS[offered.mode]}.</p>
		${passkeyNote}
		${await narrowingNotice(services, attempt.app, offered)}
		<p>The actions it would get now, and only while you hold them yourself:</p>
		${permissionList(permissions)}
		<form method="post" action="${OAUTH_DEVICE_PATH}">
		<input type="hidden" name="user_code" value="${escapeHtml(formatUserCode(userCode))}">
		<input type="hidden" name="scope" value="${escapeHtml(agentScopeToken(offered))}">
		${decisionFields()}</form>`,
	)
}

/** What a narrowed scope reaches, in words: the dimension and the value, with the value's label where the dimension lists one. */
async function narrowingNotice(services: Services, app: string, scope: AgentScope): Promise<string> {
	if (scope.within === null) return '<p>It is not limited to one scope value: it reaches everything you can reach here.</p>'
	const { type, value } = scope.within
	const dimension = await services.repositories.appSchema.getScope(app, type)
	const listed = parseStoredValueList(dimension?.value_list ?? null)?.find((entry) => entry.value === value)
	const named = dimension?.label ?? type
	const shown = listed?.label === undefined
		? `<code>${escapeHtml(value)}</code>`
		: `<strong>${escapeHtml(listed.label)}</strong> (<code>${escapeHtml(value)}</code>)`
	const unchecked = listed === undefined ? "<p>Nothing checks that this value exists: it is the agent's word.</p>" : ''
	return `<p>It is limited to ${
		escapeHtml(named)
	} ${shown}: it reaches what your grants at that value reach, and your grants anywhere else do not count.</p>
		${unchecked}`
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
