// The signed-in person's own page on IAM's host (`/auth/account`): every OAuth grant that acts as them, an agent's at an
// application included (ADR-0090), and its revocation. It lives here because the login cookie is IAM's (ADR-0023).

import { AGENT_CLIENT_ID, agentScopeToken, OAUTH_CLI_CLIENT_ID, parseAppEnvironmentId } from '@fabrika/auth-core'
import { CONTROL_APP_ID, CONTROL_CLI_RESOURCES } from '@fabrika/control-contract'
import { IAM_APP } from '../admin/router'
import { storedAgentScope } from '../agent-resource'
import { INSTALLATION_PRESENTATION, parsePresentation } from '../app-presentation'
import { type Catalog, catalogFor } from '../catalog'
import { escapeHtml } from '../html'
import { installationBrand } from '../installation-brand'
import { grantRecord, grantResources } from '../oauth'
import { authFailurePage, htmlPage } from '../password-pages'
import { chooseLocale, parseLocale, requestLocales } from '../person-locale'
import type { AuditEventInput } from '../repositories/audit'
import type { OAuthGrantRow } from '../repositories/oauth'
import { unixNow } from '../repositories/sql'
import type { Services } from '../services'
import { parseStoredPermissions } from '../stored-permissions'
import { readForm, redirectHeaders, sameOrigin } from './http'
import { type CurrentLogin, currentLogin } from './sessions'

export const ACCOUNT_PATH = '/auth/account'

/** The most grants the page lists, newest first; it says so when more are live. */
export const ACCOUNT_GRANTS_SHOWN = 50

const NOTICES = ['revoked', 'already_ended'] as const

type Notice = (typeof NOTICES)[number]

/** The query parameter a revocation's redirect names its outcome in, so a reload of the page submits nothing again. */
const NOTICE_PARAM = 'done'

/**
 * GET lists the person's live grants; a same-origin POST revokes one of them by id and redirects back with its outcome.
 * A browser with no login is sent to sign in and back here, a POST included: nothing was revoked, and the person submits
 * again.
 */
export async function handleAccount(request: Request, services: Services, requestId: string): Promise<Response> {
	if (request.method === 'POST' && !sameOrigin(request, services.config)) {
		return authFailurePage({ ...INSTALLATION_PRESENTATION, locale: chooseLocale(requestLocales(request)) }, { kind: 'cross_origin' }, 403)
	}
	const login = await currentLogin(request, services)
	if (login === null) {
		const back = new URL(ACCOUNT_PATH, services.config.issuer).toString()
		return new Response(null, {
			status: request.method === 'POST' ? 303 : 302,
			headers: redirectHeaders(`/auth/login?redirect=${encodeURIComponent(back)}`),
		})
	}
	if (request.method === 'GET') {
		const notice = new URL(request.url).searchParams.get(NOTICE_PARAM)
		return accountPage(request, services, login, NOTICES.find((known) => known === notice) ?? null)
	}
	const form = await readForm(request)
	const id = form?.get('grant') ?? ''
	const notice: Notice = await revokeOwn(services, login, id, requestId) ? 'revoked' : 'already_ended'
	return new Response(null, { status: 303, headers: redirectHeaders(`${ACCOUNT_PATH}?${NOTICE_PARAM}=${notice}`) })
}

/** Revoke `id` when it is a live grant of the signed-in person; any other id, another person's included, changes nothing. */
async function revokeOwn(services: Services, login: CurrentLogin, id: string, requestId: string): Promise<boolean> {
	const grant = id === '' ? null : await services.repositories.oauth.grant(id)
	if (grant === null || grant.principal_id !== login.principal.id) return false
	const record: AuditEventInput = {
		requestId,
		principalId: login.principal.id,
		principalLabel: login.principal.id,
		app: IAM_APP,
		action: 'iam.oauth.grant.revoke',
		resourceType: 'oauth_grant',
		resourceId: grant.id,
		metadata: { ...grantRecord(grant), reason: 'owner' },
	}
	return services.repositories.oauth.revokeOwnGrant(grant.id, login.principal.id, unixNow(), record)
}

