import { AUTH_HANDOFF_CHALLENGE_PARAM, AUTH_HANDOFF_STATE_PARAM } from '@fabrika/auth-core'
import { type AppPresentation, INSTALLATION_PRESENTATION, presentationFor } from '../app-presentation'
import { LOCAL_DEV_ADMIN_EMAIL, LOCAL_DEV_ADMIN_ID } from '../auth'
import { type SessionRow } from '../db'

import { type RequestContext } from '../env'
import { authFailurePage, chooseAccountPage, loginPage } from '../password-pages'
import { resolveUserPrincipal } from '../resolve'
import { type Services } from '../services'
import { type Handoff, handoffLocation, handoffLoginUrl, handoffOf, handoffRedirectOr, loginDestinationFields, readHandoff } from './handoff'
import { readForm, redirectHeaders, sameOrigin, stringValue } from './http'

import { startOidc } from './oidc'
import { type AuthEnv } from './oidc-flight'
import { currentLogin, endLogin, issueSession, refuseLogin, signedOutRedirect } from './sessions'

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

	// Already signed in HERE? Then a handoff needs no password. It continues silently when this login already chose the
	// app, and otherwise asks which account to use; no code exists until the answer. Token renewal never comes here: the
	// proxy re-mints from its app session server-side.
	if (handoff !== null) {
		const login = await currentLogin(request, services)
		if (login !== null) {
			if (await loginChoseApp(services, login.session, handoff.app)) {
				return new Response(null, { status: 302, headers: redirectHeaders(await handoffLocation(services, handoff, login.session.id)) })
			}
			return chooseAccountPage({
				presentation,
				label: login.principal.label,
				handoff,
				redirectOrigin: (await loginDestinationFields(services, handoff, redirect)).redirectOrigin,
			})
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

/**
 * How long a new login counts as the choice of the application it lands on. A completed password action, an invitation
 * enrollment or a sign-in on IAM's own page issues a login and lands on an application, whose proxy starts a handoff
 * moments later; asking that person which account to use would ask what they just answered.
 */
const JUST_SIGNED_IN_SECONDS = 60

/**
 * Whether `login` already chose `app`: it holds a live session there (the browser lost that cookie), or it was issued
 * moments ago. Otherwise the handoff asks before it uses the login.
 */
async function loginChoseApp(services: Services, login: SessionRow, app: string): Promise<boolean> {
	if (login.created_at > Math.floor(Date.now() / 1000) - JUST_SIGNED_IN_SECONDS) return true
	return services.repositories.sessions.hasActiveChild(login.id, app)
}

/**
 * The answer to `chooseAccountPage`. Same-origin only, and it reads the handoff and the login again. `continue` hands off
 * from the login the browser holds now; `another` ends that login like a sign-out and returns to the sign-in page of the
 * same handoff, whose verifier the app's proxy still holds.
 */
export async function handleAccountChoice(request: Request, services: Services, requestId: string): Promise<Response> {
	if (!sameOrigin(request, services.config)) return authFailurePage(INSTALLATION_PRESENTATION, { kind: 'cross_origin' }, 403)
	const form = await readForm(request)
	if (form === null) return authFailurePage(INSTALLATION_PRESENTATION, { kind: 'malformed_form' }, 400)
	const app = stringValue(form.get('app'))
	const reading = await readHandoff(
		services,
		app,
		stringValue(form.get('redirect')),
		stringValue(form.get(AUTH_HANDOFF_STATE_PARAM)),
		stringValue(form.get(AUTH_HANDOFF_CHALLENGE_PARAM)),
	)
	const presentation = await presentationFor(services, app)
	if (reading.kind === 'refused') return authFailurePage(presentation, reading.failure, 400)
	const handoff = handoffOf(reading)
	const decision = form.get('decision')
	if (handoff === null || (decision !== 'continue' && decision !== 'another')) return authFailurePage(presentation, { kind: 'malformed_form' }, 400)
	if (decision === 'another') {
		if (!await endLogin(request, services, requestId)) return authFailurePage(presentation, { kind: 'logout_unavailable' }, 503)
		return signedOutRedirect(handoffLoginUrl(services, handoff))
	}
	const login = await currentLogin(request, services)
	// The login ended after the page was rendered: sign in again, and the handoff continues from there.
	const location = login === null ? handoffLoginUrl(services, handoff) : await handoffLocation(services, handoff, login.session.id)
	return new Response(null, { status: 302, headers: redirectHeaders(location) })
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
