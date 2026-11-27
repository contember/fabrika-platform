// The signed-in person's own page on IAM's host (`/auth/account`): every OAuth grant that acts as them, an agent's at an
// application included (ADR-0090), and its revocation. It lives here because the login cookie is IAM's (ADR-0023).

import { AGENT_CLIENT_ID, agentScopeToken, OAUTH_CLI_CLIENT_ID, parseAppEnvironmentId } from '@fabrika/auth-core'
import { CONTROL_APP_ID, CONTROL_CLI_PRESETS, CONTROL_CLI_RESOURCES, type ControlCliPreset } from '@fabrika/control-contract'
import { ACCOUNT_PAGE_PATH, MAX_PASSKEY_LABEL_LENGTH } from '@fabrika/iam-contract'
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
import type { PasskeyRow } from '../repositories/passkeys'
import { unixNow } from '../repositories/sql'
import type { Services } from '../services'
import { parseStoredPermissions } from '../stored-permissions'
import { readForm, redirectHeaders, sameOrigin } from './http'
import { type CurrentLogin, currentLogin } from './sessions'

export const ACCOUNT_PATH = ACCOUNT_PAGE_PATH

/** The most grants the page lists, newest first; it says so when more are live. */
export const ACCOUNT_GRANTS_SHOWN = 50

/** Where the passkey forms of the page post (`passkey-pages.ts`); the hidden `step` names the step of the ceremony. */
export const PASSKEYS_PATH = '/auth/passkeys'

const NOTICES = [
	'revoked',
	'already_ended',
	'passkey_added',
	'passkey_removed',
	'passkey_refused',
	'passkey_busy',
	'passkey_duplicate',
	'passkey_limit',
	'passkey_label',
] as const

export type AccountNotice = (typeof NOTICES)[number]

type Notice = AccountNotice

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
	return accountRedirect(await revokeOwn(services, login, id, requestId) ? 'revoked' : 'already_ended')
}

/** Back to the account page with an outcome, as a 303, so a reload of the page submits nothing again. */
export function accountRedirect(notice: AccountNotice): Response {
	const section = notice.startsWith('passkey_') ? '#passkeys' : '#connections'
	return new Response(null, { status: 303, headers: redirectHeaders(`${ACCOUNT_PATH}?${NOTICE_PARAM}=${notice}${section}`) })
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
	const renewed = await services.repositories.oauth.lastRenewed(shown.map((grant) => grant.id))
	const held = await services.repositories.passkeys.list(login.principal.id)
	const passkeyLabels = new Map(held.map((passkey) => [passkey.credential_id, passkey.label]))
	// Each outcome shows in the section it concerns, where its redirect lands.
	const status = (section: 'passkeys' | 'connections') =>
		notice === null || notice.startsWith('passkey_') !== (section === 'passkeys')
			? ''
			: `<p role="status" class="notice${REFUSALS.has(notice) ? ' error' : ''}">${escapeHtml(noticeText(catalog, notice))}</p>`
	const grants = shown.map((grant) => describeGrant(catalog, grant, names.get(grant.app) ?? grant.app, renewed.get(grant.id) ?? null, passkeyLabels))
	return htmlPage({
		locale,
		brand: await installationBrand(services),
		title: text.title,
		layout: 'workspace',
		content: `<div class="page-head"><h1>${escapeHtml(text.title)}</h1>
		<p class="subtitle">${escapeHtml(catalog.pages.chooseAccount.signedInAs)} <strong>${escapeHtml(login.principal.label)}</strong>.</p></div>
		<nav class="section-nav" aria-label="${escapeHtml(text.onThisPage)}"><a href="#passkeys">${
			escapeHtml(catalog.pages.passkeys.title)
		} <span class="count">${held.length}</span></a><a href="#connections">${escapeHtml(text.connectionsTitle)} <span class="count">${
			rows.length > ACCOUNT_GRANTS_SHOWN ? `${ACCOUNT_GRANTS_SHOWN}+` : shown.length
		}</span></a></nav>
		${passkeysSection(held, catalog, status('passkeys'))}
		${grantsSection(catalog, grants, rows.length > ACCOUNT_GRANTS_SHOWN, status('connections'))}
		${revokeDialog(text)}`,
		script: CONFIRM_SCRIPT,
	})
}

