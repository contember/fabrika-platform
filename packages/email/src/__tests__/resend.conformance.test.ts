import { z } from 'zod'
import { describeEmailSenderConformance } from '../conformance.js'
import { ResendEmailSender } from '../resend.js'

const API_KEY = 're_conformance_secret_4b9d'
const requestSchema = z.object({
	from: z.string(),
	to: z.string(),
	subject: z.string(),
	text: z.string(),
	html: z.string().optional(),
	reply_to: z.string().optional(),
	attachments: z.array(z.object({ filename: z.string(), content: z.string(), content_type: z.string() }).strict()).optional(),
	headers: z.object({ 'List-Unsubscribe': z.string(), 'List-Unsubscribe-Post': z.literal('List-Unsubscribe=One-Click') }).strict().optional(),
	tags: z.array(z.object({ name: z.string(), value: z.string() }).strict()).optional(),
})

function errorAnswer(status: number, name: string): Response {
	return Response.json({ name, message: `private provider detail for ${name}` }, { status })
}

describeEmailSenderConformance('ResendEmailSender', {
	kind: 'http',
	secrets: [API_KEY],
	create: (fetch, { timeoutMs }) => new ResendEmailSender({ apiKey: API_KEY, from: { address: 'auth@example.test' }, fetch, timeoutMs }),
	async readRequest(request) {
		const body = requestSchema.parse(await request.json())
		const fromName = /^"?(.*?)"? <auth@example\.test>$/.exec(body.from)?.[1]
		return {
			to: body.to,
			subject: body.subject,
			text: body.text,
			...(body.html === undefined ? {} : { html: body.html }),
			...(body.reply_to === undefined ? {} : { replyTo: body.reply_to }),
			...(fromName === undefined ? {} : { fromName }),
			...(body.headers === undefined ? {} : { unsubscribeUrl: body.headers['List-Unsubscribe'].replace(/^<(.*)>$/, '$1') }),
			...(body.attachments === undefined
				? {}
				: {
					attachments: body.attachments.map((attachment) => ({
						filename: attachment.filename,
						contentType: attachment.content_type,
						content: attachment.content,
					})),
				}),
			...(body.tags?.some((tag) => tag.name === 'category' && tag.value === 'broadcast') === true ? { broadcast: true } : {}),
			idempotencyKey: request.headers.get('idempotency-key') ?? undefined,
		}
	},
	answers: {
		accepted: () => Response.json({ id: 'resend-message-1' }),
		malformedSuccess: () => Response.json({ message: 'private provider detail without an id' }),
		// The answers below with a recorded message are as a live account answered in October 2026.
		unauthorized: () => Response.json({ message: 'API key is invalid', name: 'validation_error', statusCode: 401 }, { status: 401 }),
		rejected: () =>
			Response.json({
				message: 'Invalid `to` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.',
				name: 'validation_error',
				statusCode: 422,
			}, { status: 422 }),
		rateLimited: () => errorAnswer(429, 'rate_limit_exceeded'),
		quotaExceeded: () => errorAnswer(429, 'daily_quota_exceeded'),
		unavailable: () => errorAnswer(500, 'internal_server_error'),
		inProgress: () =>
			Response.json({
				message: 'There is another request in progress with the same idempotency key.',
				name: 'concurrent_idempotent_requests',
				statusCode: 409,
			}, { status: 409 }),
		idempotencyConflict: () =>
			Response.json({
				message:
					"This idempotency key has been used with this HTTP method and endpoint within the last 24 hours, but the request body was modified and doesn't match the original request.",
				name: 'invalid_idempotent_request',
				statusCode: 409,
			}, { status: 409 }),
	},
})
