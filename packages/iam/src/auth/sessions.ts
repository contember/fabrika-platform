import { SESSION_COOKIE } from '@fabrika/auth-core'
import { iamAdministrationScope } from '@fabrika/iam-contract'
import { IAM_APP } from '../admin/router'
import { installationLanding, installationPresentation } from '../app-presentation'
import { sessionUsable } from '../auth'
import { type AuthenticationMethod, type PrincipalRow, principalStatus, type SessionRow } from '../db'
import { type RequestContext } from '../env'
import { logError } from '../log'
import { randomToken } from '../oidc'
import { parseLocale, signInLocaleCookie } from '../person-locale'
import { resolvePermissionsAt } from '../resolve'
import { hashToken } from '../secret'
import { type Services } from '../services'
import { clearCookie, readCookie, serializeCookie } from './cookies'
import { type Handoff, handoffLocation } from './handoff'

import { authFailurePage } from '../password-pages'
import { redirectHeaders, safeRedirect, sameOrigin } from './http'

import { knownDeviceCookie } from './known-device'
import { type AuthEnv, endingFlightCookies } from './oidc-flight'
import { challengeSecondFactor, endingChallengeCookie } from './second-factor-challenge'

/** SSO session lifetime — the long-lived credential a browser carries (30 days). */
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

/** The caller's IAM session, if the browser already holds a valid one on this host. */
export async function currentSession(request: Request, services: Services) {
	const raw = readCookie(request.headers.get('Cookie'), SESSION_COOKIE)
	if (raw === null) {
		return null
	}
	const session = await services.repositories.sessions.getActiveSessionByHash(await hashToken(raw))
	if (session === null) {
		return null
	}
	// A child session cannot father another: only the IAM login itself may authorize a handoff.
	if (session.app !== null) {
		return null
	}
	// And a session whose method is no longer enabled must not silently father a handoff.
	return sessionUsable(session, services.config, Math.floor(Date.now() / 1000)) ? session : null
}

/** A login a handoff may continue: the browser's IAM session and its principal, an active user. */
export interface CurrentLogin {
	readonly session: SessionRow
	readonly principal: PrincipalRow
}

/** The caller's IAM login when its principal is an active user, else null — which signs in afresh. */
export async function currentLogin(request: Request, services: Services): Promise<CurrentLogin | null> {
	const session = await currentSession(request, services)
	if (session === null) return null
	const principal = await services.repositories.principals.getPrincipalById(session.principal_id)
	if (principal === null || principal.type !== 'user' || principalStatus(principal) !== 'active') return null
	return { session, principal }
}

/** A login a proven first factor opens. */
export interface LoginInput {
	principalId: string
	idpSub?: string | null
	email?: string | null
	authenticationMethod?: AuthenticationMethod
	/** Where the login lands; null for no destination of its own, which is the installation's landing. */
	redirect: string | null
	reason: string
	/** The correlation id the composition root allowed; see `src/request-id.ts`. */
	requestId: string
	clearOidc?: boolean
	/** When set, land on the app's callback with a code instead of on `redirect` (ADR-0022). */
	handoff?: Handoff | null
	/** Set the known-device cookie once the login is recorded: a password login's (`auth/known-device.ts`). */
	rememberDevice?: boolean
	/** Set only by the second-factor form, after the principal's code or recovery code was accepted. */
	secondFactor?: 'verified'
}

/**
 * Open a login: the session and its `auth_log` row are written in one batch, before the answer. A login that cannot
 * be logged opens no session and answers 503. A principal that administers at IAM, the installation or the people of
 * an application (ADR-0058), is logged `privileged`.
 *
 * A principal with a confirmed second factor gets no session here until its code is verified: the answer is the code
 * form and a challenge cookie holding this login (`second-factor-challenge.ts`). Every password, OIDC, password-action
 * and invitation login passes through here, so none skips the factor; only the local-dev bypass does, which no
 * installation outside `ENVIRONMENT=local` serves.
 */