async function accountPage(request: Request, services: Services, login: CurrentLogin, notice: Notice | null): Promise<Response> {
	const locale = chooseLocale({ person: parseLocale(login.principal.locale), ...requestLocales(request) })
	const catalog = catalogFor(locale)
	const text = catalog.pages.account
	const rows = await services.repositories.oauth.listLiveForPrincipal(login.principal.id, unixNow(), ACCOUNT_GRANTS_SHOWN + 1)
	const shown = rows.slice(0, ACCOUNT_GRANTS_SHOWN)
	const names = await appNames(services, shown)
	const status = notice === null
		? ''
		: `<p role="status">${escapeHtml(notice === 'revoked' ? text.revoked : text.alreadyEnded)}</p>`
	const list = shown.length === 0
		? `<p>${escapeHtml(text.none)}</p>`
		: `<ul class="rows">${shown.map((grant) => grantItem(catalog, grant, names.get(grant.app) ?? grant.app)).join('')}</ul>`
	const more = rows.length > ACCOUNT_GRANTS_SHOWN ? `<p>${escapeHtml(text.more(ACCOUNT_GRANTS_SHOWN))}</p>` : ''
	return htmlPage({
		locale,
		brand: await installationBrand(services),
		title: text.title,
		content: `<h1>${escapeHtml(text.title)}</h1>
		<p>${escapeHtml(catalog.pages.chooseAccount.signedInAs)} <strong>${escapeHtml(login.principal.label)}</strong>.</p>
		${status}
		<h2>${escapeHtml(text.connectionsTitle)}</h2>
		<p>${escapeHtml(text.connectionsText)}</p>
		${list}${more}`,
	})
}

/** What a person reads each grant's application as: its declared name with the environment, else its id. */
async function appNames(services: Services, grants: readonly OAuthGrantRow[]): Promise<Map<string, string>> {
	const names = new Map<string, string>()
	for (const app of new Set(grants.map((grant) => grant.app))) {
		const declared = parsePresentation(await services.repositories.appSchema.getPresentation(app)).displayName
		const environment = parseAppEnvironmentId(app)
		names.set(app, declared === null ? app : environment === null ? declared : `${declared} (${environment.env})`)
	}
	return names
}

function grantItem(catalog: Catalog, grant: OAuthGrantRow, appName: string): string {
	const text = catalog.pages.account
	const who = grant.client_id === AGENT_CLIENT_ID
		? `<strong>${escapeHtml(text.agent(grant.agent_label))}</strong>${
			grant.agent_label === null ? '' : ` <small>${escapeHtml(text.agentWords)}</small>`
		}`
		: `<strong>${escapeHtml(grant.client_id === OAUTH_CLI_CLIENT_ID ? text.commandLine : text.client(grant.client_id))}</strong>`
	const reaches = grant.app === CONTROL_APP_ID ? consoleLabel(grant) ?? appName : appName
	const tokens = parseStoredPermissions(grant.scopes)
	const scope = grant.client_id === AGENT_CLIENT_ID ? storedAgentScope(tokens) : null
	const what = scope === null
		? `<p>${escapeHtml(text.scopes)}: ${tokens.map((token) => `<code>${escapeHtml(token)}</code>`).join(' ')}</p>`
		: `<p>${escapeHtml(text.mode(scope.mode))}${scope.within === null ? '' : ` <code>${escapeHtml(agentScopeToken(scope))}</code>`}</p>`
	const resources = grantResources(grant).map((uri) => `<code>${escapeHtml(uri)}</code>`).join(' ')
	return `<li>${who}
		<p>${escapeHtml(text.reaches)}: <strong>${escapeHtml(reaches)}</strong> ${resources}</p>
		${what}
		<p>${escapeHtml(text.allowed)}: ${utc(grant.created_at)} · ${escapeHtml(text.ends)}: ${utc(grant.expires_at)}</p>
		<form method="post" action="${ACCOUNT_PATH}"><input type="hidden" name="grant" value="${escapeHtml(grant.id)}">
		<button type="submit">${escapeHtml(text.revoke)}</button></form></li>`
}

/** The names the device page gives the console's command-line resources (`Console`, `Operations`), for a grant on them. */
function consoleLabel(grant: OAuthGrantRow): string | null {
	const labels = grantResources(grant).flatMap((uri) => {
		const path = URL.canParse(uri) ? new URL(uri).pathname : null
		return CONTROL_CLI_RESOURCES.filter((entry) => entry.path === path).map((entry) => entry.label)
	})
	return labels.length === 0 ? null : labels.join(', ')
}

/** A Unix time as `YYYY-MM-DD HH:MM UTC`: one form in every language, and no clock of the reader's to guess. */
function utc(seconds: number): string {
	return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}
