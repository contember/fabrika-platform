import { DEFAULT_LOCALE, type Locale } from '@fabrika/auth-core'
import type { InstallationBrand } from '@fabrika/proxy-core/brand'
import { PAGE_STYLE, pageBody } from '@fabrika/proxy-core/page-style'
import { type AppPresentation, appQuery, landingUrl } from './app-presentation'
import type { AuthFailure } from './auth/failure'
import type { Handoff } from './auth/handoff'
import { catalogFor, type PageText } from './catalog'
import { escapeHtml } from './html'
import { PASSWORD_MAX_CODE_POINTS, PASSWORD_MIN_CODE_POINTS, type PasswordProblem } from './password-policy'

export function loginPage(input: {
	readonly presentation: AppPresentation
	/** An address on IAM's own origin, or a handoff's destination; null lands on the installation's landing. */
	readonly redirect: string | null
	readonly oidcEnabled: boolean
	readonly forgotEnabled: boolean
	/** The app this login is a handoff for (ADR-0022); absent for a plain IAM login. */
	readonly app?: string
	readonly handoffState?: string
	readonly handoffChallenge?: string
	/**
	 * The ORIGIN off IAM the submission answers its 302 with: the handoff destination's, or the console's
	 * for a login with no return address. Chromium applies `form-action` to the REDIRECT a submission
	 * answers with, not only to the action, so `'self'` alone silently blocks the 302 to
	 * `<app>/__fabrika/auth/callback` — the login succeeds, a code is issued and spent, and the browser
	 * never leaves this page. Measured in Chromium 149. The value is a REGISTERED return origin, never
	 * the request's, so widening the directive cannot widen where a browser may be sent.
	 */
	readonly redirectOrigin?: string
	readonly invalidCredentials?: boolean
}): Response {
	const text = catalogFor(input.presentation.locale).pages
	// `app` rides both continuations so a form post and an SSO detour end in the same handoff. It is
	// re-validated against the registered origins on the way back in — the form is never trusted.
	const appQueryPart = input.app === undefined
		? ''
		: `&app=${encodeURIComponent(input.app)}&state=${encodeURIComponent(input.handoffState ?? '')}&code_challenge=${
			encodeURIComponent(input.handoffChallenge ?? '')
		}`
	const oidcUrl = `/auth/oidc/start?redirect=${encodeURIComponent(input.redirect ?? '')}${appQueryPart}`
	const title = text.signIn.title(input.presentation.displayName)
	return htmlPage({
		locale: input.presentation.locale,
		brand: input.presentation.brand,
		title,
		content: `<h1>${escapeHtml(title)}</h1>${message(input.invalidCredentials === true ? text.signIn.invalidCredentials : undefined)}
		<form method="post" action="/auth/login">
			<input type="hidden" name="redirect" value="${escapeHtml(input.redirect ?? '')}">
			${input.app === undefined ? '' : `<input type="hidden" name="app" value="${escapeHtml(input.app)}">`}
			${input.handoffState === undefined ? '' : `<input type="hidden" name="state" value="${escapeHtml(input.handoffState)}">`}
			${input.handoffChallenge === undefined ? '' : `<input type="hidden" name="code_challenge" value="${escapeHtml(input.handoffChallenge)}">`}
			<label>${escapeHtml(text.email)}<input name="email" type="email" autocomplete="username" inputmode="email" required></label>
			${passwordInput(text, 'password', text.signIn.password, 'current-password')}
			<button type="submit">${escapeHtml(text.signIn.submit)}</button>
		</form>
		${
			input.forgotEnabled
				? `<p><a href="${escapeHtml(`/auth/forgot-password${appQuery(input.presentation)}`)}">${escapeHtml(text.signIn.forgot)}</a></p>`
				: ''
		}
		${input.oidcEnabled ? `<hr><p><a class="button" href="${escapeHtml(oidcUrl)}">${escapeHtml(text.signIn.singleSignOn)}</a></p>` : ''}`,
		status: input.invalidCredentials === true ? 401 : 200,
		formActionOrigin: input.redirectOrigin,
	})
}

/** Where the account question posts its answer, with the handoff's fields and a `decision`. */
export const ACCOUNT_CHOICE_PATH = '/auth/login/account'

/**
 * The question a handoff asks a browser already signed in here, before its login is used for an application it has
 * not chosen yet. Both answers post the handoff back, and the POST reads it again: the form is a hint, never a
 * permission. Continuing answers a 302 to the application's callback, so `form-action` admits `redirectOrigin`, the
 * handoff's registered origin (`loginDestinationFields`).
 */