export async function issueSession(
	request: Request,
	services: Services,
	env: AuthEnv,
	ctx: RequestContext,
	input: LoginInput,
): Promise<Response> {
	const method = input.authenticationMethod ?? 'oidc'
	if (input.secondFactor !== 'verified' && (method === 'oidc' || method === 'password')) {
		let required: boolean
		try {
			required = await services.repositories.secondFactors.isConfirmed(input.principalId)
		} catch (err) {
			logError(`the second factor of login for request '${input.requestId}' could not be read`, err)
			return authFailurePage(await installationPresentation(services, { request }), { kind: 'login_unavailable' }, 503)
		}
		if (required) {
			return challengeSecondFactor(services, env, request, {
				principalId: input.principalId,
				idpSub: input.idpSub ?? null,
				email: input.email ?? null,
				authenticationMethod: method,
				redirect: input.redirect,
				reason: input.reason,
				handoff: input.handoff ?? null,
				rememberDevice: input.rememberDevice === true,
			})
		}
	}
	const sessionToken = randomToken(32)
	// An OIDC login stores the installation's cap as its expiry, so its app sessions, OAuth grants and cookie end with it.
	const lifetime = (input.authenticationMethod ?? 'oidc') === 'oidc'
		? Math.min(SESSION_TTL_SECONDS, services.config.authentication.oidc.sessionCapSeconds)
		: SESSION_TTL_SECONDS
	const expiresAt = Math.floor(Date.now() / 1000) + lifetime
	let sessionId: string
	try {
		sessionId = await services.repositories.sessions.createSession({
			tokenHash: await hashToken(sessionToken),
			principalId: input.principalId,
			idpSub: input.idpSub,
			email: input.email,
			authenticationMethod: input.authenticationMethod,
			expiresAt,
		}, {
			requestId: input.requestId,
			app: IAM_APP,
			kind: 'authenticate',
			principalId: input.principalId,
			decision: 'allow',
			reason: input.reason,
			privileged: await administersIam(services, input.principalId),
		})
	} catch (err) {
		logError(`login could not be recorded for request '${input.requestId}'`, err)
		return authFailurePage(await installationPresentation(services, { request }), { kind: 'login_unavailable' }, 503)
	}

	// The IAM cookie is set either way: it is what spares the NEXT handoff, to this or any other app, a
	// password. What changes is where the browser goes — its own destination, or the app's callback.
	const location = input.handoff == null
		? input.redirect ?? await installationLanding(services)
		: await handoffLocation(services, input.handoff, sessionId)
	const headers = redirectHeaders(location)
	headers.append('Set-Cookie', sessionCookie(sessionToken, lifetime))
	// A person with a language of their own keeps it on this browser's next sign-in page here (`LOCALE_COOKIE`); one
	// without clears the language a previous person left on a shared browser.
	// The session has committed and the cookie picks words only: a failed read leaves the remembered language as it is.
	const locale = await services.repositories.principals.getPrincipalById(input.principalId).then(
		(principal) => signInLocaleCookie(request, parseLocale(principal?.locale)),
		(err: unknown) => {
			logError(`the language of login for request '${input.requestId}' could not be read`, err)
			return null
		},
	)
	if (locale !== null) {
		headers.append('Set-Cookie', locale)
	}
	if (input.clearOidc === true) {
		for (const cookie of endingFlightCookies()) {
			headers.append('Set-Cookie', cookie)
		}
	}
	if (input.secondFactor === 'verified') {
		headers.append('Set-Cookie', endingChallengeCookie())
	}
	if (input.rememberDevice === true) {
		headers.append('Set-Cookie', await knownDeviceCookie(env, input.principalId))
	}
	return new Response(null, { status: 302, headers })
}

/**
 * Answer a refused login after its `deny` row is in `auth_log`. A refusal that cannot be logged answers 503 instead,
 * so no login attempt goes unrecorded.
 */
/** The fixed `auth_log.reason` of a refused login. A reason never carries what the caller submitted. */
export type LoginRefusal =
	| 'password_invalid'
	| 'password_throttled'
	| 'password_malformed'
	| 'handoff_refused'
	| 'login_cross_origin'
	| 'oidc_invalid_state'
	| 'oidc_code_exchange_failed'
	| 'oidc_invalid_id_token'
	| 'oidc_not_admitted'
	| 'oidc_disabled'
	| 'oidc_unknown_principal'
	| 'oidc_external_principal'
	| 'local_login_refused'
	| 'second_factor_invalid'
	| 'second_factor_throttled'
	| 'second_factor_expired'

