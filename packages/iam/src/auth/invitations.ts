import { z } from 'zod'
import { landingUrl, presentationFor } from '../app-presentation'
import { principalStatus } from '../db'
import { acceptInvitation, INVITATION_ACCEPT_PATH } from '../membership'
import { authFailurePage, invitationOutcomePage, invitationPage } from '../password-pages'
import type { Services } from '../services'
import { methodNotAllowed, readForm, redirectHeaders, sameOrigin, stringValue } from './http'
import { currentSession } from './sessions'

const tokenSchema = z.string().max(512).regex(/^[A-Za-z0-9_-]{32,}$/)

/**
 * `GET|POST /auth/invitations/accept`. The emailed link opens the GET page; its fragment carries the
 * one-time token, which never reaches a server log. Accepting is a POST from that page, same-origin
 * only, by the principal signed in HERE, on IAM's host — the mailbox's owner, proven by the token.
 *
 * The link's `?app=` picks the page's language; an accepted invitation lands on its own application's
 * registered origin, where the application's proxy signs the browser in through the normal handoff.
 */
export async function handleInvitation(request: Request, services: Services, requestId: string): Promise<Response> {
	const linked = await presentationFor(services, new URL(request.url).searchParams.get('app'))
	if (request.method === 'GET') {
		return invitationPage(linked)
	}
	if (request.method !== 'POST') {
		return methodNotAllowed()
	}
	if (!sameOrigin(request, services.config)) {
		return authFailurePage(linked, { kind: 'cross_origin' }, 403)
	}
	const form = await readForm(request)
	const token = tokenSchema.safeParse(stringValue(form?.get('token') ?? null))
	const invalid = () => invitationOutcomePage({ presentation: linked, title: (t) => t.invalidTitle, text: (t) => t.invalidText, status: 400 })
	if (!token.success) {
		return invalid()
	}
	const session = await currentSession(request, services)
	if (session === null) {
		// The application's own address signs the browser in through its handoff, in its language; without one, IAM's.
		const signIn = landingUrl(linked) ?? ownSignIn(services, linked.app)
		return invitationOutcomePage({
			presentation: linked,
			title: (t) => t.signInFirstTitle,
			text: (t) => t.signInFirstText,
			status: 401,
			signIn,
		})
	}
	const principal = await services.repositories.principals.getPrincipalById(session.principal_id)
	if (principal === null || principalStatus(principal) === 'disabled') {
		return invitationOutcomePage({ presentation: linked, title: (t) => t.unavailableTitle, text: (t) => t.accountCannotAccept, status: 403 })
	}
	const outcome = await acceptInvitation(services, principal, token.data, requestId)
	if (!outcome.ok) {
		switch (outcome.reason) {
			case 'invalid':
				return invalid()
			case 'wrong_principal':
				return invitationOutcomePage({ presentation: linked, title: (t) => t.wrongAddressTitle, text: (t) => t.wrongAddressText, status: 403 })
			case 'not_eligible':
				return invitationOutcomePage({ presentation: linked, title: (t) => t.unavailableTitle, text: (t) => t.roleNotEligible, status: 403 })
			case 'not_allowed':
				return invitationOutcomePage({ presentation: linked, title: (t) => t.unavailableTitle, text: (t) => t.inviterCannotGrant, status: 403 })
		}
	}
	const { invitation } = outcome
	const presentation = await presentationFor(services, invitation.app)
	const landing = landingUrl(presentation)
	if (landing !== null) {
		return new Response(null, { status: 302, headers: redirectHeaders(landing) })
	}
	const role = await services.repositories.appSchema.getRole(invitation.app, invitation.role_key)
	return invitationOutcomePage({
		presentation,
		title: (t) => t.acceptedTitle,
		text: (t) =>
			t.acceptedText({ role: role?.name ?? invitation.role_key, scope: invitation.scope_type, appName: presentation.displayName ?? invitation.app }),
		status: 200,
	})
}

/** IAM's own sign-in, back to this page: the browser opens the invitation link again there. */
function ownSignIn(services: Services, app: string | null): string {
	const accept = new URL(INVITATION_ACCEPT_PATH, services.config.issuer)
	if (app !== null) accept.searchParams.set('app', app)
	const signIn = new URL('/auth/login', services.config.issuer)
	signIn.searchParams.set('redirect', accept.toString())
	return signIn.toString()
}
