import { FABRIKA_COOKIE_PREFIX, IDENTIFICATION_QUERY_PARAMETER, permits, SESSION_COOKIE } from '@fabrika/auth-core'
import { IAM_ACTIONS } from '@fabrika/iam-contract'
import { uuidv7 } from '@fabrika/platform'
import { IAM_APP } from '../admin/router'
import { type AppPresentation, INSTALLATION_PRESENTATION, presentationFor } from '../app-presentation'
import { auditLabelOf, DEFAULT_TERMINAL_SESSION_TTL_SECONDS, type TerminalRow } from '../db'
import { normalizeOrigin, resolveReturnUrl } from '../handoff'
import { IDENTIFICATION_TTL_SECONDS } from '../identification'
import { installationBrand } from '../installation-brand'
import { logError } from '../log'
import { randomToken } from '../oidc'
import { authFailurePage, TERMINAL_ENROL_PATH, terminalEnrolledPage, terminalEnrolPage } from '../password-pages'
import { unixNow } from '../repositories/sql'
import { resolvePermissionsAt } from '../resolve'
import { hashToken } from '../secret'
import type { Services } from '../services'
import { terminalLabel } from '../terminals'
import { clearCookie, readCookie, serializeCookie } from './cookies'
import type { Handoff } from './handoff'
import { printable, readForm, redirectHeaders, sameOrigin, stringValue } from './http'
import { type CurrentLogin, currentLogin } from './sessions'

/**
 * The cookie that makes a browser a terminal (ADR-0067 §1). It is not a session: no proxy reads it and it authorizes no
 * request. IAM reads it on its own host, only to start an identification.
 */
export const TERMINAL_COOKIE = `${FABRIKA_COOKIE_PREFIX}terminal`

/**
 * 400 days, the longest lifetime a browser keeps (RFC 6265bis caps `Max-Age` there, and Chromium enforces it). A terminal
 * ends when an administrator revokes it, not when a cookie expires, so it asks for the most a browser grants.
 */
export const TERMINAL_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60

/** Where an application's proxy sends a signed-out terminal's browser; the proxy's `SIGNOUT_RELEASE_PATH` names it. */
export const TERMINAL_RELEASE_PATH = '/auth/terminals/release'

/**
 * `GET` renders the enrolment form to a login that may enrol; `POST` enrols. A browser without a login is sent to sign
 * in and back here. Every refusal names no application, so it speaks the installation's language.
 */
export async function handleTerminalEnrolment(request: Request, services: Services, requestId: string): Promise<Response> {
	if (request.method === 'POST') {
		return enrol(request, services, requestId)
	}
	const login = await currentLogin(request, services)
	if (login === null) {
		const back = new URL(TERMINAL_ENROL_PATH, services.config.issuer).toString()
		return new Response(null, { status: 302, headers: redirectHeaders(`/auth/login?redirect=${encodeURIComponent(back)}`) })
	}
	if (!await mayEnrol(services, login)) {
		return authFailurePage(INSTALLATION_PRESENTATION, { kind: 'terminal_enrolment_not_allowed' }, 403)
	}
	return terminalEnrolPage({ brand: await installationBrand(services) })
}

/**
 * Enrol this browser, in one batch: the terminal's service principal and its row, the end of the administrator's login
 * here with its `logout` row, and the enrolment's audit record. Only then are the terminal cookie set and the login
 * cookie cleared, so the terminal is never left signed in as the person who set it up.
 */
async function enrol(request: Request, services: Services, requestId: string): Promise<Response> {
	if (!sameOrigin(request, services.config)) {
		return authFailurePage(INSTALLATION_PRESENTATION, { kind: 'cross_origin' }, 403)
	}
	const login = await currentLogin(request, services)
	if (login === null || !await mayEnrol(services, login)) {
		return authFailurePage(INSTALLATION_PRESENTATION, { kind: 'terminal_enrolment_not_allowed' }, 403)
	}
	const form = await readForm(request)
	if (form === null) {
		return authFailurePage(INSTALLATION_PRESENTATION, { kind: 'malformed_form' }, 400)
	}
	const label = terminalLabel(stringValue(form.get('label')) ?? '')
	if (label === null) {
		return terminalEnrolPage({ brand: await installationBrand(services), labelProblem: true })
	}

	const terminalId = uuidv7()
	const token = randomToken(32)
	const { principals, terminals, sessions, audit } = services.repositories
	try {
		await audit.commit([
			principals.createServiceStatement(terminalId, label),
			terminals.enrolStatement({
				principalId: terminalId,
				label,
				enrolledBy: login.principal.id,
				tokenHash: await hashToken(token),
				sessionTtl: DEFAULT_TERMINAL_SESSION_TTL_SECONDS,
			}),
			sessions.revokeStatement(login.session.id),
			audit.authLogStatement({
				requestId,
				app: IAM_APP,
				kind: 'logout',
				principalId: login.principal.id,
				decision: 'allow',
				reason: 'terminal_enrolment',
			}),
			audit.eventStatement({
				requestId,
				principalId: login.principal.id,
				principalLabel: auditLabelOf(login.principal),
				app: IAM_APP,
				action: 'iam.terminal.enrol',
				resourceType: 'terminal',
				resourceId: terminalId,
				metadata: { label },
			}),
		])
	} catch (err) {
		logError(`terminal enrolment could not be recorded for request '${requestId}'`, err)
		return authFailurePage(INSTALLATION_PRESENTATION, { kind: 'terminal_enrolment_unavailable' }, 503)
	}

	const response = terminalEnrolledPage(label, await installationBrand(services))
	response.headers.append('Set-Cookie', terminalCookie(token))
	response.headers.append('Set-Cookie', clearCookie(SESSION_COOKIE, { path: '/' }))
	return response
}