/** The outcomes that report a refusal, shown on the stop wash rather than as a plain notice. */
const REFUSALS: ReadonlySet<Notice> = new Set(['passkey_refused', 'passkey_busy', 'passkey_duplicate', 'passkey_limit', 'passkey_label'])

/**
 * Asks before a form marked `data-confirm` posts: the dialog shows the form's own words and posts it on its confirm
 * button. A browser without `<dialog>` posts at once, as the page did before it asked.
 */
const CONFIRM_SCRIPT =
	"var confirmDialog=document.getElementById('revoke-dialog');var confirming=null;if(confirmDialog&&typeof confirmDialog.showModal==='function'){document.querySelectorAll('form[data-confirm]').forEach(function(form){form.addEventListener('submit',function(event){event.preventDefault();confirming=form;document.getElementById('revoke-text').textContent=form.dataset.confirm;var detail=document.getElementById('revoke-detail');detail.replaceChildren();form.dataset.confirmDetail.split('\\n').forEach(function(line){var fact=document.createElement('span');var value=document.createElement('span');var at=line.indexOf(': ');fact.className='fact';value.className='value';fact.append(at<0?'':line.slice(0,at+2));value.textContent=at<0?line:line.slice(at+2);fact.append(value);detail.append(fact);});confirmDialog.returnValue='';confirmDialog.showModal();});});confirmDialog.addEventListener('close',function(){var form=confirming;confirming=null;if(confirmDialog.returnValue==='revoke'&&form)form.submit();});}"

function revokeDialog(text: Catalog['pages']['account']): string {
	return `<dialog id="revoke-dialog" aria-labelledby="revoke-title" aria-describedby="revoke-text"><form method="dialog">
		<h2 id="revoke-title">${escapeHtml(text.revokeTitle)}</h2><p id="revoke-text"></p><p id="revoke-detail" class="dialog-detail"></p>
		<div class="dialog-actions"><button type="submit" value="cancel">${
		escapeHtml(text.cancel)
	}</button><button type="submit" value="revoke" class="danger strong">${escapeHtml(text.revoke)}</button></div></form></dialog>`
}

