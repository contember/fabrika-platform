import { z } from 'zod'
import { actionLandingOrigin, type AppPresentation, landingUrl, presentationFor } from '../app-presentation'
import { type InvitationRow, principalStatus } from '../db'
import { type RequestContext } from '../env'
import { acceptCreatingPrincipal, acceptInvitation, INVITATION_ACCEPT_PATH, invitationOffer } from '../membership'
import { authFailurePage, invitationOutcomePage, invitationPage, invitationPasswordPage } from '../password-pages'
import { validatePassword } from '../password-policy'
import type { Services } from '../services'
import { methodNotAllowed, readForm, redirectHeaders, sameOrigin, stringValue } from './http'
import { currentSession, issueSession } from './sessions'

const tokenSchema = z.string().max(512).regex(/^[A-Za-z0-9_-]{32,}$/)

/**
 * `GET|POST /auth/invitations/accept`. The emailed link opens the GET page; its fragment carries the
 * one-time token, which never reaches a server log. Accepting is a POST from that page, same-origin
 * only, by the principal signed in HERE, on IAM's host — the mailbox's owner, proven by the token.
 *
 * An invitation that creates its principal (`invitationOffer`) answers that POST with a set-password form instead;
 * its POST, with the password, creates the external principal and accepts in one transaction, then signs the browser
 * in on IAM. Neither the GET nor the POST without a password changes anything, so a mail scanner spends nothing. A
 * browser signed in here as anyone gets neither: it is told to sign out or use another browser profile first.
 *
 * The link's `?app=` picks the page's language; an accepted invitation lands on its own application's
 * registered origin, where the application's proxy signs the browser in through the normal handoff.
 */
export async function handleInvitation(request: Request, services: Services, ctx: RequestContext, requestId: string): Promise<Response> {
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
	const offer = await invitationOffer(services, token.data)
	if (offer.kind === 'invalid') {
		return invalid()
	}
	if (offer.kind === 'not_allowed') {
		return invitationOutcomePage({ presentation: linked, title: (t) => t.unavailableTitle, text: (t) => t.inviterCannotGrant, status: 403 })
	}
	if (offer.kind === 'create') {
		// The new account would replace the browser's session silently, and the application would keep the old identity.
		if ((await currentSession(request, services)) !== null) {
			return invitationOutcomePage({
				presentation: await presentationFor(services, offer.invitation.app),
				title: (t) => t.otherAccountTitle,
				text: (t) => t.otherAccountText(offer.invitation.email),
				status: 409,
				signOut: '/auth/logout',
			})
		}
		const password = stringValue(form?.get('password') ?? null)
		if (password !== null) {
			return createAndAccept(request, services, ctx, { invitation: offer.invitation, token: token.data, password, requestId })
		}
		const presentation = await presentationFor(services, offer.invitation.app)
		return invitationPasswordPage({
			presentation,
			landingOrigin: await actionLandingOrigin(services, presentation),
			token: token.data,
			address: offer.invitation.email,
		})
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

/**
 * The set-password form's POST: the password policy, then the external principal, its password and the acceptance in
 * one transaction, then the IAM session, and the browser lands on the application, whose proxy hands the session off.
 */
async function createAndAccept(
	request: Request,
	services: Services,
	ctx: RequestContext,
	input: { readonly invitation: InvitationRow; readonly token: string; readonly password: string; readonly requestId: string },
): Promise<Response> {
	const { invitation } = input
	const presentation = await presentationFor(services, invitation.app)
	const policy = validatePassword(input.password, { email: invitation.email, label: invitation.email })
	if (!policy.ok) {
		return invitationPasswordPage({
			presentation,
			landingOrigin: await actionLandingOrigin(services, presentation),
			token: input.token,
			address: invitation.email,
			problem: policy.problem,
		})
	}
	const outcome = await acceptCreatingPrincipal(services, invitation, await services.passwordHasher.hash(policy.password), input.requestId)
	if (!outcome.ok) {
		return creationRefused(services, presentation, outcome.reason)
	}
	return issueSession(request, services, ctx, {
		principalId: outcome.principal.id,
		email: outcome.principal.email,
		authenticationMethod: 'password',
		redirect: landingUrl(presentation),
		reason: 'invitation_enrollment',
		requestId: input.requestId,
	})
}

function creationRefused(
	services: Services,
	presentation: AppPresentation,
	reason: 'invalid' | 'not_allowed' | 'not_eligible' | 'sign_in',
): Response {
	switch (reason) {
		case 'invalid':
			return invitationOutcomePage({ presentation, title: (t) => t.invalidTitle, text: (t) => t.invalidText, status: 400 })
		case 'not_allowed':
			return invitationOutcomePage({ presentation, title: (t) => t.unavailableTitle, text: (t) => t.inviterCannotGrant, status: 403 })
		case 'not_eligible':
			return invitationOutcomePage({ presentation, title: (t) => t.unavailableTitle, text: (t) => t.roleNotEligible, status: 403 })
		case 'sign_in':
			return invitationOutcomePage({
				presentation,
				title: (t) => t.signInFirstTitle,
				text: (t) => t.signInFirstText,
				status: 401,
				signIn: landingUrl(presentation) ?? ownSignIn(services, presentation.app),
			})
	}
}

/** IAM's own sign-in, back to this page: the browser opens the invitation link again there. */
function ownSignIn(services: Services, app: string | null): string {
	const accept = new URL(INVITATION_ACCEPT_PATH, services.config.issuer)
	if (app !== null) accept.searchParams.set('app', app)
	const signIn = new URL('/auth/login', services.config.issuer)
	signIn.searchParams.set('redirect', accept.toString())
	return signIn.toString()
}
