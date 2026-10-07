import { SESSION_COOKIE } from '@fabrika/auth-core'
import { sessionUsable } from '../auth'
import { type AuthenticationMethod } from '../db'
import { type RequestContext } from '../env'
import { randomToken } from '../oidc'
import { requestId } from '../request-id'
import { hashToken } from '../secret'
import { type Services } from '../services'
import { clearCookie, readCookie, serializeCookie } from './cookies'
import { type Handoff, handoffLocation } from './handoff'

import { authError, redirectHeaders, safeRedirect, sameOrigin } from './http'

import { OIDC_COOKIE } from './oidc-flight'

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
	return sessionUsable(session, services.config) ? session : null
}

export async function issueSession(
	request: Request,
	services: Services,
	ctx: RequestContext,
	input: {
		principalId: string
		idpSub?: string | null
		email?: string | null
		authenticationMethod?: AuthenticationMethod
		redirect: string
		reason: string
		clearOidc?: boolean
		/** When set, land on the app's callback with a code instead of on `redirect` (ADR-0022). */
		handoff?: Handoff | null
	},
): Promise<Response> {
	const sessionToken = randomToken(32)
	const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
	const sessionId = await services.repositories.sessions.createSession({
		tokenHash: await hashToken(sessionToken),
		principalId: input.principalId,
		idpSub: input.idpSub,
		email: input.email,
		authenticationMethod: input.authenticationMethod,
		expiresAt,
	})
	ctx.waitUntil(
		services.repositories.audit.writeAuthLog({
			requestId: requestId(request),
			app: 'propustka',
			kind: 'authenticate',
			principalId: input.principalId,
			decision: 'allow',
			reason: input.reason,
		}),
	)

	// The IAM cookie is set either way: it is what makes the NEXT handoff, to this or any other app,
	// silent. What changes is where the browser goes — its own destination, or the app's callback.
	const location = input.handoff == null ? input.redirect : await handoffLocation(services, input.handoff, sessionId)
	const headers = redirectHeaders(location)
	headers.append('Set-Cookie', sessionCookie(sessionToken))
	if (input.clearOidc === true) {
		headers.append('Set-Cookie', clearCookie(OIDC_COOKIE, { path: '/auth' }))
	}
	return new Response(null, { status: 302, headers })
}

/**
 * Revoke the login and clear the cookie. Same-origin only, like every other mutating form here:
 * `px_session` is `SameSite=Lax`, so a cross-site top-level GET carried it, and because every app
 * session hangs off this one, that single request logged the human out of every host at once.
 */
export async function handleLogout(request: Request, services: Services): Promise<Response> {
	if (!sameOrigin(request, services.config)) return authError('invalid request origin', 403)
	const cookie = readCookie(request.headers.get('Cookie'), SESSION_COOKIE)
	if (cookie) {
		await services.repositories.sessions.revokeSessionByHash(await hashToken(cookie))
	}
	const url = new URL(request.url)
	const headers = redirectHeaders(safeRedirect(url.searchParams.get('redirect'), services.config))
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
 * outcome for a 30-day credential, not a regression to work around.
 */
function sessionCookie(value: string): string {
	return serializeCookie(SESSION_COOKIE, value, {
		httpOnly: true,
		secure: true,
		sameSite: 'Lax',
		maxAge: SESSION_TTL_SECONDS,
		path: '/',
	})
}