function noticeText(catalog: Catalog, notice: Notice): string {
	const account = catalog.pages.account
	const passkeys = catalog.pages.passkeys
	switch (notice) {
		case 'revoked':
			return account.revoked
		case 'already_ended':
			return account.alreadyEnded
		case 'passkey_added':
			return passkeys.addedNotice
		case 'passkey_removed':
			return passkeys.removedNotice
		case 'passkey_refused':
			return passkeys.refusedNotice
		case 'passkey_busy':
			return passkeys.busyNotice
		case 'passkey_duplicate':
			return passkeys.duplicateNotice
		case 'passkey_limit':
			return passkeys.limitNotice
		case 'passkey_label':
			return passkeys.labelNotice
	}
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

/** One grant as the page shows it: who holds it, what it reaches and may do, and when. */
interface GrantView {
	readonly grant: OAuthGrantRow
	readonly holder: string
	readonly reaches: string
	/** The holder is an agent that named itself; its name is its own words. */
	readonly selfNamed: boolean
	/** When it last renewed its access; null when it has not since its approval. */
	readonly renewed: number | null
	/** What it may do: the mode of an agent's grant in words, else its scope names. */
	readonly mode: string | null
	readonly scopes: readonly string[]
	readonly confirmation: string | null
}

function describeGrant(
	catalog: Catalog,
	grant: OAuthGrantRow,
	appName: string,
	renewed: number | null,
	passkeyLabels: ReadonlyMap<string, string>,
): GrantView {
	const text = catalog.pages.account
	const agent = grant.client_id === AGENT_CLIENT_ID
	const tokens = parseStoredPermissions(grant.scopes)
	const scope = agent ? storedAgentScope(tokens) : null
	const presets = grant.client_id === OAUTH_CLI_CLIENT_ID && grant.app === CONTROL_APP_ID ? cliPresets(tokens) : null
	return {
		grant,
		holder: agent ? text.agent(grant.agent_label) : grant.client_id === OAUTH_CLI_CLIENT_ID ? text.commandLine : text.client(grant.client_id),
		reaches: grant.app === CONTROL_APP_ID ? consoleLabel(grant) ?? appName : appName,
		selfNamed: agent && grant.agent_label !== null,
		renewed,
		mode: scope !== null ? text.mode(scope.mode) : presets !== null ? presets.map(({ preset, app }) => text.cliPreset(preset, app)).join('; ') : null,
		scopes: scope !== null ? scope.within === null ? [] : [agentScopeToken(scope)] : presets !== null ? [] : tokens,
		confirmation: confirmation(text, grant, passkeyLabels),
	}
}

/**
 * A command-line grant's scopes as the console's presets (`deploy:<app>`, `create`), or null when any is not one: the
 * page then shows the scope names as they are.
 */
function cliPresets(tokens: readonly string[]): { preset: ControlCliPreset; app: string | null }[] | null {
	const presets = tokens.map((token) => {
		const [name, app, ...rest] = token.split(':')
		const preset = CONTROL_CLI_PRESETS.find((known) => known === name)
		if (preset === undefined || rest.length > 0 || app === '') return null
		return { preset, app: app ?? null }
	})
	return presets.length > 0 && presets.every((entry) => entry !== null) ? presets.filter((entry) => entry !== null) : null
}

/**
 * The grants, one group of rows per application they reach, in the order of each group's newest grant. A row leads with
 * what tells two similar grants apart (when each was allowed, last active and ends) and folds the endpoints away.
 */
function grantsSection(catalog: Catalog, grants: readonly GrantView[], more: boolean, status: string): string {
	const text = catalog.pages.account
	// Keyed by application id: two applications may share a name.
	const groups = new Map<string, { reaches: string; views: GrantView[] }>()
	for (const view of grants) {
		const key = `${view.grant.app}\n${view.reaches}`
		const group = groups.get(key) ?? { reaches: view.reaches, views: [] }
		group.views.push(view)
		groups.set(key, group)
	}
	const table = grants.length === 0
		? `<p>${escapeHtml(text.none)}</p>`
		: `<table class="stack"><thead><tr><th class="grow" scope="col">${escapeHtml(text.holder)}</th><th scope="col">${
			escapeHtml(text.allowed)
		}</th><th scope="col">${escapeHtml(text.lastActive)}</th><th scope="col">${escapeHtml(text.ends)}</th><th scope="col"><span class="sr-only">${
			escapeHtml(text.revoke)
		}</span></th></tr></thead>${
			[...groups.values()].map(({ reaches, views }) =>
				`<tbody><tr><th colspan="5" scope="rowgroup">${escapeHtml(reaches)} <span class="count">${views.length}</span></th></tr>${
					views.map((view) => grantRow(catalog, view)).join('')
				}</tbody>`
			).join('')
		}</table>`
	const words = grants.some((view) => view.selfNamed) ? ` ${text.agentWords}` : ''
	return `<section class="card" id="connections" aria-labelledby="connections-title"><div class="card-head"><h2 id="connections-title">${
		escapeHtml(text.connectionsTitle)
	}</h2></div><div class="card-body">${status}
		<p>${escapeHtml(text.connectionsText)} ${escapeHtml(text.lastActiveText)}${escapeHtml(words)}</p>
		${table}${more ? `<p>${escapeHtml(text.more(ACCOUNT_GRANTS_SHOWN))}</p>` : ''}</div></section>`
}

function grantRow(catalog: Catalog, view: GrantView): string {
	const text = catalog.pages.account
	const { grant } = view
	const allowed = utc(grant.created_at)
	const lastActive = view.renewed === null ? text.notRenewed : utc(view.renewed)
	const chips = view.scopes.length === 0
		? ''
		: `<span class="chips">${view.scopes.map((token) => `<code class="chip">${escapeHtml(token)}</code>`).join('')}</span>`
	const details = `<details><summary>${escapeHtml(text.details)}</summary><dl><dt>${escapeHtml(text.endpoints)}</dt><dd>${
		grantResources(grant).map((uri) => `<code>${escapeHtml(uri)}</code>`).join('')
	}</dd><dt>${escapeHtml(text.scopes)}</dt><dd>${
		parseStoredPermissions(grant.scopes).map((token) => `<code>${escapeHtml(token)}</code>`).join('')
	}</dd></dl></details>`
	return `<tr><td><strong>${escapeHtml(view.holder)}</strong>${
		view.mode === null ? '' : `<span class="line">${escapeHtml(view.mode)}</span>`
	}${chips}${view.confirmation === null ? '' : `<span class="line">${escapeHtml(view.confirmation)}</span>`}${details}</td>
		<td class="when" data-label="${escapeHtml(text.allowed)}">${allowed}</td>
		<td class="when" data-label="${escapeHtml(text.lastActive)}">${escapeHtml(lastActive)}</td>
		<td class="when" data-label="${escapeHtml(text.ends)}">${utc(grant.expires_at)}</td>
		<td class="act"><form method="post" action="${ACCOUNT_PATH}" data-confirm="${
		escapeHtml(text.revokeConfirm(view.holder, view.reaches))
	}" data-confirm-detail="${escapeHtml(`${text.allowed}: ${allowed}\n${text.lastActive}: ${lastActive}`)}">
		<input type="hidden" name="grant" value="${escapeHtml(grant.id)}"><button type="submit" class="danger small" aria-label="${
		escapeHtml(text.revokeLabel(view.holder, view.reaches, allowed))
	}">${escapeHtml(text.revoke)}</button></form></td></tr>`
}

/** Which passkey confirmed the grant's approval and when, by the label of a passkey the person still holds; null when none did. */
function confirmation(text: Catalog['pages']['account'], grant: OAuthGrantRow, passkeyLabels: ReadonlyMap<string, string>): string | null {
	if (grant.passkey_confirmed_at === null) return null
	const label = grant.passkey_credential_id === null ? null : passkeyLabels.get(grant.passkey_credential_id) ?? null
	const words = grant.passkey_credential_id === null
		? text.confirmedWithUnrecorded
		: label === null
		? text.confirmedWithRemoved
		: text.confirmedWith(label)
	return `${words}: ${utc(grant.passkey_confirmed_at)}`
}

/**
 * The passkeys section, first on the page because registering one is what most people come for: the person's passkeys,
 * each with its removal (whose own page asks a passkey check first), and the form that adds one.
 */
function passkeysSection(held: readonly PasskeyRow[], catalog: Catalog, status: string): string {
	const text = catalog.pages.passkeys
	const list = held.length === 0
		? `<p>${escapeHtml(text.none)}</p>`
		: `<table class="stack"><thead><tr><th class="grow" scope="col">${escapeHtml(text.label)}</th><th scope="col">${
			escapeHtml(text.added)
		}</th><th scope="col">${escapeHtml(text.lastUsed)}</th><th scope="col"><span class="sr-only">${
			escapeHtml(text.remove)
		}</span></th></tr></thead><tbody>${
			held.map((passkey) =>
				`<tr><td><strong>${escapeHtml(passkey.label)}</strong></td><td class="when" data-label="${escapeHtml(text.added)}">${
					utc(passkey.created_at)
				}</td><td class="when" data-label="${escapeHtml(text.lastUsed)}">${
					passkey.last_used_at === null ? escapeHtml(text.neverUsed) : utc(passkey.last_used_at)
				}</td>
				<td class="act"><form method="post" action="${PASSKEYS_PATH}"><input type="hidden" name="step" value="remove"><input type="hidden" name="passkey" value="${
					escapeHtml(passkey.id)
				}"><button type="submit" class="danger small" aria-label="${escapeHtml(text.removeLabel(passkey.label))}">${
					escapeHtml(text.remove)
				}</button></form></td></tr>`
			).join('')
		}</tbody></table>`
	return `<section class="card" id="passkeys" aria-labelledby="passkeys-title"><div class="card-head"><h2 id="passkeys-title">${
		escapeHtml(text.title)
	}</h2></div><div class="card-body">${status}
		<p>${escapeHtml(text.text)}</p>
		${list}
		<h3 class="subhead">${escapeHtml(text.addTitle)}</h3>
		<form class="inline-form" method="post" action="${PASSKEYS_PATH}"><input type="hidden" name="step" value="add">
		<label for="passkey-label">${escapeHtml(text.label)}
		<input id="passkey-label" name="label" required maxlength="${MAX_PASSKEY_LABEL_LENGTH}" autocomplete="off" aria-describedby="passkey-label-hint"></label>
		<button type="submit">${escapeHtml(text.add)}</button>
		<p class="hint" id="passkey-label-hint">${escapeHtml(text.labelHint)}</p></form></div></section>`
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
