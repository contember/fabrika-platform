import { PASSWORD_MAX_CODE_POINTS, PASSWORD_MIN_CODE_POINTS } from './password-policy'

export function loginPage(input: {
	readonly redirect: string
	readonly oidcEnabled: boolean
	readonly forgotEnabled: boolean
	readonly error?: string
}): Response {
	const oidcUrl = `/auth/oidc/start?redirect=${encodeURIComponent(input.redirect)}`
	return htmlPage(
		'Sign in',
		`<h1>Sign in</h1>${message(input.error)}
		<form method="post" action="/auth/login">
			<input type="hidden" name="redirect" value="${escapeHtml(input.redirect)}">
			<label>Email<input name="email" type="email" autocomplete="username" inputmode="email" required></label>
			${passwordInput('password', 'Password', 'current-password')}
			<button type="submit">Sign in</button>
		</form>
		${input.forgotEnabled ? '<p><a href="/auth/forgot-password">Forgot password?</a></p>' : ''}
		${input.oidcEnabled ? `<hr><p><a class="button" href="${escapeHtml(oidcUrl)}">Continue with single sign-on</a></p>` : ''}`,
		input.error === undefined ? 200 : 401,
	)
}

export function forgotPasswordPage(input: { readonly sent?: boolean }): Response {
	const content = input.sent
		? '<h1>Request received</h1><p>If the account can use password sign-in and email delivery succeeds, a one-time link will arrive.</p><p><a href="/auth/login">Return to sign in</a></p>'
		: `<h1>Reset password</h1><form method="post" action="/auth/forgot-password">
			<label>Email<input name="email" type="email" autocomplete="username" inputmode="email" required></label>
			<button type="submit">Continue</button>
		</form>`
	return htmlPage('Reset password', content)
}

export function setPasswordPage(input: {
	readonly token?: string
	readonly purpose: 'enrollment' | 'reset'
	readonly error?: string
}): Response {
	const title = input.purpose === 'enrollment' ? 'Set your password' : 'Reset your password'
	const path = input.purpose === 'enrollment' ? '/auth/password/enroll' : '/auth/password/reset'
	return htmlPage(
		title,
		`<h1>${title}</h1>${
			message(input.error)
		}<p>Use ${PASSWORD_MIN_CODE_POINTS}–${PASSWORD_MAX_CODE_POINTS} characters. Long passphrases are welcome.</p>
		<form method="post" action="${path}">
			<input id="password-action-token" type="hidden" name="token" value="${escapeHtml(input.token ?? '')}">
			${passwordInput('password', 'New password', 'new-password')}
			<button type="submit">${title}</button>
		</form>`,
		input.error === undefined ? 200 : 400,
	)
}

export function invalidActionPage(): Response {
	return htmlPage(
		'Link unavailable',
		'<h1>Link unavailable</h1><p>This link is invalid, expired, or already used.</p><p><a href="/auth/forgot-password">Request a new link</a></p>',
		400,
	)
}

function passwordInput(name: string, label: string, autocomplete: 'current-password' | 'new-password'): string {
	return `<label>${label}<span class="password"><input id="${name}" name="${name}" type="password" autocomplete="${autocomplete}" required><button type="button" data-show="${name}">Show</button></span></label>`
}

function message(value: string | undefined): string {
	return value === undefined ? '' : `<p role="alert" class="error">${escapeHtml(value)}</p>`
}

function htmlPage(title: string, content: string, status = 200): Response {
	const nonce = randomNonce()
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${
		escapeHtml(title)
	}</title>
	<style nonce="${nonce}">:root{font-family:system-ui,sans-serif;color-scheme:light dark}body{max-width:30rem;margin:4rem auto;padding:1rem}form{display:grid;gap:1rem}label{display:grid;gap:.35rem}input,button,.button{font:inherit;padding:.65rem}.password{display:flex}.password input{flex:1}.error{color:#c33}hr{margin:2rem 0}.button{display:inline-block}</style></head><body><main>${content}</main>
	<script nonce="${nonce}">var actionToken=document.getElementById('password-action-token');if(actionToken&&!actionToken.value){var fragment=new URLSearchParams(location.hash.slice(1));var token=fragment.get('token');if(token){actionToken.value=token;history.replaceState(null,'',location.pathname);}}document.querySelectorAll('[data-show]').forEach(function(button){button.addEventListener('click',function(){var input=document.getElementById(button.dataset.show);if(!input)return;var show=input.type==='password';input.type=show?'text':'password';button.textContent=show?'Hide':'Show';} );});</script></body></html>`
	return new Response(html, {
		status,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
			'content-security-policy':
				`default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
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

export function escapeHtml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}
