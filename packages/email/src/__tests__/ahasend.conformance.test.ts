import { z } from 'zod'
import { AhaSendEmailSender } from '../ahasend.js'
import { describeEmailSenderConformance } from '../conformance.js'

const API_KEY = 'aha-sk-conformance-secret-8b1e'
const ACCOUNT_ID = '0f4c6a52-6d1e-4c7a-9b0e-3a2f1d5c7e90'
const requestSchema = z.object({
	from: z.object({ email: z.literal('auth@example.test'), name: z.string().optional() }).strict(),
	recipients: z.tuple([z.object({ email: z.string() }).strict()]),
	subject: z.string(),
	text_content: z.string(),
	html_content: z.string().optional(),
	reply_to: z.object({ email: z.string() }).strict().optional(),
	headers: z.object({ 'List-Unsubscribe': z.string(), 'List-Unsubscribe-Post': z.literal('List-Unsubscribe=One-Click') }).strict().optional(),
	attachments: z.array(z.object({ base64: z.literal(true), data: z.string(), content_type: z.string(), file_name: z.string() }).strict()).optional(),
})

function errorAnswer(status: number): Response {
	return Response.json({ message: `private provider detail for ${status}` }, { status })
}

describeEmailSenderConformance('AhaSendEmailSender', {
	kind: 'http',
	secrets: [API_KEY],
	create: (fetch, { timeoutMs }) =>
		new AhaSendEmailSender({ apiKey: API_KEY, accountId: ACCOUNT_ID, from: { address: 'auth@example.test' }, fetch, timeoutMs }),
	async readRequest(request) {
		const body = requestSchema.parse(await request.json())
		return {
			to: body.recipients[0].email,
			subject: body.subject,
			text: body.text_content,
			...(body.html_content === undefined ? {} : { html: body.html_content }),
			...(body.reply_to === undefined ? {} : { replyTo: body.reply_to.email }),
			...(body.from.name === undefined ? {} : { fromName: body.from.name }),
			...(body.headers === undefined ? {} : { unsubscribeUrl: body.headers['List-Unsubscribe'].replace(/^<(.*)>$/, '$1') }),
			...(body.attachments === undefined
				? {}
				: {
					attachments: body.attachments.map((attachment) => ({
						filename: attachment.file_name,
						contentType: attachment.content_type,
						content: attachment.data,
					})),
				}),
			idempotencyKey: request.headers.get('idempotency-key') ?? undefined,
		}
	},
	answers: {
		accepted: () =>
			Response.json({
				object: 'list',
				data: [{ object: 'message', id: 'ahasend-message-1', recipient: { email: 'recipient@example.test', name: '' }, status: 'queued', error: null }],
			}, { status: 202 }),
		malformedSuccess: () => Response.json({ object: 'list', data: [] }, { status: 202 }),
		// As a live account answered in October 2026.
		unauthorized: () => Response.json({ message: 'invalid API key' }, { status: 401 }),
		rejected: () => Response.json({ message: "domain 'example.com' not found" }, { status: 400 }),
		rateLimited: () => errorAnswer(429),
		unavailable: () => errorAnswer(500),
		inProgress: () => errorAnswer(409),
		idempotencyConflict: () => Response.json({ message: 'idempotency key was already used with a different request payload' }, { status: 422 }),
	},
})
