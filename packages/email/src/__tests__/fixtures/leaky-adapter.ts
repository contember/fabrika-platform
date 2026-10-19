// Run by `conformance-kit.test.ts` in its own `bun test` process: an adapter that conforms in every way but one,
// copying the provider's answer body into its error message. The kit must fail it.

import { z } from 'zod'
import { describeEmailSenderConformance } from '../../conformance.js'
import { EmailDeliveryError, type EmailFetch } from '../../email.js'
import { ResendEmailSender } from '../../resend.js'

const requestSchema = z.object({
	from: z.string(),
	to: z.string(),
	subject: z.string(),
	text: z.string(),
	html: z.string().optional(),
	reply_to: z.string().optional(),
	headers: z.object({ 'List-Unsubscribe': z.string() }).optional(),
	attachments: z.array(z.object({ filename: z.string(), content: z.string(), content_type: z.string() })).optional(),
})

function errorAnswer(status: number, name: string): Response {
	return Response.json({ name, message: `private provider detail for ${name}` }, { status })
}

describeEmailSenderConformance('LeakyEmailSender', {
	kind: 'http',
	secrets: ['re_leaky_secret'],
	create(fetch, { timeoutMs }) {
		let lastBody = ''
		const recording: EmailFetch = async (input, init) => {
			const response = await fetch(input, init)
			if (!response.ok) lastBody = await response.clone().text()
			return response
		}
		const inner = new ResendEmailSender({ apiKey: 're_leaky_secret', from: { address: 'auth@example.test' }, fetch: recording, timeoutMs })
		return {
			capabilities: inner.capabilities,
			async send(message, signal) {
				try {
					return await inner.send(message, signal)
				} catch (error) {
					if (error instanceof EmailDeliveryError && error.httpStatus !== undefined) {
						throw new EmailDeliveryError(`${error.message}: ${lastBody}`, { code: error.code, httpStatus: error.httpStatus })
					}
					throw error
				}
			},
		}
	},
	async readRequest(request) {
		const body = requestSchema.parse(await request.json())
		return {
			to: body.to,
			subject: body.subject,
			text: body.text,
			...(body.html === undefined ? {} : { html: body.html }),
			...(body.reply_to === undefined ? {} : { replyTo: body.reply_to }),
			...(body.headers === undefined ? {} : { unsubscribeUrl: body.headers['List-Unsubscribe'].replace(/^<(.*)>$/, '$1') }),
			...(body.attachments === undefined
				? {}
				: { attachments: body.attachments.map(({ filename, content, content_type }) => ({ filename, contentType: content_type, content })) }),
			...(body.from === 'auth@example.test' ? {} : { fromName: body.from.replace(/^"?(.*?)"? <auth@example\.test>$/, '$1') }),
			idempotencyKey: request.headers.get('idempotency-key') ?? undefined,
		}
	},
	answers: {
		accepted: () => Response.json({ id: 'leaky-1' }),
		malformedSuccess: () => Response.json({ message: 'private provider detail without an id' }),
		unauthorized: () => errorAnswer(401, 'missing_api_key'),
		rejected: () => errorAnswer(422, 'validation_error'),
		rateLimited: () => errorAnswer(429, 'rate_limit_exceeded'),
		unavailable: () => errorAnswer(500, 'internal_server_error'),
		inProgress: () => errorAnswer(409, 'concurrent_idempotent_requests'),
		idempotencyConflict: () => errorAnswer(409, 'invalid_idempotent_request'),
	},
})
