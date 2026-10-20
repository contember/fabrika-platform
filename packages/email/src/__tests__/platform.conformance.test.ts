import { describeEmailSenderConformance } from '../conformance.js'
import { base64Of } from '../content.js'
import type { EmailDeliveryErrorCode } from '../email.js'
import { parsePlatformMailRequest, PlatformEmailSender, platformMailAnswerResponse } from '../platform.js'

const KEY = 'px_conformance_secret_7c1a'

/** An error answer in the relay's wire form, under a status of the harness's choosing for codes the relay maps none for. */
function errorAnswer(status: number, code: EmailDeliveryErrorCode): Response {
	return Response.json({ error: { code } }, { status })
}

describeEmailSenderConformance('PlatformEmailSender', {
	kind: 'http',
	secrets: [KEY],
	create: (fetch, { timeoutMs }) => new PlatformEmailSender({ url: 'http://control:3000', key: KEY, fetch, timeoutMs }),
	async readRequest(request) {
		const parsed = parsePlatformMailRequest(await request.json())
		if (!parsed.ok) throw new Error(parsed.reason)
		const { attachments, ...fields } = parsed.message
		return {
			...fields,
			...(attachments === undefined
				? {}
				: {
					attachments: attachments.map((attachment) => ({
						filename: attachment.filename,
						contentType: attachment.contentType,
						content: base64Of(attachment.content),
					})),
				}),
		}
	},
	answers: {
		accepted: () => platformMailAnswerResponse({ status: 'accepted', messageId: 'platform-message-1' }),
		malformedSuccess: () => Response.json({ status: 'accepted' }),
		unauthorized: () => platformMailAnswerResponse({ error: { code: 'provider_unauthorized' } }),
		rejected: () => errorAnswer(422, 'provider_rejected'),
		rateLimited: () => errorAnswer(429, 'rate_limited'),
		quotaExceeded: () => errorAnswer(429, 'quota_exceeded'),
		unavailable: () => platformMailAnswerResponse({ error: { code: 'provider_unavailable' } }),
		inProgress: () => errorAnswer(409, 'request_in_progress'),
		idempotencyConflict: () => platformMailAnswerResponse({ error: { code: 'idempotency_conflict' } }),
	},
})
