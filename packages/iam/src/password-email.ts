import type { EmailMessage } from '@fabrika/email'
import type { PasswordActionPurpose } from './password-db'

export function passwordActionEmail(input: {
	readonly to: string
	readonly purpose: PasswordActionPurpose
	readonly actionUrl: string
	readonly idempotencyKey: string
}): EmailMessage {
	const action = input.purpose === 'enrollment' ? 'set your Fabrika password' : 'reset your Fabrika password'
	const subject = input.purpose === 'enrollment' ? 'Set your Fabrika password' : 'Reset your Fabrika password'
	const text = `Use this one-time link to ${action}:\n\n${input.actionUrl}\n\nIf you did not request this, you can ignore this email.`
	return {
		to: input.to,
		subject,
		text,
		html: `<p>Use this one-time link to ${escapeHtml(action)}:</p><p><a href="${escapeHtml(input.actionUrl)}">${
			escapeHtml(subject)
		}</a></p><p>If you did not request this, you can ignore this email.</p>`,
		idempotencyKey: input.idempotencyKey,
	}
}

function escapeHtml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}