export function chooseAccountPage(input: {
	readonly presentation: AppPresentation
	/** The signed-in principal's label. */
	readonly label: string
	readonly handoff: Handoff
	readonly redirectOrigin?: string
}): Response {
	const text = catalogFor(input.presentation.locale).pages.chooseAccount
	const title = text.title(input.presentation.displayName)
	const { handoff } = input
	return htmlPage({
		locale: input.presentation.locale,
		brand: input.presentation.brand,
		title,
		content: `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text.signedInAs)} <strong>${escapeHtml(input.label)}</strong>.</p>
		<form method="post" action="${ACCOUNT_CHOICE_PATH}">
			<input type="hidden" name="app" value="${escapeHtml(handoff.app)}">
			<input type="hidden" name="redirect" value="${escapeHtml(handoff.returnUrl)}">
			<input type="hidden" name="state" value="${escapeHtml(handoff.state)}">
			<input type="hidden" name="code_challenge" value="${escapeHtml(handoff.challenge)}">
			<button type="submit" name="decision" value="continue">${escapeHtml(text.continueAs(input.label))}</button>
			<button type="submit" name="decision" value="another">${escapeHtml(text.another)}</button>
		</form>
		<p>${escapeHtml(text.anotherNote)}</p>`,
		formActionOrigin: input.redirectOrigin,
	})
}

/**
 * The recovery form, and the page its POST answers. The form posts back with the link's `?app=`, so the action it may
 * issue keeps the application; the way back is the application's address when it has one, otherwise IAM's sign-in.
 */
export function forgotPasswordPage(input: { readonly presentation: AppPresentation; readonly sent?: boolean }): Response {
	const { presentation } = input
	const text = catalogFor(presentation.locale).pages
	const back = landingUrl(presentation) ?? '/auth/login'
	const content = input.sent === true
		? `<h1>${escapeHtml(text.forgot.sentTitle)}</h1><p>${escapeHtml(text.forgot.sentText)}</p><p><a href="${escapeHtml(back)}">${
			escapeHtml(text.forgot.back)
		}</a></p>`
		: `<h1>${escapeHtml(text.forgot.title)}</h1><p>${escapeHtml(text.forgot.intro(presentation.displayName))}</p>
		<form method="post" action="${escapeHtml(`/auth/forgot-password${appQuery(presentation)}`)}">
			<label>${escapeHtml(text.email)}<input name="email" type="email" autocomplete="username" inputmode="email" required></label>
			<button type="submit">${escapeHtml(text.forgot.submit)}</button>
		</form>`
	return htmlPage({
		locale: presentation.locale,
		brand: presentation.brand,
		title: input.sent === true ? text.forgot.sentTitle : text.forgot.title,
		content,
	})
}

/**
 * The page an action link opens. Its form posts back with the link's `?app=`, so a refusal speaks the same language;
 * the completed action lands on `landingOrigin`, which `form-action` therefore admits.
 */
export function setPasswordPage(input: {
	readonly presentation: AppPresentation
	/** Where the completed action lands off IAM (`actionLandingOrigin`); null for IAM's own sign-in page. */
	readonly landingOrigin: string | null
	readonly token?: string
	readonly purpose: 'enrollment' | 'reset'
	readonly problem?: PasswordProblem
}): Response {
	const { presentation } = input
	const text = catalogFor(presentation.locale).pages
	const title = text.setPassword.title(input.purpose)
	const path = input.purpose === 'enrollment' ? '/auth/password/enroll' : '/auth/password/reset'
	const problem = input.problem === undefined ? undefined : text.setPassword.problem(input.problem, PASSWORD_MIN_CODE_POINTS, PASSWORD_MAX_CODE_POINTS)
	return htmlPage({
		locale: presentation.locale,
		brand: presentation.brand,
		title,
		content: `<h1>${escapeHtml(title)}</h1>${message(problem)}<p>${
			escapeHtml(text.setPassword.rule(PASSWORD_MIN_CODE_POINTS, PASSWORD_MAX_CODE_POINTS))
		}</p><p>${escapeHtml(text.setPassword.shared(presentation.displayName))}</p>
		<form method="post" action="${escapeHtml(`${path}${appQuery(presentation)}`)}">
			<input id="action-token" type="hidden" name="token" value="${escapeHtml(input.token ?? '')}">
			${passwordInput(text, 'password', text.setPassword.newPassword, 'new-password')}
			<button type="submit">${escapeHtml(title)}</button>
		</form>`,
		status: input.problem === undefined ? 200 : 400,
		formActionOrigin: input.landingOrigin ?? undefined,
	})
}

/**
 * The same-origin confirmation that `GET /auth/logout` renders. Signing out is a state change, so it
 * only happens on a POST that passes the origin check; this keeps the link usable and lives here
 * because `htmlPage` (and its CSP) is what every browser-facing IAM page is built from.
 */
