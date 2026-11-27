// A person's passkey ceremonies on IAM's own pages, where the RP ID is IAM's host (ADR-0050 §5): adding and removing a
// passkey from the account page, and answering a step-up another service asked IAM for (`/auth/step-up`). Each page runs
// `navigator.credentials` under the page's nonce, puts the answer in a hidden field and posts the form, so no page
// fetches anything (`connect-src` stays closed). Never log a challenge, a credential or a key.

import type { Locale } from '@fabrika/auth-core'
import { PASSKEY_REGISTRATION_BINDING, passkeyRemovalBinding } from '@fabrika/iam-contract'
import { IAM_APP } from '../admin/router'
import { type Catalog, catalogFor } from '../catalog'
import { type AuditEventInput, auditLabelOf } from '../db'
import { escapeHtml } from '../html'
import { installationBrand } from '../installation-brand'
import {
	answerStepUp,
	assertionSchema,
	completeRegistration,
	issueAssertionChallenge,
	issueRegistrationChallenge,
	openStepUp,
	passkeyLabelSchema,
	type PasskeyRefusal,
	registrationCredentialSchema,
	relyingParty,
	verifyPasskeyAssertion,
} from '../passkeys'
import { htmlPage } from '../password-pages'
import { chooseLocale, parseLocale, requestLocales } from '../person-locale'
import { unixNow } from '../repositories/sql'
import type { Config } from '../services'
import type { Services } from '../services'
import { ACCOUNT_PATH, type AccountNotice, accountRedirect, PASSKEYS_PATH } from './account'
import { readForm, redirectHeaders, sameOrigin } from './http'
import { type CurrentLogin, currentLogin } from './sessions'

/** Where a person answers a step-up challenge; the challenge's id travels in `challenge`. */
export const STEP_UP_PATH = '/auth/step-up'

export function stepUpUrl(config: Pick<Config, 'issuer'>, challengeId: string): string {
	const url = new URL(STEP_UP_PATH, config.issuer)
	url.searchParams.set('challenge', challengeId)
	return url.toString()
}

/**
 * The browser half of every ceremony, a fixed string. The form `#webauthn` carries the options as JSON in
 * `data-options` and the ceremony in `data-ceremony`; its button runs it, and the answer, in WebAuthn's JSON encoding,
 * goes into the hidden `credential` field before the form is posted.
 */
const WEBAUTHN_SCRIPT =
	`(function(){function buf(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';var r=atob(s),a=new Uint8Array(r.length);for(var i=0;i<r.length;i++)a[i]=r.charCodeAt(i);return a.buffer}function b64(b){var a=new Uint8Array(b),s='';for(var i=0;i<a.length;i++)s+=String.fromCharCode(a[i]);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')}function ids(list){return list.map(function(c){var d={type:c.type,id:buf(c.id)};if(c.transports)d.transports=c.transports;return d})}var form=document.getElementById('webauthn');if(form){var button=document.getElementById('webauthn-start'),error=document.getElementById('webauthn-error');var say=function(text){error.textContent=text;error.hidden=false};if(!window.PublicKeyCredential||!navigator.credentials){button.disabled=true;say(form.dataset.unsupported)}else{button.addEventListener('click',function(){var o=JSON.parse(form.dataset.options),run;button.disabled=true;error.hidden=true;o.challenge=buf(o.challenge);if(form.dataset.ceremony==='create'){o.user.id=buf(o.user.id);o.excludeCredentials=ids(o.excludeCredentials);run=navigator.credentials.create({publicKey:o})}else{o.allowCredentials=ids(o.allowCredentials);run=navigator.credentials.get({publicKey:o})}run.then(function(c){var r=c.response,j={id:c.id,rawId:b64(c.rawId),type:c.type,response:{clientDataJSON:b64(r.clientDataJSON)}};if(r.attestationObject){j.response.attestationObject=b64(r.attestationObject);if(r.getTransports)j.response.transports=r.getTransports()}else{j.response.authenticatorData=b64(r.authenticatorData);j.response.signature=b64(r.signature);if(r.userHandle)j.response.userHandle=b64(r.userHandle)}form.elements.namedItem('credential').value=JSON.stringify(j);form.submit()}).catch(function(){button.disabled=false;say(form.dataset.failed)})})}}})();`