/** Whether the login's principal holds `iam.terminals.manage` at IAM, resolved live. */
async function mayEnrol(services: Services, login: CurrentLogin): Promise<boolean> {
	return permits(await resolvePermissionsAt(services, login.principal, IAM_APP), IAM_ACTIONS.TERMINALS_MANAGE)
}

/** HOST-ONLY on IAM's host, like the login cookie: the `__Host-` prefix makes the browser require `Secure`, `Path=/`, no `Domain`. */
function terminalCookie(value: string): string {
	return serializeCookie(TERMINAL_COOKIE, value, {
		httpOnly: true,
		secure: true,
		sameSite: 'Lax',
		maxAge: TERMINAL_COOKIE_MAX_AGE_SECONDS,
		path: '/',
	})
}

/** The enrolled terminal this browser is, by its cookie, with the cookie's value; null for any other browser. */
async function browserTerminal(request: Request, services: Services): Promise<{ terminal: TerminalRow; token: string } | null> {
	const token = readCookie(request.headers.get('Cookie'), TERMINAL_COOKIE)
	if (token === null) {
		return null
	}
	const terminal = await services.repositories.terminals.getActiveByTokenHash(await hashToken(token))
	return terminal === null ? null : { terminal, token }
}

/**
 * Send a terminal's browser to the application to identify the person at it (ADR-0067 §2): when the browser is an
 * enrolled terminal, the handoff's application is one of its asserters and declares an identification page. The
 * identification holds the handoff, so IAM alone issues the code once the application names the person. Null for any
 * other sign-in, which goes on as usual. The terminal cookie is refreshed, so a terminal in use never reaches its cap.
 */
export async function identificationRedirect(
	request: Request,
	services: Services,
	handoff: Handoff,
	presentation: AppPresentation,
	requestId: string,
): Promise<Response | null> {
	const browser = await browserTerminal(request, services)
	if (browser === null) {
		return null
	}
	const { terminals, appSchema } = services.repositories
	const terminalId = browser.terminal.principal_id
	if (await terminals.getAsserter(terminalId, handoff.app) === null) {
		return null
	}
	const identify = await appSchema.getTerminalIdentifyPath(handoff.app)
	const origin = normalizeOrigin(handoff.returnUrl)
	if (identify === null || origin === null) {
		return null
	}
	const id = randomToken(32)
	try {
		await terminals.createIdentification({
			idHash: await hashToken(id),
			terminalId,
			app: handoff.app,
			returnUrl: handoff.returnUrl,
			handoffState: handoff.state,
			handoffChallenge: handoff.challenge,
			expiresAt: unixNow() + IDENTIFICATION_TTL_SECONDS,
		}, {
			requestId,
			app: IAM_APP,
			kind: 'authenticate',
			principalId: null,
			decision: 'allow',
			reason: 'terminal_identification',
			terminal: { terminalId, assertedBy: handoff.app },
		})
	} catch (err) {
		logError(`a terminal identification could not be opened for request '${requestId}'`, err)
		return authFailurePage(presentation, { kind: 'login_unavailable' }, 503)
	}
	const location = new URL(identify, origin)
	location.searchParams.set(IDENTIFICATION_QUERY_PARAMETER, id)
	const headers = redirectHeaders(location.toString())
	headers.append('Set-Cookie', terminalCookie(browser.token))
	return new Response(null, { status: 302, headers })
}

/**
 * `GET /auth/terminals/release?app=&redirect=` (ADR-0067 §5): end the sessions of this browser's terminal, then return
 * to `redirect`, which must lie in the app's registered return origins. A browser that is no terminal is only sent back.
 *
 * A GET without a same-origin check, unlike every other auth route that changes state: the application's proxy sends
 * the browser here from its own sign-out, a navigation from another host. The most a cross-site request can do is end
 * the short session of whoever stands at the terminal.
 */
export async function handleTerminalRelease(request: Request, services: Services, requestId: string): Promise<Response> {
	const url = new URL(request.url)
	const app = url.searchParams.get('app')
	const redirect = url.searchParams.get('redirect')
	const presentation = await presentationFor(services, app)
	if (app === null || app === '' || redirect === null || redirect === '') {
		return authFailurePage(presentation, { kind: 'no_return_address' }, 400)
	}
	const returnUrl = await resolveReturnUrl(services, app, redirect)
	if (returnUrl === null) {
		return authFailurePage(presentation, { kind: 'unregistered_origin', origin: printable(normalizeOrigin(redirect) ?? 'that address') }, 400)
	}
	const browser = await browserTerminal(request, services)
	if (browser !== null) {
		try {
			await services.repositories.terminals.revokeSessions(browser.terminal.principal_id, { requestId, app: IAM_APP, reason: 'terminal_release' })
		} catch (err) {
			logError(`a terminal release could not be recorded for request '${requestId}'`, err)
			return authFailurePage(presentation, { kind: 'logout_unavailable' }, 503)
		}
	}
	return new Response(null, { status: 302, headers: redirectHeaders(returnUrl) })
}
