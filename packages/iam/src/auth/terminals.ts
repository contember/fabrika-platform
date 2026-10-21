import { FABRIKA_COOKIE_PREFIX, permits, SESSION_COOKIE } from '@fabrika/auth-core'
import { IAM_ACTIONS } from '@fabrika/iam-contract'
import { uuidv7 } from '@fabrika/platform'
import { IAM_APP } from '../admin/router'
import { INSTALLATION_PRESENTATION } from '../app-presentation'
import { auditLabelOf, DEFAULT_TERMINAL_SESSION_TTL_SECONDS } from '../db'
import { installationBrand } from '../installation-brand'
import { logError } from '../log'
import { randomToken } from '../oidc'
import { authFailurePage, TERMINAL_ENROL_PATH, terminalEnrolledPage, terminalEnrolPage } from '../password-pages'
import { resolvePermissionsAt } from '../resolve'
import { hashToken } from '../secret'
import type { Services } from '../services'
import { terminalLabel } from '../terminals'
import { clearCookie, serializeCookie } from './cookies'
import { readForm, redirectHeaders, sameOrigin, stringValue } from './http'
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