interface Page {
	readonly services: Services
	readonly login: CurrentLogin
	readonly locale: Locale
	readonly text: Catalog['pages']['passkeys']
	readonly requestId: string
}

async function pageFor(request: Request, services: Services, login: CurrentLogin, requestId: string): Promise<Page> {
	const locale = chooseLocale({ person: parseLocale(login.principal.locale), ...requestLocales(request) })
	return { services, login, locale, text: catalogFor(locale).pages.passkeys, requestId }
}

function crossOrigin(): Response {
	return new Response('Forbidden', { status: 403 })
}

function toLogin(back: string, post: boolean): Response {
	return new Response(null, { status: post ? 303 : 302, headers: redirectHeaders(`/auth/login?redirect=${encodeURIComponent(back)}`) })
}

/** A form's credential field, parsed from its JSON; undefined when it is no JSON. */
export function credentialField(form: URLSearchParams): unknown {
	try {
		return JSON.parse(form.get('credential') ?? '')
	} catch {
		return undefined
	}
}

/** What a ceremony page needs to render: the installation, the language and the passkey texts in it. */
export type CeremonyContext = Pick<Page, 'services' | 'locale' | 'text'>

/** The ceremony context of a page outside the account page's flows, in `locale`. */
export function ceremonyContext(services: Services, locale: Locale): CeremonyContext {
	return { services, locale, text: catalogFor(locale).pages.passkeys }
}

async function page(p: CeremonyContext, title: string, content: string, status = 200): Promise<Response> {
	return htmlPage({ locale: p.locale, brand: await installationBrand(p.services), title, content, status, script: WEBAUTHN_SCRIPT })
}

/** A page that runs one ceremony and posts its answer with `fields` to `action`. */
export async function ceremonyPage(
	p: CeremonyContext,
	input: {
		readonly title: string
		readonly text: string
		readonly ceremony: 'get' | 'create'
		readonly options: unknown
		readonly action: string
		readonly fields: Readonly<Record<string, string>>
		readonly back: boolean
	},
): Promise<Response> {
	const hidden = Object.entries(input.fields)
		.map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
		.join('')
	return page(
		p,
		input.title,
		`<h1>${escapeHtml(input.title)}</h1>
		<p>${escapeHtml(input.text)}</p>
		<form id="webauthn" method="post" action="${escapeHtml(input.action)}" data-ceremony="${input.ceremony}" data-options="${
			escapeHtml(JSON.stringify(input.options))
		}" data-failed="${escapeHtml(p.text.failed)}" data-unsupported="${
			escapeHtml(p.text.unsupported)
		}">${hidden}<input type="hidden" name="credential" value="">
		<p id="webauthn-error" role="alert" class="error" hidden></p>
		<button type="button" id="webauthn-start">${escapeHtml(p.text.continue)}</button></form>
		${input.back ? `<p><a href="${ACCOUNT_PATH}">${escapeHtml(p.text.back)}</a></p>` : ''}`,
	)
}

function personEvent(p: Page, action: string, passkeyId: string): AuditEventInput {
	return {
		requestId: p.requestId,
		principalId: p.login.principal.id,
		principalLabel: auditLabelOf(p.login.principal),
		app: IAM_APP,
		action,
		resourceType: 'principal',
		resourceId: p.login.principal.id,
		metadata: { passkeyId },
	}
}

/**
 * A same-origin POST from the account page or a ceremony page; the hidden `step` names the step. Every outcome but the
 * next ceremony returns to the account page with a notice, so a reload submits nothing again.
 */
