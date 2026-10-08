import { z } from 'zod'
import { principalStatus } from '../db'
import type { RequestContext } from '../env'
import { logError } from '../log'
import { acceptInvitation, INVITATION_ACCEPT_PATH } from '../membership'
import { invitationOutcomePage, invitationPage } from '../password-pages'
import type { Services } from '../services'
import { authError, methodNotAllowed, readForm, sameOrigin, stringValue } from './http'
import { currentSession } from './sessions'

const tokenSchema = z.string().max(512).regex(/^[A-Za-z0-9_-]{32,}$/)

/**
 * `GET|POST /auth/invitations/accept`. The emailed link opens the GET page; its fragment carries the
 * one-time token, which never reaches a server log. Accepting is a POST from that page, same-origin
 * only, by the principal signed in HERE, on IAM's host — the mailbox's owner, proven by the token.
 */
export async function handleInvitation(request: Request, services: Services, ctx: RequestContext, requestId: string): Promise<Response> {
	if (request.method === 'GET') {
		return invitationPage()
	}
	if (request.method !== 'POST') {
		return methodNotAllowed()
	}
	if (!sameOrigin(request, services.config)) {
		return authError('invalid request origin', 403)
	}
	const form = await readForm(request)
	const token = tokenSchema.safeParse(stringValue(form?.get('token') ?? null))
	if (!token.success) {
		return invalidInvitation()
	}
	const session = await currentSession(request, services)
	if (session === null) {
		const signIn = new URL('/auth/login', services.config.issuer)
		signIn.searchParams.set('redirect', new URL(INVITATION_ACCEPT_PATH, services.config.issuer).toString())
		return invitationOutcomePage({
			title: 'Sign in first',
			text: 'Sign in with the invited address, then open the invitation link again.',
			status: 401,
			signIn: signIn.toString(),
		})
	}
	const principal = await services.repositories.principals.getPrincipalById(session.principal_id)
	if (principal === null || principalStatus(principal) === 'disabled') {
		return invitationOutcomePage({ title: 'Invitation unavailable', text: 'This account cannot accept invitations.', status: 403 })
	}
	const outcome = await acceptInvitation(services, principal, token.data)
	if (!outcome.ok) {
		switch (outcome.reason) {
			case 'invalid':
				return invalidInvitation()
			case 'wrong_principal':
				return invitationOutcomePage({
					title: 'Invitation for another address',
					text: 'You are signed in with an address this invitation was not sent to. Sign in with the invited address.',
					status: 403,
				})
			case 'not_allowed':
				return invitationOutcomePage({
					title: 'Invitation unavailable',
					text: 'The person who sent this invitation can no longer give this role. Ask for a new invitation.',
					status: 403,
				})
		}
	}
	const { invitation } = outcome
	ctx.waitUntil(
		services.repositories.audit
			.writeAuditEvent({
				requestId,
				principalId: principal.id,
				principalLabel: principal.label,
				app: invitation.app,
				action: 'iam.member.accept',
				resourceType: 'scope',
				resourceId: `${invitation.scope_type}:${invitation.scope_value}`,
				metadata: { invitationId: invitation.id, role: invitation.role_key },
			})
			.catch((err: unknown) => logError('invitation audit write failed', err)),
	)
	return invitationOutcomePage({
		title: 'Invitation accepted',
		text: `You are now ${invitation.role_key} of a ${invitation.scope_type} of ${invitation.app}.`,
		status: 200,
	})
}

function invalidInvitation(): Response {
	return invitationOutcomePage({ title: 'Link unavailable', text: 'This invitation is invalid, expired, cancelled or already used.', status: 400 })
}
