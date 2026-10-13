import { DEFAULT_LOCALE, type Locale } from '@fabrika/auth-core'
import { type AppPresentation, appQuery, landingUrl } from './app-presentation'
import { catalogFor, type PageText } from './catalog'
import { escapeHtml } from './html'
import { PASSWORD_MAX_CODE_POINTS, PASSWORD_MIN_CODE_POINTS, type PasswordProblem } from './password-policy'

export function loginPage(input: {
	readonly presentation: AppPresentation
	readonly redirect: string
	readonly oidcEnabled: boolean
	readonly forgotEnabled: boolean
	/** The app this login is a handoff for (ADR-0022); absent for a plain IAM login. */
	readonly app?: string
	readonly handoffState?: string
	readonly handoffChallenge?: string
	/**
	 * The handoff destination's ORIGIN, and the one page on this service whose form may answer with a
	 * redirect off it. Chromium applies `form-action` to the REDIRECT a submission answers with, not
	 * only to the action, so `'self'` alone silently blocks the 302 to `<app>/__fabrika/auth/callback`
	 * — the login succeeds, a code is issued and spent, and the browser never leaves this page.
	 * Measured in Chromium 149. The value comes from the app's REGISTERED return origin, never from
	 * the request, so widening the directive cannot widen where a browser may be sent.
	 */
	readonly handoffOrigin?: string
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
	const oidcUrl = `/auth/oidc/start?redirect=${encodeURIComponent(input.redirect)}${appQueryPart}`
	const title = text.signIn.title(input.presentation.displayName)
	return htmlPage({
		locale: input.presentation.locale,
		title,
		content: `<h1>${escapeHtml(title)}</h1>${message(input.invalidCredentials === true ? text.signIn.invalidCredentials : undefined)}
		<form method="post" action="/auth/login">
			<input type="hidden" name="redirect" value="${escapeHtml(input.redirect)}">
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
		formActionOrigin: input.handoffOrigin,
	})
}

/**
 * The recovery form, and the page its POST answers. The form carries `app` so the action it may issue keeps the
 * application; the way back is the application's address when it has one, otherwise IAM's sign-in.
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
		<form method="post" action="/auth/forgot-password">
			${presentation.app === null ? '' : `<input type="hidden" name="app" value="${escapeHtml(presentation.app)}">`}
			<label>${escapeHtml(text.email)}<input name="email" type="email" autocomplete="username" inputmode="email" required></label>
			<button type="submit">${escapeHtml(text.forgot.submit)}</button>
		</form>`
	return htmlPage({ locale: presentation.locale, title: input.sent === true ? text.forgot.sentTitle : text.forgot.title, content })
}

/**
 * The page an action link opens. Its form posts back with the link's `?app=`, so a refusal speaks the same language;
 * the completed action lands on the application's registered origin, which `form-action` therefore admits.
 */
export function setPasswordPage(input: {
	readonly presentation: AppPresentation
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
		formActionOrigin: presentation.landing ?? undefined,
	})
}

/**
 * The same-origin confirmation that `GET /auth/logout` renders. Signing out is a state change, so it
 * only happens on a POST that passes the origin check; this keeps the link usable and lives here
 * because `htmlPage` (and its CSP) is what every browser-facing IAM page is built from.
 */
export function logoutPage(redirect: string): Response {
	const text = catalogFor(DEFAULT_LOCALE).pages
	return htmlPage({
		locale: DEFAULT_LOCALE,
		title: text.logout.title,
		content: `<h1>${escapeHtml(text.logout.title)}</h1><p>${escapeHtml(text.logout.text)}</p>
		<form method="post" action="/auth/logout?redirect=${encodeURIComponent(redirect)}">
			<button type="submit">${escapeHtml(text.logout.submit)}</button>
		</form>`,
	})
}

export function invalidActionPage(presentation: AppPresentation): Response {
	const text = catalogFor(presentation.locale).pages
	return htmlPage({
		locale: presentation.locale,
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
		title: text.invitation.title,
		content: `<h1>${escapeHtml(text.invitation.title)}</h1><p>${escapeHtml(text.invitation.text)}</p>
		<form method="post" action="${escapeHtml(`/auth/invitations/accept${appQuery(presentation)}`)}">
			<input id="action-token" type="hidden" name="token" value="">
			<button type="submit">${escapeHtml(text.invitation.submit)}</button>
		</form>`,
		formActionOrigin: presentation.landing ?? undefined,
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
	},
): Response {
	const text = catalogFor(input.presentation.locale).pages.invitation
	const title = input.title(text)
	const signIn = input.signIn === undefined ? '' : `<p><a class="button" href="${escapeHtml(input.signIn)}">${escapeHtml(text.signIn)}</a></p>`
	return htmlPage({
		locale: input.presentation.locale,
		title,
		content: `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(input.text(text))}</p>${signIn}`,
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
 * port, no spaces, no `;`) — `normalizeOrigin` produces exactly that and the registry stores only its output — so it
 * cannot inject a second directive.
 */
export function htmlPage(page: {
	readonly locale: Locale
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
	<style nonce="${nonce}">:root{font-family:system-ui,sans-serif;color-scheme:light dark}body{max-width:30rem;margin:4rem auto;padding:1rem}form{display:grid;gap:1rem}label{display:grid;gap:.35rem}input,button,.button{font:inherit;padding:.65rem}.password{display:flex}.password input{flex:1}.error{color:#c33}hr{margin:2rem 0}.button{display:inline-block}</style></head><body><main>${page.content}</main>
	<script nonce="${nonce}">var actionToken=document.getElementById('action-token');if(actionToken&&!actionToken.value){var fragment=new URLSearchParams(location.hash.slice(1));var token=fragment.get('token');if(token){actionToken.value=token;history.replaceState(null,'',location.pathname+location.search);}}document.querySelectorAll('[data-show]').forEach(function(button){button.addEventListener('click',function(){var input=document.getElementById(button.dataset.show);if(!input)return;var show=input.type==='password';input.type=show?'text':'password';button.textContent=show?button.dataset.labelHide:button.dataset.labelShow;} );});</script></body></html>`
	return new Response(html, {
		status: page.status ?? 200,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
			'content-security-policy':
				`default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`,
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