export async function handlePasskeys(request: Request, services: Services, requestId: string): Promise<Response> {
	if (!sameOrigin(request, services.config)) return crossOrigin()
	const login = await currentLogin(request, services)
	if (login === null) return toLogin(new URL(ACCOUNT_PATH, services.config.issuer).toString(), true)
	const form = await readForm(request)
	if (form === null) return accountRedirect('passkey_refused')
	const p = await pageFor(request, services, login, requestId)
	switch (form.get('step')) {
		case 'add':
			return beginAdding(p, form)
		case 'add-confirm':
			return confirmAdding(p, form)
		case 'add-finish':
			return finishAdding(p, form)
		case 'remove':
			return beginRemoving(p, form)
		case 'remove-confirm':
			return finishRemoving(p, form)
		default:
			return accountRedirect('passkey_refused')
	}
}

function labelOf(form: URLSearchParams): string | null {
	const label = passkeyLabelSchema.safeParse(form.get('label') ?? '')
	return label.success ? label.data : null
}

/** A person with a passkey confirms with it first; a person with none goes straight to creating one. */
async function beginAdding(p: Page, form: URLSearchParams): Promise<Response> {
	const label = labelOf(form)
	if (label === null) return accountRedirect('passkey_label')
	const held = await p.services.repositories.passkeys.list(p.login.principal.id)
	if (held.length === 0) return creationPage(p, label, false)
	const issued = await issueAssertionChallenge(p.services, relyingParty(p.services.config), p.login.principal.id, PASSKEY_REGISTRATION_BINDING)
	if (issued === 'too_many') return accountRedirect('passkey_busy')
	if (issued === 'no_passkey') return creationPage(p, label, false)
	return ceremonyPage(p, {
		title: p.text.confirmTitle,
		text: p.text.confirmAddText,
		ceremony: 'get',
		options: issued.options,
		action: PASSKEYS_PATH,
		fields: { step: 'add-confirm', label, challengeId: issued.challengeId },
		back: true,
	})
}

async function confirmAdding(p: Page, form: URLSearchParams): Promise<Response> {
	const label = labelOf(form)
	if (label === null) return accountRedirect('passkey_label')
	const assertion = assertionSchema.safeParse({ challengeId: form.get('challengeId') ?? '', credential: credentialField(form) })
	if (!assertion.success) return accountRedirect('passkey_refused')
	const verified = await verifyPasskeyAssertion(
		p.services,
		relyingParty(p.services.config),
		p.login.principal.id,
		PASSKEY_REGISTRATION_BINDING,
		assertion.data,
	)
	return verified.ok ? creationPage(p, label, true) : accountRedirect('passkey_refused')
}

/** The creation ceremony; `steppedUp` says an assertion bound to the registration was verified just before. */
async function creationPage(p: Page, label: string, steppedUp: boolean): Promise<Response> {
	const issued = await issueRegistrationChallenge(p.services, relyingParty(p.services.config), p.login.principal, steppedUp)
	if (issued === null) return accountRedirect('passkey_busy')
	return ceremonyPage(p, {
		title: p.text.createTitle,
		text: p.text.createText(label),
		ceremony: 'create',
		options: issued.options,
		action: PASSKEYS_PATH,
		fields: { step: 'add-finish', label, challengeId: issued.challengeId },
		back: true,
	})
}

async function finishAdding(p: Page, form: URLSearchParams): Promise<Response> {
	const label = labelOf(form)
	if (label === null) return accountRedirect('passkey_label')
	const credential = registrationCredentialSchema.safeParse(credentialField(form))
	if (!credential.success) return accountRedirect('passkey_refused')
	const registered = await completeRegistration(
		p.services,
		relyingParty(p.services.config),
		p.login.principal.id,
		{ challengeId: form.get('challengeId') ?? '', label, credential: credential.data },
		(passkeyId) => personEvent(p, 'iam.passkey.register', passkeyId),
	)
	if (registered.ok) return accountRedirect('passkey_added')
	const notices: Partial<Record<PasskeyRefusal, AccountNotice>> = { duplicate: 'passkey_duplicate', limit: 'passkey_limit' }
	return accountRedirect(notices[registered.reason] ?? 'passkey_refused')
}