export function logoutPage(input: {
	/** An address on IAM's own origin; null signs out to the installation's landing. */
	readonly redirect: string | null
	/** The console's origin when the sign-out lands there, which `form-action` therefore admits. */
	readonly landingOrigin: string | null
	/** The installation's logo (`installationBrand`), or null for the fabrika mark. */
	readonly brand: InstallationBrand | null
}): Response {
	const text = catalogFor(DEFAULT_LOCALE).pages
	const query = input.redirect === null ? '' : `?redirect=${encodeURIComponent(input.redirect)}`
	return htmlPage({
		locale: DEFAULT_LOCALE,
		brand: input.brand,
		title: text.logout.title,
		content: `<h1>${escapeHtml(text.logout.title)}</h1><p>${escapeHtml(text.logout.text)}</p>
		<form method="post" action="${escapeHtml(`/auth/logout${query}`)}">
			<button type="submit">${escapeHtml(text.logout.submit)}</button>
		</form>`,
		formActionOrigin: input.landingOrigin ?? undefined,
	})
}

/** A refused browser-facing auth request, in the request's language and with its status. */
export function authFailurePage(presentation: AppPresentation, failure: AuthFailure, status: number): Response {
	const text = catalogFor(presentation.locale).pages.failure
	return htmlPage({
		locale: presentation.locale,
		brand: presentation.brand,
		title: text.title,
		content: `<h1>${escapeHtml(text.title)}</h1><p>${escapeHtml(text.text(failure))}</p>`,
		status,
	})
}

export function invalidActionPage(presentation: AppPresentation): Response {
	const text = catalogFor(presentation.locale).pages
	return htmlPage({
		locale: presentation.locale,
		brand: presentation.brand,
		title: text.invalidLink.title,
		content: `<h1>${escapeHtml(text.invalidLink.title)}</h1><p>${escapeHtml(text.invalidLink.text)}</p><p><a href="${
			escapeHtml(`/auth/forgot-password${appQuery(presentation)}`)
		}">${escapeHtml(text.invalidLink.requestNew)}</a></p>`,
		status: 400,
	})
}

/**
 * The page an invitation link opens. The one-time token rides in the fragment and the script copies it into the form,
 * which posts back with the link's `?app=`; an accepted invitation lands on the application's registered origin, which
 * `form-action` therefore admits.
 */
export function invitationPage(presentation: AppPresentation): Response {
	const text = catalogFor(presentation.locale).pages
	return htmlPage({
		locale: presentation.locale,
		brand: presentation.brand,
		title: text.invitation.title,
		content: `<h1>${escapeHtml(text.invitation.title)}</h1><p>${escapeHtml(text.invitation.text)}</p>
		<form method="post" action="${escapeHtml(`/auth/invitations/accept${appQuery(presentation)}`)}">
			<input id="action-token" type="hidden" name="token" value="">
			<button type="submit">${escapeHtml(text.invitation.submit)}</button>
		</form>`,
		formActionOrigin: presentation.landing ?? undefined,
	})
}

/**
 * The answer to accepting an invitation that creates its principal: choose the password of the new account. The token
 * rides in the form as on `setPasswordPage`, and the form posts back to the invitation with the application's `?app=`;
 * the accepted invitation lands on `landingOrigin`, which `form-action` therefore admits.
 */
export function invitationPasswordPage(input: {
	readonly presentation: AppPresentation
	/** Where the new account lands off IAM (`actionLandingOrigin`); null for IAM's own sign-in page. */
	readonly landingOrigin: string | null
	readonly token: string
	/** The invited mailbox, which the new account signs in with. */
	readonly address: string
	readonly problem?: PasswordProblem
}): Response {
	const { presentation } = input
	const text = catalogFor(presentation.locale).pages
	const problem = input.problem === undefined ? undefined : text.setPassword.problem(input.problem, PASSWORD_MIN_CODE_POINTS, PASSWORD_MAX_CODE_POINTS)
	return htmlPage({
		locale: presentation.locale,
		brand: presentation.brand,
		title: text.invitation.createTitle,
		content: `<h1>${escapeHtml(text.invitation.createTitle)}</h1>${message(problem)}<p>${escapeHtml(text.invitation.createText(input.address))}</p><p>${
			escapeHtml(text.setPassword.rule(PASSWORD_MIN_CODE_POINTS, PASSWORD_MAX_CODE_POINTS))
		}</p><p>${escapeHtml(text.setPassword.shared(presentation.displayName))}</p>
		<form method="post" action="${escapeHtml(`/auth/invitations/accept${appQuery(presentation)}`)}">
			<input id="action-token" type="hidden" name="token" value="${escapeHtml(input.token)}">
			<input type="email" name="username" value="${escapeHtml(input.address)}" autocomplete="username" readonly hidden>
			${passwordInput(text, 'password', text.setPassword.newPassword, 'new-password')}
			<button type="submit">${escapeHtml(text.invitation.createSubmit)}</button>
		</form>`,
		status: input.problem === undefined ? 200 : 400,
		formActionOrigin: input.landingOrigin ?? undefined,
	})
}