export async function refuseLogin(
	services: Services,
	request: Request,
	entry: { requestId: string; principalId: string | null; reason: LoginRefusal },
	answer: () => Response | Promise<Response>,
): Promise<Response> {
	try {
		await services.repositories.audit.writeAuthLog({
			requestId: entry.requestId,
			app: IAM_APP,
			kind: 'authenticate',
			principalId: entry.principalId,
			decision: 'deny',
			reason: entry.reason,
		})
	} catch (err) {
		logError(`a refused login could not be recorded for request '${entry.requestId}'`, err)
		return authFailurePage(await installationPresentation(services, { request }), { kind: 'login_unavailable' }, 503)
	}
	return answer()
}

/** Whether the principal administers at IAM, the installation or the people of an application — what marks its login privileged. */
export async function administersIam(services: Services, principalId: string): Promise<boolean> {
	const principal = await services.repositories.principals.getPrincipalById(principalId)
	if (principal === null) return false
	return iamAdministrationScope(await resolvePermissionsAt(services, principal, IAM_APP)) !== null
}

/**
 * Revoke the login and clear the cookie. Same-origin only, like every other mutating form here:
 * `px_session` is `SameSite=Lax`, so a cross-site top-level GET carried it, and because every app
 * session hangs off this one, that single request logged the human out of every host at once.
 * The revocation and its `logout` row in `auth_log` are one batch; one that cannot be written answers 503
 * and leaves the session as it was.
 */
export async function handleLogout(request: Request, services: Services, requestId: string): Promise<Response> {
	// Logout names no application, like its confirmation page: these answers speak the reader's language.
	if (!sameOrigin(request, services.config)) {
		return authFailurePage(await installationPresentation(services, { request }), { kind: 'cross_origin' }, 403)
	}
	if (!await endLogin(request, services, requestId)) {
		return authFailurePage(await installationPresentation(services, { request }), { kind: 'logout_unavailable' }, 503)
	}
	const url = new URL(request.url)
	return signedOutRedirect(safeRedirect(url.searchParams.get('redirect'), services.config) ?? await installationLanding(services))
}

/**
 * End the browser's IAM login, and with it every app session derived from it. The revocation and its `logout` row are
 * one batch; false when that batch could not be written, and the login stands. The caller checks `sameOrigin` first.
 */
export async function endLogin(request: Request, services: Services, requestId: string): Promise<boolean> {
	const cookie = readCookie(request.headers.get('Cookie'), SESSION_COOKIE)
	if (!cookie) return true
	try {
		await services.repositories.sessions.revokeSessionByHash(await hashToken(cookie), { requestId, app: IAM_APP, reason: 'logout' })
	} catch (err) {
		logError(`logout could not be recorded for request '${requestId}'`, err)
		return false
	}
	return true
}

/** The 302 out of an ended login, which clears its cookie. */
export function signedOutRedirect(location: string): Response {
	const headers = redirectHeaders(location)
	headers.append('Set-Cookie', clearCookie(SESSION_COOKIE, { path: '/' }))
	return new Response(null, { status: 302, headers })
}

/**
 * Build the long-lived login `Set-Cookie` — HOST-ONLY, on IAM's own host and nowhere else (ADR-0023).
 *
 * `SESSION_COOKIE` carries the `__Host-` prefix, which a browser honours only when the cookie has
 * `Secure`, `Path=/` and NO `Domain`. All three are set here; adding a `Domain` would make the browser
 * drop the cookie outright rather than widen it.
 *
 * **`Secure` is unconditional**, and it used to be derived from the issuer's scheme. The prefix
 * removed the decision: without `Secure` the browser refuses the cookie whatever the transport, so a
 * conditional could only ever produce a cookie nothing would store. It stays correct behind a
 * TLS-TERMINATING BALANCER (the socket is plain HTTP, the browser spoke HTTPS) and over plain HTTP on
 * `localhost` / `*.localhost`, which browsers treat as potentially trustworthy. An installation
 * served over cleartext HTTP on a public hostname can hold no session at all — which is the correct
 * outcome for a credential that lasts up to 30 days, not a regression to work around.
 */
function sessionCookie(value: string, maxAge: number): string {
	return serializeCookie(SESSION_COOKIE, value, {
		httpOnly: true,
		secure: true,
		sameSite: 'Lax',
		maxAge,
		path: '/',
	})
}
