import { AUTH_HANDOFF_CHALLENGE_PARAM, AUTH_HANDOFF_STATE_PARAM } from '@fabrika/auth-core'
import { type AppPresentation, presentationFor } from '../app-presentation'
import { LOCAL_DEV_ADMIN_EMAIL, LOCAL_DEV_ADMIN_ID } from '../auth'

import { type RequestContext } from '../env'
import { authFailurePage, loginPage } from '../password-pages'
import { resolveUserPrincipal } from '../resolve'
import { type Services } from '../services'
import { type Handoff, handoffLocation, handoffOf, handoffRedirectOr, loginDestinationFields, readHandoff } from './handoff'
import { redirectHeaders } from './http'

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
		return authFailurePage(await presentationFor(services, url.searchParams.get('app')), reading.failure, 400)
	}
	const handoff = handoffOf(reading)
	const presentation = await presentationFor(services, handoff?.app ?? null)
	// A handoff's destination is already validated against the app's registry, so `safeRedirect` must
	// not get a say: it admits IAM's own origin only, which by definition excludes the app host this
	// exists for. Passing its refusal to the form would send the login to the installation's landing.
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
		return handleLocalLogin(request, services, ctx, requestId, redirect, handoff, presentation)
	}
	if (services.config.authentication.password.enabled) {
		return loginPage({
			presentation,
			redirect,
			oidcEnabled: services.config.authentication.oidc.enabled,
			forgotEnabled: services.email !== null,
			...await loginDestinationFields(services, handoff, redirect),
		})
	}
	return startOidc(services, env, redirect, handoff)
}

async function handleLocalLogin(
	request: Request,
	services: Services,
	ctx: RequestContext,
	requestId: string,
	redirect: string | null,
	handoff: Handoff | null,
	presentation: AppPresentation,
): Promise<Response> {
	const resolved = await resolveUserPrincipal(services.repositories.principals, LOCAL_DEV_ADMIN_ID, LOCAL_DEV_ADMIN_EMAIL, requestId)
	if (!resolved.ok) {
		return refuseLogin(
			services,
			{ requestId, principalId: null, reason: 'local_login_refused' },
			() => authFailurePage(presentation, { kind: 'login_refused', reason: `local ${resolved.reason}` }, 403),
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
