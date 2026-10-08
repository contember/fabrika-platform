import { AUTH_HANDOFF_CHALLENGE_PARAM, AUTH_HANDOFF_STATE_PARAM } from '@fabrika/auth-core'
import { normalizeEmailIdentity } from '../email-identity'
import { type RequestContext } from '../env'
import { generatePkce, randomToken } from '../oidc'
import { resolveUserPrincipal } from '../resolve'
import { type Config, type Services } from '../services'

import { readCookie, serializeCookie } from './cookies'
import { type Handoff, handoffOf, handoffRedirectOr, readHandoff } from './handoff'
import { authError, redirectHeaders, safeRedirect } from './http'
import { type AuthEnv, authErrorEndingFlight, decodeFlight, encodeFlight, OIDC_COOKIE, OIDC_TTL_SECONDS } from './oidc-flight'
import { issueSession } from './sessions'

export async function handleOidcStart(request: Request, services: Services, env: AuthEnv): Promise<Response> {
	if (!services.config.authentication.oidc.enabled) return authError('OIDC login is disabled', 404)
	const url = new URL(request.url)
	const reading = await readHandoff(
		services,
		url.searchParams.get('app'),
		url.searchParams.get('redirect'),
		url.searchParams.get(AUTH_HANDOFF_STATE_PARAM),
		url.searchParams.get(AUTH_HANDOFF_CHALLENGE_PARAM),
	)
	if (reading.kind === 'refused') {
		return authError(reading.message, 400)
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
	if (!services.config.authentication.oidc.enabled || services.oidc === null) return authError('OIDC login is disabled', 404)
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
	if (!services.config.authentication.oidc.enabled || services.oidc === null) return authError('OIDC login is disabled', 404)
	const url = new URL(request.url)
	const code = url.searchParams.get('code')
	const state = url.searchParams.get('state')
	const flight = await decodeFlight(env, readCookie(request.headers.get('Cookie'), OIDC_COOKIE))
	// EVERY terminal outcome below consumes the flight. The cookie holds a live PKCE verifier and the
	// state nonce; leaving it behind on a failure kept both replayable for the rest of their 600s.
	const refuse = (message: string, status: number): Response => authErrorEndingFlight(message, status)

	// CSRF: the state echoed by the IdP must match the one in the flight WE signed.
	if (!code || !state || !flight || flight.state !== state) {
		return refuse('invalid OIDC state', 400)
	}

	const idToken = await services.oidc.exchangeCode(code, flight.verifier)
	if (!idToken) {
		return refuse('code exchange failed', 502)
	}
	const identity = await services.oidc.verifyIdToken(idToken)
	if (!identity) {
		return refuse('invalid id_token', 401)
	}

	// Admission: who may log in as a human. The central allowlist (`HUMAN_EMAIL_DOMAINS`/
	// `HUMAN_EMAILS`, with a `*` entry meaning admit-all) gates SELF-PROVISIONING of a new identity.
	// An already-known or invited principal (and a bootstrap admin) is always admitted regardless —
	// so check existence WITHOUT lazily creating before refusing a non-allowlisted newcomer.
	if (!admitted(identity.email, services.config)) {
		const known = (await services.repositories.principals.getUserByExternalId(identity.sub))
			?? (await services.repositories.principals.getUserByEmail(identity.email))
		if (!known) {
			return refuse('login refused (not allowed)', 403)
		}
	}

	// Resolve (or claim/lazy-create) the principal from the verified OIDC identity — the 3-step flow
	// keyed on the IdP `sub` and verified email.
	const resolved = await resolveUserPrincipal(services.repositories.principals, identity.sub, identity.email)
	if (!resolved.ok) {
		return refuse(`login refused (${resolved.reason})`, 403)
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
		return refuse(reading.message, 400)
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

/**
 * The human-admission allowlist for self-provisioning a brand-new identity. propustka owns this
 * centrally (the deploy vars `FABRIKA_IAM_HUMAN_EMAIL_DOMAINS` / `FABRIKA_IAM_HUMAN_EMAILS`):
 *   - a `*` entry in EITHER list = admit anyone (allow-all);
 *   - an exact email match in `emails`;
 *   - the email's domain in `emailDomains` (case-insensitive);
 *   - a bootstrap admin.
 * Returns false otherwise — an empty allowlist with no `*` means only known/invited principals and
 * bootstrap admins may log in (fail-closed). Matching uses ONLY the IdP-verified email.
 *
 * Both sides of every comparison are normalized. Entra and Okta both preserve directory casing, so a
 * `FABRIKA_IAM_HUMAN_EMAILS` entry spelled `Vip@Example.com` used to be a control that simply never
 * matched, with nothing said about it either way.
 */
function admitted(email: string, config: Config): boolean {
	const { emailDomains, emails } = config.human
	if (emailDomains.includes('*') || emails.includes('*')) {
		return true
	}
	const mailbox = normalizeEmailIdentity(email)
	if (emails.some((allowed) => normalizeEmailIdentity(allowed) === mailbox)) {
		return true
	}
	const at = mailbox.lastIndexOf('@')
	const domain = at === -1 ? '' : mailbox.slice(at + 1)
	if (domain !== '' && emailDomains.some((d) => d.toLowerCase() === domain)) {
		return true
	}
	return config.bootstrapAdmins.has(mailbox)
}
