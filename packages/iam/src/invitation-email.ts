import type { EmailMessage } from '@fabrika/email'
import { escapeHtml } from './password-pages'

/** The email that carries an invitation's one-time link. Possessing the link proves the mailbox. */
export function invitationEmail(input: {
	readonly to: string
	readonly app: string
	readonly role: string
	readonly dimension: string
	readonly acceptUrl: string
	readonly idempotencyKey: string
}): EmailMessage {
	const what = `${input.dimension} of ${input.app} as ${input.role}`
	const text =
		`You are invited to join a ${what}.\n\nSign in with this address, then open this one-time link to accept:\n\n${input.acceptUrl}\n\nIf you did not expect this, you can ignore this email.`
	return {
		to: input.to,
		subject: `You are invited to ${input.app}`,
		text,
		html: `<p>You are invited to join a ${escapeHtml(what)}.</p><p>Sign in with this address, then open this one-time link to accept:</p><p><a href="${
			escapeHtml(input.acceptUrl)
		}">Accept the invitation</a></p><p>If you did not expect this, you can ignore this email.</p>`,
		idempotencyKey: input.idempotencyKey,
	}
}
