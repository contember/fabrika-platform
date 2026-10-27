// IAM falls back to its own provider only when Control's relay refused a message for good: never on an answer that may
// mean the relay took it, so a message is never sent twice.

import { EmailDeliveryError, type EmailDeliveryErrorCode, type EmailMessage, type EmailSender } from '@fabrika/email'
import { PLATFORM_MAIL_CAPABILITIES } from '@fabrika/email/platform'
import { describe, expect, spyOn, test } from 'bun:test'
import { relayRefused, relayWithFallback } from '../relay-mail'

const message: EmailMessage = { to: 'ada@example.com', subject: 'Reset', text: 'Open the link', idempotencyKey: 'iam-reset-1' }

/** A sender that answers every send with `answer`, and counts the sends. */
function fake(answer: () => Promise<Awaited<ReturnType<EmailSender['send']>>>): EmailSender & { sent: number } {
	const sender = {
		capabilities: PLATFORM_MAIL_CAPABILITIES,
		sent: 0,
		send: () => {
			sender.sent++
			return answer()
		},
	}
	return sender
}

const refusing = (code: EmailDeliveryErrorCode, httpStatus?: number) =>
	fake(() =>
		Promise.reject(new EmailDeliveryError('Platform mail relay refused the message', { code, ...(httpStatus === undefined ? {} : { httpStatus }) }))
	)
const direct = () => fake(() => Promise.resolve({ status: 'accepted', provider: 'resend', messageId: 'resend-1' }))

describe("IAM's relay fallback", () => {
	test('a definite refusal sends the message once with IAM own provider, and logs no message content', async () => {
		const warn = spyOn(console, 'warn').mockImplementation(() => {})
		try {
			for (
				const relay of [
					refusing('provider_unauthorized', 401),
					refusing('mail_not_configured', 503),
					refusing('invalid_configuration'),
					refusing('malformed_response', 404),
				]
			) {
				const own = direct()
				const result = await relayWithFallback(relay, own).send(message, AbortSignal.timeout(5_000))
				expect(result).toEqual({ status: 'accepted', provider: 'resend', messageId: 'resend-1' })
				expect([relay.sent, own.sent]).toEqual([1, 1])
			}
			expect(warn).toHaveBeenCalledTimes(4)
			expect(warn.mock.calls.flat().join('\n')).not.toContain(message.to)
		} finally {
			warn.mockRestore()
		}
	})

	test('an answer that may mean the relay took the message never falls back', async () => {
		for (
			const relay of [
				refusing('network_error'),
				refusing('request_timeout'),
				refusing('provider_unavailable', 503),
				refusing('malformed_response', 502),
				refusing('idempotency_conflict', 409),
				fake(() => Promise.reject(new Error('unexpected'))),
			]
		) {
			const own = direct()
			await expect(relayWithFallback(relay, own).send(message, AbortSignal.timeout(5_000))).rejects.toThrow()
			expect(own.sent).toBe(0)
		}
	})

	test('a message the relay accepted is not sent again', async () => {
		const relay = fake(() => Promise.resolve({ status: 'accepted', provider: 'platform', messageId: 'relay-1' }))
		const own = direct()
		expect(await relayWithFallback(relay, own).send(message, AbortSignal.timeout(5_000))).toMatchObject({ provider: 'platform' })
		expect(own.sent).toBe(0)
		expect(relayRefused(new Error('not a delivery error'))).toBe(false)
	})
})
