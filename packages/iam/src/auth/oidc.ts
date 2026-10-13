import { AUTH_HANDOFF_CHALLENGE_PARAM, AUTH_HANDOFF_STATE_PARAM } from '@fabrika/auth-core'
import { type RequestContext } from '../env'
import { admitted } from '../human-admission'
import { generatePkce, randomToken } from '../oidc'
import { resolveUserPrincipal } from '../resolve'
import { type Services } from '../services'

import { presentationFor } from '../app-presentation'
import { authFailurePage } from '../password-pages'
import { readCookie, serializeCookie } from './cookies'
import type { AuthFailure } from './failure'
import { type Handoff, handoffOf, handoffRedirectOr, readHandoff } from './handoff'
import { redirectHeaders, safeRedirect } from './http'
import { type AuthEnv, authFailureEndingFlight, decodeFlight, encodeFlight, OIDC_COOKIE, OIDC_TTL_SECONDS } from './oidc-flight'
import { issueSession, type LoginRefusal, refuseLogin } from './sessions'

export async function handleOidcStart(request: Request, services: Services, env: AuthEnv): Promise<Response> {
	const url = new URL(request.url)
	const linked = await presentationFor(services, url.searchParams.get('app'))
	if (!services.config.authentication.oidc.enabled) return authFailurePage(linked, { kind: 'oidc_disabled' }, 404)
	const reading = await readHandoff(
		services,
		url.searchParams.get('app'),
		url.searchParams.get('redirect'),
		url.searchParams.get(AUTH_HANDOFF_STATE_PARAM),
		url.searchParams.get(AUTH_HANDOFF_CHALLENGE_PARAM),
	)
	if (reading.kind === 'refused') {
		return authFailurePage(linked, reading.failure, 400)
	}
	const handoff = handoffOf(reading)
	return startOidc(services, env, handoffRedirectOr(handoff, url.searchParams.get('redirect'), services), handoff)
}

export async function startOidc(
	services: Services,
	env: AuthEnv,
	redirect: string,
	handoff: Handoff | null = null,
): Promise<Response> {
	if (!services.config.authentication.oidc.enabled || services.oidc === null) {
		return authFailurePage(await presentationFor(services, handoff?.app ?? null), { kind: 'oidc_disabled' }, 404)
	}
	const { verifier, challenge } = await generatePkce()
	const state = randomToken(16)
	const location = await services.oidc.authorizationUrl({ state, codeChallenge: challenge })

	const flight = await encodeFlight(env, {
		state,
		verifier,
		redirect,
		...(handoff === null
			? {}
			: { app: handoff.app, handoffState: handoff.state, handoffChallenge: handoff.challenge }),
	})
	const headers = redirectHeaders(location)
	// The in-flight cookie is scoped to /auth (only the callback reads it), single-use, and SIGNED —
	// see `encodeFlight`.
	headers.append(
		'Set-Cookie',
		serializeCookie(OIDC_COOKIE, flight, { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: OIDC_TTL_SECONDS, path: '/auth' }),
	)
	return new Response(null, { status: 302, headers })
}

export async function handleCallback(
	request: Request,
	services: Services,
	env: AuthEnv,
	ctx: RequestContext,
	requestId: string,
): Promise<Response> {
	const url = new URL(request.url)
	const code = url.searchParams.get('code')
	const state = url.searchParams.get('state')
	const flight = await decodeFlight(env, readCookie(request.headers.get('Cookie'), OIDC_COOKIE))
	// The flight we signed names the application the login started from; its refusals speak that language.
	const presentation = await presentationFor(services, flight?.app ?? null)
	if (!services.config.authentication.oidc.enabled || services.oidc === null) return authFailurePage(presentation, { kind: 'oidc_disabled' }, 404)
	// EVERY terminal outcome below consumes the flight. The cookie holds a live PKCE verifier and the
	// state nonce; leaving it behind on a failure kept both replayable for the rest of their 600s.
	// Every refusal is a refused login, logged before the answer.
	const refuse = (reason: LoginRefusal, failure: AuthFailure, status: number): Promise<Response> =>
		refuseLogin(services, { requestId, principalId: null, reason }, () => authFailureEndingFlight(presentation, failure, status))

	// CSRF: the state echoed by the IdP must match the one in the flight WE signed.
	if (!code || !state || !flight || flight.state !== state) {
		return refuse('oidc_invalid_state', { kind: 'oidc_invalid_state' }, 400)
	}

	const idToken = await services.oidc.exchangeCode(code, flight.verifier)
	if (!idToken) {
		return refuse('oidc_code_exchange_failed', { kind: 'oidc_exchange_failed' }, 502)
	}
	const identity = await services.oidc.verifyIdToken(idToken)
	if (!identity) {
		return refuse('oidc_invalid_id_token', { kind: 'oidc_invalid_id_token' }, 401)
	}

	// Admission: who may log in as a human. The central allowlist (`HUMAN_EMAIL_DOMAINS`/
	// `HUMAN_EMAILS`, with a `*` entry meaning admit-all) gates SELF-PROVISIONING of a new identity.
	// An already-known or invited INTERNAL principal (and a bootstrap admin) is always admitted regardless —
	// so check existence WITHOUT lazily creating before refusing a non-allowlisted newcomer. An external
	// principal is no reason to admit anyone: OIDC never claims it (ADR-0051).
	if (!admitted(identity.email, services.config)) {
		const known = (await services.repositories.principals.getUserByExternalId(identity.sub))
			?? (await services.repositories.principals.getUserByEmail(identity.email))
		if (!known || known.affiliation === 'external') {
			return refuse('oidc_not_admitted', { kind: 'not_admitted' }, 403)
		}
	}

	// Resolve (or claim/lazy-create) the principal from the verified OIDC identity — the 3-step flow
	// keyed on the IdP `sub` and verified email.
	const resolved = await resolveUserPrincipal(services.repositories.principals, identity.sub, identity.email, requestId)
	if (!resolved.ok) {
		// The answer does not say an external principal holds the address.
		const failure: AuthFailure = resolved.reason === 'external_principal'
			? { kind: 'not_admitted' }
			: { kind: 'login_refused', reason: resolved.reason }
		return refuse(`oidc_${resolved.reason}`, failure, 403)
	}

	// Re-validate the handoff on the way back: the flight is ours (signature-checked), but the registry
	// may have changed while the human was away at the IdP.
	const reading = flight.app === undefined
		? { kind: 'none' as const }
		: await readHandoff(
			services,
			flight.app,
			flight.redirect,
			flight.handoffState ?? null,
			flight.handoffChallenge ?? null,
		)
	if (reading.kind === 'refused') {
		return refuse('handoff_refused', reading.failure, 400)
	}

	return issueSession(request, services, ctx, {
		principalId: resolved.principal.id,
		idpSub: identity.sub,
		email: identity.email,
		redirect: safeRedirect(flight.redirect, services.config),
		reason: 'login',
		requestId,
		clearOidc: true,
		handoff: handoffOf(reading),
	})
}
