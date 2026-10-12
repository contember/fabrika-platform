import { AUTH_HANDOFF_CHALLENGE_PARAM, AUTH_HANDOFF_STATE_PARAM } from '@fabrika/auth-core'
import { LOCAL_DEV_ADMIN_EMAIL, LOCAL_DEV_ADMIN_ID } from '../auth'

import { type RequestContext } from '../env'
import { loginPage } from '../password-pages'
import { resolveUserPrincipal } from '../resolve'
import { type Services } from '../services'
import { type Handoff, handoffLocation, handoffOf, handoffRedirectOr, loginHandoffFields, readHandoff } from './handoff'
import { authError, redirectHeaders } from './http'

import { startOidc } from './oidc'
import { type AuthEnv } from './oidc-flight'
import { currentSession, issueSession, refuseLogin } from './sessions'

export async function handleLogin(
	request: Request,
	services: Services,
	env: AuthEnv,
	ctx: RequestContext,
	requestId: string,
): Promise<Response> {
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
	// A handoff's destination is already validated against the app's registry, so `safeRedirect` must
	// not get a say: it admits IAM's own origin only, which by definition excludes the app host this
	// exists for. Passing its fallback to the form would strand the login on IAM.
	const redirect = handoffRedirectOr(handoff, url.searchParams.get('redirect'), services)

	// Already signed in HERE? Then a handoff needs no prompt — mint the code off the existing login and
	// bounce. This is what makes a second app, and every token expiry, silent.
	if (handoff !== null) {
		const existing = await currentSession(request, services)
		if (existing !== null) {
			return new Response(null, { status: 302, headers: redirectHeaders(await handoffLocation(services, handoff, existing.id)) })
		}
	}

	if (services.config.localDevLogin) {
		return handleLocalLogin(request, services, ctx, requestId, redirect, handoff)
	}
	if (services.config.authentication.password.enabled) {
		return loginPage({
			redirect,
			oidcEnabled: services.config.authentication.oidc.enabled,
			forgotEnabled: services.email !== null,
			...loginHandoffFields(handoff),
		})
	}
	return startOidc(services, env, redirect, handoff)
}

async function handleLocalLogin(
	request: Request,
	services: Services,
	ctx: RequestContext,
	requestId: string,
	redirect: string,
	handoff: Handoff | null = null,
): Promise<Response> {
	const resolved = await resolveUserPrincipal(services.repositories.principals, LOCAL_DEV_ADMIN_ID, LOCAL_DEV_ADMIN_EMAIL, requestId)
	if (!resolved.ok) {
		return refuseLogin(
			services,
			{ requestId, principalId: null, reason: 'local_login_refused' },
			() => authError(`local login refused (${resolved.reason})`, 403),
		)
	}
	return issueSession(request, services, ctx, {
		principalId: resolved.principal.id,
		idpSub: LOCAL_DEV_ADMIN_ID,
		email: LOCAL_DEV_ADMIN_EMAIL,
		// The bypass's own method, so the session dies with the flag rather than passing as an OIDC login.
		authenticationMethod: 'local_dev',
		redirect,
		reason: 'local_login',
		requestId,
		handoff,
	})
}