/** An outcome of accepting an invitation. `signIn` adds the way back for a browser with no session here. */
export function invitationOutcomePage(
	input: {
		readonly presentation: AppPresentation
		readonly title: (text: PageText['invitation']) => string
		readonly text: (text: PageText['invitation']) => string
		readonly status: number
		readonly signIn?: string
		/** IAM's sign-out page, which asks before it signs out. */
		readonly signOut?: string
	},
): Response {
	const text = catalogFor(input.presentation.locale).pages.invitation
	const title = input.title(text)
	const signIn = input.signIn === undefined ? '' : `<p><a class="button" href="${escapeHtml(input.signIn)}">${escapeHtml(text.signIn)}</a></p>`
	const signOut = input.signOut === undefined ? '' : `<p><a class="button" href="${escapeHtml(input.signOut)}">${escapeHtml(text.signOut)}</a></p>`
	return htmlPage({
		locale: input.presentation.locale,
		brand: input.presentation.brand,
		title,
		content: `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(input.text(text))}</p>${signIn}${signOut}`,
		status: input.status,
	})
}

function passwordInput(text: PageText, name: string, label: string, autocomplete: 'current-password' | 'new-password'): string {
	return `<label>${
		escapeHtml(label)
	}<span class="password"><input id="${name}" name="${name}" type="password" autocomplete="${autocomplete}" required><button type="button" data-show="${name}" data-label-show="${
		escapeHtml(text.showPassword)
	}" data-label-hide="${escapeHtml(text.hidePassword)}">${escapeHtml(text.showPassword)}</button></span></label>`
}

function message(value: string | undefined): string {
	return value === undefined ? '' : `<p role="alert" class="error">${escapeHtml(value)}</p>`
}

/**
 * `formActionOrigin` widens `form-action` by exactly one origin: the login page's handoff destination, or the
 * registered origin an action or an invitation page lands on. It must already be an origin (scheme + host + optional
 * port) that `normalizeOrigin` admitted, which refuses every character that would end or widen the directive; the
 * registry stores only its output, and `presentationFor` checks a stored origin again.
 *
 * `brand` is required, so no page forgets the installation's logo; null draws the fabrika mark. The logo is an `<img>`
 * of a `data:` URI, which is all `img-src data:` admits: an image runs no script, and a `data:` URI loads nothing from
 * anywhere. `default-src` and `script-src` stay closed to it.
 */
export function htmlPage(page: {
	readonly locale: Locale
	readonly brand: InstallationBrand | null
	readonly title: string
	readonly content: string
	readonly status?: number
	readonly formActionOrigin?: string
}): Response {
	const formAction = page.formActionOrigin === undefined ? `'self'` : `'self' ${page.formActionOrigin}`
	const nonce = randomNonce()
	const html =
		`<!doctype html><html lang="${page.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${
			escapeHtml(page.title)
		}</title>
	<style nonce="${nonce}">${PAGE_STYLE}</style></head><body>${
			pageBody(page.content, { runsOn: escapeHtml(catalogFor(page.locale).pages.runsOn) }, page.brand)
		}
	<script nonce="${nonce}">var actionToken=document.getElementById('action-token');if(actionToken&&!actionToken.value){var fragment=new URLSearchParams(location.hash.slice(1));var token=fragment.get('token');if(token){actionToken.value=token;history.replaceState(null,'',location.pathname+location.search);}}document.querySelectorAll('[data-show]').forEach(function(button){button.addEventListener('click',function(){var input=document.getElementById(button.dataset.show);if(!input)return;var show=input.type==='password';input.type=show?'text':'password';button.textContent=show?button.dataset.labelHide:button.dataset.labelShow;} );});</script></body></html>`
	return new Response(html, {
		status: page.status ?? 200,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
			'content-security-policy':
				`default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src data:; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`,
			'referrer-policy': 'no-referrer',
			'x-content-type-options': 'nosniff',
			'x-frame-options': 'DENY',
		},
	})
}

function randomNonce(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16))
	let value = ''
	for (const byte of bytes) value += byte.toString(16).padStart(2, '0')
	return value
}