async function beginRemoving(p: Page, form: URLSearchParams): Promise<Response> {
	const passkeyId = form.get('passkey') ?? ''
	const held = await p.services.repositories.passkeys.list(p.login.principal.id)
	const passkey = held.find((row) => row.id === passkeyId)
	if (passkey === undefined) return accountRedirect('passkey_refused')
	const issued = await issueAssertionChallenge(p.services, relyingParty(p.services.config), p.login.principal.id, passkeyRemovalBinding(passkey.id))
	if (issued === 'too_many') return accountRedirect('passkey_busy')
	if (issued === 'no_passkey') return accountRedirect('passkey_refused')
	return ceremonyPage(p, {
		title: p.text.confirmTitle,
		text: p.text.confirmRemoveText(passkey.label),
		ceremony: 'get',
		options: issued.options,
		action: PASSKEYS_PATH,
		fields: { step: 'remove-confirm', passkey: passkey.id, challengeId: issued.challengeId },
		back: true,
	})
}

async function finishRemoving(p: Page, form: URLSearchParams): Promise<Response> {
	const passkeyId = form.get('passkey') ?? ''
	const assertion = assertionSchema.safeParse({ challengeId: form.get('challengeId') ?? '', credential: credentialField(form) })
	if (passkeyId === '' || !assertion.success) return accountRedirect('passkey_refused')
	const principalId = p.login.principal.id
	const verified = await verifyPasskeyAssertion(
		p.services,
		relyingParty(p.services.config),
		principalId,
		passkeyRemovalBinding(passkeyId),
		assertion.data,
	)
	if (!verified.ok) return accountRedirect('passkey_refused')
	const removed = await p.services.repositories.passkeys.remove(
		principalId,
		passkeyId,
		{
			removal: personEvent(p, 'iam.passkey.remove', passkeyId),
			revocation: { ...personEvent(p, 'iam.oauth.grant.revoke', passkeyId), metadata: { reason: 'passkey_removed', passkeyId } },
		},
		unixNow(),
	)
	return accountRedirect(removed ? 'passkey_removed' : 'passkey_refused')
}

/**
 * GET shows the step-up ceremony of the person's open challenge `challenge`; a same-origin POST answers it, and IAM
 * records the answer on the challenge for its issuer to consume. The page says nothing of what the challenge guards
 * beyond the console's kinds of step: its binding is the issuer's opaque string.
 */
export async function handleStepUp(request: Request, services: Services, requestId: string): Promise<Response> {
	const post = request.method === 'POST'
	if (post && !sameOrigin(request, services.config)) return crossOrigin()
	const form = post ? await readForm(request) : null
	const challengeId = (post ? form?.get('challenge') : new URL(request.url).searchParams.get('challenge')) ?? ''
	const login = await currentLogin(request, services)
	if (login === null) return toLogin(stepUpUrl(services.config, challengeId), post)
	const p = await pageFor(request, services, login, requestId)
	const rp = relyingParty(services.config)
	if (!post) {
		const open = challengeId === '' ? null : await openStepUp(services, rp, login.principal.id, challengeId)
		if (open === null) return notice(p, p.text.stepUpGone, 410)
		return ceremonyPage(p, {
			title: p.text.stepUpTitle,
			text: p.text.stepUpText,
			ceremony: 'get',
			options: open.options,
			action: STEP_UP_PATH,
			fields: { challenge: open.challengeId },
			back: false,
		})
	}
	const assertion = form === null ? null : assertionSchema.safeParse({ challengeId, credential: credentialField(form) })
	if (assertion === null || !assertion.success) return notice(p, p.text.stepUpRefused, 400)
	const answered = await answerStepUp(services, rp, login.principal.id, assertion.data)
	if (!answered.ok) return notice(p, answered.reason === 'challenge_unknown' ? p.text.stepUpGone : p.text.stepUpRefused, 403)
	return page(p, p.text.stepUpTitle, `<h1>${escapeHtml(p.text.stepUpTitle)}</h1><p role="status">${escapeHtml(p.text.stepUpDone)}</p>`)
}

async function notice(p: Page, text: string, status: number): Promise<Response> {
	return page(p, p.text.stepUpTitle, `<h1>${escapeHtml(p.text.stepUpTitle)}</h1><p role="alert" class="error">${escapeHtml(text)}</p>`, status)
}
